// OC-BOOKS-1 R4 (Carolina R3 race): a gift, refund, or shift written while a
// mapping save is in flight must not be read on one account and then
// restated by that save. Every write to those tables takes the parish's
// mapping lock shared (a trigger from migration 132); a save takes it
// exclusive. So the write waits for the save and lands under the saved
// mapping, and a save that starts second waits for the write, sees the
// committed line, and refuses to restate it.
//
// Controlled, not timed: the "in-flight save" is the real applyMappingList
// run on a held transaction, and the test watches pg_locks for the write
// waiting on the advisory lock instead of sleeping.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { civilDateInTimeZone } from '../src/utils/timezone.js'
import { EFFECTIVE_COA } from '../src/finance/effectiveCoa.js'
import { applyMappingList } from '../src/finance/mappingWrite.js'

let server
const cleanup = []
const auth = t => ({ Authorization: `Bearer ${t}` })
const cat = (key, code) => ({ source_type: 'donation_category', source_key: key, account_code: code })
let n = 0

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of cleanup) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

async function parish(tag) {
  n += 1
  const r = await createOrg(server, {
    organizationName: `Books Lock ${tag} ${RUN_ID}`, name: 'Lock Admin',
    email: `bookslock_${tag}_${RUN_ID}@openchurch.test`, password: 'books-lock-pw-1',
  }, `10.89.${n}.1`)
  expect(r.status).toBe(201)
  const org = r.body.user.organization.id
  cleanup.push(org)
  const { rows } = await pool.query(`SELECT timezone FROM ochr_organizations WHERE id = $1`, [org])
  return { token: r.body.token, org, today: civilDateInTimeZone(new Date(), rows[0].timezone) }
}

async function byCode(org) {
  const { rows } = await pool.query(
    `SELECT code, name, acct_type, assessable FROM (${EFFECTIVE_COA}) c WHERE c.active`, [org])
  return new Map(rows.map(r => [r.code, r]))
}

// Opens a mapping save and leaves it uncommitted: the state a real PUT is in
// between taking the books lock and COMMIT.
async function inFlightSave(org, list) {
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    await applyMappingList(client, org, list, null, await byCode(org))
  } catch (err) {
    await client.query('ROLLBACK'); client.release(); throw err
  }
  return {
    async commit() { try { await client.query('COMMIT') } finally { client.release() } },
  }
}

// Resolves true once some backend is waiting on THIS parish's mapping lock
// (the key lockMappingSave takes), so other files' advisory locks in a
// parallel run cannot satisfy it.
async function advisoryWaiter(org, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
          AND ((classid::bigint << 32) | objid::bigint)
              = hashtextextended('oc-books-mapping:' || $1::text, 0)
        LIMIT 1`, [org])
    if (rows.length) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return false
}

async function race(org, write) {
  const pending = write()
  const outcome = await Promise.race([
    pending.then(() => 'committed', () => 'committed'),
    advisoryWaiter(org).then(w => (w ? 'waiting' : 'timeout')),
  ])
  return { outcome, pending }
}

const donationAccount = async (org, category) => (await pool.query(
  `SELECT l.account_code FROM ochr_parish_ledger l
     JOIN ochr_donations d ON d.id = l.source_id AND l.source_type = 'donation'
    WHERE l.organization_id = $1 AND d.category = $2`, [org, category])).rows[0]?.account_code

describe('gift, refund, and payroll writes take the parish mapping lock', () => {
  it('a gift posted while a mapping save is in flight waits, then lands under the saved mapping', async () => {
    const p = await parish('gift')
    const save = await inFlightSave(p.org, [cat('lockrace', '4110')])
    const { outcome, pending } = await race(p.org, () =>
      request(server).post('/api/donations').set(auth(p.token))
        .send({ donor_name: 'Synthetic Donor', amount: 161, category: 'lockrace', method: 'cash', date: p.today })
        .then(r => r))
    // What a reader sees while the save is still open.
    const seen = await donationAccount(p.org, 'lockrace')
    await save.commit()
    const res = await pending
    expect(res.status).toBe(201)
    const final = await donationAccount(p.org, 'lockrace')
    // Waited for the save; never visible on one account and then moved.
    expect({ outcome, seen, final }).toEqual({ outcome: 'waiting', seen: undefined, final: '4110' })
  })

  it('a shift posted while a wages save is in flight waits, and is not restated', async () => {
    const p = await parish('shift')
    const { rows: [staff] } = await pool.query(
      `INSERT INTO ochr_payroll_staff (organization_id, name, pay_rate) VALUES ($1, 'Synthetic Sexton', 20) RETURNING id`,
      [p.org])
    const save = await inFlightSave(p.org, [{ source_type: 'payroll', source_key: 'wages', account_code: '5130' }])
    const { outcome, pending } = await race(p.org, () =>
      request(server).post('/api/payroll/shifts').set(auth(p.token))
        .send({ staff_id: staff.id, date: p.today, hours: 3 }).then(r => r))
    const shiftAccount = async () => (await pool.query(
      `SELECT account_code FROM ochr_parish_ledger WHERE organization_id = $1 AND source_type = 'payroll'`,
      [p.org])).rows[0]?.account_code
    const seen = await shiftAccount()
    await save.commit()
    expect((await pending).status).toBe(201)
    const final = await shiftAccount()
    expect({ outcome, seen, final }).toEqual({ outcome: 'waiting', seen: undefined, final: '5130' })
  })

  it('a refund written while a mapping save is in flight waits for it', async () => {
    const p = await parish('refund')
    const { rows: [g] } = await pool.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, method, date)
       VALUES ($1, 'Synthetic Donor', 90, 'tithe', 'cash', '2099-02-01') RETURNING id`, [p.org])
    const save = await inFlightSave(p.org, [cat('unrelated key', '4110')])
    const { outcome, pending } = await race(p.org, () => pool.query(
      `INSERT INTO ochr_donation_refunds (organization_id, donation_id, amount, status, kind, reason)
       VALUES ($1, $2, 10, 'posted', 'refund', 'synthetic')`, [p.org, g.id]))
    await save.commit()
    await pending
    expect(outcome).toBe('waiting')
  })

  it('a save that starts while a gift is uncommitted waits, then refuses to restate it', async () => {
    const p = await parish('giftfirst')
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query(
        `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, method, date)
         VALUES ($1, 'Synthetic Donor', 171, 'lockctl', 'cash', $2::date)`, [p.org, p.today])
      const before = await (async () => {
        const c = await pool.query(
          `SELECT ochr_mapping_account($1, 'donation_category', 'lockctl', $2::date) AS a`, [p.org, p.today])
        return c.rows[0].a
      })()
      const put = request(server).put('/api/finance/mappings').set(auth(p.token))
        .send({ mappings: [cat('lockctl', '4110')] }).then(r => r)
      const waited = await Promise.race([
        put.then(() => false),
        advisoryWaiter(p.org).then(w => w),
      ])
      await writer.query('COMMIT')
      const res = await put
      const final = await donationAccount(p.org, 'lockctl')
      expect({ waited, status: res.status, code: res.body.code, final }).toEqual(
        { waited: true, status: 409, code: 'mapping_restates_posted', final: before ?? '4420' })
    } finally {
      writer.release()
    }
  })

  it('every gift, refund, shift, and staff table carries the lock trigger', async () => {
    const { rows } = await pool.query(
      `SELECT tgrelid::regclass::text AS t FROM pg_trigger
        WHERE tgname = 'ochr_lock_parish_mappings' AND NOT tgisinternal ORDER BY 1`)
    expect(rows.map(r => r.t)).toEqual(
      ['ochr_donation_refunds', 'ochr_donations', 'ochr_payroll_shifts', 'ochr_payroll_staff'])
  })
})
