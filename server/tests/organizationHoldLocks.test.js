// Stage 6 — lock order between organization HOLD and everything that
// admits a write for that organization.
//
// HOLD locks the organization first. Every other path must take the
// organization admission lock before any user/profile row lock, or a HOLD
// that already owns the organization and waits on a user row can deadlock
// against a writer that owns the user row and waits on the organization.
// These tests drive that interleaving with separate connections and a
// barrier (a held lock on the lowest-id user), then require: no deadlock,
// HOLD completes, and the late write is refused by the hold.
//
// Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { holdOrganization } from '../src/auth/organizationHold.js'
import { closeLogin } from '../src/auth/loginClosure.js'
import { deactivateLogin, reactivateLogin } from '../src/auth/loginDeactivation.js'

let server
const orgIds = []
let sequence = 1
const auth = token => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => { await migrateOnce(); server = await bindServer() }, 60000)
afterAll(async () => {
  for (const id of orgIds) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server); await pool.end()
})

async function parish(tag) {
  const name = `HoldLock ${tag} ${RUN_ID}`
  const res = await createOrg(server, { organizationName: name, name: 'Synthetic Admin', email: `holdlock_${tag}_${RUN_ID}@example.com`, password: 'holdlock-test-pw' }, `10.94.${sequence++}.1`)
  expect(res.status).toBe(201)
  const org = { id: res.body.user.organization.id, name, userId: res.body.user.id, token: res.body.token }
  orgIds.push(org.id)
  const staff = await request(server).post('/api/users').set(auth(org.token)).send({ name: 'Synthetic Staff', email: `holdlock_staff_${tag}_${RUN_ID}@example.com`, password: 'holdlock-test-pw', role: 'staff' })
  expect(staff.status).toBe(201)
  org.staffId = staff.body.id
  expect(org.staffId).toBeGreaterThan(org.userId)
  return org
}

const settle = p => p.then(value => ({ value }), error => ({ error }))
const pidOf = async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid

async function waitUntil(fn, label) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 15)) }
  throw new Error(`timed out waiting: ${label}`)
}
const blockedBy = async pid => (await pool.query(
  'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS b', [pid]
)).rows[0].b
const isBlocked = async pid => (await pool.query('SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS b', [pid])).rows[0].b

// Barrier: hold a SHARE lock on the admin row (lowest id) so HOLD owns the
// organization and then waits on users. While it waits, `writer` runs the
// statement under test. Then the barrier is released.
async function raceHoldAgainst(org, statement) {
  const barrier = await pool.connect()
  const writer = await pool.connect()
  try {
    await barrier.query('BEGIN')
    await barrier.query('SELECT 1 FROM ochr_users WHERE id = $1 FOR SHARE', [org.userId])
    const barrierPid = await pidOf(barrier)
    const hold = settle(holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true }))
    await waitUntil(() => blockedBy(barrierPid), 'HOLD waiting behind the barrier')

    await writer.query('BEGIN')
    const writerPid = await pidOf(writer)
    let writeDone = false
    // End the writer's transaction as soon as its statement settles, so a
    // HOLD that waits on the writer's row lock is released by the writer,
    // not by the test.
    const write = settle(statement(writer)).then(async result => {
      await writer.query(result.error ? 'ROLLBACK' : 'COMMIT').catch(() => {})
      return result
    }).finally(() => { writeDone = true })
    await waitUntil(async () => writeDone || await isBlocked(writerPid), 'writer blocked or finished')

    await barrier.query('COMMIT')
    const [holdResult, writeResult] = await Promise.all([hold, write])
    return { hold: holdResult, write: writeResult }
  } finally {
    await barrier.query('ROLLBACK').catch(() => {})
    await writer.query('ROLLBACK').catch(() => {})
    barrier.release(); writer.release()
  }
}

function expectNoDeadlockHoldWinsWriteRefused(r) {
  expect(r.hold.error?.code, 'HOLD must not deadlock').not.toBe('40P01')
  expect(r.write.error?.code, 'writer must not deadlock').not.toBe('40P01')
  expect(r.hold.error).toBeUndefined()
  expect(r.hold.value.status).toBe(200)
  expect(r.write.error?.code).toBe('23514')
}

describe('HOLD vs capability and copy writes on a user row (separate connections, barrier)', () => {
  it('push subscription INSERT', async () => {
    const org = await parish('push')
    const r = await raceHoldAgainst(org, c => c.query(
      `INSERT INTO ochr_push_subscriptions (organization_id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, 'k', 'a')`,
      [org.id, org.staffId, `https://push.invalid/${org.id}/${RUN_ID}`]
    ))
    expectNoDeadlockHoldWinsWriteRefused(r)
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM ochr_push_subscriptions WHERE organization_id = $1', [org.id])).rows[0].n).toBe(0)
  })

  it('password reset / invitation token INSERT', async () => {
    const org = await parish('reset')
    const r = await raceHoldAgainst(org, c => c.query(
      `INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [org.staffId, `holdlock-${org.id}-${RUN_ID}`]
    ))
    expectNoDeadlockHoldWinsWriteRefused(r)
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM ochr_password_reset_tokens WHERE user_id = $1', [org.staffId])).rows[0].n).toBe(0)
  })

  it('feedback ledger INSERT', async () => {
    const org = await parish('feedback')
    const r = await raceHoldAgainst(org, c => c.query(
      `INSERT INTO ochr_feedback_ledger (organization_id, user_id, category, message) VALUES ($1, $2, 'bug', 'synthetic')`,
      [org.id, org.staffId]
    ))
    expectNoDeadlockHoldWinsWriteRefused(r)
  })

  it('an UPDATE on a user-owned row admitted before HOLD: no deadlock, a defined order', async () => {
    const org = await parish('update')
    const r = await raceHoldAgainst(org, c => c.query(
      'UPDATE ochr_users SET pastoral_lead = TRUE WHERE id = $1 AND organization_id = $2', [org.staffId, org.id]
    ))
    expect(r.hold.error?.code).not.toBe('40P01')
    expect(r.write.error?.code).not.toBe('40P01')
    expect(r.hold.value?.status).toBe(200)
    // Either the write was admitted before HOLD (and HOLD then waited for it),
    // or it was refused by the hold. Never both, never a deadlock.
    expect([undefined, '23514']).toContain(r.write.error?.code)
  })
})

describe('account operations and HOLD share the organization admission boundary', () => {
  for (const [label, run, prepare] of [
    ['closure', org => closeLogin({ organizationId: org.id, targetId: org.staffId, closedBy: org.userId })],
    ['deactivation', org => deactivateLogin({ organizationId: org.id, targetId: org.staffId })],
    ['reactivation', org => reactivateLogin({ organizationId: org.id, targetId: org.staffId }),
      org => deactivateLogin({ organizationId: org.id, targetId: org.staffId })],
  ]) {
    it(`${label} started first: HOLD waits for it, then wins; no deadlock`, async () => {
      const org = await parish(`first_${label}`)
      if (prepare) expect((await prepare(org)).status).toBe(200)
      // The operation holds the admission lock; HOLD must wait behind it.
      const barrier = await pool.connect()
      try {
        await barrier.query('BEGIN')
        await barrier.query('SELECT 1 FROM ochr_users WHERE id = $1 FOR SHARE', [org.staffId])
        const barrierPid = await pidOf(barrier)
        const op = settle(run(org))
        await waitUntil(() => blockedBy(barrierPid), `${label} waiting behind barrier`)
        const hold = settle(holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true }))
        await new Promise(r => setTimeout(r, 150))
        await barrier.query('COMMIT')
        const [opResult, holdResult] = await Promise.all([op, hold])
        expect(opResult.error?.code).not.toBe('40P01')
        expect(holdResult.error?.code).not.toBe('40P01')
        expect(opResult.value.status).toBe(200)
        expect(holdResult.value.status).toBe(200)
      } finally { await barrier.query('ROLLBACK').catch(() => {}); barrier.release() }
    })
  }

  for (const [label, barrierSql, request_] of [
    ['role change (HTTP)', 'SELECT 1 FROM ochr_users WHERE id = $1 FOR SHARE',
      (org) => request(server).patch(`/api/users/${org.staffId}/role`).set(auth(org.token)).send({ role: 'viewer' })],
    ['profile minimization (HTTP)', 'SELECT 1 FROM ochr_clients WHERE id = $1 FOR SHARE',
      (org) => request(server).post(`/api/clients/${org.clientId}/deidentify`).set(auth(org.token)).send({ confirm: 'DEIDENTIFY', acknowledge_history_retained: true })],
  ]) {
    it(`${label} started first: HOLD waits for it, then wins; no deadlock`, async () => {
      const org = await parish(`http_${label.split(' ')[0]}`)
      const c = await request(server).post('/api/clients').set(auth(org.token)).send({ name: 'Synthetic Member', email: `holdlock_member_${org.id}@example.com` })
      expect(c.status).toBe(201)
      org.clientId = c.body.id
      const barrier = await pool.connect()
      try {
        await barrier.query('BEGIN')
        await barrier.query(barrierSql, [label.startsWith('role') ? org.staffId : org.clientId])
        const barrierPid = await pidOf(barrier)
        const op = settle(request_(org))
        await waitUntil(() => blockedBy(barrierPid), `${label} waiting behind barrier`)
        const hold = settle(holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true }))
        await new Promise(r => setTimeout(r, 150))
        await barrier.query('COMMIT')
        const [opResult, holdResult] = await Promise.all([op, hold])
        expect(opResult.error).toBeUndefined()
        expect(opResult.value.status).toBe(200)
        expect(holdResult.error?.code).not.toBe('40P01')
        expect(holdResult.value.status).toBe(200)
      } finally { await barrier.query('ROLLBACK').catch(() => {}); barrier.release() }
    })
  }

  it('after HOLD, every account operation is refused with 409 and changes nothing', async () => {
    const org = await parish('after')
    expect((await holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true })).status).toBe(200)
    const before = (await pool.query('SELECT closed_at, deactivated_at, token_version, role FROM ochr_users WHERE id = $1', [org.staffId])).rows[0]
    for (const op of [
      () => closeLogin({ organizationId: org.id, targetId: org.staffId, closedBy: org.userId }),
      () => deactivateLogin({ organizationId: org.id, targetId: org.staffId }),
      () => reactivateLogin({ organizationId: org.id, targetId: org.staffId }),
    ]) expect((await op()).status).toBe(409)
    expect((await pool.query('SELECT closed_at, deactivated_at, token_version, role FROM ochr_users WHERE id = $1', [org.staffId])).rows[0]).toEqual(before)
  })
})
