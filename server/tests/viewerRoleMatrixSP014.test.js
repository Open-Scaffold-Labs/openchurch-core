// SP-014..022: role matrix over Saint's 47 GETs (shots/2026-10-13-viewer-matrix).
//
// Viewer: 403 everywhere except what the Help role table gives them
// (Dashboard, Schedule, Members, plus their own profile, notifications,
// preferences and reports). Staff and Admin: unchanged, except that under
// ux-legal 0005a Staff also lose Finance and Billing. The test reads which
// option is applied from app.js so one file serves both stacks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { signToken } from '../src/middleware/auth.js'
import { viewerMayRead } from '../src/middleware/viewerScope.js'

const appSrc = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
const OPTION_A = /app\.use\('\/api\/finance',\s*requireAuth,\s*requireRole\('admin'\)/.test(appSrc)

// [path, staff status at this stack, viewer may read]
const D = '?start=2026-10-01&end=2026-10-12'
const MATRIX = [
  ['/api/clients/stats', 200, true],
  ['/api/clients', 200, true],
  ['/api/groups', 200, false],
  ['/api/calendar', 200, true],
  ['/api/schedule', 200, true],
  ['/api/checkins/recent', 200, false],
  ['/api/events', 200, false],
  ['/api/sacraments', 200, false],
  ['/api/mass-intentions', 200, false],
  ['/api/service-plans', 200, false],
  ['/api/calendar/conflicts', 200, false],
  ['/api/events', 200, false],
  ['/api/tasks', 200, false],
  ['/api/forms', 403, false],
  ['/api/bulletins', 403, false],
  ['/api/donations', 200, false],
  ['/api/donations/summary', 200, false],
  ['/api/funds', 200, false],
  ['/api/pledges', 403, false],
  ['/api/invoices', 200, false],
  ['/api/fee-schedules', 200, false],
  [`/api/payroll/staff${D}`, 200, false],
  [`/api/payroll/shifts${D}`, 200, false],
  [`/api/payroll/summary${D}`, 200, false],
  ['/api/finance/summary', OPTION_A ? 403 : 200, false],
  ['/api/finance/coa', OPTION_A ? 403 : 200, false],
  ['/api/finance/ledger', OPTION_A ? 403 : 200, false],
  ['/api/ai/quota', 200, false],
  ['/api/ai/generations', 403, false], // admin-only since Stage 7 AI (main)
  ['/api/ai/provider', 403, false],
  ['/api/daily-verse', 200, true],
  ['/api/packet', 200, false],
  ['/api/setup', 200, true],  // flagged exception, see viewerScope.js
  ['/api/onboarding/status', 200, false],
  ['/api/insights', 403, false],
  ['/api/users', 403, false],
  ['/api/organization', 403, false],
  ['/api/billing/status', OPTION_A ? 403 : 200, false],
  ['/api/audit-log?limit=5', 403, false],
  ['/api/vault', 200, false],
  ['/api/support-tickets/mine', 200, true],
  ['/api/support-tickets', 403, false],
  ['/api/imports', 200, false],
  ['/api/admin/notifications', 403, false],
  ['/api/notifications', 200, true],
  ['/api/notification-prefs', 200, true],
  ['/api/affiliation', 200, false],
]

let server, orgId
const tokens = {}
beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const res = await createOrg(server, {
    organizationName: `Matrix ${RUN_ID}`, name: 'Admin', email: `mx_admin_${RUN_ID}@example.com`, password: 'matrix-test-pw',
  }, '10.214.1.1')
  expect(res.status).toBe(201)
  orgId = res.body.user.organization.id
  tokens.admin = res.body.token
  for (const role of ['staff', 'viewer']) {
    const email = `mx_${role}_${RUN_ID}@example.com`
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', $3, $4) RETURNING id, token_version`, [orgId, email, `Matrix ${role}`, role])
    tokens[role] = signToken({ userId: rows[0].id, organizationId: orgId, email, name: `Matrix ${role}`, role, tv: rows[0].token_version ?? 1 })
  }
}, 60_000)
afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})

const get = (role, path) => request(server).get(path).set('Authorization', `Bearer ${tokens[role]}`)

describe('SP-014..022 role matrix: 47 GETs', () => {
  it('has the 47 rows from Saint\u2019s matrix', () => {
    expect(MATRIX).toHaveLength(47)
  })
  it.each(MATRIX)('viewer %s', async (path, _staff, viewerOk) => {
    const res = await get('viewer', path)
    if (viewerOk) expect(res.status).toBe(200)
    else {
      expect(res.status).toBe(403)
      expect(JSON.stringify(res.body)).not.toMatch(/donor|pay_rate|amount/i)
    }
  })
  it.each(MATRIX)('staff %s', async (path, staff) => {
    expect((await get('staff', path)).status).toBe(staff)
  })
  it.each(MATRIX)('admin %s', async (path) => {
    const res = await get('admin', path)
    expect(res.status).not.toBe(403)
    expect(res.status).toBeLessThan(500)
  })
  it('the matrix agrees with the central allowlist', () => {
    for (const [path, , ok] of MATRIX) expect(viewerMayRead(path)).toBe(ok)
  })
})

describe('Viewer scope details', () => {
  it('a member\u2019s giving is closed to Viewers, the member is not', async () => {
    const { rows } = await pool.query(
      `INSERT INTO ochr_clients (organization_id, name) VALUES ($1, 'Matrix Member') RETURNING id`, [orgId])
    expect((await get('viewer', `/api/clients/${rows[0].id}`)).status).toBe(200)
    expect((await get('viewer', `/api/clients/${rows[0].id}/donations`)).status).toBe(403)
    expect((await get('staff', `/api/clients/${rows[0].id}/donations`)).status).toBe(200)
  })
  it('search returns members only to a Viewer', async () => {
    await pool.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, amount, date) VALUES ($1, 'Matrix Member', 50, '2026-10-01')`, [orgId])
    const v = await get('viewer', '/api/search?q=Matrix')
    expect(v.status).toBe(200)
    expect(v.body.length).toBeGreaterThan(0)
    expect(v.body.every(r => r.type === 'member')).toBe(true)
    const s = await get('staff', '/api/search?q=Matrix')
    expect(s.body.some(r => r.type === 'donation')).toBe(true)
  })
  it('own profile works; trailing slash and case do not open a closed path', async () => {
    expect((await get('viewer', '/api/auth/me')).status).toBe(200)
    expect((await get('viewer', '/api/donations/')).status).toBe(403)
    expect((await get('viewer', '/API/Donations')).status).toBe(403)
  })
  it('a demotion to viewer applies on the next request with the old token', async () => {
    const email = `mx_demote_${RUN_ID}@example.com`
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', 'Demoted', 'staff') RETURNING id, token_version`, [orgId, email])
    const tok = signToken({ userId: rows[0].id, organizationId: orgId, email, name: 'Demoted', role: 'staff', tv: rows[0].token_version ?? 1 })
    const auth = { Authorization: `Bearer ${tok}` }
    expect((await request(server).get('/api/donations').set(auth)).status).toBe(200)
    await pool.query(`UPDATE ochr_users SET role = 'viewer' WHERE id = $1`, [rows[0].id])
    expect((await request(server).get('/api/donations').set(auth)).status).toBe(403)
  })
  it('viewer writes are still refused', async () => {
    const res = await request(server).post('/api/clients').set('Authorization', `Bearer ${tokens.viewer}`).send({ name: 'x' })
    expect(res.status).toBe(403)
  })
})

describe('Viewer scope is parish-only', () => {
  it('a chancery (diocese) viewer is not limited by the parish role table', async () => {
    const res = await createOrg(server, {
      organizationName: `Matrix Diocese ${RUN_ID}`, name: 'Chancery Admin', email: `mx_dio_${RUN_ID}@example.com`,
      password: 'matrix-test-pw', organizationType: 'diocese',
    }, '10.214.2.1')
    expect(res.status).toBe(201)
    const dioId = res.body.user.organization.id
    try {
      const email = `mx_dio_viewer_${RUN_ID}@example.com`
      const { rows } = await pool.query(
        `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
         VALUES ($1, $2, 'x', 'Dio Viewer', 'viewer') RETURNING id, token_version`, [dioId, email])
      const tok = signToken({ userId: rows[0].id, organizationId: dioId, email, name: 'Dio Viewer', role: 'viewer', tv: rows[0].token_version ?? 1 })
      const r = await request(server).get('/api/diocese/parishes').set('Authorization', `Bearer ${tok}`)
      expect(r.body?.code).not.toBe('viewer_scope')
      expect(r.status).not.toBe(403)
    } finally {
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [dioId]).catch(() => {})
    }
  })
})
