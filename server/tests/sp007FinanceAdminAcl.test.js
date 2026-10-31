// SP-007 / SP-030 / SP-037 — Staff must not read or write /api/finance/*.
// Argus packet: /workspace/argus/sp007-acl-2026-10-27.md
// FAIL: any Staff 200 on a finance money route, or a UI-only fix (mount must
// use requireRole('admin') for every method). Donations/funds stay Staff.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import 'dotenv/config'
import pool from '../src/db.js'
import { signToken } from '../src/middleware/auth.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

const appSrc = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')

// Every leaf under the finance router (methods that exist today).
const FINANCE_GETS = [
  '/api/finance/summary',
  '/api/finance/coa',
  '/api/finance/ledger',
  '/api/finance/mappings',
  '/api/finance/submissions',
  '/api/finance/diocese',
  '/api/finance/cutover/signoffs',
  '/api/finance/cutover/template',
]

const FINANCE_WRITES = [
  ['post', '/api/finance/ledger', { entry_date: '2026-10-01', account_code: '4000', amount: 1, memo: 'sp007' }],
  ['post', '/api/finance/ledger/import', { csv: 'account_code,amount\n4000,1\n5000,-1', as_of: '2026-10-01' }],
  ['put', '/api/finance/mappings', { mappings: [{ source_type: 'donation_category', source_key: 'plate', account_code: '4000' }] }],
  ['post', '/api/finance/submissions', { period_start: '2026-10-01', period_end: '2026-10-31' }],
  ['post', '/api/finance/parallel-check', { csv: 'account_code,amount\n4000,0', as_of: '2026-10-01' }],
  ['post', '/api/finance/cutover/scoreboard', { csv: 'account_code,amount\n4000,0', as_of: '2026-10-01' }],
  ['post', '/api/finance/cutover/export', { csv: 'account_code,amount\n4000,0', as_of: '2026-10-01' }],
  ['post', '/api/finance/cutover/signoffs', {
    csv: 'account_code,amount\n4000,0', as_of: '2026-10-01',
    accountant_name: 'SP007', signed_on: '2026-10-01',
  }],
]

let server, orgId, orgBId, dioceseOrgId, parishBOrgId
const tokens = {}
const cleanupOrgIds = []
const MARKER_B = `SP007_ORG_B_SECRET_${RUN_ID}`
const MARKER_LIVE = `SP007_PARISH_LIVE_LEDGER_${RUN_ID}`
const APPROVED_REVENUE = '42424.00'
let adminAUserId
let dioceseStaffToken, dioceseAdminToken

async function mintUser(org, role, tag) {
  const email = `sp007_${tag}_${role}_${RUN_ID}@example.com`
  const { rows } = await pool.query(
    `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
     VALUES ($1, $2, 'x', $3, $4) RETURNING id, token_version`,
    [org, email, `SP007 ${tag} ${role}`, role])
  return {
    id: rows[0].id,
    email,
    token: signToken({
      userId: rows[0].id, organizationId: org, email,
      name: `SP007 ${tag} ${role}`, role, tv: rows[0].token_version ?? 1,
    }),
  }
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  // Org A — primary parish under test (T1–T6 / T10)
  const o = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
     VALUES ($1, $2, 'parish', 'catholic') RETURNING id`,
    [`SP007 A ${RUN_ID}`, `sp007-a-${RUN_ID}`])
  orgId = o.rows[0].id
  cleanupOrgIds.push(orgId)
  for (const role of ['admin', 'staff', 'viewer']) {
    const u = await mintUser(orgId, role, 'a')
    tokens[role] = u.token
    if (role === 'admin') adminAUserId = u.id
  }

  // Org B — sibling parish with distinctive live ledger money (T7)
  const b = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
     VALUES ($1, $2, 'parish', 'catholic') RETURNING id`,
    [`SP007 B ${RUN_ID}`, `sp007-b-${RUN_ID}`])
  orgBId = b.rows[0].id
  cleanupOrgIds.push(orgBId)
  await mintUser(orgBId, 'admin', 'b')
  await pool.query(
    `INSERT INTO ochr_ledger_entries
       (organization_id, entry_date, account_code, amount, source_type, memo)
     VALUES ($1, '2026-06-15', '4110', 9999.00, 'manual', $2)`,
    [orgBId, MARKER_B])

  // Diocese + affiliated parish for chancery live-ledger boundary (T8)
  const d = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
     VALUES ($1, $2, 'diocese', 'catholic') RETURNING id`,
    [`SP007 Diocese ${RUN_ID}`, `sp007-dio-${RUN_ID}`])
  dioceseOrgId = d.rows[0].id
  cleanupOrgIds.push(dioceseOrgId)
  const dioAdmin = await mintUser(dioceseOrgId, 'admin', 'dio')
  const dioStaff = await mintUser(dioceseOrgId, 'staff', 'dio')
  dioceseAdminToken = dioAdmin.token
  dioceseStaffToken = dioStaff.token

  const pb = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
     VALUES ($1, $2, 'parish', 'catholic') RETURNING id`,
    [`SP007 Parish-under-Dio ${RUN_ID}`, `sp007-par-dio-${RUN_ID}`])
  parishBOrgId = pb.rows[0].id
  cleanupOrgIds.push(parishBOrgId)
  await mintUser(parishBOrgId, 'admin', 'pardio')

  await pool.query(
    `INSERT INTO ochr_diocese_affiliations
       (diocese_org_id, parish_org_id, status, grant_level, accepted_at)
     VALUES ($1, $2, 'active', 'detail', now())`,
    [dioceseOrgId, parishBOrgId])

  // Live ledger money the chancery must never see via /api/finance
  await pool.query(
    `INSERT INTO ochr_ledger_entries
       (organization_id, entry_date, account_code, amount, source_type, memo)
     VALUES ($1, '2026-07-01', '4110', 7777.00, 'manual', $2)`,
    [parishBOrgId, MARKER_LIVE])

  // Approved submission snapshot the chancery IS allowed to see
  await pool.query(
    `INSERT INTO ochr_report_submissions
       (organization_id, diocese_org_id, period_start, period_end, status, totals_json)
     VALUES ($1, $2, '2026-01-01', '2026-06-30', 'approved', $3::jsonb)`,
    [parishBOrgId, dioceseOrgId, JSON.stringify({
      totals: { revenue: APPROVED_REVENUE, expense: '1000.00', assessable_base: APPROVED_REVENUE },
      groups: [{ acct_type: 'revenue', rollup_group: 'Offertory', total: APPROVED_REVENUE }],
      accounts: [{ code: '4110', total: APPROVED_REVENUE }],
    })])
}, 90_000)

afterAll(async () => {
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

const auth = role => ({ Authorization: `Bearer ${tokens[role]}` })
const bearer = token => ({ Authorization: `Bearer ${token}` })

describe('SP-007 finance admin-only mount', () => {
  it('mount uses requireRole(admin), not writeGate alone (T10)', () => {
    expect(appSrc).toMatch(
      /app\.use\(\s*'\/api\/finance'\s*,\s*requireAuth\s*,\s*requireRole\(\s*'admin'\s*\)/)
    expect(appSrc).not.toMatch(
      /app\.use\(\s*'\/api\/finance'\s*,\s*requireAuth\s*,\s*writeGate/)
  })

  it.each(FINANCE_GETS)('Staff GET %s is 403 (T1)', async (path) => {
    const res = await request(server).get(path).set(auth('staff'))
    expect(res.status, `${path} -> ${res.status}`).toBe(403)
  })

  it.each(FINANCE_WRITES)('Staff %s %s is 403 (T2)', async (method, path, body) => {
    const res = await request(server)[method](path).set(auth('staff')).send(body)
    expect(res.status, `${method.toUpperCase()} ${path} -> ${res.status}`).toBe(403)
  })

  it('Admin GET finance summary is not 403 (T3)', async () => {
    const res = await request(server).get('/api/finance/summary').set(auth('admin'))
    expect(res.status).not.toBe(403)
    expect(res.status).toBeLessThan(500)
  })

  it('Admin GET coa/ledger/mappings are not 403 (T3)', async () => {
    for (const path of ['/api/finance/coa', '/api/finance/ledger', '/api/finance/mappings']) {
      const res = await request(server).get(path).set(auth('admin'))
      expect(res.status, path).not.toBe(403)
      expect(res.status).toBeLessThan(500)
    }
  })

  it('Viewer GET finance is 403 (T4)', async () => {
    for (const path of FINANCE_GETS.slice(0, 4)) {
      expect((await request(server).get(path).set(auth('viewer'))).status).toBe(403)
    }
  })

  it('Staff donations and funds stay open (T5)', async () => {
    expect((await request(server).get('/api/donations').set(auth('staff'))).status).toBe(200)
    expect((await request(server).get('/api/funds').set(auth('staff'))).status).toBe(200)
  })

  it('Staff giving-statements / insights / audit stay 403 (T6)', async () => {
    expect((await request(server).get('/api/giving-statements/preview').set(auth('staff'))).status).toBe(403)
    expect((await request(server).get('/api/insights').set(auth('staff'))).status).toBe(403)
    expect((await request(server).get('/api/audit-log?limit=5').set(auth('staff'))).status).toBe(403)
  })

  it('no Staff 200 across the full finance surface (Argus FAIL criteria)', async () => {
    const leaks = []
    for (const path of FINANCE_GETS) {
      const res = await request(server).get(path).set(auth('staff'))
      if (res.status === 200) leaks.push(`GET ${path}`)
    }
    for (const [method, path, body] of FINANCE_WRITES) {
      const res = await request(server)[method](path).set(auth('staff')).send(body)
      if (res.status === 200) leaks.push(`${method.toUpperCase()} ${path}`)
    }
    expect(leaks).toEqual([])
  })
})

describe('SP-007 T7 — Org A admin cannot read or write Org B finance', () => {
  it('Admin A GET ledger/summary never returns Org B money', async () => {
    const ledger = await request(server).get('/api/finance/ledger').set(auth('admin'))
    expect(ledger.status).toBe(200)
    const blob = JSON.stringify(ledger.body)
    expect(blob).not.toContain(MARKER_B)
    expect(blob).not.toContain(String(orgBId))

    const summary = await request(server)
      .get('/api/finance/summary?start=2026-01-01&end=2026-12-31')
      .set(auth('admin'))
    expect(summary.status).toBe(200)
    expect(JSON.stringify(summary.body)).not.toContain(MARKER_B)
  })

  it('Admin A with Org B ids in query/body still only sees Org A (403/404 or A-scoped)', async () => {
    const probes = [
      `/api/finance/ledger?organization_id=${orgBId}`,
      `/api/finance/ledger?organizationId=${orgBId}`,
      `/api/finance/ledger?org_id=${orgBId}`,
      `/api/finance/summary?organization_id=${orgBId}&start=2026-01-01&end=2026-12-31`,
      `/api/finance/coa?organization_id=${orgBId}`,
    ]
    for (const path of probes) {
      const res = await request(server).get(path).set(auth('admin'))
      expect([200, 403, 404], `${path} -> ${res.status}`).toContain(res.status)
      if (res.status === 200) {
        const blob = JSON.stringify(res.body)
        expect(blob, path).not.toContain(MARKER_B)
      }
    }
  })

  it('forged JWT placing Admin A into Org B is refused (401/403/404)', async () => {
    const forged = signToken({
      userId: adminAUserId, organizationId: orgBId,
      email: `sp007_a_admin_${RUN_ID}@example.com`,
      name: 'SP007 a admin', role: 'admin', tv: 1,
    })
    const res = await request(server).get('/api/finance/ledger').set(bearer(forged))
    expect([401, 403, 404]).toContain(res.status)
    expect(JSON.stringify(res.body)).not.toContain(MARKER_B)
  })

  it('Admin A write with Org B organization_id in body never lands in Org B', async () => {
    const memo = `SP007_CROSS_WRITE_${RUN_ID}`
    const res = await request(server).post('/api/finance/ledger').set(auth('admin')).send({
      entry_date: '2026-10-02',
      account_code: '4110',
      amount: 12.34,
      memo,
      organization_id: orgBId,
      organizationId: orgBId,
    })
    // Accept create-under-A (200/201) or reject (4xx); never create under B.
    expect(res.status).toBeLessThan(500)
    if (res.status === 200 || res.status === 201) {
      expect([403, 404]).not.toContain(res.status)
    }
    const { rows: inB } = await pool.query(
      `SELECT id FROM ochr_ledger_entries
        WHERE organization_id = $1 AND memo = $2`,
      [orgBId, memo])
    expect(inB).toEqual([])
    // If accepted, it must be under Org A.
    if (res.status === 200 || res.status === 201) {
      const { rows: inA } = await pool.query(
        `SELECT id FROM ochr_ledger_entries
          WHERE organization_id = $1 AND memo = $2`,
        [orgId, memo])
      expect(inA.length).toBeGreaterThan(0)
    }
  })

  it('Org B live entry id is not readable as Org A money', async () => {
    // No ledger-by-id route today; confirm list filter never surfaces B's memo/amount.
    const res = await request(server)
      .get(`/api/finance/ledger?account=4110&start=2026-01-01&end=2026-12-31`)
      .set(auth('admin'))
    expect(res.status).toBe(200)
    const blob = JSON.stringify(res.body)
    expect(blob).not.toContain(MARKER_B)
    expect(blob).not.toContain('9999.00')
    const entries = res.body.entries ?? []
    for (const e of entries) {
      expect(e.memo).not.toBe(MARKER_B)
      expect(String(e.amount)).not.toBe('9999.00')
    }
  })
})

describe('SP-007 T8 — Diocese/chancery sees approved roll-up, not parish live ledger', () => {
  it('Diocese Staff GET /api/diocese/financials is 200 approved roll-up only', async () => {
    const res = await request(server)
      .get('/api/diocese/financials?start=2026-01-01&end=2026-12-31')
      .set(bearer(dioceseStaffToken))
    expect(res.status).toBe(200)
    expect(res.body.submission_count).toBeGreaterThanOrEqual(1)
    expect(res.body.totals?.revenue).toBe(APPROVED_REVENUE)
    const blob = JSON.stringify(res.body)
    // Approved snapshot numbers may appear; the live ledger memo must not.
    expect(blob).not.toContain(MARKER_LIVE)
    expect(blob).not.toContain('7777')
  })

  it('Diocese Staff GET /api/finance/ledger is 403 (admin-only mount; not parish live ledger)', async () => {
    const res = await request(server).get('/api/finance/ledger').set(bearer(dioceseStaffToken))
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain(MARKER_LIVE)
  })

  it('Diocese Admin GET /api/finance/ledger is empty/wrong-org — never parish live ledger', async () => {
    const res = await request(server).get('/api/finance/ledger').set(bearer(dioceseAdminToken))
    // Diocese admin may pass requireRole('admin'); SQL scopes to diocese org id.
    expect([200, 403, 404]).toContain(res.status)
    const blob = JSON.stringify(res.body)
    expect(blob).not.toContain(MARKER_LIVE)
    expect(blob).not.toContain(MARKER_B)
    if (res.status === 200) {
      const entries = res.body.entries ?? res.body.rows ?? res.body.items ?? res.body
      const flat = JSON.stringify(entries)
      expect(flat).not.toContain('7777.00')
      expect(flat).not.toContain(String(parishBOrgId))
    }
  })

  it('Diocese cannot pull parish live ledger via organization_id query params', async () => {
    for (const token of [dioceseStaffToken, dioceseAdminToken]) {
      const res = await request(server)
        .get(`/api/finance/ledger?organization_id=${parishBOrgId}&organizationId=${parishBOrgId}`)
        .set(bearer(token))
      expect([200, 401, 403, 404]).toContain(res.status)
      expect(JSON.stringify(res.body)).not.toContain(MARKER_LIVE)
    }
  })
})
