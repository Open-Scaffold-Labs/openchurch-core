// SP-064 (Saint uat MIN-28): read-only "past scheduled — fulfilment not
// recorded" filter + per-row flag on GET /api/mass-intentions.
// Real PG. The clock is faked (Date only) so the parish-midnight boundary is
// deterministic. Rule: status scheduled AND stored mass_date strictly before
// TODAY in ochr_organizations.timezone. Unknown/today/future dates and
// open/cancelled/fulfilled rows never match. Filtered in SQL before
// pagination, tenant-scoped, and nothing is written.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, A, B
const PW = 'sp064-test-pw-0001'
let ip = 10
const nextIp = () => `10.253.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
async function org(label, tz) {
  const r = await createOrg(server, { organizationName: `SP064 ${label} ${RUN_ID}`, name: `Admin ${label}`, email: `sp064_${label}_${RUN_ID}@example.com`, password: PW }, nextIp())
  expect(r.status).toBe(201)
  await pool.query('UPDATE ochr_organizations SET timezone=$2 WHERE id=$1', [r.body.user.organization.id, tz])
  return { token: r.body.token, id: r.body.user.organization.id }
}
async function row(o, tag, status, massDate, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_mass_intentions (organization_id, intention, requested_by, status, mass_date, fulfilled_mass_date)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [o.id, `SP064 ${tag} ${RUN_ID}`, 'Synthetic Requester', status, massDate, extra.fulfilledDate ?? null])
  return rows[0].id
}
const list = (o, qs) => request(server).get(`/api/mass-intentions?${qs}`).set(auth(o.token))
const tags = r => r.body.intentions.map(x => x.intention.replace(`SP064 `, '').replace(` ${RUN_ID}`, '')).sort()
// 2026-10-18T06:59Z = Oct 17 23:59 in Los Angeles (Oct 18 in UTC, Oct 18 19:59 in Auckland).
const BEFORE_LA_MIDNIGHT = new Date('2026-10-18T06:59:00Z')
const AT_LA_MIDNIGHT = new Date('2026-10-18T07:00:00Z')
const at = when => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(when) }

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  A = await org('a', 'America/Los_Angeles')
  B = await org('b', 'Pacific/Auckland')
  // 55 undated open rows sort first (NULLS FIRST), so every past-scheduled
  // match sits beyond the unfiltered first page of 50.
  for (let i = 0; i < 55; i++) await row(A, `filler${String(i).padStart(2, '0')}`, 'open', null)
  await row(A, 'sched-oct16', 'scheduled', '2026-10-16')
  await row(A, 'sched-oct17', 'scheduled', '2026-10-17')
  await row(A, 'sched-oct18', 'scheduled', '2026-10-18')
  await row(A, 'sched-oct19', 'scheduled', '2026-10-19')
  await row(A, 'sched-nodate', 'scheduled', null)
  await row(A, 'open-oct01', 'open', '2026-10-01')
  await row(A, 'cancelled-oct01', 'cancelled', '2026-10-01')
  await row(A, 'fulfilled-oct01', 'fulfilled', '2026-10-01', { fulfilledDate: '2026-10-01' })
  await row(B, 'b-sched-oct17', 'scheduled', '2026-10-17')
  await row(B, 'b-sched-oct19', 'scheduled', '2026-10-19')
}, 120_000)
afterEach(() => { vi.useRealTimers() })
afterAll(async () => { await closeServer(server); await pool.end() })

describe('SP-064 past scheduled — fulfilment not recorded', () => {
  it('parish midnight: one minute before LA midnight, Oct 17 is TODAY (not past) even though UTC says Oct 18', async () => {
    at(BEFORE_LA_MIDNIGHT)
    const r = await list(A, 'view=past_scheduled&limit=50&offset=0')
    expect(r.status).toBe(200)
    expect(tags(r)).toEqual(['sched-oct16'])
  })

  it('parish midnight: at LA midnight Oct 17 becomes past; today, future, unknown and terminal statuses never match', async () => {
    at(AT_LA_MIDNIGHT)
    const r = await list(A, 'view=past_scheduled&limit=50&offset=0')
    expect(r.status).toBe(200)
    expect(tags(r)).toEqual(['sched-oct16', 'sched-oct17'])
    expect(r.body.intentions.every(x => x.status === 'scheduled' && x.past_scheduled === true)).toBe(true)
  })

  it('per-row flag on the unfiltered book uses the same rule; matches beyond the first page are found by the filter', async () => {
    at(AT_LA_MIDNIGHT)
    const p1 = await list(A, 'limit=50&offset=0')
    expect(p1.status).toBe(200)
    expect(p1.body.intentions).toHaveLength(50)
    expect(p1.body.intentions.some(x => x.past_scheduled)).toBe(false) // all 50 are undated filler
    const all = []
    for (let off = 0; off < 200; off += 50) {
      const p = await list(A, `limit=50&offset=${off}`)
      all.push(...p.body.intentions)
      if (p.body.intentions.length < 50) break
    }
    const flag = Object.fromEntries(all.map(x => [x.intention.replace(`SP064 `, '').replace(` ${RUN_ID}`, ''), x.past_scheduled]))
    expect(flag).toMatchObject({ 'sched-oct16': true, 'sched-oct17': true, 'sched-oct18': false, 'sched-oct19': false, 'sched-nodate': false, 'open-oct01': false, 'cancelled-oct01': false, 'fulfilled-oct01': false })
  })

  it('pagination applies after the filter (limit/offset over the matching set only)', async () => {
    at(AT_LA_MIDNIGHT)
    const a = await list(A, 'view=past_scheduled&limit=1&offset=0')
    const b = await list(A, 'view=past_scheduled&limit=1&offset=1')
    const c = await list(A, 'view=past_scheduled&limit=1&offset=2')
    expect([...tags(a), ...tags(b)].sort()).toEqual(['sched-oct16', 'sched-oct17'])
    expect(c.body.intentions).toEqual([])
  })

  it('keeps search and status behaviour (AND)', async () => {
    at(AT_LA_MIDNIGHT)
    expect(tags(await list(A, `view=past_scheduled&q=${encodeURIComponent('oct17')}`))).toEqual(['sched-oct17'])
    expect((await list(A, 'view=past_scheduled&status=open')).body.intentions).toEqual([])
    expect(tags(await list(A, 'view=past_scheduled&status=scheduled'))).toEqual(['sched-oct16', 'sched-oct17'])
  })

  it('tenant isolation, each parish on its own clock: Auckland (already Oct 18) sees its Oct 17 row as past; LA never sees B rows', async () => {
    at(BEFORE_LA_MIDNIGHT)
    expect(tags(await list(B, 'view=past_scheduled'))).toEqual(['b-sched-oct17'])
    const a = await list(A, 'view=past_scheduled')
    expect(a.body.intentions.some(x => x.intention.includes('b-sched'))).toBe(false)
  })

  it('read-only: the filter and flag write nothing (no status change, no audit row)', async () => {
    at(AT_LA_MIDNIGHT)
    const snap = async () => (await pool.query("SELECT id, status, updated_at FROM ochr_mass_intentions WHERE organization_id=$1 ORDER BY id", [A.id])).rows
    const audits = async () => (await pool.query("SELECT COUNT(*)::int n FROM ochr_audit_log WHERE organization_id=$1 AND entity_type='mass_intention'", [A.id])).rows[0].n
    const before = await snap(); const auditsBefore = await audits()
    await list(A, 'view=past_scheduled'); await list(A, 'limit=50')
    await new Promise(r => setTimeout(r, 150))
    expect(await snap()).toEqual(before)
    expect(await audits()).toBe(auditsBefore)
  })

  it('CONTROL: without view= the book is unchanged in membership (all rows, any status)', async () => {
    at(AT_LA_MIDNIGHT)
    const r = await list(A, `q=${encodeURIComponent('sched-')}`)
    expect(tags(r)).toEqual(['sched-nodate', 'sched-oct16', 'sched-oct17', 'sched-oct18', 'sched-oct19'])
  })
})
