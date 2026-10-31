// OC-WEB-1 PR-D — N460-2 optimistic concurrency.
//
// A holder keeps the site row locked. The HTTP writer blocks on that lock.
// The holder then commits a newer revision. The blocked writer must lose:
// 409, and the winner's draft stays. A writer that ignores the revision
// overwrites the winner after the lock clears, and this test goes red.

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

const CONFLICT = /someone else edited this page/i

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

function draftWith(headline) {
  return {
    version: 1,
    pages: [{
      id: 'home',
      title: { en: 'Home', es: 'Inicio' },
      blocks: [{ type: 'hero_split', headline: { en: headline, es: headline } }],
    }],
    nav: [],
  }
}

async function waitForSiteDocumentLock() {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const { rows } = await pool.query(`
      SELECT pid
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND state = 'active'
         AND query ILIKE '%ochr_site_documents%'
    `)
    if (rows.length > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return false
}

describe('site draft optimistic concurrency (controlled row lock)', () => {
  let org, admin

  beforeAll(async () => {
    const created = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, TRUE)
       RETURNING id, slug`,
      [`Publish race ${RUN_ID}`, `pub-race-${RUN_ID}`.toLowerCase()],
    )
    org = created.rows[0]
    const user = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Admin Race', 'admin')
       RETURNING id, token_version, email`,
      [org.id, `admin-race-${RUN_ID}@example.com`],
    )
    admin = { ...user.rows[0], organization_id: org.id, name: 'Admin Race' }
  })

  afterAll(async () => {
    if (!org?.id) return
    await pool.query('DELETE FROM ochr_site_publish_history WHERE organization_id = $1', [org.id]).catch(() => {})
    await pool.query('DELETE FROM ochr_site_documents WHERE organization_id = $1', [org.id]).catch(() => {})
    await pool.query('DELETE FROM ochr_users WHERE organization_id = $1', [org.id]).catch(() => {})
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.id]).catch(() => {})
  })

  async function seedAtRevision(headline, revision = 3) {
    await pool.query('DELETE FROM ochr_site_documents WHERE organization_id = $1', [org.id])
    await pool.query(
      `INSERT INTO ochr_site_documents (organization_id, draft_doc, look_id, revision)
       VALUES ($1, $2::jsonb, 'warm-editorial', $3)`,
      [org.id, JSON.stringify(draftWith(headline)), revision],
    )
  }

  it('a stale draft PUT blocked on the row lock loses to the committed revision', async () => {
    const winner = draftWith(`Winner ${RUN_ID}`)
    const stale = draftWith(`Stale ${RUN_ID}`)
    await seedAtRevision(`Seed ${RUN_ID}`, 3)

    const holder = await pool.connect()
    let response
    try {
      await holder.query('BEGIN')
      const locked = await holder.query(
        `SELECT revision FROM ochr_site_documents WHERE organization_id = $1 FOR UPDATE`,
        [org.id],
      )
      expect(locked.rows[0].revision).toBe(3)

      // superagent does not send until end/then. Start it now so it blocks
      // on the row lock before the holder commits.
      const pending = new Promise((resolve, reject) => {
        request(server)
          .put('/api/organization/site')
          .set('Authorization', `Bearer ${auth(admin)}`)
          .send({ draft: stale, look_id: 'warm-editorial', expected_revision: 3 })
          .end((err, res) => (err ? reject(err) : resolve(res)))
      })

      const sawLock = await waitForSiteDocumentLock()
      expect(sawLock).toBe(true)

      await holder.query(
        `UPDATE ochr_site_documents
            SET draft_doc = $2::jsonb,
                revision = revision + 1,
                updated_at = NOW()
          WHERE organization_id = $1`,
        [org.id, JSON.stringify(winner)],
      )
      await holder.query('COMMIT')
      response = await pending
    } catch (err) {
      await holder.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      holder.release()
    }

    expect(response.status).toBe(409)
    expect(response.body.code).toBe('site_revision_conflict')
    expect(String(response.body.error || '')).toMatch(CONFLICT)
    expect(String(response.body.error || '')).toMatch(/reload/i)

    const { rows } = await pool.query(
      `SELECT draft_doc, revision FROM ochr_site_documents WHERE organization_id = $1`,
      [org.id],
    )
    expect(rows[0].revision).toBe(4)
    expect(rows[0].draft_doc.pages[0].blocks[0].headline.en).toBe(`Winner ${RUN_ID}`)
    expect(JSON.stringify(rows[0].draft_doc)).not.toContain(`Stale ${RUN_ID}`)
  })

  it('a stale publish blocked on the row lock does not copy the old draft', async () => {
    const winner = draftWith(`Publish winner ${RUN_ID}`)
    await seedAtRevision(`Publish seed ${RUN_ID}`, 3)

    const holder = await pool.connect()
    let response
    try {
      await holder.query('BEGIN')
      await holder.query(
        `SELECT revision FROM ochr_site_documents WHERE organization_id = $1 FOR UPDATE`,
        [org.id],
      )

      const pending = new Promise((resolve, reject) => {
        request(server)
          .post('/api/organization/site/publish')
          .set('Authorization', `Bearer ${auth(admin)}`)
          .send({ confirm: true, expected_revision: 3 })
          .end((err, res) => (err ? reject(err) : resolve(res)))
      })

      const sawLock = await waitForSiteDocumentLock()
      expect(sawLock).toBe(true)

      await holder.query(
        `UPDATE ochr_site_documents
            SET draft_doc = $2::jsonb,
                revision = revision + 1,
                updated_at = NOW()
          WHERE organization_id = $1`,
        [org.id, JSON.stringify(winner)],
      )
      await holder.query('COMMIT')
      response = await pending
    } catch (err) {
      await holder.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      holder.release()
    }

    expect(response.status).toBe(409)
    expect(response.body.code).toBe('site_revision_conflict')
    expect(String(response.body.error || '')).toMatch(CONFLICT)
    expect(String(response.body.error || '')).toMatch(/reload/i)

    const { rows } = await pool.query(
      `SELECT draft_doc, published_doc, revision
         FROM ochr_site_documents WHERE organization_id = $1`,
      [org.id],
    )
    expect(rows[0].revision).toBe(4)
    expect(rows[0].published_doc).toBeNull()
    expect(rows[0].draft_doc.pages[0].blocks[0].headline.en).toBe(`Publish winner ${RUN_ID}`)
  })
})
