// Stage 6 — a held organization issues no usable capability through the
// pre-auth and invitation doors, including requests admitted just before
// HOLD committed. Pre-auth replies stay generic where they were generic.
//
// "Mid-hold" below: a barrier transaction sets held_at but has not
// committed. A request reads the organization as not held, proceeds, and
// its capability write then waits on the admission lock; when the barrier
// commits, the database refuses the write (migrations 113/114) and the
// route must answer honestly instead of issuing a link or failing with 500.
//
// Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import crypto from 'node:crypto'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { holdOrganization, ORGANIZATION_HELD } from '../src/auth/organizationHold.js'
import { tombstoneEmail } from '../src/auth/loginClosure.js'

let server
const orgIds = []
let sequence = 1
const PW = 'holdauth-test-pw'
const auth = token => ({ Authorization: `Bearer ${token}` })
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex')

beforeAll(async () => { await migrateOnce(); server = await bindServer() }, 60000)
afterAll(async () => {
  for (const id of orgIds) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server); await pool.end()
})

async function parish(tag) {
  const name = `HoldAuth ${tag} ${RUN_ID}`
  const res = await createOrg(server, { organizationName: name, name: 'Synthetic Admin', email: `holdauth_${tag}_${RUN_ID}@example.com`, password: PW }, `10.95.${sequence++}.1`)
  expect(res.status).toBe(201)
  const org = { id: res.body.user.organization.id, name, userId: res.body.user.id, token: res.body.token }
  orgIds.push(org.id)
  org.staffEmail = `holdauth_staff_${tag}_${RUN_ID}@example.com`
  const staff = await request(server).post('/api/users').set(auth(org.token)).send({ name: 'Synthetic Staff', email: org.staffEmail, password: PW, role: 'staff' })
  expect(staff.status).toBe(201)
  org.staffId = staff.body.id
  return org
}
const hold = org => holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true })
const tokenCount = async userId => (await pool.query('SELECT COUNT(*)::int AS n FROM ochr_password_reset_tokens WHERE user_id = $1 AND used_at IS NULL', [userId])).rows[0].n

// Backend pids of this worker's pool (pg-pool keeps its clients in _clients).
const ownPoolPids = () => (pool._clients || []).map(c => c.processID).filter(Number.isInteger)

async function quiescePool() {
  for (let i = 0; i < 400; i++) {
    if (pool.waitingCount === 0 && pool.totalCount === pool.idleCount) return
    await new Promise(res => setTimeout(res, 10))
  }
  throw new Error('pool did not quiesce: earlier work still holds a connection')
}

// A HOLD in flight: held_at written, not committed.
async function midHold(org, during) {
  // Second cause (CI run 39090047177, same 401): the audit write of an
  // EARLIER request in this test (parish() creating its staff login) is
  // fire-and-forget on res 'finish' (middleware/auditLog.js). Its INSERT into
  // ochr_audit_log fires the HOLD guard trigger, which takes FOR KEY SHARE on
  // this org row, so under load it is an own-pool backend blocked by the
  // barrier, and the pid check alone accepted it. Quiesce first: no
  // checked-out or waiting pool client may remain from earlier requests, so
  // any own-pool backend the barrier blocks afterwards belongs to `during`.
  await quiescePool()
  const barrier = await pool.connect()
  try {
    await barrier.query('BEGIN')
    await barrier.query('SELECT 1 FROM ochr_organizations WHERE id = $1 FOR UPDATE', [org.id])
    await barrier.query('UPDATE ochr_organizations SET held_at = NOW(), held_by = $2 WHERE id = $1', [org.id, org.userId])
    const barrierPid = (await barrier.query('SELECT pg_backend_pid() AS p')).rows[0].p
    // supertest only sends on .then(); start the request now.
    const pending = new Promise((resolve, reject) => during().then(resolve, reject))
    // Let the request run until IT waits on the barrier. Main CI f2131af7
    // (run 39086121269) failed because this used to accept ANY backend
    // blocked by the barrier: a backend from another test worker that queued
    // on this org row tripped it before the request reached the server, the
    // barrier committed, and the request then met the committed HOLD in the
    // auth middleware (401 instead of the admission path's 409/403).
    // The server runs in this worker on this module's pool, and nothing else
    // in this worker touches the row while the request is in flight, so "the
    // request's backend" is a backend owned by THIS pool (by pid) that the
    // barrier is blocking. Re-read each poll: the request may open a new one.
    let blocked = false
    for (let i = 0; i < 200 && !blocked; i++) {
      const ownPids = ownPoolPids().filter(p => p !== barrierPid)
      const { rows: [r] } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                         WHERE pid = ANY($2::int[]) AND $1::int = ANY(pg_blocking_pids(pid))) AS b`,
        [barrierPid, ownPids]
      )
      blocked = r.b
      if (!blocked) await new Promise(res => setTimeout(res, 15))
    }
    // The race must actually be exercised: the request is waiting on HOLD.
    expect(blocked, 'request reached the admission lock while HOLD was in flight').toBe(true)
    await barrier.query('COMMIT')
    return await pending
  } finally {
    await barrier.query('ROLLBACK').catch(() => {})
    barrier.release()
  }
}

describe('login', () => {
  it('a held organization refuses sign-in only after the password matched; wrong password stays generic', async () => {
    const org = await parish('login')
    // held_at committed but revocation not yet run: the login check alone must stop it.
    await pool.query('UPDATE ochr_organizations SET held_at = NOW(), held_by = $2 WHERE id = $1', [org.id, org.userId])
    const ok = await request(server).post('/api/auth/login').send({ email: org.staffEmail, password: PW })
    expect(ok.status).toBe(403)
    expect(ok.body).toEqual({ error: ORGANIZATION_HELD })
    expect(ok.body.token).toBeUndefined()
    const wrong = await request(server).post('/api/auth/login').send({ email: org.staffEmail, password: 'not-the-password' })
    const unknown = await request(server).post('/api/auth/login').send({ email: `nobody_${RUN_ID}@example.com`, password: 'not-the-password' })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body).toEqual(unknown.body)
  })
})

describe('forgot-password', () => {
  it('held organization: generic reply, no link stored, no email sent', async () => {
    const org = await parish('forgot')
    await hold(org)
    const log = vi.spyOn(console, 'log')
    try {
      const held = await request(server).post('/api/auth/forgot-password').send({ email: org.staffEmail })
      const unknown = await request(server).post('/api/auth/forgot-password').send({ email: `nobody_${RUN_ID}@example.com` })
      expect(held.status).toBe(200)
      expect(held.body).toEqual(unknown.body)
      expect(log.mock.calls.flat().join('\n')).not.toContain(org.staffEmail)
    } finally { log.mockRestore() }
    expect(await tokenCount(org.staffId)).toBe(0)
  })

  it('mid-hold: request admitted before HOLD commits gets the generic reply and no link', async () => {
    const org = await parish('forgot_race')
    const log = vi.spyOn(console, 'log')
    let res
    try {
      res = await midHold(org, () => request(server).post('/api/auth/forgot-password').send({ email: org.staffEmail }))
      expect(log.mock.calls.flat().join('\n')).not.toContain(`TO:      ${org.staffEmail}`)
    } finally { log.mockRestore() }
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, message: 'If that email is registered, a reset link has been sent.' })
    expect(await tokenCount(org.staffId)).toBe(0)
  })
})

describe('reset-password and accept-invite', () => {
  async function plantToken(userId) {
    const raw = crypto.randomBytes(32).toString('base64url')
    await pool.query(`INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`, [userId, sha(raw)])
    return raw
  }

  it('a reset link issued before HOLD cannot set a password after it', async () => {
    const org = await parish('reset')
    const raw = await plantToken(org.staffId)
    const before = (await pool.query('SELECT password_hash FROM ochr_users WHERE id = $1', [org.staffId])).rows[0].password_hash
    // The window between HOLD committing and its revocation phase deleting
    // outstanding links: held_at set, the link still present.
    await pool.query('UPDATE ochr_organizations SET held_at = NOW(), held_by = $2 WHERE id = $1', [org.id, org.userId])
    expect(await tokenCount(org.staffId)).toBe(1)
    const res = await request(server).post('/api/auth/reset-password').send({ token: raw, password: 'new-password-123' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: ORGANIZATION_HELD })
    expect((await pool.query('SELECT password_hash FROM ochr_users WHERE id = $1', [org.staffId])).rows[0].password_hash).toBe(before)
  })

  it('mid-hold: a reset admitted before HOLD commits is refused honestly, not 500, and changes nothing', async () => {
    const org = await parish('reset_race')
    const raw = await plantToken(org.staffId)
    const before = (await pool.query('SELECT password_hash, token_version FROM ochr_users WHERE id = $1', [org.staffId])).rows[0]
    const res = await midHold(org, () => request(server).post('/api/auth/reset-password').send({ token: raw, password: 'new-password-123' }))
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: ORGANIZATION_HELD })
    expect((await pool.query('SELECT password_hash, token_version FROM ochr_users WHERE id = $1', [org.staffId])).rows[0]).toEqual(before)
  })

  it('an invitation accepted after HOLD: refused, no session', async () => {
    const org = await parish('invite')
    const inv = await request(server).post('/api/users/invite').set(auth(org.token)).send({ name: 'Synthetic Invitee', email: `holdauth_invitee_${RUN_ID}@example.com`, role: 'staff' })
    expect(inv.status).toBe(201)
    const raw = new URL(inv.body.invite.url).searchParams.get('token')
    await pool.query('UPDATE ochr_organizations SET held_at = NOW(), held_by = $2 WHERE id = $1', [org.id, org.userId])
    const res = await request(server).post('/api/auth/accept-invite').send({ token: raw, password: 'new-password-123' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: ORGANIZATION_HELD })
    expect(res.body.token).toBeUndefined()
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('mid-hold: invitation acceptance admitted before HOLD commits is refused, no session', async () => {
    const org = await parish('invite_race')
    const inv = await request(server).post('/api/users/invite').set(auth(org.token)).send({ name: 'Synthetic Invitee', email: `holdauth_invitee2_${RUN_ID}@example.com`, role: 'staff' })
    const raw = new URL(inv.body.invite.url).searchParams.get('token')
    const res = await midHold(org, () => request(server).post('/api/auth/accept-invite').send({ token: raw, password: 'new-password-123' }))
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: ORGANIZATION_HELD })
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})

describe('midHold() waits for the request itself, not any blocked backend', () => {
  it('a foreign backend queued on the barrier does not release HOLD before the request arrives (still 409)', async () => {
    const org = await parish('midhold_foreign')
    const pg = (await import('pg')).default
    // Outside this pool, like another test worker's connection.
    const foreign = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await foreign.connect()
    try {
      const res = await midHold(org, async () => {
        await foreign.query('BEGIN')
        // KEY SHARE: conflicts with the barrier's FOR UPDATE, not with the
        // request's own admission lock, so it never blocks the request.
        foreign.query('SELECT 1 FROM ochr_organizations WHERE id = $1 FOR KEY SHARE', [org.id]).catch(() => {})
        await new Promise(r => setTimeout(r, 400)) // the request is late
        return request(server).post('/api/users/invite').set(auth(org.token))
          .send({ name: 'Synthetic Late', email: `holdauth_foreign_${RUN_ID}@example.com`, role: 'staff' })
      })
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: ORGANIZATION_HELD })
    } finally {
      await foreign.query('ROLLBACK').catch(() => {})
      await foreign.end().catch(() => {})
    }
  })
})

describe('midHold() ignores an earlier request\'s pending audit write', () => {
  it('a late audit INSERT for this org blocked on the barrier does not release HOLD early (still 409)', async () => {
    const org = await parish('midhold_audit')
    const pg = (await import('pg')).default
    const gate = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await gate.connect()
    try {
      // Delay the next audit write: it waits on this table lock.
      await gate.query('BEGIN')
      await gate.query('LOCK TABLE ochr_audit_log IN EXCLUSIVE MODE')
      const staff = await request(server).post('/api/users').set(auth(org.token))
        .send({ name: 'Synthetic Audit', email: `holdauth_audit_${RUN_ID}@example.com`, password: PW, role: 'staff' })
      expect(staff.status).toBe(201)
      // The audit INSERT is now pending in this pool. Let it go shortly.
      setTimeout(() => { gate.query('COMMIT').catch(() => {}) }, 200)
      const res = await midHold(org, async () => {
        await new Promise(r => setTimeout(r, 400)) // the request is late
        return request(server).post('/api/users/invite').set(auth(org.token))
          .send({ name: 'Synthetic Late', email: `holdauth_auditlate_${RUN_ID}@example.com`, role: 'staff' })
      })
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: ORGANIZATION_HELD })
    } finally {
      await gate.query('ROLLBACK').catch(() => {})
      await gate.end().catch(() => {})
    }
  })
})

describe('admin-issued invitation links', () => {
  it('mid-hold: an invitation admitted before HOLD commits issues no link (409, not 500)', async () => {
    const org = await parish('admin_invite')
    const res = await midHold(org, () => request(server).post('/api/users/invite').set(auth(org.token)).send({ name: 'Synthetic Late', email: `holdauth_late_${RUN_ID}@example.com`, role: 'staff' }))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: ORGANIZATION_HELD })
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM ochr_users WHERE email = $1', [`holdauth_late_${RUN_ID}@example.com`])).rows[0].n).toBe(0)
  })

  it('mid-closure: a resend admitted before the closure commits issues no link (409, not 500)', async () => {
    const org = await parish('resend_closed')
    const inv = await request(server).post('/api/users/invite').set(auth(org.token)).send({ name: 'Synthetic Pending', email: `holdauth_pending_${RUN_ID}@example.com`, role: 'staff' })
    const pendingId = inv.body.user.id
    const barrier = await pool.connect()
    let res
    try {
      await barrier.query('BEGIN')
      // The closure's own row change, uncommitted (loginClosure.js shape).
      await barrier.query(`UPDATE ochr_users SET closed_at = NOW(), deactivated_at = COALESCE(deactivated_at, NOW()), email = $2, name = '', avatar = NULL WHERE id = $1`, [pendingId, tombstoneEmail(pendingId)])
      const barrierPid = (await barrier.query('SELECT pg_backend_pid() AS p')).rows[0].p
      const pending = new Promise((resolve, reject) => request(server).post(`/api/users/${pendingId}/invite/resend`).set(auth(org.token)).then(resolve, reject))
      let blocked = false
      for (let i = 0; i < 200 && !blocked; i++) {
        blocked = (await pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS b', [barrierPid])).rows[0].b
        if (!blocked) await new Promise(r => setTimeout(r, 15))
      }
      expect(blocked, 'resend reached the capability lock while closure was in flight').toBe(true)
      await barrier.query('COMMIT')
      res = await pending
    } finally { await barrier.query('ROLLBACK').catch(() => {}); barrier.release() }
    expect(res.status).toBe(409)
    expect(res.body.invite).toBeUndefined()
    expect(await tokenCount(pendingId)).toBe(0)
  })
})
