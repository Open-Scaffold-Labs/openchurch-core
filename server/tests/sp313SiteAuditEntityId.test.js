// SP-313: site publish / unpublish / draft-save audit rows must carry
// entity_id = the organization id so /audit?entity_type=organization&entity_id=
// can scope them. Historical NULL rows are left alone (no backfill).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import 'dotenv/config'
import request from 'supertest'
import pool from '../src/db.js'
import { migrateOnce, bindServer, closeServer, RUN_ID } from './support/harness.js'
import { signToken } from '../src/middleware/auth.js'
import { _auditInternalsForTests } from '../src/middleware/auditLog.js'

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

describe('SP-313 resolveEntityId', () => {
  it('scopes { site } responses to the organization', () => {
    expect(_auditInternalsForTests.resolveEntityId(
      { organizationId: 42, params: {} },
      { site: { revision: 1 } },
    )).toBe('42')
  })

  it('still prefers a real resource id or :id param', () => {
    expect(_auditInternalsForTests.resolveEntityId(
      { organizationId: 42, params: {} },
      { id: 99 },
    )).toBe('99')
    expect(_auditInternalsForTests.resolveEntityId(
      { organizationId: 42, params: { id: '7' } },
      { site: {} },
    )).toBe('7')
  })
})

describe('SP-313 site mutations write organization entity_id', () => {
  let org, admin

  beforeAll(async () => {
    const o = await pool.query(
      `INSERT INTO ochr_organizations (name, slug, page_published)
       VALUES ($1, $2, FALSE) RETURNING id, slug`,
      [`SP313 ${RUN_ID}`, `sp313-${RUN_ID}`.toLowerCase()],
    )
    org = o.rows[0]
    const u = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'SP313 Admin', 'admin') RETURNING id, token_version, email`,
      [org.id, `sp313-admin-${RUN_ID}@example.com`],
    )
    admin = { ...u.rows[0], organization_id: org.id, name: 'SP313 Admin' }
  })

  afterAll(async () => {
    if (!org?.id) return
    await pool.query('DELETE FROM ochr_audit_log WHERE organization_id = $1', [org.id]).catch(() => {})
    await pool.query('DELETE FROM ochr_site_publish_history WHERE organization_id = $1', [org.id]).catch(() => {})
    await pool.query('DELETE FROM ochr_site_documents WHERE organization_id = $1', [org.id]).catch(() => {})
    await pool.query('DELETE FROM ochr_users WHERE organization_id = $1', [org.id]).catch(() => {})
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.id]).catch(() => {})
  })

  function bearer() {
    return { Authorization: `Bearer ${authFor(admin)}` }
  }

  async function revisionOf() {
    const res = await request(server).get('/api/organization/site').set(bearer())
    expect(res.status).toBe(200)
    return res.body.site.revision
  }

  async function waitForAudit(pathFrag, method) {
    for (let i = 0; i < 20; i++) {
      const { rows } = await pool.query(
        `SELECT entity_id, action, metadata, request_path, request_method
           FROM ochr_audit_log
          WHERE organization_id = $1 AND entity_type = 'organization'
            AND request_path LIKE $2 AND request_method = $3
          ORDER BY id DESC LIMIT 1`,
        [org.id, `%${pathFrag}`, method],
      )
      if (rows[0]) return rows[0]
      await new Promise(r => setTimeout(r, 50))
    }
    return null
  }

  it('draft-save PUT /site stores entity_id = org id', async () => {
    const saved = await request(server)
      .put('/api/organization/site')
      .set(bearer())
      .send({ draft: draft('SP313 draft'), expected_revision: await revisionOf() })
    expect(saved.status).toBe(200)

    const row = await waitForAudit('/site', 'PUT')
    expect(row).toBeTruthy()
    expect(row.entity_id).toBe(String(org.id))
  })

  it('publish stores entity_id = org id', async () => {
    const rev = await revisionOf()
    const published = await request(server)
      .post('/api/organization/site/publish')
      .set(bearer())
      .send({ confirm: true, expected_revision: rev })
    expect(published.status).toBe(200)

    const row = await waitForAudit('/site/publish', 'POST')
    expect(row).toBeTruthy()
    expect(row.entity_id).toBe(String(org.id))
    expect(row.metadata?.op).toBe('publish_site')
  })
})
