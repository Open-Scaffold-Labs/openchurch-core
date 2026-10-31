// SP-133 / F4 — José adopted TARS #62 comment 6380227296 item 3 (2026-10-23):
// once an offering amount has been recorded on a Mass intention, hard delete
// is refused for every role, admin included. The admin-only reasoned void
// keeps the row and its trail.
//
// WHAT WOULD MAKE THESE FAIL
//   - DELETE not reading stipend under its row lock (the old gap).
//   - Treating an explicit 0.00 as "no offering" (truthiness).
//   - "Clear the offering, then delete": an ordinary PATCH nulling a
//     recorded amount, or DELETE ignoring audit evidence of an earlier amount.
//   - A concurrent amount entry slipping past a DELETE that read first.
//   - A refusal writing an audit row, or changing the row.
//   - R382-1: proof that disappears when audit retention prunes (marker
//     not durable, or backfill missing / cross-tenant / blind to 0).
//   - Another parish's row answering anything but 404.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { OFFERING_RECORDED_CODE, OFFERING_CLEAR_CODE } from '../src/routes/massIntentions.js'
import { up as migration126 } from '../src/migrations/126-mass-intention-offering-history.js'
import { pruneOldRecords } from '../src/services/retention.js'

let server
let tokenA, tokenB, staffA, orgAId

const auth = token => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `MOD Parish A ${RUN_ID}`, name: 'Ana Admin',
    email: `mod_a_${RUN_ID}@example.com`, password: 'mod-test-pw-1',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id
  const b = await createOrg(server, {
    organizationName: `MOD Parish B ${RUN_ID}`, name: 'Ben Admin',
    email: `mod_b_${RUN_ID}@example.com`, password: 'mod-test-pw-2',
  })
  expect(b.status).toBe(201)
  tokenB = b.body.token
  const staff = await request(server).post('/api/users').set(auth(tokenA))
    .send({ name: 'Sam Staff', email: `mod_s_${RUN_ID}@example.com`, password: 'mod-test-pw-3x', role: 'staff' })
  expect(staff.status).toBe(201)
  const login = await request(server).post('/api/auth/login')
    .send({ email: `mod_s_${RUN_ID}@example.com`, password: 'mod-test-pw-3x' })
  expect(login.status).toBe(200)
  staffA = login.body.token
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

let seq = 0
async function make(token, body = {}) {
  seq += 1
  const res = await request(server).post('/api/mass-intentions').set(auth(token))
    .send({ intention: `† MOD ${seq} ${RUN_ID}`, ...body })
  expect(res.status).toBe(201)
  return res.body.id
}
const del = (token, id) => request(server).delete(`/api/mass-intentions/${id}`).set(auth(token))
const rowOf = async id => (await pool.query(
  `SELECT id, intention, stipend, status, voided_at, void_reason, entered_history, updated_at
     FROM ochr_mass_intentions WHERE id = $1`, [id])).rows[0]
const auditCount = async id => Number((await pool.query(
  `SELECT count(*) FROM ochr_audit_log WHERE entity_type = 'mass_intention' AND entity_id = $1`, [String(id)])).rows[0].count)
const deleteAudits = async id => Number((await pool.query(
  `SELECT count(*) FROM ochr_audit_log WHERE entity_type = 'mass_intention' AND entity_id = $1 AND action = 'delete'`, [String(id)])).rows[0].count)

describe('SP-133 — a recorded offering blocks hard delete', () => {
  it('admin is refused; row and audit trail are unchanged', async () => {
    const id = await make(tokenA, { stipend: '10.00' })
    const before = await rowOf(id)
    const audits = await auditCount(id)
    const res = await del(tokenA, id)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(OFFERING_RECORDED_CODE)
    expect(res.body.error).toMatch(/void it with a reason/)
    expect(await rowOf(id)).toEqual(before)
    expect(await auditCount(id)).toBe(audits)
  })

  it('staff is refused too', async () => {
    const id = await make(tokenA, { stipend: '5.00' })
    const res = await del(staffA, id)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(OFFERING_RECORDED_CODE)
    expect(await rowOf(id)).toBeTruthy()
  })

  it('an explicit 0.00 offering is a recorded amount and blocks delete', async () => {
    const id = await make(tokenA, { stipend: 0 })
    expect((await rowOf(id)).stipend).toBe('0.00')
    const res = await del(tokenA, id)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(OFFERING_RECORDED_CODE)
  })

  it('no-offering open row (null) can still be deleted (control)', async () => {
    const id = await make(tokenA, { stipend: null })
    const res = await del(staffA, id)
    expect(res.status).toBe(204)
    expect(await rowOf(id)).toBeUndefined()
    expect(await deleteAudits(id)).toBe(1)
  })

  it('clear-then-delete: an ordinary PATCH may not null a recorded offering', async () => {
    const id = await make(tokenA, { stipend: '20.00' })
    for (const token of [tokenA, staffA]) {
      const clear = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(token)).send({ stipend: null })
      expect(clear.status).toBe(409)
      expect(clear.body.code).toBe(OFFERING_CLEAR_CODE)
    }
    expect((await rowOf(id)).stipend).toBe('20.00')
    const res = await del(tokenA, id)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(OFFERING_RECORDED_CODE)
  })

  it('an amount may still change to another real amount (including 0.00)', async () => {
    const id = await make(tokenA, { stipend: '20.00' })
    const ed = await request(server).patch(`/api/mass-intentions/${id}`).set(auth(tokenA)).send({ stipend: '0.00' })
    expect(ed.status).toBe(200)
    expect((await rowOf(id)).stipend).toBe('0.00')
    expect((await del(tokenA, id)).status).toBe(409)
  })

  it('admin correction may clear the amount, but the row stays protected', async () => {
    const id = await make(tokenA, { stipend: '12.00' })
    const fix = await request(server).post(`/api/mass-intentions/${id}/correct`).set(auth(tokenA))
      .send({ reason: 'Amount entered on the wrong intention', changes: { stipend: null } })
    expect(fix.status).toBe(200)
    const row = await rowOf(id)
    expect(row.stipend).toBeNull()
    expect(row.entered_history).toBe(true)
    const res = await del(tokenA, id)
    expect(res.status).toBe(409)
    expect(await rowOf(id)).toBeTruthy()
  })

  // R382-1: the proof must survive ordinary audit retention. Legacy rows are
  // simulated with the latch suspended (as before migration 126), then the
  // real migration backfill and the real retention prune are run.
  async function legacyNullRow(orgToken, orgId, auditOrgId, amount) {
    const id = await make(orgToken, { stipend: null })
    await pool.query(
      `INSERT INTO ochr_audit_log (organization_id, action, entity_type, entity_id, metadata, status_code, created_at)
       VALUES ($1, 'update', 'mass_intention', $2, $3, 200, now() - interval '20 years')`,
      [auditOrgId ?? orgId, String(id), JSON.stringify({ changed: ['stipend'], stipend_before: amount, stipend_after: null })]
    )
    return id
  }
  const offeringFlag = async id => (await pool.query(
    'SELECT offering_recorded FROM ochr_mass_intentions WHERE id = $1', [id])).rows[0]?.offering_recorded
  const legacyAudits = async id => Number((await pool.query(
    `SELECT count(*) FROM ochr_audit_log WHERE entity_type = 'mass_intention' AND entity_id = $1 AND created_at < now() - interval '10 years'`,
    [String(id)])).rows[0].count)

  it('legacy NULL-stipend row with own-parish amount evidence stays protected after retention prunes the audit', async () => {
    const id = await legacyNullRow(tokenA, orgAId, null, 10)
    const zero = await legacyNullRow(tokenA, orgAId, null, 0)
    expect(await offeringFlag(id)).toBe(false)
    await migration126()            // backfill (also proves rerun is safe)
    expect(await offeringFlag(id)).toBe(true)
    expect(await offeringFlag(zero)).toBe(true)
    await pruneOldRecords()         // the real per-plan audit retention path
    expect(await legacyAudits(id)).toBe(0)
    expect(await legacyAudits(zero)).toBe(0)
    for (const x of [id, zero]) {
      const before = await rowOf(x)
      const res = await del(tokenA, x)
      expect(res.status).toBe(409)
      expect(res.body.code).toBe(OFFERING_RECORDED_CODE)
      expect(await rowOf(x)).toEqual(before)
    }
  })

  it('another parish\'s audit evidence does not mark this tenant\'s row', async () => {
    const other = (await pool.query(`SELECT organization_id FROM ochr_users WHERE organization_id <> $1 LIMIT 1`, [orgAId])).rows[0]
    const id = await legacyNullRow(tokenA, orgAId, other.organization_id, 10)
    await migration126()
    expect(await offeringFlag(id)).toBe(false)
    expect((await del(tokenA, id)).status).toBe(204)
  })

  it('no-offering control: no evidence, migration rerun leaves it deletable', async () => {
    const id = await make(tokenA, { stipend: null })
    await migration126()
    await migration126()
    expect(await offeringFlag(id)).toBe(false)
    expect((await del(tokenA, id)).status).toBe(204)
  })

  it('backfill reaches a held parish row without touching its amount or revision', async () => {
    const c = await createOrg(server, {
      organizationName: `MOD Parish C ${RUN_ID}`, name: 'Cy Admin',
      email: `mod_c_${RUN_ID}@example.com`, password: 'mod-test-pw-4',
    })
    expect(c.status).toBe(201)
    const orgC = c.body.user.organization.id
    const id = await legacyNullRow(c.body.token, orgC, null, 15)
    const before = (await pool.query('SELECT stipend, book_revision FROM ochr_mass_intentions WHERE id = $1', [id])).rows[0]
    // A throwaway parish; the hold is one-way here and stays.
    await pool.query('UPDATE ochr_organizations SET held_at = now() WHERE id = $1', [orgC])
    await migration126()
    expect(await offeringFlag(id)).toBe(true)
    const after = (await pool.query('SELECT stipend, book_revision FROM ochr_mass_intentions WHERE id = $1', [id])).rows[0]
    expect(after).toEqual(before)
  })

  it('the latch: any write storing an amount (0.00 included) sets the marker; no write clears it', async () => {
    const id = await make(tokenA, { stipend: null })
    expect(await offeringFlag(id)).toBe(false)
    await pool.query(`UPDATE ochr_mass_intentions SET stipend = 0 WHERE id = $1`, [id])
    expect(await offeringFlag(id)).toBe(true)
    await pool.query(`UPDATE ochr_mass_intentions SET stipend = NULL, offering_recorded = false WHERE id = $1`, [id])
    expect(await offeringFlag(id)).toBe(true)
    expect((await del(tokenA, id)).status).toBe(409)
  })

  it('cross-tenant DELETE of an offered row is 404 and the row stays', async () => {
    const id = await make(tokenA, { stipend: '10.00' })
    const res = await del(tokenB, id)
    expect(res.status).toBe(404)
    expect(await rowOf(id)).toBeTruthy()
  })

  it('reasoned void preserves the offered intention and its amount', async () => {
    const id = await make(tokenA, { stipend: '10.00' })
    const v = await request(server).post(`/api/mass-intentions/${id}/void`).set(auth(tokenA))
      .send({ reason: 'Duplicate entry', disposition: { kind: 'refunded', reason: 'Returned to requester' } })
    expect(v.status).toBe(200)
    const row = await rowOf(id)
    expect(row.voided_at).not.toBeNull()
    expect(row.void_reason).toBe('Duplicate entry')
    expect(row.stipend).toBe('10.00')
    expect((await del(tokenA, id)).status).toBe(409)
  })

  it('concurrent amount entry vs delete: DELETE waits on the row lock and then refuses', async () => {
    const id = await make(tokenA, { stipend: null })
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM ochr_mass_intentions WHERE id = $1 FOR UPDATE', [id])
      await holder.query(`UPDATE ochr_mass_intentions SET stipend = '7.00' WHERE id = $1`, [id])
      // Fire DELETE while the writer holds the lock; it must block, not read stale NULL.
      let settled = false
      const pending = del(tokenA, id).then(r => { settled = true; return r })
      await new Promise(r => setTimeout(r, 400))
      expect(settled).toBe(false)
      await holder.query('COMMIT')
      const res = await pending
      expect(res.status).toBe(409)
      expect(res.body.code).toBe(OFFERING_RECORDED_CODE)
    } finally {
      holder.release()
    }
    expect((await rowOf(id)).stipend).toBe('7.00')
  })

  it('concurrent delete vs amount entry: delete committed first, the late PATCH finds nothing', async () => {
    const id = await make(tokenA, { stipend: null })
    const [d, p] = await Promise.all([
      del(tokenA, id),
      new Promise(r => setTimeout(r, 5)).then(() =>
        request(server).patch(`/api/mass-intentions/${id}`).set(auth(tokenA)).send({ stipend: '9.00' })),
    ])
    // Serialised by the row lock: either delete won (204 + PATCH 404) or
    // the amount won (PATCH 200 + delete 409). Never both succeed.
    const outcomes = `${d.status}/${p.status}`
    expect(['204/404', '409/200']).toContain(outcomes)
    const row = await rowOf(id)
    if (d.status === 204) expect(row).toBeUndefined()
    else expect(row.stipend).toBe('9.00')
  })
})
