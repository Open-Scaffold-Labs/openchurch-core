// Stage 6 — child check-in redaction keeps running while a parish is held
// (TARS #278 review, 14 Oct, finding 1).
//
// HOLD refuses a held parish's writes. The existing retention policy (spent
// pickup-code hashes cleared; names past the existing window replaced) must
// still apply to it, through a path that can do nothing else: one table,
// UPDATE only, only the redaction columns, only toward the redacted values,
// only for the organization its transaction names. No new retention period.
//
// Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { holdOrganization } from '../src/auth/organizationHold.js'
import { pruneOldRecords, redactCheckins, CHECKIN_REDACTED_NAME } from '../src/services/retention.js'

let server
const orgIds = []
let sequence = 1

beforeAll(async () => { await migrateOnce(); server = await bindServer() }, 60000)
afterAll(async () => {
  for (const id of orgIds) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server); await pool.end()
})

async function parish(tag) {
  const name = `HeldRedact ${tag} ${RUN_ID}`
  const res = await createOrg(server, { organizationName: name, name: 'Synthetic Admin', email: `heldredact_${tag}_${RUN_ID}@example.com`, password: 'heldredact-test-pw' }, `10.97.${sequence++}.1`)
  expect(res.status).toBe(201)
  const org = { id: res.body.user.organization.id, name, userId: res.body.user.id }
  orgIds.push(org.id)
  return org
}
const hold = org => holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true })

// One old check-in past the existing name window, one spent code (checked
// out, past the code window), one recent check-in that must be left alone.
async function checkins(org) {
  const { rows: [event] } = await pool.query(
    `INSERT INTO ochr_calendar_events (organization_id, title, date, start_time, end_time)
     VALUES ($1, 'Synthetic service', CURRENT_DATE, '09:00', '10:00') RETURNING id`, [org.id])
  const add = (name, guardian, hash, inAgo, outAgo) => pool.query(
    `INSERT INTO ochr_checkins (organization_id, calendar_event_id, person_name, kind, guardian_name, security_code_hash, checked_in_at, checked_out_at)
     VALUES ($1, $2, $3, 'child', $4, $5, NOW() - $6::interval, CASE WHEN $7::text IS NULL THEN NULL ELSE NOW() - $7::interval END) RETURNING id`,
    [org.id, event.id, name, guardian, hash, inAgo, outAgo]).then(r => r.rows[0].id)
  return {
    old: await add('Synthetic Child Old', 'Synthetic Guardian', 'hash-old', '500 days', '500 days'),
    spent: await add('Synthetic Child Spent', 'Synthetic Guardian', 'hash-spent', '5 days', '5 days'),
    inRoom: await add('Synthetic Child In Room', 'Synthetic Guardian', 'hash-in-room', '5 days', null),
    recent: await add('Synthetic Child Recent', 'Synthetic Guardian', null, '1 day', '1 day'),
  }
}
const row = id => pool.query('SELECT person_name, guardian_name, security_code_hash, kind FROM ochr_checkins WHERE id = $1', [id]).then(r => r.rows[0])

async function expectRedacted(ids) {
  expect(await row(ids.old)).toEqual({ person_name: CHECKIN_REDACTED_NAME, guardian_name: null, security_code_hash: null, kind: 'child' })
  expect(await row(ids.spent)).toEqual({ person_name: 'Synthetic Child Spent', guardian_name: 'Synthetic Guardian', security_code_hash: null, kind: 'child' })
  // A child still in the room keeps the pickup code (existing policy).
  expect((await row(ids.inRoom)).security_code_hash).toBe('hash-in-room')
  expect(await row(ids.recent)).toEqual({ person_name: 'Synthetic Child Recent', guardian_name: 'Synthetic Guardian', security_code_hash: null, kind: 'child' })
}

describe('retention applies the existing check-in redaction to held and active parishes', () => {
  it('both parishes redacted; the held parish stays held and its other history is not pruned', async () => {
    const held = await parish('held'), live = await parish('live')
    const heldRows = await checkins(held), liveRows = await checkins(live)
    const { rows: [heldLog] } = await pool.query(
      `INSERT INTO ochr_notification_log (organization_id, notification_type, status, created_at)
       VALUES ($1, 'synthetic', 'sent', NOW() - INTERVAL '800 days') RETURNING id`, [held.id])
    expect((await hold(held)).status).toBe(200)

    const result = await pruneOldRecords()

    await expectRedacted(heldRows)
    await expectRedacted(liveRows)
    expect(result.checkin_pii_anonymized).toBeGreaterThanOrEqual(2)
    expect((await pool.query('SELECT held_at FROM ochr_organizations WHERE id = $1', [held.id])).rows[0].held_at).not.toBeNull()
    expect((await pool.query('SELECT id FROM ochr_notification_log WHERE id = $1', [heldLog.id])).rows).toHaveLength(1)
    // Re-running changes nothing more (idempotent, no new period).
    expect(await redactCheckins(held.id)).toEqual({ codesCleared: 0, piiAnonymized: 0 })
  })
})

describe('the held-organization redaction path admits redaction and nothing else', () => {
  let held, other, ids, otherIds
  beforeAll(async () => {
    held = await parish('narrow'); other = await parish('narrow_other')
    ids = await checkins(held); otherIds = await checkins(other)
    expect((await hold(held)).status).toBe(200)
    expect((await hold(other)).status).toBe(200)
  })
  async function asRedaction(orgId, sql, params) {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT set_config('ochr.checkin_redaction_org', $1, true)", [String(orgId)])
      const r = await c.query(sql, params)
      await c.query('ROLLBACK')
      return r
    } catch (err) { await c.query('ROLLBACK').catch(() => {}); throw err } finally { c.release() }
  }
  const refused = p => expect(p).rejects.toMatchObject({ code: '23514' })

  it('redaction of its own organization is admitted', async () => {
    const r = await asRedaction(held.id, `UPDATE ochr_checkins SET person_name = $2, guardian_name = NULL, security_code_hash = NULL WHERE id = $1`, [ids.recent, CHECKIN_REDACTED_NAME])
    expect(r.rowCount).toBe(1)
  })
  it('any other value, column, operation, table or organization is refused', async () => {
    await refused(asRedaction(held.id, 'UPDATE ochr_checkins SET person_name = $2 WHERE id = $1', [ids.recent, 'Someone Else']))
    await refused(asRedaction(held.id, 'UPDATE ochr_checkins SET guardian_name = $2 WHERE id = $1', [ids.recent, 'New Guardian']))
    await refused(asRedaction(held.id, 'UPDATE ochr_checkins SET security_code_hash = $2 WHERE id = $1', [ids.recent, 'new-hash']))
    await refused(asRedaction(held.id, `UPDATE ochr_checkins SET person_name = 'Redacted', kind = 'guest' WHERE id = $1`, [ids.recent]))
    await refused(asRedaction(held.id, `UPDATE ochr_checkins SET checked_out_at = NOW() WHERE id = $1`, [ids.inRoom]))
    await refused(asRedaction(held.id, 'DELETE FROM ochr_checkins WHERE id = $1', [ids.recent]))
    await refused(asRedaction(held.id,
      `INSERT INTO ochr_checkins (organization_id, calendar_event_id, person_name) SELECT organization_id, calendar_event_id, 'Synthetic' FROM ochr_checkins WHERE id = $1`, [ids.recent]))
    await refused(asRedaction(held.id, `UPDATE ochr_clients SET notes = NULL WHERE organization_id = $1`, [held.id]))
    // Marked for one held parish, writing another held parish's rows.
    await refused(asRedaction(held.id, `UPDATE ochr_checkins SET person_name = 'Redacted' WHERE id = $1`, [otherIds.recent]))
    // Without the mark.
    await refused(pool.query(`UPDATE ochr_checkins SET person_name = 'Redacted' WHERE id = $1`, [ids.recent]))
  })
  it('the mark does not outlive its transaction', async () => {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT set_config('ochr.checkin_redaction_org', $1, true)", [String(held.id)])
      await c.query('COMMIT')
      await refused(c.query(`UPDATE ochr_checkins SET person_name = 'Redacted' WHERE id = $1`, [ids.recent]))
    } finally { c.release() }
  })
})

describe('HOLD racing the redaction job', () => {
  it('a HOLD placed while redaction runs waits for it; the rows end redacted and the parish held', async () => {
    const org = await parish('race')
    const ids = await checkins(org)
    // Barrier: lock the old row so redaction stops inside its transaction,
    // holding the admission lock.
    const barrier = await pool.connect()
    let job, holding
    try {
      await barrier.query('BEGIN')
      await barrier.query('SELECT 1 FROM ochr_checkins WHERE id = $1 FOR UPDATE', [ids.old])
      job = redactCheckins(org.id)
      for (let i = 0; i < 200; i++) {
        const { rows } = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%UPDATE ochr_checkins%person_name%'`)
        if (rows.length) break
        await new Promise(r => setTimeout(r, 15))
      }
      holding = hold(org)
      await new Promise(r => setTimeout(r, 200))
      expect((await pool.query('SELECT held_at FROM ochr_organizations WHERE id = $1', [org.id])).rows[0].held_at).toBeNull()
      await barrier.query('COMMIT')
      expect(await job).toMatchObject({ piiAnonymized: 1 })
      expect((await holding).status).toBe(200)
    } finally {
      await barrier.query('ROLLBACK').catch(() => {}); barrier.release()
      await job?.catch(() => {}); await holding?.catch(() => {})
    }
    await expectRedacted(ids)
    expect((await pool.query('SELECT held_at FROM ochr_organizations WHERE id = $1', [org.id])).rows[0].held_at).not.toBeNull()
  })

  it('a HOLD committed before the job: the job still redacts, under the narrow path', async () => {
    const org = await parish('race2')
    const ids = await checkins(org)
    expect((await hold(org)).status).toBe(200)
    expect(await redactCheckins(org.id)).toEqual({ piiAnonymized: 1, codesCleared: 2 })
    await expectRedacted(ids)
  })
})

describe('one parish failing redaction does not stop the others', () => {
  it('the run still redacts later parishes, then reports the failure', async () => {
    const org = await parish('continue')
    const ids = await checkins(org)
    const connect = pool.connect.bind(pool)
    let failed = false
    const spy = vi.spyOn(pool, 'connect').mockImplementation((...cb) => {
      // pool.query uses the callback form; only redactCheckins' own
      // transaction is failed, once, for the first organization it visits.
      if (!cb.length && !failed) { failed = true; return Promise.reject(new Error('synthetic redaction failure')) }
      return connect(...cb)
    })
    try {
      await expect(pruneOldRecords()).rejects.toThrow(/Check-in redaction failed for 1 organization/)
    } finally { spy.mockRestore() }
    await expectRedacted(ids)
  })
})
