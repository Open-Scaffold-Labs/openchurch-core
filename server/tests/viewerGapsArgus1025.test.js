// Argus viewer gaps (2026-10-25, ARGUS-VIEWER-GAPS.md): tests only.
// A parish Viewer gets 403 and no record data on sacrament detail and
// sub-routes, five donation sub-routes, payroll and giving statements.
// Path tricks against the /api/clients/:id/donations deny rule must not
// return gift data. Viewer member writes are refused and leave the row
// unchanged. A Viewer from another parish cannot read this parish's
// records either. Synthetic org and fixtures only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { signToken } from '../src/middleware/auth.js'

const MINISTER = `Fr Synthetic ${RUN_ID}`
const DONOR = `VG Member ${RUN_ID}`
const SECRET = new RegExp(`${RUN_ID}|amount|donor|minister|pay_rate|"total"`, 'i')

let server, orgA, orgB, memberId, sacramentId
const tok = {}

async function addUser(orgId, role, tag) {
  const email = `vg_${tag}_${role}_${RUN_ID}@example.com`
  const { rows } = await pool.query(
    `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
     VALUES ($1, $2, 'x', $3, $4) RETURNING id, token_version`, [orgId, email, `VG ${role}`, role])
  return signToken({ userId: rows[0].id, organizationId: orgId, email, name: `VG ${role}`, role, tv: rows[0].token_version ?? 1 })
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `VG A ${RUN_ID}`, name: 'Admin A', email: `vg_a_${RUN_ID}@example.com`, password: 'vg-test-pw-a',
  }, '10.215.1.1')
  expect(a.status).toBe(201)
  orgA = a.body.user.organization.id; tok.admin = a.body.token
  const b = await createOrg(server, {
    organizationName: `VG B ${RUN_ID}`, name: 'Admin B', email: `vg_b_${RUN_ID}@example.com`, password: 'vg-test-pw-b',
  }, '10.215.1.2')
  expect(b.status).toBe(201)
  orgB = b.body.user.organization.id; tok.adminB = b.body.token
  tok.viewer = await addUser(orgA, 'viewer', 'a')
  tok.viewerB = await addUser(orgB, 'viewer', 'b')

  const m = await request(server).post('/api/clients').set('Authorization', `Bearer ${tok.admin}`).send({ name: DONOR })
  expect(m.status).toBe(201); memberId = m.body.id
  const s = await request(server).post('/api/sacraments').set('Authorization', `Bearer ${tok.admin}`)
    .send({ client_id: memberId, type: 'baptism', date: '2001-05-20', minister: MINISTER })
  expect(s.status).toBe(201); sacramentId = s.body.id
  await pool.query(
    `INSERT INTO ochr_donations (organization_id, donor_name, amount, date) VALUES ($1, $2, 77, '2026-10-01')`,
    [orgA, DONOR])
}, 60_000)

afterAll(async () => {
  for (const id of [orgA, orgB]) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server); await pool.end()
})

const as = (who) => ({ Authorization: `Bearer ${tok[who]}` })
const D = '?start=2026-01-01&end=2026-12-31'

const closed = () => [
  `/api/sacraments/${sacramentId}`,
  '/api/sacraments/anniversaries',
  '/api/sacraments/drafts',
  `/api/sacraments/${sacramentId}/amendments`,
  '/api/donations/chart',
  '/api/donations/by-fund',
  '/api/donations/recurring',
  '/api/donations/cash-counts',
  '/api/donations/cash-counts/void-requests',
  `/api/payroll/staff${D}`,
  `/api/payroll/summary${D}`,
  '/api/giving-statements/preview?year=2026',
  `/api/giving-statements/donor?year=2026&client_id=${memberId}`,
  '/api/giving-statements/issued',
  '/api/giving-statements/issued/1',
]

describe('Argus gaps: Viewer GETs are 403 with no data', () => {
  it('fixtures are readable by the admin (so the 403s are not empty-route artefacts)', async () => {
    const r = await request(server).get(`/api/sacraments/${sacramentId}`).set(as('admin'))
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.body)).toContain(MINISTER)
  })
  it('every closed path refuses the Viewer', async () => {
    for (const path of closed()) {
      const r = await request(server).get(path).set(as('viewer'))
      expect(r.status, path).toBe(403)
      expect(JSON.stringify(r.body), path).not.toMatch(SECRET)
    }
  })
  it('the same paths refuse a Viewer from another parish', async () => {
    for (const path of closed()) {
      const r = await request(server).get(path).set(as('viewerB'))
      expect(r.status, path).toBe(403)
      expect(JSON.stringify(r.body), path).not.toMatch(SECRET)
    }
  })
  it('another parish admin cannot read this parish sacrament or its amendments', async () => {
    const amend = await request(server).patch(`/api/sacraments/${sacramentId}`).set(as('admin'))
      .send({ notes: `amended ${RUN_ID}`, reason: 'synthetic correction' })
    expect(amend.status).toBeLessThan(300)
    const own = await request(server).get(`/api/sacraments/${sacramentId}/amendments`).set(as('admin'))
    expect(own.status).toBe(200)
    expect(own.body.amendments.length).toBeGreaterThan(0)
    const r = await request(server).get(`/api/sacraments/${sacramentId}`).set(as('adminB'))
    expect([403, 404]).toContain(r.status)
    expect(JSON.stringify(r.body)).not.toContain(MINISTER)
    // Amendments are org-scoped in SQL: a foreign id yields an empty list, not a 404.
    const a = await request(server).get(`/api/sacraments/${sacramentId}/amendments`).set(as('adminB'))
    expect(a.status).toBe(200)
    expect(a.body.amendments).toEqual([])
    expect(JSON.stringify(a.body)).not.toMatch(SECRET)
  })
})

describe('Argus gaps: Viewer sacrament writes are refused', () => {
  it('PATCH, DELETE, void, restore and drafts are 403 and the record is unchanged', async () => {
    const calls = [
      ['patch', `/api/sacraments/${sacramentId}`, { minister: 'changed' }],
      ['delete', `/api/sacraments/${sacramentId}`],
      ['post', `/api/sacraments/${sacramentId}/void`, { reason: 'x' }],
      ['post', `/api/sacraments/${sacramentId}/restore`, {}],
      ['post', '/api/sacraments/drafts', { client_id: memberId, type: 'baptism' }],
    ]
    for (const [m, path, body] of calls) {
      const r = await request(server)[m](path).set(as('viewer')).send(body || {})
      expect(r.status, `${m} ${path}`).toBe(403)
    }
    const after = await request(server).get(`/api/sacraments/${sacramentId}`).set(as('admin'))
    expect(after.body.minister).toBe(MINISTER)
  })
})

describe('Argus gaps: path tricks on the member-giving deny rule', () => {
  const tricks = () => [
    `/api/clients//${memberId}/donations`,
    `/api/clients/${memberId}/%64onations`,
    `/api/clients/${memberId};x/donations`,
    `/api/clients/${memberId}/donations;x`,
    `/api/clients/${memberId}/DONATIONS`,
    `/api/clients/${memberId}/donations/`,
  ]
  it('the fixture gift is visible to the admin on the real route', async () => {
    const r = await request(server).get(`/api/clients/${memberId}/donations`).set(as('admin'))
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.body)).toContain('77')
  })
  it('none returns 200 with gift data to a Viewer', async () => {
    for (const path of tricks()) {
      const r = await request(server).get(path).set(as('viewer'))
      const body = JSON.stringify(r.body)
      expect(body, path).not.toContain(DONOR)
      expect(body, path).not.toMatch(/"amount"/)
      expect(r.status, path).not.toBe(200)
    }
  })
})

describe('Argus gaps: Viewer member writes', () => {
  it('PATCH, DELETE and import are 403 and the member is unchanged', async () => {
    const before = await pool.query('SELECT name, deleted_at IS NULL AS live FROM ochr_clients WHERE id = $1', [memberId]).catch(() =>
      pool.query('SELECT name FROM ochr_clients WHERE id = $1', [memberId]))
    expect((await request(server).patch(`/api/clients/${memberId}`).set(as('viewer')).send({ name: 'Hacked' })).status).toBe(403)
    expect((await request(server).delete(`/api/clients/${memberId}`).set(as('viewer'))).status).toBe(403)
    expect((await request(server).post('/api/clients/import').set(as('viewer')).send({ rows: [{ name: 'x' }] })).status).toBe(403)
    const { rows } = await pool.query('SELECT * FROM ochr_clients WHERE id = $1', [memberId])
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe(before.rows[0].name)
  })
})
