// D-2 / D-5. Real Postgres.
// D-2: weekend=this_sunday is the Saturday vigil and the Sunday of the
// weekly sheet's week, in the parish timezone. The listing day is the
// same CASE as week_date (recorded fulfilment stamp, else working
// mass_date). Read-only, tenant-scoped, applied in SQL before pagination.
// On main the query is ignored, so Friday and the next Monday come back
// with the weekend.
// D-5: the requester picker hides inactive members unless include_inactive=1.
// On main an inactive member is in the default name search. Linking an
// inactive member of this parish still saves — the picker is not a new
// write rule, and history rows are not rewritten.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, la, utc, other
const PW = 'd2d5-test-pw-0001'
let ip = 10
const nextIp = () => `10.249.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const SUNDAY_EVENING_LA = new Date('2026-10-05T04:00:00.000Z')
const MONDAY_MORNING_LA = new Date('2026-10-05T16:00:00.000Z')

async function org(label, tz) {
  const r = await createOrg(server, {
    organizationName: `D2D5 ${label} ${RUN_ID}`,
    name: `Admin ${label}`,
    email: `d2d5_${label}_${RUN_ID}@example.com`,
    password: PW,
  }, nextIp())
  expect(r.status).toBe(201)
  await pool.query('UPDATE ochr_organizations SET timezone=$2 WHERE id=$1', [r.body.user.organization.id, tz])
  return { token: r.body.token, id: r.body.user.organization.id }
}

async function row(o, tag, status, massDate, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_mass_intentions (organization_id, intention, requested_by, status, mass_date, fulfilled_mass_date)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [o.id, `D2 ${tag} ${RUN_ID}`, 'Synthetic Requester', status, massDate, extra.fulfilledDate ?? null],
  )
  return rows[0].id
}

async function member(o, name, status = 'active') {
  const r = await request(server).post('/api/clients').set(auth(o.token)).send({ name, status })
  expect(r.status).toBe(201)
  return r.body.id
}

const list = (o, qs) => request(server).get(`/api/mass-intentions?${qs}`).set(auth(o.token))
const tags = r => r.body.intentions.map(x => x.intention.replace('D2 ', '').replace(` ${RUN_ID}`, '')).sort()
const count = async (orgId) => (await pool.query(
  'SELECT COUNT(*)::int AS n FROM ochr_mass_intentions WHERE organization_id=$1',
  [orgId],
)).rows[0].n
const at = when => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(when) }

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  la = await org('la', 'America/Los_Angeles')
  utc = await org('utc', 'UTC')
  other = await org('other', 'America/Los_Angeles')
  for (let i = 0; i < 55; i++) await row(la, `filler${String(i).padStart(2, '0')}`, 'open', null)
  await row(la, 'fri', 'scheduled', '2026-10-02')
  await row(la, 'sat', 'scheduled', '2026-10-03')
  await row(la, 'sun', 'scheduled', '2026-10-04')
  await row(la, 'mon', 'scheduled', '2026-10-05')
  await row(la, 'next-sat', 'open', '2026-10-10')
  await row(la, 'next-sun', 'open', '2026-10-11')
  await row(la, 'fulfilled-stamped', 'fulfilled', '2026-10-04', { fulfilledDate: '2026-09-01' })
  await row(la, 'fulfilled-working', 'fulfilled', '2026-10-04')
  await row(la, 'cancelled-sun', 'cancelled', '2026-10-04')
  await row(la, 'undated', 'scheduled', null)
  await row(utc, 'utc-sun', 'scheduled', '2026-10-04')
  await row(utc, 'utc-next-sun', 'scheduled', '2026-10-11')
  await row(other, 'other-sun', 'scheduled', '2026-10-04')
}, 120_000)

afterEach(() => { vi.useRealTimers() })
afterAll(async () => { await closeServer(server); await pool.end() })

describe('D-2 This Sunday filter', () => {
  it('Sunday evening in the parish is this vigil and this Sunday, not next week', async () => {
    at(SUNDAY_EVENING_LA)
    const before = await count(la.id)
    const r = await list(la, 'weekend=this_sunday&limit=50&offset=0')
    expect(r.status).toBe(200)
    expect(r.body.weekend).toEqual({ saturday: '2026-10-03', sunday: '2026-10-04' })
    expect(tags(r)).toEqual(['cancelled-sun', 'fulfilled-working', 'sat', 'sun'])
    expect(await count(la.id)).toBe(before)
    const stamp = await pool.query(
      `SELECT status, to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled
         FROM ochr_mass_intentions
        WHERE organization_id=$1 AND intention=$2`,
      [la.id, `D2 fulfilled-stamped ${RUN_ID}`],
    )
    expect(stamp.rows[0]).toEqual({ status: 'fulfilled', mass_date: '2026-10-04', fulfilled: '2026-09-01' })
  })

  it('the same instant in UTC is already Monday, so the filter is the coming weekend', async () => {
    at(SUNDAY_EVENING_LA)
    const r = await list(utc, 'weekend=this_sunday&limit=50')
    expect(r.status).toBe(200)
    expect(r.body.weekend).toEqual({ saturday: '2026-10-10', sunday: '2026-10-11' })
    expect(tags(r)).toEqual(['utc-next-sun'])
  })

  it('Monday morning looks forward; the unfiltered first page does not contain the match', async () => {
    at(MONDAY_MORNING_LA)
    const filtered = await list(la, 'weekend=this_sunday&limit=50&offset=0')
    expect(tags(filtered)).toEqual(['next-sat', 'next-sun'])
    const page = await list(la, 'limit=50&offset=0')
    expect(tags(page)).not.toContain('next-sat')
    expect(page.body.weekend).toBeUndefined()
  })

  it('pages the filtered set before the rest of the book, and another parish is absent', async () => {
    at(SUNDAY_EVENING_LA)
    const seen = []
    for (let i = 0; i < 4; i++) seen.push(...tags(await list(la, `weekend=this_sunday&limit=1&offset=${i}`)))
    expect(seen.sort()).toEqual(['cancelled-sun', 'fulfilled-working', 'sat', 'sun'])
    const foreign = await list(la, 'weekend=this_sunday&limit=50')
    expect(tags(foreign)).not.toContain('other-sun')
    expect(tags(foreign)).not.toContain('utc-sun')
  })

  it('status, search, and past scheduled narrow the weekend; a wrong token does not', async () => {
    at(SUNDAY_EVENING_LA)
    expect(tags(await list(la, 'weekend=this_sunday&status=cancelled'))).toEqual(['cancelled-sun'])
    expect(tags(await list(la, `weekend=this_sunday&q=${encodeURIComponent('sat')}`))).toEqual(['sat'])
    expect(tags(await list(la, 'weekend=this_sunday&view=past_scheduled'))).toEqual(['sat'])
    expect(tags(await list(la, `weekend=this_sunday&q=${encodeURIComponent('fri')}`))).toEqual([])
    expect(tags(await list(la, `weekend=nope&q=${encodeURIComponent('fri')}`))).toEqual(['fri'])
  })

  it('requires a session', async () => {
    expect((await request(server).get('/api/mass-intentions?weekend=this_sunday')).status).toBe(401)
  })

  it('an accepted weekend stays that weekend after parish midnight, including a later page', async () => {
    at(SUNDAY_EVENING_LA)
    const first = await list(la, 'weekend=this_sunday&limit=1&offset=0')
    expect(first.status).toBe(200)
    expect(first.body.weekend).toEqual({ saturday: '2026-10-03', sunday: '2026-10-04' })
    at(MONDAY_MORNING_LA)
    const pinned = await list(la, 'weekend=this_sunday&saturday=2026-10-03&sunday=2026-10-04&limit=50&offset=0')
    expect(pinned.status).toBe(200)
    expect(pinned.body.weekend).toEqual({ saturday: '2026-10-03', sunday: '2026-10-04' })
    expect(tags(pinned)).toEqual(['cancelled-sun', 'fulfilled-working', 'sat', 'sun'])
    const later = await list(la, 'weekend=this_sunday&saturday=2026-10-03&sunday=2026-10-04&limit=1&offset=3')
    expect(later.status).toBe(200)
    expect(later.body.weekend).toEqual({ saturday: '2026-10-03', sunday: '2026-10-04' })
    expect(['cancelled-sun', 'fulfilled-working', 'sat', 'sun']).toContain(tags(later)[0])
    expect(tags(later)).not.toContain('next-sat')
    expect(tags(later)).not.toContain('next-sun')
    const recomputed = await list(la, 'weekend=this_sunday&limit=50&offset=0')
    expect(tags(recomputed)).toEqual(['next-sat', 'next-sun'])
  })

  it('an unresolvable weekend is not an empty or clock-shifted book', async () => {
    at(MONDAY_MORNING_LA)
    const before = await count(la.id)
    const bad = [
      'weekend=this_sunday&saturday=2026-02-30&sunday=2026-03-01',
      'weekend=this_sunday&saturday=2026-10-04&sunday=2026-10-03',
      'weekend=this_sunday&saturday=2026-10-03&sunday=2026-10-05',
      'weekend=this_sunday&saturday=2026-10-02&sunday=2026-10-03',
      'weekend=this_sunday&saturday=2026-10-03',
      'weekend=this_sunday&sunday=2026-10-04',
    ]
    for (const qs of bad) {
      const r = await list(la, qs)
      expect(r.status, qs).toBe(400)
      expect(r.body.intentions, qs).toBeUndefined()
      expect(r.body.weekend, qs).toBeUndefined()
    }
    expect(await count(la.id)).toBe(before)
    const plain = await list(la, `saturday=2026-10-03&sunday=2026-10-04&q=${encodeURIComponent('fri')}`)
    expect(plain.status).toBe(200)
    expect(plain.body.weekend).toBeUndefined()
    expect(tags(plain)).toEqual(['fri'])
  })
})

describe('D-5 requester picker hides inactive members', () => {
  it('hides inactive by default, shows them only for include_inactive=1, and stays in this parish', async () => {
    const token = `D5x${RUN_ID}`
    const active = await member(la, `${token} Active`, 'active')
    const inactive = await member(la, `${token} Inactive`, 'inactive')
    const newer = await member(la, `${token} New`, 'new')
    const abroad = await member(other, `${token} Abroad`, 'inactive')
    await pool.query(
      `UPDATE ochr_clients SET email=$2, phone=$3, notes=$4 WHERE id=$1`,
      [inactive, 'd5.inactive@example.com', '5550199', 'Synthetic note'],
    )
    const q = encodeURIComponent(`D5x${RUN_ID}`)
    const def = await request(server).get(`/api/clients/picker?search=${q}`).set(auth(la.token))
    expect(def.status).toBe(200)
    expect(def.body.map(m => m.id).sort()).toEqual([active, newer].sort())
    expect(def.body.every(m => m.status !== 'inactive')).toBe(true)
    const loose = await request(server).get(`/api/clients/picker?search=${q}&include_inactive=true`).set(auth(la.token))
    expect(loose.body.map(m => m.id).sort()).toEqual([active, newer].sort())
    const shown = await request(server).get(`/api/clients/picker?search=${q}&include_inactive=1`).set(auth(la.token))
    expect(shown.status).toBe(200)
    expect(shown.body.map(m => m.id).sort()).toEqual([active, inactive, newer].sort())
    const inactiveRow = shown.body.find(m => m.id === inactive)
    expect(inactiveRow).toEqual({ id: inactive, name: `${token} Inactive`, status: 'inactive' })
    for (const row of shown.body) expect(Object.keys(row).sort()).toEqual(['id', 'name', 'status'])
    expect(JSON.stringify(shown.body)).not.toMatch(/example\.com|5550199|Synthetic note/)
    const cross = await request(server).get(`/api/clients/picker?search=${q}&include_inactive=1`).set(auth(other.token))
    expect(cross.body.map(m => m.id)).toEqual([abroad])
    expect(cross.body.map(m => m.id)).not.toContain(inactive)
  })

  it('an inactive member of this parish can still be linked; another parish cannot', async () => {
    const inactive = await member(la, `D5 Link ${RUN_ID}`, 'inactive')
    const abroad = await member(other, `D5 Link Other ${RUN_ID}`, 'inactive')
    const ok = await request(server).post('/api/mass-intentions').set(auth(la.token)).send({
      intention: `D5 link ok ${RUN_ID}`,
      requested_by_client_id: inactive,
    })
    expect(ok.status).toBe(201)
    expect(ok.body.requested_by_client_id).toBe(inactive)
    const refused = await request(server).post('/api/mass-intentions').set(auth(la.token)).send({
      intention: `D5 link refuse ${RUN_ID}`,
      requested_by_client_id: abroad,
    })
    expect(refused.status).toBe(404)
    expect(await count(la.id)).toBeGreaterThan(0)
    const written = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_mass_intentions WHERE organization_id=$1 AND intention=$2',
      [la.id, `D5 link refuse ${RUN_ID}`],
    )
    expect(written.rows[0].n).toBe(0)
  })
})
