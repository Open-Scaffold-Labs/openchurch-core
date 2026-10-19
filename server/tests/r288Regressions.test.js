// R288-1 / R288-2 regressions (TARS review of #288).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { signToken } from '../src/middleware/auth.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const MARK = `R288MARK_${RUN_ID}`
let server, orgId, clientId
const tokens = {}
beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const res = await createOrg(server, {
    organizationName: `R288 ${RUN_ID}`, name: 'Admin', email: `r288_admin_${RUN_ID}@example.com`, password: 'r288-test-pw',
  }, '10.215.1.1')
  expect(res.status).toBe(201)
  orgId = res.body.user.organization.id
  tokens.admin = res.body.token
  for (const role of ['staff', 'viewer']) {
    const email = `r288_${role}_${RUN_ID}@example.com`
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', $3, $4) RETURNING id, token_version`, [orgId, email, `R288 ${role}`, role])
    tokens[role] = signToken({ userId: rows[0].id, organizationId: orgId, email, name: `R288 ${role}`, role, tv: rows[0].token_version ?? 1 })
  }
  const receipt = { imported: 4271, skipped: 3, held_for_follow_up: 5, duplicates_left_for_review: 2, ignored_columns: [`${MARK}_col`], retention_days: 30 }
  await pool.query(
    `INSERT INTO ochr_import_batches
       (organization_id, kind, source_name, status, row_count, headers, mapping, receipt, committed_at, created_by)
     VALUES ($1, 'members', $2, 'committed', 4281, $4, $5, $3, NOW(), NULL)`,
    [orgId, `${MARK}-members.csv`, JSON.stringify(receipt), JSON.stringify(['name']), JSON.stringify({ name: 'name' })])
  await pool.query(`INSERT INTO ochr_funds (organization_id, name, active) VALUES ($1, $2, TRUE)`, [orgId, `${MARK} Fund`])
  const c = await pool.query(`INSERT INTO ochr_clients (organization_id, name) VALUES ($1, 'R288 Member') RETURNING id`, [orgId])
  clientId = c.rows[0].id
}, 60_000)
afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})
const as = (role, m, path) => request(server)[m](path).set('Authorization', `Bearer ${tokens[role]}`)

describe('R288-1: Viewer-safe /api/setup projection', () => {
  it('Viewer JSON carries no import, receipt, fund or restricted link (deep scan)', async () => {
    const v = await as('viewer', 'get', '/api/setup')
    expect(v.status).toBe(200)
    const s = JSON.stringify(v.body)
    for (const bad of [MARK, '4271', '4281', 'setup.inPlace.import', 'setup.inPlace.funds', '/migration', '/finance', '/giving', 'by_role'])
      expect(s, bad).not.toContain(bad)
    expect(v.body.import_context ?? null).toBeNull()
    const keys = v.body.in_place.map(e => e.key)
    expect(keys).toContain('setup.inPlace.workspace')
    for (const e of v.body.in_place) if (e.key === 'setup.inPlace.people') expect(Object.keys(e.detail ?? {})).toEqual(['count'])
  })
  it('Admin still sees everything (positive control)', async () => {
    const a = await as('admin', 'get', '/api/setup')
    const s = JSON.stringify(a.body)
    expect(s).toContain(`${MARK}-members.csv`)
    const keys = a.body.in_place.map(e => e.key)
    expect(keys).toContain('setup.inPlace.import')
    expect(keys).toContain('setup.inPlace.funds')
    expect(a.body.import_context.imported).toBe(4271)
  })
})

describe('R288-2: member attendance closed to Viewers', () => {
  it('GET and HEAD /api/clients/:id/checkins are 403 for a Viewer', async () => {
    const g = await as('viewer', 'get', `/api/clients/${clientId}/checkins`)
    expect(g.status).toBe(403)
    expect(g.body.code ?? g.body.error).toBeTruthy()
    expect((await as('viewer', 'head', `/api/clients/${clientId}/checkins`)).status).toBe(403)
    expect((await as('viewer', 'get', `/api/clients/${clientId}`)).status).toBe(200)
  })
  it('Staff and Admin still read it', async () => {
    for (const r of ['staff', 'admin']) {
      expect((await as(r, 'get', `/api/clients/${clientId}/checkins`)).status).toBe(200)
      expect((await as(r, 'head', `/api/clients/${clientId}/checkins`)).status).toBe(200)
    }
  })
})
