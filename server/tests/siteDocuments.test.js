// OC-WEB-1 PR-C — site document model, allowlist, tenancy, public projection.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import request from 'supertest'
import pool from '../src/db.js'
import { migrateOnce, bindServer, closeServer, RUN_ID } from './support/harness.js'
import { signToken } from '../src/middleware/auth.js'
import {
  normalizeSiteDocument,
  normalizeBilingual,
  projectPublishedSite,
  libraryCatalog,
  OC_V1_BLOCK_TYPES,
  DEFAULT_LOOK_ID,
} from '../src/website/index.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const websiteLib = require('../src/lib/openscaffold-website/index.js')

beforeAll(async () => { await migrateOnce() }, 180_000)

let server
beforeAll(async () => { server = await bindServer() })
afterAll(async () => { await closeServer(server); await pool.end() })

describe('vendored @openscaffold/website libraries', () => {
  it('exposes blocks, connectors, looks, SEO — not schema mount helpers', () => {
    expect(websiteLib.UPSTREAM.name).toBe('@openscaffold/website')
    expect(websiteLib.UPSTREAM.surface).toBe('v2-libraries-only')
    expect(typeof websiteLib.listSectionBlocks).toBe('function')
    expect(typeof websiteLib.listLiveConnectors).toBe('function')
    expect(typeof websiteLib.listOfficialLooks).toBe('function')
    expect(typeof websiteLib.renderSectionBlock).toBe('function')
    expect(websiteLib.createWebsiteSchema).toBeUndefined()
    expect(websiteLib.createWebsiteRoutes).toBeUndefined()
    expect(websiteLib.createPublicSiteRouter).toBeUndefined()
    expect(websiteLib.vercelDomainManager || websiteLib.provisionCustomDomain).toBeFalsy()
  })

  it('OC v1 catalog is the Dale parish-safe subset plus OC-native Mass/events', () => {
    const cat = libraryCatalog()
    expect(cat.oc_v1.map((b) => b.id)).toEqual([...OC_V1_BLOCK_TYPES])
    expect(cat.rejected_v1).toContain('virtual_tour_360')
    expect(cat.rejected_v1).toContain('event_ticketing_calendar')
    expect(cat.rejected_v1).toContain('lead_capture_crm')
    expect(cat.looks.every((l) => typeof l.id === 'string')).toBe(true)
  })
})

describe('normalizeSiteDocument (unit)', () => {
  it('accepts bilingual parish-core blocks and forces giving to display/link only', () => {
    const result = normalizeSiteDocument({
      pages: [{
        id: 'home',
        title: { en: 'Home', es: 'Inicio' },
        blocks: [
          {
            type: 'hero_split',
            headline: { en: 'Welcome', es: 'Bienvenidos' },
            subheadline: { en: 'A parish home', es: 'Una casa parroquial' },
          },
          {
            type: 'mass_confession_times',
            mass_times: { en: 'Sun 10am', es: 'Dom 10am' },
            confession_times: { en: 'Sat 4pm', es: 'Sáb 4pm' },
          },
          {
            type: 'donation_dues_portal',
            title: { en: 'Give', es: 'Donar' },
            portalUrl: 'https://evil.example/pay',
            description: 'Pay via ACH $0.20',
          },
          {
            type: 'faq_accordion',
            faqs: [{ question: { en: 'Where?', es: '¿Dónde?' }, answer: { en: 'Here', es: 'Aquí' } }],
          },
        ],
      }],
    }, { slug: 'st-brigid' })

    expect(result.ok).toBe(true)
    const blocks = result.doc.pages[0].blocks
    expect(blocks.map((b) => b.type)).toEqual([
      'hero_split', 'mass_confession_times', 'donation_dues_portal', 'faq_accordion',
    ])
    const giving = blocks[2]
    expect(giving.portalUrl).toBe('/p/st-brigid/give')
    expect(giving.money.wired).toBe(false)
    expect(giving.money.platform_markup).toBe(0)
    expect(giving.money.payments).toBe('on_hold')
    expect(giving.title).toEqual({ en: 'Give', es: 'Donar' })
    expect(blocks[0].headline).toEqual({ en: 'Welcome', es: 'Bienvenidos' })
  })

  it('rejects Dale blocks outside the v1 allowlist', () => {
    for (const type of ['virtual_tour_360', 'event_ticketing_calendar', 'lead_capture_crm', 'tee_sheet_widget']) {
      const result = normalizeSiteDocument({
        pages: [{ id: 'home', blocks: [{ type, title: 'x' }] }],
      })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not|allowlist|allowed/i)
    }
  })

  // Argus N460-5 — hostile schemes must not land in stored block links.
  it('rejects javascript:, data:, and protocol-relative // on block links', () => {
    const hostile = [
      'javascript:alert(1)',
      'data:text/html,hi',
      '//evil.example/phish',
    ]
    for (const url of hostile) {
      const result = normalizeSiteDocument({
        pages: [{
          id: 'home',
          blocks: [
            {
              type: 'hero_split',
              headline: { en: 'H', es: 'H' },
              ctaLink: url,
              secondaryCtaLink: url,
            },
            {
              type: 'public_documents_vault',
              documents: [{ title: { en: 'Bulletin', es: 'Boletín' }, url }],
            },
            {
              type: 'location_hours_map',
              address: { en: '1 St', es: '1 St' },
              mapUrl: url,
            },
          ],
        }],
      }, { slug: 'st-brigid' })
      expect(result.ok).toBe(true)
      const [hero, docs, loc] = result.doc.pages[0].blocks
      // Hero primary falls back to #connect; secondary drops; docs item filtered out; mapUrl null.
      expect(hero.ctaLink).toBe('#connect')
      expect(hero.ctaLink).not.toMatch(/javascript:|data:|^\/\//i)
      expect(hero.secondaryCtaLink).toBeNull()
      expect(docs.documents).toEqual([])
      expect(loc.mapUrl == null || loc.mapUrl === '').toBe(true)
      expect(JSON.stringify(result.doc)).not.toContain('javascript:')
      expect(JSON.stringify(result.doc)).not.toContain('data:text')
      expect(JSON.stringify(result.doc)).not.toContain('//evil.example')
    }
  })

  // Argus N460-4 — C0/DEL strip parity with branding N452-3.
  it('strips C0 control characters and DEL from bilingual fields', () => {
    const out = normalizeBilingual(
      { en: 'Valley\u0007 Parish\u007F', es: 'Parroquia\u0000 Valle\u001F' },
      { max: 120 },
    )
    expect(out.en).toBe('Valley Parish')
    expect(out.es).toBe('Parroquia Valle')
    const asString = normalizeBilingual('Hello\u0007World\u007F', { max: 120 })
    expect(asString.en).toBe('HelloWorld')
    expect(asString.es).toBe('HelloWorld')
  })
})

describe('migration 142 + admin/public tenancy', () => {
  let orgA, orgB, adminA, adminB, slugA, slugB

  beforeAll(async () => {
    const a = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published, tagline, about, service_times, address)
       VALUES ($1, $2, TRUE, 'Welcome A', 'About A', 'Sun 9am', '1 A St')
       RETURNING id, slug, name`,
      [`Site A ${RUN_ID}`, `site-a-${RUN_ID}`.toLowerCase()],
    )
    const b = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published, tagline)
       VALUES ($1, $2, TRUE, 'Welcome B')
       RETURNING id, slug, name`,
      [`Site B ${RUN_ID}`, `site-b-${RUN_ID}`.toLowerCase()],
    )
    orgA = a.rows[0]; slugA = orgA.slug
    orgB = b.rows[0]; slugB = orgB.slug

    const ua = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Admin A', 'admin') RETURNING id, token_version, email`,
      [orgA.id, `admin-a-${RUN_ID}@example.com`],
    )
    const ub = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Admin B', 'admin') RETURNING id, token_version, email`,
      [orgB.id, `admin-b-${RUN_ID}@example.com`],
    )
    adminA = { ...ua.rows[0], organization_id: orgA.id, name: 'Admin A' }
    adminB = { ...ub.rows[0], organization_id: orgB.id, name: 'Admin B' }
  })

  afterAll(async () => {
    for (const id of [orgA?.id, orgB?.id].filter(Boolean)) {
      await pool.query('DELETE FROM ochr_site_documents WHERE organization_id = $1', [id]).catch(() => {})
      await pool.query('DELETE FROM ochr_users WHERE organization_id = $1', [id]).catch(() => {})
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
    }
  })

  function auth(user) {
    return signToken({
      userId: user.id,
      organizationId: user.organization_id,
      email: user.email,
      name: user.name,
      role: 'admin',
      tv: user.token_version ?? 1,
    })
  }

  async function currentRevision(user) {
    const res = await request(server)
      .get('/api/organization/site')
      .set('Authorization', `Bearer ${auth(user)}`)
    expect(res.status).toBe(200)
    return res.body.site.revision
  }

  it('migration 142 table has composite uniqueness, RLS, and look_id CHECK', async () => {
    const { rows: cols } = await pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'ochr_site_documents'
       ORDER BY column_name`)
    const names = cols.map((r) => r.column_name)
    expect(names).toEqual(expect.arrayContaining([
      'organization_id', 'draft_doc', 'published_doc', 'published_at',
      'published_by_user_id', 'look_id', 'revision', 'custom_domain',
    ]))

    const { rows: rls } = await pool.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'ochr_site_documents'`)
    expect(rls[0]?.relrowsecurity).toBe(true)

    await expect(pool.query(
      `INSERT INTO ochr_site_documents (organization_id, look_id)
       VALUES ($1, 'neon-golf')`,
      [orgA.id],
    )).rejects.toMatchObject({ code: '23514' })

    await expect(pool.query(
      `INSERT INTO ochr_site_documents (organization_id, custom_domain)
       VALUES ($1, 'parish.example')`,
      [orgA.id],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('admin PUT saves draft for the session org only; public ignores draft', async () => {
    const draft = {
      pages: [{
        id: 'home',
        title: { en: 'Home', es: 'Inicio' },
        blocks: [
          { type: 'hero_split', headline: { en: 'Parish A', es: 'Parroquia A' } },
          { type: 'donation_dues_portal', title: { en: 'Give', es: 'Donar' } },
        ],
      }],
    }
    const putA = await request(server)
      .put('/api/organization/site')
      .set('Authorization', `Bearer ${auth(adminA)}`)
      .send({ draft, look_id: 'warm-editorial', expected_revision: await currentRevision(adminA) })
    expect(putA.status).toBe(200)
    expect(putA.body.site.draft.pages[0].blocks[0].headline.en).toBe('Parish A')
    expect(putA.body.site.draft.pages[0].blocks[1].portalUrl).toBe(`/p/${slugA}/give`)
    expect(putA.body.site.has_published).toBe(false)
    expect(putA.body.site.look_id).toBe(DEFAULT_LOOK_ID)

    const putBad = await request(server)
      .put('/api/organization/site')
      .set('Authorization', `Bearer ${auth(adminA)}`)
      .send({ draft: { pages: [{ id: 'home', blocks: [{ type: 'virtual_tour_360' }] }] } })
    expect(putBad.status).toBe(400)

    const putPublish = await request(server)
      .put('/api/organization/site')
      .set('Authorization', `Bearer ${auth(adminA)}`)
      .send({ draft, publish: true })
    expect(putPublish.status).toBe(400)

    // Public still legacy — draft must not leak.
    const pub = await request(server).get(`/api/public/${slugA}/page`)
    expect(pub.status).toBe(200)
    expect(pub.body.site).toBeNull()
    expect(pub.body.page.tagline).toBe('Welcome A')
    expect(pub.body.branding.accent_hex).toBeTruthy()

    // Org B cannot read Org A draft.
    const getB = await request(server)
      .get('/api/organization/site')
      .set('Authorization', `Bearer ${auth(adminB)}`)
    expect(getB.status).toBe(200)
    expect(getB.body.site.draft.pages).toEqual([])
  })

  it('public /page returns published_doc for the matching slug only', async () => {
    const published = {
      version: 1,
      pages: [{
        id: 'home',
        title: { en: 'Home', es: 'Inicio' },
        blocks: [
          { type: 'hero_split', headline: { en: 'Published A', es: 'Publicado A' } },
          {
            type: 'team_roster_grid',
            title: { en: 'Clergy', es: 'Clero' },
            members: [{ name: { en: 'Fr. Smith', es: 'P. Smith' }, role: { en: 'Pastor', es: 'Párroco' } }],
          },
          { type: 'location_hours_map', address: { en: '1 A St', es: '1 Calle A' } },
        ],
      }],
      nav: [],
      look_id: 'clinical-light',
    }

    // Live look_id intentionally differs from frozen published look — public must use frozen.
    await pool.query(
      `INSERT INTO ochr_site_documents
         (organization_id, draft_doc, published_doc, published_at, look_id, revision)
       VALUES ($1, $2::jsonb, $2::jsonb, NOW(), 'midnight', 1)
       ON CONFLICT (organization_id) DO UPDATE
         SET published_doc = EXCLUDED.published_doc,
             published_at = NOW(),
             look_id = 'midnight',
             revision = ochr_site_documents.revision + 1`,
      [orgA.id, JSON.stringify(published)],
    )

    // Org B published different content
    await pool.query(
      `INSERT INTO ochr_site_documents
         (organization_id, draft_doc, published_doc, published_at, look_id)
       VALUES ($1, '{"version":1,"pages":[],"nav":[]}'::jsonb, $2::jsonb, NOW(), 'midnight')
       ON CONFLICT (organization_id) DO UPDATE
         SET published_doc = EXCLUDED.published_doc,
             published_at = NOW(),
             look_id = 'midnight'`,
      [orgB.id, JSON.stringify({
        version: 1,
        pages: [{
          id: 'home',
          blocks: [{ type: 'hero_split', headline: { en: 'Published B', es: 'Publicado B' } }],
        }],
        nav: [],
        look_id: 'midnight',
      })],
    )

    const resA = await request(server).get(`/api/public/${slugA}/page`)
    expect(resA.status).toBe(200)
    expect(resA.body.site).toBeTruthy()
    expect(resA.body.site.look_id).toBe('clinical-light')
    expect(resA.body.site.visitor_controls).toEqual({
      look_switcher: false,
      high_contrast_toggle: true,
    })
    expect(resA.body.site.doc.pages[0].blocks[0].headline.en).toBe('Published A')
    expect(resA.body.site.doc.pages[0].blocks[0].headline.es).toBe('Publicado A')

    const resB = await request(server).get(`/api/public/${slugB}/page`)
    expect(resB.status).toBe(200)
    expect(resB.body.site.doc.pages[0].blocks[0].headline.en).toBe('Published B')
    expect(resB.body.site.look_id).toBe('midnight')
    // Tenant isolation: A never sees B's headline
    expect(JSON.stringify(resA.body)).not.toContain('Published B')
    expect(JSON.stringify(resB.body)).not.toContain('Published A')
  })

  it('projectPublishedSite returns null for empty docs (legacy 4-box)', () => {
    expect(projectPublishedSite({ publishedDoc: null })).toBeNull()
    expect(projectPublishedSite({ publishedDoc: { version: 1, pages: [], nav: [] } })).toBeNull()
    expect(projectPublishedSite({
      publishedDoc: { version: 1, pages: [{ id: 'home', blocks: [] }], nav: [] },
    })).toBeNull()
  })

  // Atlas P1 — look-only PUT must not wipe draft_doc (body.draft ?? body.doc ?? body).
  it('PUT {look_id} updates look only and leaves draft pages intact', async () => {
    const draft = {
      pages: [{
        id: 'home',
        title: { en: 'Home', es: 'Inicio' },
        blocks: [
          { type: 'hero_split', headline: { en: 'Keep me', es: 'Guárdame' } },
          { type: 'faq_accordion', faqs: [{ question: { en: 'Q?', es: '¿P?' }, answer: { en: 'A', es: 'R' } }] },
        ],
      }],
    }
    const seeded = await request(server)
      .put('/api/organization/site')
      .set('Authorization', `Bearer ${auth(adminA)}`)
      .send({ draft, look_id: 'warm-editorial', expected_revision: await currentRevision(adminA) })
    expect(seeded.status).toBe(200)
    expect(seeded.body.site.draft.pages[0].blocks).toHaveLength(2)
    expect(seeded.body.site.look_id).toBe('warm-editorial')

    const lookOnly = await request(server)
      .put('/api/organization/site')
      .set('Authorization', `Bearer ${auth(adminA)}`)
      .send({ look_id: 'midnight', expected_revision: seeded.body.site.revision })
    expect(lookOnly.status).toBe(200)
    expect(lookOnly.body.site.look_id).toBe('midnight')
    expect(lookOnly.body.site.draft.pages[0].blocks).toHaveLength(2)
    expect(lookOnly.body.site.draft.pages[0].blocks[0].headline.en).toBe('Keep me')
    expect(lookOnly.body.site.draft.pages[0].blocks[1].type).toBe('faq_accordion')
  })

  it('PUT without draft, doc, or look_id returns 400', async () => {
    const res = await request(server)
      .put('/api/organization/site')
      .set('Authorization', `Bearer ${auth(adminA)}`)
      .send({})
    expect(res.status).toBe(400)
    expect(String(res.body.error || '')).toMatch(/draft|doc|look/i)
  })

  // Atlas P2-b — mirror PR-B staff 403 on branding PATCH.
  it('staff cannot PUT /api/organization/site (admin RBAC)', async () => {
    const email = `site_staff_${RUN_ID}@example.com`
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', $3, 'staff') RETURNING id, token_version`,
      [orgA.id, email, `Staff ${RUN_ID}`],
    )
    const staffToken = signToken({
      userId: rows[0].id,
      organizationId: orgA.id,
      email,
      name: `Staff ${RUN_ID}`,
      role: 'staff',
      tv: rows[0].token_version ?? 1,
    })
    const anon = await request(server).put('/api/organization/site').send({ look_id: 'midnight' })
    expect([401, 403]).toContain(anon.status)
    const staff = await request(server)
      .put('/api/organization/site')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ look_id: 'midnight' })
    expect(staff.status).toBe(403)
  })
})
