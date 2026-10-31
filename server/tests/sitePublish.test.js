// OC-WEB-1 PR-D — publish, unpublish, revert, and revision conflicts.
// Public reads keep serving published_doc only. History rows are append-only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import request from 'supertest'
import pool from '../src/db.js'
import { migrateOnce, bindServer, closeServer, RUN_ID } from './support/harness.js'
import { signToken } from '../src/middleware/auth.js'

beforeAll(async () => { await migrateOnce() }, 180_000)

let server
beforeAll(async () => { server = await bindServer() })
afterAll(async () => { await closeServer(server); await pool.end() })

function authFor(user, role = 'admin') {
  return signToken({
    userId: user.id,
    organizationId: user.organization_id,
    email: user.email,
    name: user.name,
    role,
    tv: user.token_version ?? 1,
  })
}

function draft(headline) {
  return {
    pages: [{
      id: 'home',
      title: { en: 'Home', es: 'Inicio' },
      blocks: [{ type: 'hero_split', headline: { en: headline, es: headline } }],
    }],
  }
}

describe('migration 143 + site publish', () => {
  let orgA, orgB, adminA, adminB, slugA

  beforeAll(async () => {
    const a = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, TRUE) RETURNING id, slug`,
      [`Publish A ${RUN_ID}`, `pub-a-${RUN_ID}`.toLowerCase()],
    )
    const b = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, TRUE) RETURNING id, slug`,
      [`Publish B ${RUN_ID}`, `pub-b-${RUN_ID}`.toLowerCase()],
    )
    orgA = a.rows[0]
    orgB = b.rows[0]
    slugA = orgA.slug
    const ua = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Admin A', 'admin') RETURNING id, token_version, email`,
      [orgA.id, `pub-admin-a-${RUN_ID}@example.com`],
    )
    const ub = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Admin B', 'admin') RETURNING id, token_version, email`,
      [orgB.id, `pub-admin-b-${RUN_ID}@example.com`],
    )
    adminA = { ...ua.rows[0], organization_id: orgA.id, name: 'Admin A' }
    adminB = { ...ub.rows[0], organization_id: orgB.id, name: 'Admin B' }
  })

  afterAll(async () => {
    for (const id of [orgA?.id, orgB?.id].filter(Boolean)) {
      await pool.query('DELETE FROM ochr_site_publish_history WHERE organization_id = $1', [id]).catch(() => {})
      await pool.query('DELETE FROM ochr_site_documents WHERE organization_id = $1', [id]).catch(() => {})
      await pool.query('DELETE FROM ochr_users WHERE organization_id = $1', [id]).catch(() => {})
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  function bearer(user, role) {
    return { Authorization: `Bearer ${authFor(user, role)}` }
  }

  async function revisionOf(user) {
    const res = await request(server).get('/api/organization/site').set(bearer(user))
    expect(res.status).toBe(200)
    return res.body.site.revision
  }

  it('migration 143 history table has RLS and composite tenant foreign keys', async () => {
    const { rows: rls } = await pool.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'ochr_site_publish_history'`,
    )
    expect(rls[0]?.relrowsecurity).toBe(true)

    await expect(pool.query(
      `INSERT INTO ochr_site_publish_history
         (organization_id, site_document_id, seq, action, doc)
       VALUES ($1, 1, 1, 'erase', '{"version":1}'::jsonb)`,
      [orgA.id],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('publishes the stored draft, keeps history, and leaves the public page on published_doc', async () => {
    const saved = await request(server)
      .put('/api/organization/site')
      .set(bearer(adminA))
      .send({ draft: draft('Draft one'), look_id: 'clinical-light', expected_revision: await revisionOf(adminA) })
    expect(saved.status).toBe(200)
    const rev1 = saved.body.site.revision

    const unconfirmed = await request(server)
      .post('/api/organization/site/publish')
      .set(bearer(adminA))
      .send({ expected_revision: rev1 })
    expect(unconfirmed.status).toBe(400)
    expect(unconfirmed.body.code).toBe('site_confirm_required')

    const published = await request(server)
      .post('/api/organization/site/publish')
      .set(bearer(adminA))
      .send({
        confirm: true,
        expected_revision: rev1,
        published_doc: { pages: [{ id: 'home', blocks: [{ type: 'hero_split', headline: { en: 'Evil', es: 'Evil' } }] }] },
      })
    expect(published.status).toBe(200)
    expect(published.body.site.has_published).toBe(true)
    expect(published.body.site.can_revert).toBe(false)
    expect(published.body.site.draft_matches_published).toBe(true)
    expect(published.body.site.draft.pages[0].blocks[0].headline.en).toBe('Draft one')
    expect(published.body.site.history.map((h) => h.action)).toEqual(['publish'])
    expect(JSON.stringify(published.body)).not.toContain('Evil')

    const { rows } = await pool.query(
      `SELECT published_by_user_id, published_at, published_doc
         FROM ochr_site_documents WHERE organization_id = $1`,
      [orgA.id],
    )
    expect(Number(rows[0].published_by_user_id)).toBe(Number(adminA.id))
    expect(rows[0].published_at).toBeTruthy()
    expect(rows[0].published_doc.pages[0].blocks[0].headline.en).toBe('Draft one')

    const pub = await request(server).get(`/api/public/${slugA}/page`)
    expect(pub.status).toBe(200)
    expect(pub.body.site.doc.pages[0].blocks[0].headline.en).toBe('Draft one')

    const edited = await request(server)
      .put('/api/organization/site')
      .set(bearer(adminA))
      .send({ draft: draft('Draft two'), expected_revision: published.body.site.revision })
    expect(edited.status).toBe(200)
    expect(edited.body.site.draft_matches_published).toBe(false)
    const still = await request(server).get(`/api/public/${slugA}/page`)
    expect(still.body.site.doc.pages[0].blocks[0].headline.en).toBe('Draft one')
    expect(JSON.stringify(still.body)).not.toContain('Draft two')

    const second = await request(server)
      .post('/api/organization/site/publish')
      .set(bearer(adminA))
      .send({ confirm: true, expected_revision: edited.body.site.revision })
    expect(second.status).toBe(200)
    expect(second.body.site.can_revert).toBe(true)
    const liveTwo = await request(server).get(`/api/public/${slugA}/page`)
    expect(liveTwo.body.site.doc.pages[0].blocks[0].headline.en).toBe('Draft two')

    const reverted = await request(server)
      .post('/api/organization/site/revert')
      .set(bearer(adminA))
      .send({ confirm: true, expected_revision: second.body.site.revision })
    expect(reverted.status).toBe(200)
    expect(reverted.body.site.draft.pages[0].blocks[0].headline.en).toBe('Draft two')
    expect(reverted.body.site.can_revert).toBe(false)
    const liveOne = await request(server).get(`/api/public/${slugA}/page`)
    expect(liveOne.body.site.doc.pages[0].blocks[0].headline.en).toBe('Draft one')

    const { rows: book } = await pool.query(
      `SELECT action, doc->'pages'->0->'blocks'->0->'headline'->>'en' AS en
         FROM ochr_site_publish_history
        WHERE organization_id = $1
        ORDER BY seq`,
      [orgA.id],
    )
    expect(book.map((r) => r.action)).toEqual(['publish', 'publish', 'revert'])
    expect(book[0].en).toBe('Draft one')
    expect(book[1].en).toBe('Draft two')
    expect(book[2].en).toBe('Draft one')

    const down = await request(server)
      .post('/api/organization/site/unpublish')
      .set(bearer(adminA))
      .send({ confirm: true, expected_revision: reverted.body.site.revision })
    expect(down.status).toBe(200)
    expect(down.body.site.has_published).toBe(false)
    expect(down.body.site.page_published).toBe(false)
    expect(down.body.site.can_revert).toBe(true)
    // SP-307: takedown clears the public address — same 404 as unpublished.
    const hidden = await request(server).get(`/api/public/${slugA}/page`)
    expect(hidden.status).toBe(404)

    const restored = await request(server)
      .post('/api/organization/site/revert')
      .set(bearer(adminA))
      .send({ confirm: true, expected_revision: down.body.site.revision })
    expect(restored.status).toBe(200)
    expect(restored.body.site.has_published).toBe(true)
    // Revert restores published_doc only (Atlas AND gate). Address stays off
    // until the parish turns page_published back on.
    expect(restored.body.site.page_published).toBe(false)
    const stillDown = await request(server).get(`/api/public/${slugA}/page`)
    expect(stillDown.status).toBe(404)
    await pool.query(
      `UPDATE ochr_organizations SET page_published = TRUE WHERE id = $1`,
      [orgA.id],
    )
    const back = await request(server).get(`/api/public/${slugA}/page`)
    expect(back.status).toBe(200)
    expect(back.body.site.doc.pages[0].blocks[0].headline.en).toBe('Draft one')

    const again = await request(server)
      .post('/api/organization/site/revert')
      .set(bearer(adminA))
      .send({ confirm: true, expected_revision: restored.body.site.revision })
    expect(again.status).toBe(400)
    expect(again.body.code).toBe('site_no_previous')
    const unchanged = await request(server).get(`/api/public/${slugA}/page`)
    expect(unchanged.body.site.doc.pages[0].blocks[0].headline.en).toBe('Draft one')
  })

  it('refuses a stale revision and a non-integer revision without writing', async () => {
    const before = await request(server).get('/api/organization/site').set(bearer(adminA))
    const headline = before.body.site.draft.pages[0].blocks[0].headline.en
    const rev = before.body.site.revision

    const coerced = await request(server)
      .put('/api/organization/site')
      .set(bearer(adminA))
      .send({ draft: draft('Coerced'), expected_revision: true })
    expect(coerced.status).toBe(400)
    expect(coerced.body.code).toBe('site_revision_required')

    await pool.query(
      `UPDATE ochr_site_documents SET revision = revision + 1, updated_at = NOW()
        WHERE organization_id = $1`,
      [orgA.id],
    )
    const stale = await request(server)
      .put('/api/organization/site')
      .set(bearer(adminA))
      .send({ draft: draft('Stale sequential'), expected_revision: rev })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('site_revision_conflict')
    expect(String(stale.body.error)).toMatch(/someone else edited this page/i)
    expect(String(stale.body.error)).toMatch(/reload/i)

    const { rows } = await pool.query(
      `SELECT draft_doc FROM ochr_site_documents WHERE organization_id = $1`,
      [orgA.id],
    )
    expect(rows[0].draft_doc.pages[0].blocks[0].headline.en).toBe(headline)
  })

  it('keeps another parish from reading or publishing this draft', async () => {
    const other = await request(server).get('/api/organization/site').set(bearer(adminB))
    expect(other.status).toBe(200)
    expect(JSON.stringify(other.body)).not.toContain('Draft one')
    expect(JSON.stringify(other.body)).not.toContain('Draft two')

    const stolen = await request(server)
      .post('/api/organization/site/publish')
      .set(bearer(adminB))
      .send({ confirm: true, expected_revision: 0, published_doc: draft('Stolen') })
    expect(stolen.status).toBe(400)
    expect(stolen.body.code).toBe('site_draft_empty')

    const { rows: a } = await pool.query(
      `SELECT published_doc FROM ochr_site_documents WHERE organization_id = $1`,
      [orgA.id],
    )
    expect(a[0].published_doc.pages[0].blocks[0].headline.en).toBe('Draft one')

    const { rows: siteA } = await pool.query(
      `SELECT id FROM ochr_site_documents WHERE organization_id = $1`,
      [orgA.id],
    )
    await expect(pool.query(
      `INSERT INTO ochr_site_publish_history
         (organization_id, site_document_id, seq, action, doc)
       VALUES ($1, $2, 1, 'publish', '{"version":1,"pages":[],"nav":[]}'::jsonb)`,
      [orgB.id, siteA[0].id],
    )).rejects.toMatchObject({ code: '23503' })
  })

  it('staff and anonymous callers cannot publish, unpublish, or revert', async () => {
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Staff', 'staff') RETURNING id, token_version, email`,
      [orgA.id, `pub-staff-${RUN_ID}@example.com`],
    )
    const staff = { ...rows[0], organization_id: orgA.id, name: 'Staff' }
    const rev = await revisionOf(adminA)
    for (const action of ['publish', 'unpublish', 'revert']) {
      const staffRes = await request(server)
        .post(`/api/organization/site/${action}`)
        .set(bearer(staff, 'staff'))
        .send({ confirm: true, expected_revision: rev })
      expect(staffRes.status).toBe(403)
    }
    const anon = await request(server)
      .post('/api/organization/site/unpublish')
      .send({ confirm: true, expected_revision: rev })
    expect([401, 403]).toContain(anon.status)
  })

  // Atlas P1 / Argus N465-3 — freeze look_id into the published snapshot.
  it('freezes look_id at publish; look-only PUT changes draft only; revert restores look', async () => {
    const { rows: orgRows } = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, TRUE) RETURNING id, slug`,
      [`Look Freeze ${RUN_ID}`, `look-fz-${RUN_ID}`.toLowerCase()],
    )
    const org = orgRows[0]
    const { rows: userRows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Look Admin', 'admin') RETURNING id, token_version, email`,
      [org.id, `look-admin-${RUN_ID}@example.com`],
    )
    const admin = { ...userRows[0], organization_id: org.id, name: 'Look Admin' }
    try {
      const saved = await request(server)
        .put('/api/organization/site')
        .set(bearer(admin))
        .send({
          draft: draft('Look freeze A'),
          look_id: 'clinical-light',
          expected_revision: 0,
        })
      expect(saved.status).toBe(200)
      expect(saved.body.site.look_id).toBe('clinical-light')

      const published = await request(server)
        .post('/api/organization/site/publish')
        .set(bearer(admin))
        .send({ confirm: true, expected_revision: saved.body.site.revision })
      expect(published.status).toBe(200)
      expect(published.body.site.published.look_id).toBe('clinical-light')

      const { rows: snap } = await pool.query(
        `SELECT published_doc->>'look_id' AS look, look_id AS live_look
           FROM ochr_site_documents WHERE organization_id = $1`,
        [org.id],
      )
      expect(snap[0].look).toBe('clinical-light')
      expect(snap[0].live_look).toBe('clinical-light')

      const lookOnly = await request(server)
        .put('/api/organization/site')
        .set(bearer(admin))
        .send({ look_id: 'midnight', expected_revision: published.body.site.revision })
      expect(lookOnly.status).toBe(200)
      expect(lookOnly.body.site.look_id).toBe('midnight')
      // Draft look moved; published projection and public page stay frozen.
      expect(lookOnly.body.site.published.look_id).toBe('clinical-light')

      const publicAfterLook = await request(server).get(`/api/public/${org.slug}/page`)
      expect(publicAfterLook.status).toBe(200)
      expect(publicAfterLook.body.site.look_id).toBe('clinical-light')
      expect(publicAfterLook.body.site.doc.pages[0].blocks[0].headline.en).toBe('Look freeze A')

      const republish = await request(server)
        .post('/api/organization/site/publish')
        .set(bearer(admin))
        .send({ confirm: true, expected_revision: lookOnly.body.site.revision })
      expect(republish.status).toBe(200)
      expect(republish.body.site.published.look_id).toBe('midnight')
      const publicB = await request(server).get(`/api/public/${org.slug}/page`)
      expect(publicB.body.site.look_id).toBe('midnight')

      const reverted = await request(server)
        .post('/api/organization/site/revert')
        .set(bearer(admin))
        .send({ confirm: true, expected_revision: republish.body.site.revision })
      expect(reverted.status).toBe(200)
      expect(reverted.body.site.published.look_id).toBe('clinical-light')
      // Draft look_id column is not rewritten by revert (pages stay draft-ahead).
      expect(reverted.body.site.look_id).toBe('midnight')
      const publicReverted = await request(server).get(`/api/public/${org.slug}/page`)
      expect(publicReverted.body.site.look_id).toBe('clinical-light')

      const { rows: hist } = await pool.query(
        `SELECT action, doc->>'look_id' AS look
           FROM ochr_site_publish_history
          WHERE organization_id = $1
          ORDER BY seq`,
        [org.id],
      )
      expect(hist.map((h) => h.action)).toEqual(['publish', 'publish', 'revert'])
      expect(hist[0].look).toBe('clinical-light')
      expect(hist[1].look).toBe('midnight')
      expect(hist[2].look).toBe('clinical-light')
    } finally {
      await pool.query('DELETE FROM ochr_site_publish_history WHERE organization_id = $1', [org.id]).catch(() => {})
      await pool.query('DELETE FROM ochr_site_documents WHERE organization_id = $1', [org.id]).catch(() => {})
      await pool.query('DELETE FROM ochr_users WHERE organization_id = $1', [org.id]).catch(() => {})
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.id]).catch(() => {})
    }
  })

  // Atlas ruling (c) — publish does not auto-flip page_published (AND gate).
  // SP-307 — unpublish ("Take the page down") DOES clear page_published so
  // /page returns 404, not 200 with site:null.
  it('publish leaves page_published alone; unpublish clears it (SP-307)', async () => {
    const { rows: offRows } = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, FALSE) RETURNING id, slug`,
      [`And Gate Off ${RUN_ID}`, `and-off-${RUN_ID}`.toLowerCase()],
    )
    const orgOff = offRows[0]
    const { rows: onRows } = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, TRUE) RETURNING id, slug`,
      [`And Gate On ${RUN_ID}`, `and-on-${RUN_ID}`.toLowerCase()],
    )
    const orgOn = onRows[0]
    const mkAdmin = async (org, tag) => {
      const { rows } = await pool.query(
        `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
         VALUES ($1, $2, 'x', $3, 'admin') RETURNING id, token_version, email`,
        [org.id, `and-${tag}-${RUN_ID}@example.com`, `And ${tag}`],
      )
      return { ...rows[0], organization_id: org.id, name: `And ${tag}` }
    }
    const adminOff = await mkAdmin(orgOff, 'off')
    const adminOn = await mkAdmin(orgOn, 'on')
    try {
      const saveOff = await request(server)
        .put('/api/organization/site')
        .set(bearer(adminOff))
        .send({ draft: draft('Address off'), look_id: 'warm-editorial', expected_revision: 0 })
      expect(saveOff.status).toBe(200)
      const pubOff = await request(server)
        .post('/api/organization/site/publish')
        .set(bearer(adminOff))
        .send({ confirm: true, expected_revision: saveOff.body.site.revision })
      expect(pubOff.status).toBe(200)
      expect(pubOff.body.site.has_published).toBe(true)
      expect(pubOff.body.site.page_published).toBe(false)
      const { rows: flagOff } = await pool.query(
        `SELECT page_published FROM ochr_organizations WHERE id = $1`,
        [orgOff.id],
      )
      expect(flagOff[0].page_published).toBe(false)
      // Both gates required: address off → public page 404 even with published_doc.
      const hidden = await request(server).get(`/api/public/${orgOff.slug}/page`)
      expect(hidden.status).toBe(404)

      const saveOn = await request(server)
        .put('/api/organization/site')
        .set(bearer(adminOn))
        .send({ draft: draft('Address on'), look_id: 'warm-editorial', expected_revision: 0 })
      expect(saveOn.status).toBe(200)
      const pubOn = await request(server)
        .post('/api/organization/site/publish')
        .set(bearer(adminOn))
        .send({ confirm: true, expected_revision: saveOn.body.site.revision })
      expect(pubOn.status).toBe(200)
      const live = await request(server).get(`/api/public/${orgOn.slug}/page`)
      expect(live.status).toBe(200)
      expect(live.body.site.doc.pages[0].blocks[0].headline.en).toBe('Address on')

      const down = await request(server)
        .post('/api/organization/site/unpublish')
        .set(bearer(adminOn))
        .send({ confirm: true, expected_revision: pubOn.body.site.revision })
      expect(down.status).toBe(200)
      expect(down.body.site.has_published).toBe(false)
      expect(down.body.site.page_published).toBe(false)
      const { rows: flagOn } = await pool.query(
        `SELECT page_published FROM ochr_organizations WHERE id = $1`,
        [orgOn.id],
      )
      expect(flagOn[0].page_published).toBe(false)
      const after = await request(server).get(`/api/public/${orgOn.slug}/page`)
      expect(after.status).toBe(404)
    } finally {
      for (const id of [orgOff.id, orgOn.id]) {
        await pool.query('DELETE FROM ochr_site_publish_history WHERE organization_id = $1', [id]).catch(() => {})
        await pool.query('DELETE FROM ochr_site_documents WHERE organization_id = $1', [id]).catch(() => {})
        await pool.query('DELETE FROM ochr_users WHERE organization_id = $1', [id]).catch(() => {})
        await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
      }
    }
  })

  // N465-1 — public /page must not sit in shared caches after unpublish.
  it('public /page sets Cache-Control: no-store (N465-1)', async () => {
    const put = await request(server)
      .put('/api/organization/site')
      .set(bearer(adminA))
      .send({ expected_revision: (await request(server).get('/api/organization/site').set(bearer(adminA))).body.site.revision, doc: draft('Cache check') })
    expect(put.status).toBe(200)
    const pub = await request(server)
      .post('/api/organization/site/publish')
      .set(bearer(adminA))
      .send({ confirm: true, expected_revision: put.body.site.revision })
    expect(pub.status).toBe(200)
    const live = await request(server).get(`/api/public/${slugA}/page`)
    expect(live.status).toBe(200)
    expect(live.headers['cache-control']).toMatch(/no-store/i)
    expect(live.headers['cache-control']).not.toMatch(/max-age=300/)
  })

  // N465-2 — unpublish must clear even when today's normalize refuses the live doc.
  it('unpublish clears an invalid published_doc (N465-2)', async () => {
    const before = await request(server).get('/api/organization/site').set(bearer(adminA))
    const put = await request(server)
      .put('/api/organization/site')
      .set(bearer(adminA))
      .send({ expected_revision: before.body.site.revision, doc: draft('Valid then corrupt') })
    expect(put.status).toBe(200)
    const pub = await request(server)
      .post('/api/organization/site/publish')
      .set(bearer(adminA))
      .send({ confirm: true, expected_revision: put.body.site.revision })
    expect(pub.status).toBe(200)
    // Corrupt the live snapshot past today's allowlist (unknown block type).
    await pool.query(
      `UPDATE ochr_site_documents
          SET published_doc = jsonb_set(
            published_doc,
            '{pages,0,blocks}',
            '[{"type":"not_a_real_block_xyz","headline":{"en":"x","es":"x"}}]'::jsonb
          )
        WHERE organization_id = $1`,
      [orgA.id],
    )
    const liveBefore = await request(server).get(`/api/public/${slugA}/page`)
    // Public projection already nulls invalid docs.
    expect(liveBefore.body.site).toBeNull()

    const down = await request(server)
      .post('/api/organization/site/unpublish')
      .set(bearer(adminA))
      .send({ confirm: true, expected_revision: pub.body.site.revision })
    expect(down.status).toBe(200)
    expect(down.body.code).toBeUndefined()
    expect(down.body.site.has_published).toBe(false)
    expect(down.body.site.page_published).toBe(false)
    const { rows } = await pool.query(
      `SELECT published_doc IS NULL AS cleared FROM ochr_site_documents WHERE organization_id = $1`,
      [orgA.id],
    )
    expect(rows[0].cleared).toBe(true)
    const gone = await request(server).get(`/api/public/${slugA}/page`)
    expect(gone.status).toBe(404)
    const { rows: hist } = await pool.query(
      `SELECT action, doc->>'look_id' AS look
         FROM ochr_site_publish_history
        WHERE organization_id = $1
        ORDER BY seq DESC LIMIT 1`,
      [orgA.id],
    )
    expect(hist[0].action).toBe('unpublish')
    expect(hist[0].look).toBeTruthy()
  })
})
