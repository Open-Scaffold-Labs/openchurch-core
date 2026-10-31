// OC-BOOKS-1 S0 + S1 + S1b.
//
// Dates come from the cutover row and the parish timezone. History uses
// 2026-01-15, which is before the 2026-10-27 floor, not a shifted year.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { civilDateInTimeZone } from '../src/utils/timezone.js'
import { giftAssessableAtFreeze } from '../src/finance/giftAssessableFreeze.js'
import { ledgerTotalsDiffer } from '../src/finance/mappingParity.js'
import { assertNothingRestated } from '../src/finance/mappingWrite.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATION = join(HERE, '../src/migrations/132-effective-dated-mappings.js')
const HISTORY = '2026-01-15'

let server, token, orgId, otherToken
const cleanup = []
const auth = t => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `Books Parish ${RUN_ID}`, name: 'Books Admin',
    email: `books_${RUN_ID}@openchurch.test`, password: 'books-pw-1',
  }, '10.88.1.1')
  expect(a.status).toBe(201)
  token = a.body.token
  orgId = a.body.user.organization.id
  cleanup.push(orgId)
  const b = await createOrg(server, {
    organizationName: `Books Other ${RUN_ID}`, name: 'Other Admin',
    email: `books_other_${RUN_ID}@openchurch.test`, password: 'books-pw-2',
  }, '10.88.1.2')
  expect(b.status).toBe(201)
  otherToken = b.body.token
  cleanup.push(b.body.user.organization.id)
}, 60_000)

afterAll(async () => {
  for (const id of cleanup) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

async function cutover() {
  const { rows } = await pool.query(`SELECT to_char(cutover_on, 'YYYY-MM-DD') AS c FROM ochr_books_cutover`)
  return rows[0].c
}

async function parishDay(id = orgId) {
  const { rows } = await pool.query(`SELECT timezone FROM ochr_organizations WHERE id = $1`, [id])
  return civilDateInTimeZone(new Date(), rows[0].timezone)
}

async function gift(body, t = token) {
  const res = await request(server).post('/api/donations').set(auth(t)).send(body)
  expect(res.status).toBe(201)
  return res.body
}

async function ledgerAccount(date, amount, t = token) {
  const res = await request(server).get('/api/finance/ledger')
    .query({ start: date, end: date, source: 'donation' }).set(auth(t))
  const row = res.body.entries.find(e => Number(e.amount) === amount)
  return row ? row.account_code : undefined
}

async function base(start, end, t = token) {
  const res = await request(server).get('/api/finance/summary')
    .query({ start, end }).set(auth(t))
  return Number(res.body.totals.assessable_base)
}

let ipSeq = 20
async function affiliatedParish(tag) {
  ipSeq += 2
  const dio = await createOrg(server, {
    organizationName: `Books Diocese ${tag} ${RUN_ID}`, name: 'Canon',
    email: `books_dio_${tag}_${RUN_ID}@openchurch.test`, password: `books-pw-dio-${tag}`,
    organizationType: 'diocese',
  }, `10.88.2.${ipSeq}`)
  expect(dio.status).toBe(201)
  cleanup.push(dio.body.user.organization.id)
  const email = `books_aff_${tag}_${RUN_ID}@openchurch.test`
  const par = await createOrg(server, {
    organizationName: `Books Parish ${tag} ${RUN_ID}`, name: 'Parish',
    email, password: `books-pw-aff-${tag}`,
  }, `10.88.2.${ipSeq + 1}`)
  expect(par.status).toBe(201)
  cleanup.push(par.body.user.organization.id)
  const inv = await request(server).post('/api/diocese/parishes/invite').set(auth(dio.body.token)).send({ email })
  expect(inv.status).toBeLessThan(300)
  const acc = await request(server).post('/api/affiliation/accept').set(auth(par.body.token)).send({ grant_level: 'detail' })
  expect(acc.status).toBe(200)
  return { token: par.body.token, org: par.body.user.organization.id }
}

async function putMapping(t, items, effective_from) {
  return request(server).put('/api/finance/mappings').set(auth(t))
    .send(effective_from ? { mappings: items, effective_from } : { mappings: items })
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

describe('cutover, exact match, and parity', () => {
  it('stores the cutover inside one transaction, after every parish today', () => {
    const src = readFileSync(MIGRATION, 'utf8')
    expect(src).toMatch(/GREATEST\(\s*DATE '2026-10-27',/)
    expect(src).toMatch(/pg_timezone_names/)
    expect(src).toMatch(/\) \+ 1\)/)
    expect(src).toMatch(/BEGIN ISOLATION LEVEL REPEATABLE READ/)
    // Atlas P2-a: bounded lock waits; source tables before mappings.
    expect(src).toMatch(/SET LOCAL lock_timeout = '5s'/)
    const sources = src.indexOf('IN SHARE ROW EXCLUSIVE MODE')
    const mappings = src.indexOf('LOCK TABLE ochr_coa_mappings IN ACCESS EXCLUSIVE MODE')
    expect(sources).toBeGreaterThan(-1)
    expect(mappings).toBeGreaterThan(sources)
    // Every statement goes through the one transaction's client.
    expect(src).not.toMatch(/\bpool\.query\(/)
    expect(src).not.toMatch(/BOOKS_MAPPING_EPOCH/)
    expect(src).not.toMatch(/reclass/i)
  })

  it('the cutover row is at least the floor date and after this parish today', async () => {
    const day = await cutover()
    expect(day >= '2026-10-27').toBe(true)
    expect(day > await parishDay()).toBe(true)
    const src = readFileSync(MIGRATION, 'utf8')
    expect(src).toMatch(/mapping parity/)
  })

  it('aborts when old and new totals differ, and accepts a match', () => {
    const row = { organization_id: 1, account_code: '4420', total: '10.00' }
    expect(ledgerTotalsDiffer([row], [{ ...row, account_code: '4110' }])).toBe(true)
    expect(ledgerTotalsDiffer([row], [row])).toBe(false)
    expect(ledgerTotalsDiffer([], [])).toBe(false)
    const oct = { ...row, month: '2026-10' }
    expect(ledgerTotalsDiffer([oct], [{ ...oct, month: '2026-09' }])).toBe(true)
  })

  it('matches a key exactly, and a case variant is its own mapping the parish can set', async () => {
    const day = await cutover()
    await pool.query(
      `INSERT INTO ochr_coa_mappings
         (organization_id, source_type, source_key, account_code, effective_from, set_by)
       VALUES ($1, 'donation_category', 'Plate', '4410', $2::date, 'diocese')`,
      [orgId, day])
    await gift({ donor_name: 'Case', amount: 9, category: 'plate', date: day, method: 'cash' })
    expect(await ledgerAccount(day, 9)).toBeNull()

    const variant = await request(server).put('/api/finance/mappings').set(auth(token))
      .send({ mappings: [{ source_type: 'donation_category', source_key: 'plate', account_code: '4410' }] })
    expect(variant.status).toBe(200)
    expect(await ledgerAccount(day, 9)).toBe('4410')
    const { rows } = await pool.query(
      `SELECT source_key FROM ochr_coa_mappings
        WHERE organization_id = $1 AND source_type = 'donation_category'
          AND lower(source_key) = 'plate' AND superseded_on IS NULL
        ORDER BY source_key COLLATE "C"`,
      [orgId])
    expect(rows.map(r => r.source_key)).toEqual(['Plate', 'plate'])
    // The mappings list is in byte order on any database collation.
    const list = await request(server).get('/api/finance/mappings').set(auth(token))
    expect(list.status).toBe(200)
    const keys = list.body.mappings
      .filter(m => m.source_type === 'donation_category' && m.source_key.toLowerCase() === 'plate')
      .map(m => m.source_key)
    expect(keys).toEqual(['Plate', 'plate'])
  })

  it('an imported Offering, capitalised, can be mapped and then submitted', async () => {
    const day = await cutover()
    await gift({ donor_name: 'Caps', amount: 13, category: 'Offering', date: day, method: 'cash' })
    expect(await ledgerAccount(day, 13)).toBeNull()
    const put = await request(server).put('/api/finance/mappings').set(auth(token))
      .send({ mappings: [{ source_type: 'donation_category', source_key: 'Offering', account_code: '4110' }] })
    expect(put.status).toBe(200)
    expect(await ledgerAccount(day, 13)).toBe('4110')
  })
})

describe('unmapped money after cutover is unknown', () => {
  it('second collections on the cutover day are 2320 and not in the base', async () => {
    const day = await cutover()
    const before = await base(day, day)
    await gift({ donor_name: 'Second', amount: 75, category: 'special collection', date: day, method: 'cash' })
    expect(await ledgerAccount(day, 75)).toBe('2320')
    expect(await base(day, day)).toBe(before)
  })

  it('the same category before the cutover stays on 4420', async () => {
    await gift({ donor_name: 'Second Earlier', amount: 18, category: 'special collection', date: HISTORY, method: 'cash' })
    expect(await ledgerAccount(HISTORY, 18)).toBe('4420')
    expect(HISTORY < '2026-10-27').toBe(true)
  })

  it('offering, offertory, and tithe on the cutover day are 4110', async () => {
    const day = await cutover()
    await gift({ donor_name: 'Plate', amount: 10, category: 'offering', date: day, method: 'cash' })
    await gift({ donor_name: 'Plate', amount: 11, category: 'offertory', date: day, method: 'cash' })
    await gift({ donor_name: 'Plate', amount: 12, category: 'tithe', date: day, method: 'cash' })
    expect(await ledgerAccount(day, 10)).toBe('4110')
    expect(await ledgerAccount(day, 11)).toBe('4110')
    expect(await ledgerAccount(day, 12)).toBe('4110')
  })

  it('a category with no mapping is unknown, and freeze does not stamp it false', async () => {
    const day = await cutover()
    const before = await base(day, day)
    const row = await gift({ donor_name: 'Roof', amount: 40, category: 'building fund', date: day, method: 'cash' })
    expect(await ledgerAccount(day, 40)).toBeNull()
    expect(await base(day, day)).toBe(before)
    const stamped = await giftAssessableAtFreeze(orgId, day, day)
    expect(stamped[String(row.id)].assessable).toBeNull()
  })

  it('a fund mapping to 4450 is refused for the parish', async () => {
    const fund = await request(server).post('/api/funds').set(auth(token)).send({ name: `Roof ${RUN_ID}` })
    expect(fund.status).toBe(201)
    const put = await request(server).put('/api/finance/mappings').set(auth(token))
      .send({ mappings: [{ source_type: 'fund', source_key: String(fund.body.id), account_code: '4450' }] })
    expect(put.status).toBe(403)
    expect(put.body.code).toBe('diocese_mapping_required')
  })

  it('lists the unmapped categories and blocks the submission', async () => {
    const dio = await createOrg(server, {
      organizationName: `Books Diocese ${RUN_ID}`, name: 'Canon',
      email: `books_dio_${RUN_ID}@openchurch.test`, password: 'books-pw-dio-1',
      organizationType: 'diocese',
    }, '10.88.1.3')
    expect(dio.status).toBe(201)
    cleanup.push(dio.body.user.organization.id)
    const email = `books_aff_${RUN_ID}@openchurch.test`
    const par = await createOrg(server, {
      organizationName: `Books Affiliated ${RUN_ID}`, name: 'Parish',
      email, password: 'books-pw-aff-1',
    }, '10.88.1.4')
    expect(par.status).toBe(201)
    const parToken = par.body.token
    const parOrg = par.body.user.organization.id
    cleanup.push(parOrg)
    const inv = await request(server).post('/api/diocese/parishes/invite').set(auth(dio.body.token)).send({ email })
    expect(inv.status).toBeLessThan(300)
    const acc = await request(server).post('/api/affiliation/accept').set(auth(parToken)).send({ grant_level: 'detail' })
    expect(acc.status).toBe(200)

    const day = await cutover()
    const key = `Unmapped ${RUN_ID}`
    await gift({ donor_name: 'Unknown', amount: 33, category: key, date: day, method: 'cash' }, parToken)
    const prompt = await request(server).get('/api/finance/mappings').set(auth(parToken))
    expect(prompt.body.mapping_prompt.lines.some(l => l.category === key && Number(l.amount) === 33)).toBe(true)

    const sub = await request(server).post('/api/finance/submissions').set(auth(parToken))
      .send({ period_start: day, period_end: day })
    expect(sub.status).toBe(409)
    expect(sub.body.code).toBe('unmapped_unknown')
    expect(sub.body.categories.some(l => l.category === key && Number(l.amount) === 33)).toBe(true)
    const { rows } = await pool.query(
      `SELECT id, totals_json FROM ochr_report_submissions WHERE organization_id = $1`, [parOrg])
    expect(rows).toEqual([])
  })
})

describe('mapping edits keep provenance and the parish clock', () => {
  it('a same-day edit inserts a new row and leaves the earlier account', async () => {
    const day = await parishDay()
    const key = `Same Day ${RUN_ID}`
    const first = await request(server).put('/api/finance/mappings').set(auth(token))
      .send({ mappings: [{ source_type: 'donation_category', source_key: key, account_code: '4110' }] })
    expect(first.status).toBe(200)
    const second = await request(server).put('/api/finance/mappings').set(auth(token))
      .send({ mappings: [{ source_type: 'donation_category', source_key: key, account_code: '4410' }] })
    expect(second.status).toBe(200)
    const { rows } = await pool.query(
      `SELECT account_code, set_by, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
              to_char(superseded_on, 'YYYY-MM-DD') AS superseded_on
         FROM ochr_coa_mappings
        WHERE organization_id = $1 AND source_type = 'donation_category' AND source_key = $2
        ORDER BY id`,
      [orgId, key])
    expect(rows).toHaveLength(2)
    expect(rows[0].account_code).toBe('4110')
    expect(rows[0].superseded_on).toBe(day)
    expect(rows[1].account_code).toBe('4410')
    expect(rows[1].superseded_on).toBeNull()

    await gift({ donor_name: 'History', amount: 7, category: key, date: HISTORY, method: 'cash' })
    expect(await ledgerAccount(HISTORY, 7)).toBe('4420')
    await gift({ donor_name: 'Today', amount: 8, category: key, date: day, method: 'cash' })
    expect(await ledgerAccount(day, 8)).toBe('4410')
    const { rows: gifts } = await pool.query(
      `SELECT amount, category FROM ochr_donations WHERE organization_id = $1 AND category = $2 ORDER BY amount`,
      [orgId, key])
    expect(gifts.map(g => Number(g.amount))).toEqual([7, 8])
  })

  it('uses the parish timezone for today', async () => {
    await pool.query(`UPDATE ochr_organizations SET timezone = 'America/Los_Angeles' WHERE id = $1`, [orgId])
    try {
      const la = civilDateInTimeZone(new Date(), 'America/Los_Angeles')
      const key = `Zone ${RUN_ID}`
      const put = await request(server).put('/api/finance/mappings').set(auth(token))
        .send({ mappings: [{ source_type: 'donation_category', source_key: key, account_code: '4410' }] })
      expect(put.status).toBe(200)
      const { rows } = await pool.query(
        `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from
           FROM ochr_coa_mappings
          WHERE organization_id = $1 AND source_key = $2 AND superseded_on IS NULL`,
        [orgId, key])
      expect(rows[0].effective_from).toBe(la)
    } finally {
      await pool.query(`UPDATE ochr_organizations SET timezone = 'UTC' WHERE id = $1`, [orgId])
    }
  })

  it('a second save that cannot take the lock returns 409 and leaves one open row', async () => {
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(
        `SELECT id FROM ochr_coa_mappings
          WHERE organization_id = $1 AND source_type = 'donation_category'
            AND source_key = 'offering' AND superseded_on IS NULL
          FOR UPDATE`,
        [orgId])
      const res = await request(server).put('/api/finance/mappings').set(auth(token))
        .send({ mappings: [{ source_type: 'donation_category', source_key: 'offering', account_code: '4110' }] })
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('mapping_conflict')
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_coa_mappings
        WHERE organization_id = $1 AND source_type = 'donation_category'
          AND source_key = 'offering' AND superseded_on IS NULL`,
      [orgId])
    expect(rows[0].n).toBe(1)
  })

  it('refuses a remap that would move gifts in a submitted period', async () => {
    const dio = await createOrg(server, {
      organizationName: `Books Diocese Period ${RUN_ID}`, name: 'Canon',
      email: `books_dio_p_${RUN_ID}@openchurch.test`, password: 'books-pw-dio-2',
      organizationType: 'diocese',
    }, '10.88.1.5')
    expect(dio.status).toBe(201)
    cleanup.push(dio.body.user.organization.id)
    const email = `books_aff_p_${RUN_ID}@openchurch.test`
    const par = await createOrg(server, {
      organizationName: `Books Period ${RUN_ID}`, name: 'Parish',
      email, password: 'books-pw-aff-2',
    }, '10.88.1.6')
    expect(par.status).toBe(201)
    const parToken = par.body.token
    const parOrg = par.body.user.organization.id
    cleanup.push(parOrg)
    await request(server).post('/api/diocese/parishes/invite').set(auth(dio.body.token)).send({ email })
    const acc = await request(server).post('/api/affiliation/accept').set(auth(parToken)).send({ grant_level: 'detail' })
    expect(acc.status).toBe(200)

    const day = await parishDay(parOrg)
    const key = `Period ${RUN_ID}`
    const mapped = await request(server).put('/api/finance/mappings').set(auth(parToken))
      .send({ mappings: [{ source_type: 'donation_category', source_key: key, account_code: '4110' }] })
    expect(mapped.status).toBe(200)
    await gift({ donor_name: 'Frozen', amount: 64, category: key, date: day, method: 'cash' }, parToken)
    const sub = await request(server).post('/api/finance/submissions').set(auth(parToken))
      .send({ period_start: day, period_end: day })
    expect(sub.status).toBe(201)
    const subId = sub.body.submission?.id ?? sub.body.id
    const before = await pool.query('SELECT totals_json FROM ochr_report_submissions WHERE id = $1', [subId])

    const remap = await request(server).put('/api/finance/mappings').set(auth(parToken))
      .send({ mappings: [{ source_type: 'donation_category', source_key: key, account_code: '4410' }] })
    expect(remap.status).toBe(409)
    expect(remap.body.code).toBe('period_submitted')
    expect(await ledgerAccount(day, 64, parToken)).toBe('4110')
    const after = await pool.query('SELECT totals_json FROM ochr_report_submissions WHERE id = $1', [subId])
    expect(after.rows[0].totals_json).toEqual(before.rows[0].totals_json)

    const other = await request(server).put('/api/finance/mappings').set(auth(otherToken))
      .send({ mappings: [{ source_type: 'donation_category', source_key: key, account_code: '4410' }] })
    expect(other.status).toBe(200)
    const { rows: theirs } = await pool.query(
      `SELECT organization_id FROM ochr_coa_mappings WHERE source_key = $1 AND account_code = '4410'`,
      [key])
    expect(theirs.map(r => Number(r.organization_id))).not.toContain(Number(parOrg))
  })

  it('a parish cannot point offering at 4450, or a new mapping at 4510', async () => {
    const day = await cutover()
    const shrink = await request(server).put('/api/finance/mappings').set(auth(token))
      .send({ mappings: [{ source_type: 'donation_category', source_key: 'offering', account_code: '4450' }] })
    expect(shrink.status).toBe(403)
    expect(shrink.body.code).toBe('diocese_mapping_required')
    expect(await ledgerAccount(day, 10)).toBe('4110')

    const fund = await request(server).post('/api/funds').set(auth(token)).send({ name: `Old 4510 ${RUN_ID}` })
    const history = await request(server).put('/api/finance/mappings').set(auth(token))
      .send({ mappings: [{ source_type: 'fund', source_key: String(fund.body.id), account_code: '4510' }] })
    expect(history.status).toBe(400)
    expect(history.body.code).toBe('history_only_account')
  })
})

describe('R3: mapping guards', () => {
  it('a parish cannot send unknown category money to 2320, 4450, 4430, or 4910', async () => {
    for (const code of ['2320', '4450', '4430', '4910']) {
      const res = await putMapping(token, [{ source_type: 'donation_category', source_key: `Out ${code} ${RUN_ID}`, account_code: code }])
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('diocese_mapping_required')
    }
    const ok = await putMapping(token, [{ source_type: 'donation_category', source_key: `In ${RUN_ID}`, account_code: '4410' }])
    expect(ok.status).toBe(200)
  })

  it('a same-day remap does not restate a gift already posted today; tomorrow does', async () => {
    const day = await parishDay()
    const key = `Posted ${RUN_ID}`
    expect((await putMapping(token, [{ source_type: 'donation_category', source_key: key, account_code: '4110' }])).status).toBe(200)
    await gift({ donor_name: 'Posted', amount: 71, category: key, date: day, method: 'cash' })
    expect(await ledgerAccount(day, 71)).toBe('4110')

    const same = await putMapping(token, [{ source_type: 'donation_category', source_key: key, account_code: '4410' }])
    expect(same.status).toBe(409)
    expect(same.body.code).toBe('mapping_restates_posted')
    expect(await ledgerAccount(day, 71)).toBe('4110')

    const tomorrow = addDays(day, 1)
    const later = await putMapping(token, [{ source_type: 'donation_category', source_key: key, account_code: '4410' }], tomorrow)
    expect(later.status).toBe(200)
    expect(await ledgerAccount(day, 71)).toBe('4110')
    await gift({ donor_name: 'Next', amount: 72, category: key, date: tomorrow, method: 'cash' })
    expect(await ledgerAccount(tomorrow, 72)).toBe('4410')
  })

  it('a first mapping today does not restate an unmapped gift already posted on 4420', async () => {
    const day = await parishDay()
    const key = `Legacy ${RUN_ID}`
    await gift({ donor_name: 'Legacy today', amount: 73, category: key, date: day, method: 'cash' })
    const before = await ledgerAccount(day, 73)
    const same = await putMapping(token, [{ source_type: 'donation_category', source_key: key, account_code: '4110' }])
    if (day < await cutover()) {
      expect(before).toBe('4420')
      expect(same.status).toBe(409)
      expect(same.body.code).toBe('mapping_restates_posted')
      expect(await ledgerAccount(day, 73)).toBe('4420')
    } else {
      expect(before).toBeNull()
      expect(same.status).toBe(200)
    }
  })

  it('resolving posted unknown money is allowed; changing or clearing a known account is not', () => {
    const line = (accounts, posted = true, frozen = false) => new Map([['k', { accounts, posted, frozen }]])
    expect(() => assertNothingRestated(line(['']), line(['4110']))).not.toThrow()
    expect(() => assertNothingRestated(line(['4110']), line(['4410']))).toThrow(/posted/)
    expect(() => assertNothingRestated(line(['4110']), line(['']))).toThrow(/posted/)
    expect(() => assertNothingRestated(line(['4110'], false), line(['4410'], false))).not.toThrow()
    expect(() => assertNothingRestated(line([''], false, true), line(['4110'], false, true))).toThrow(/diocese/)
  })

  it('a wages remap that would move payroll in a submitted period returns 409', async () => {
    const p = await affiliatedParish('pay')
    const day = await parishDay(p.org)
    const { rows: [staff] } = await pool.query(
      `INSERT INTO ochr_payroll_staff (organization_id, name, pay_rate) VALUES ($1, 'Sexton', 20) RETURNING id`, [p.org])
    await pool.query(`INSERT INTO ochr_payroll_shifts (staff_id, date, hours) VALUES ($1, $2, 4)`,
      [staff.id, day])
    const sub = await request(server).post('/api/finance/submissions').set(auth(p.token))
      .send({ period_start: day, period_end: day })
    expect(sub.status).toBe(201)

    for (const from of [undefined, day]) {
      const res = await putMapping(p.token, [{ source_type: 'payroll', source_key: 'wages', account_code: '5130' }], from)
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('period_submitted')
    }
    const { rows } = await pool.query(
      `SELECT account_code FROM ochr_parish_ledger WHERE organization_id = $1 AND source_type = 'payroll'`, [p.org])
    expect(rows.map(r => r.account_code)).toEqual(['5120'])
    const tomorrow = await putMapping(p.token, [{ source_type: 'payroll', source_key: 'wages', account_code: '5130' }], addDays(day, 1))
    expect(tomorrow.status).toBe(200)
  })

  it('an offsetting unknown ledger line does not hide unmapped gifts from the submit guard', async () => {
    const p = await affiliatedParish('off')
    const day = await cutover()
    const key = `Hidden ${RUN_ID}`
    await gift({ donor_name: 'Hidden', amount: 55, category: key, date: day, method: 'cash' }, p.token)
    await pool.query(
      `INSERT INTO ochr_ledger_entries (organization_id, entry_date, account_code, amount, memo, source_type)
       VALUES ($1, $2, 'ZZ99', -55, 'offset', 'manual')`, [p.org, day])
    const sub = await request(server).post('/api/finance/submissions').set(auth(p.token))
      .send({ period_start: day, period_end: day })
    expect(sub.status).toBe(409)
    expect(sub.body.code).toBe('unmapped_unknown')
    expect(sub.body.categories.some(l => l.category === key && Number(l.amount) === 55)).toBe(true)
  })

  it('a non-donation unknown code alone does not block with an empty gift list', async () => {
    const p = await affiliatedParish('odd')
    const day = await cutover()
    await pool.query(
      `INSERT INTO ochr_ledger_entries (organization_id, entry_date, account_code, amount, memo, source_type)
       VALUES ($1, $2, 'ZZ98', 12, 'odd code', 'manual')`, [p.org, day])
    const sub = await request(server).post('/api/finance/submissions').set(auth(p.token))
      .send({ period_start: day, period_end: day })
    expect(sub.status).toBe(201)
  })
})

describe('S1b trial-balance import', () => {
  it('a reordered copy of the same trial balance is the same import', async () => {
    const first = await request(server).post('/api/finance/ledger/import').set(auth(token)).send({
      as_of: '2026-12-16', csv: 'account_code,debit,credit,memo\n1110,40.00,,cash\n4420,,40.00,gift\n',
    })
    expect(first.status).toBe(201)
    const again = await request(server).post('/api/finance/ledger/import').set(auth(token)).send({
      as_of: '2026-12-16', csv: 'account_code,debit,credit,memo\r\n4420,,40.00,gift\r\n1110,40.00,,cash',
    })
    expect(again.status).toBe(200)
    expect(again.body.idempotent).toBe(true)
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_ledger_entries
        WHERE organization_id = $1 AND entry_date = '2026-12-16' AND source_type = 'import'`, [orgId])
    expect(rows[0].n).toBe(2)
  })

  it('rejects an unbalanced file and saves nothing', async () => {
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_ledger_entries WHERE organization_id = $1 AND source_type = 'import'`,
      [orgId])
    const res = await request(server).post('/api/finance/ledger/import').set(auth(token)).send({
      as_of: '2026-12-31',
      csv: 'account_code,amount,memo\n4310,1200.00,RE fees\n5310,80.50,Candles',
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('trial_balance_unbalanced')
    expect(res.body.imported).toBe(0)
    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_ledger_entries WHERE organization_id = $1 AND source_type = 'import'`,
      [orgId])
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('posts a balanced file once and returns that result on a replay', async () => {
    const csv = 'account_code,debit,credit,memo\n1110,25.00,,cash\n4420,,25.00,gift\n'
    const first = await request(server).post('/api/finance/ledger/import').set(auth(token)).send({
      as_of: '2026-12-15', csv,
    })
    expect(first.status).toBe(201)
    expect(first.body.imported).toBe(2)
    const second = await request(server).post('/api/finance/ledger/import').set(auth(token)).send({
      as_of: '2026-12-15', csv,
    })
    expect(second.status).toBe(200)
    expect(second.body.idempotent).toBe(true)
    expect(second.body.imported).toBe(2)
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_ledger_entries
        WHERE organization_id = $1 AND entry_date = '2026-12-15' AND source_type = 'import'`,
      [orgId])
    expect(rows[0].n).toBe(2)
    const lines = await request(server).get('/api/finance/ledger')
      .query({ start: '2026-12-15', end: '2026-12-15', source: 'import' }).set(auth(token))
    const byCode = Object.fromEntries(lines.body.entries.map(e => [e.account_code, Number(e.amount)]))
    expect(byCode['1110']).toBe(25)
    expect(byCode['4420']).toBe(25)
  })

  it('refuses a non-zero Opening Balance Equity and saves nothing', async () => {
    await pool.query(
      `INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
       VALUES ($1, '3990', 'Opening Balance Equity', 'net_asset', 'Net Assets', false, 95)`,
      [orgId])
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_ledger_entries WHERE organization_id = $1 AND entry_date = '2026-12-14'`,
      [orgId])
    const res = await request(server).post('/api/finance/ledger/import').set(auth(token)).send({
      as_of: '2026-12-14',
      csv: 'account_code,debit,credit\n3990,,10.00\n1110,10.00,',
    })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('opening_balance_equity')
    expect(res.body.imported).toBe(0)
    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_ledger_entries WHERE organization_id = $1 AND entry_date = '2026-12-14'`,
      [orgId])
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('does not cascade a batch delete onto posted lines', async () => {
    const src = readFileSync(MIGRATION, 'utf8')
    expect(src).toMatch(/ochr_ledger_entries_import_fk[\s\S]{0,500}ON DELETE RESTRICT/)
    expect(src).not.toMatch(/import_id[\s\S]{0,240}ON DELETE CASCADE/)
    const { rows: [imp] } = await pool.query(
      `SELECT id FROM ochr_ledger_imports WHERE organization_id = $1 LIMIT 1`, [orgId])
    await expect(pool.query('DELETE FROM ochr_ledger_imports WHERE id = $1', [imp.id])).rejects.toThrow()
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_ledger_entries
        WHERE organization_id = $1 AND source_type = 'import'`,
      [orgId])
    expect(rows[0].n).toBeGreaterThan(0)
  })
})

describe('the fake CPA fixture is gone', () => {
  it('does not ship selfServeOnboarding or the books v3.3 engine', () => {
    expect(existsSync(join(HERE, '../src/lib/selfServeOnboarding.js'))).toBe(false)
    expect(existsSync(join(HERE, '../src/lib/booksV33VerticalEngine.cjs'))).toBe(false)
    expect(existsSync(join(HERE, 'selfServeOnboarding.test.mjs'))).toBe(false)
  })
})
