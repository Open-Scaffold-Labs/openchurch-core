// Level A — reversible login deactivation.
//
// The login row stays. Sessions die. A password reset and an invitation
// do not turn the login back on. The last active admin cannot be
// deactivated, demoted, or deleted, including when those operations race.
// The race holds the login rows, starts both HTTP calls, and releases
// only after both are blocked. Removing FOR UPDATE from
// lockLoginForAdminCount lets both writes commit. A member, a gift, a
// sacramental snapshot, and an issued giving snapshot are not rewritten.
//
// This is not account deletion.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'node:crypto'
import pg from 'pg'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { ONLY_ACTIVE_ADMIN, DEACTIVATED_LOGIN, PASSWORD_DOES_NOT_REACTIVATE } from '../src/auth/loginDeactivation.js'
import { signToken } from '../src/middleware/auth.js'

let server
const cleanupOrgIds = []
let ip = 1

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

const auth = (token) => ({ Authorization: `Bearer ${token}` })

async function signup(tag) {
  const email = `deact_${tag}_${RUN_ID}@example.com`
  const password = 'deact-test-pw'
  const res = await createOrg(server, {
    organizationName: `Deact ${tag} ${RUN_ID}`,
    name: 'Parish Admin',
    email,
    password,
  }, `10.88.${ip++}.1`)
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return {
    token: res.body.token,
    orgId: res.body.user.organization.id,
    userId: res.body.user.id,
    email,
    password,
  }
}

async function addUser(adminToken, { name, email, password, role }) {
  const res = await request(server).post('/api/users').set(auth(adminToken)).send({
    name, email, password, role,
  })
  expect(res.status).toBe(201)
  const login = await request(server).post('/api/auth/login').send({ email, password })
  expect(login.status).toBe(200)
  return { id: res.body.id, token: login.body.token, email, password }
}

async function versionOf(userId) {
  const { rows } = await pool.query(
    'SELECT token_version, deactivated_at, email, name, role, password_hash FROM ochr_users WHERE id = $1',
    [userId]
  )
  return rows[0]
}

async function activeAdminCount(orgId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ochr_users
      WHERE organization_id = $1 AND role = 'admin' AND deactivated_at IS NULL`,
    [orgId]
  )
  return rows[0].n
}

// Hold the named login rows so the HTTP handlers block inside their
// transaction. The caller starts the requests, waits until that many
// sessions are stuck on the lock, then this function commits and the
// handlers run. With the shared FOR UPDATE they re-check after the wait.
// Without it they already counted, and the blocked statement is the write.
async function releaseAfterBlocked(orgId, userIds, start, waiters) {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  const pending = []
  try {
    await holder.query('BEGIN')
    await holder.query(
      `SELECT id FROM ochr_users
        WHERE organization_id = $1 AND id = ANY($2::int[])
        ORDER BY id
        FOR UPDATE`,
      [orgId, userIds]
    )
    // Promise.resolve calls then() on the superagent thenable, which is
    // what actually sends the request. Holding the bare thenable does not.
    pending.push(...start().map(req => Promise.resolve(req)))
    await waitForBlockedUsersQueries(waiters)
    await holder.query('COMMIT')
  } catch (err) {
    await holder.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await holder.end()
    if (pending.length) await Promise.allSettled(pending)
  }
  return Promise.all(pending)
}

async function waitForBlockedUsersQueries(min) {
  const start = Date.now()
  let last = []
  while (Date.now() - start < 8000) {
    const { rows } = await pool.query(
      `SELECT pid, wait_event_type, left(query, 160) AS query
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query ILIKE '%ochr_users%'`
    )
    last = rows
    if (rows.length >= min) return
    await new Promise(r => setTimeout(r, 40))
  }
  const activity = await pool.query(
    `SELECT pid, state, wait_event_type, wait_event, left(query, 140) AS query
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`
  )
  throw new Error(
    `timed out waiting for ${min} blocked ochr_users queries; blocked=${JSON.stringify(last)} activity=${JSON.stringify(activity.rows)}`
  )
}

describe('login deactivation', () => {
  it('a staff member can turn their own login off, and the old session dies', async () => {
    const admin = await signup('self')
    const staff = await addUser(admin.token, {
      name: 'Staff', email: `deact_staff_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'staff',
    })
    const before = await versionOf(staff.id)
    const off = await request(server).post('/api/auth/deactivate').set(auth(staff.token))
    expect(off.status).toBe(200)
    expect(off.body).toEqual({ deactivated: true, already: false })
    expect(JSON.stringify(off.body)).not.toMatch(/delet/i)

    const after = await versionOf(staff.id)
    expect(after.token_version).toBe(before.token_version + 1)
    expect(after.deactivated_at).toBeTruthy()
    expect(after.email).toBe(before.email)
    expect(after.name).toBe(before.name)
    expect(after.role).toBe(before.role)
    expect(after.password_hash).toBe(before.password_hash)

    const me = await request(server).get('/api/auth/me').set(auth(staff.token))
    expect(me.status).toBe(401)

    const again = await request(server).post('/api/auth/login').send({
      email: staff.email, password: staff.password,
    })
    expect(again.status).toBe(403)
    expect(again.body.error).toBe(DEACTIVATED_LOGIN)

    const wrong = await request(server).post('/api/auth/login').send({
      email: staff.email, password: 'not-the-password',
    })
    expect(wrong.status).toBe(401)

    // The deactivated flag refuses the old token even if the version is
    // put back. A version bump that was forgotten would not save this.
    await pool.query('UPDATE ochr_users SET token_version = $2 WHERE id = $1', [staff.id, before.token_version])
    const still = await request(server).get('/api/auth/me').set(auth(staff.token))
    expect(still.status).toBe(401)
    expect(still.body.error).toMatch(/deactivated/i)

    // Clearing the flag without going through reactivation leaves the
    // bumped version in place, so the old token stays dead.
    await pool.query('UPDATE ochr_users SET deactivated_at = NULL WHERE id = $1', [staff.id])
    await pool.query('UPDATE ochr_users SET token_version = $2 WHERE id = $1', [staff.id, before.token_version + 1])
    const expired = await request(server).get('/api/auth/me').set(auth(staff.token))
    expect(expired.status).toBe(401)
  })

  it('the only active admin cannot deactivate, even under two concurrent requests', async () => {
    const alone = await signup('alone')
    const refused = await request(server).post('/api/auth/deactivate').set(auth(alone.token))
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(ONLY_ACTIVE_ADMIN)
    const me = await request(server).get('/api/auth/me').set(auth(alone.token))
    expect(me.status).toBe(200)

    const pair = await signup('race')
    const other = await addUser(pair.token, {
      name: 'Other Admin', email: `deact_other_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'admin',
    })
    const [left, right] = await Promise.all([
      request(server).post(`/api/users/${other.id}/deactivate`).set(auth(pair.token)),
      request(server).post(`/api/users/${pair.userId}/deactivate`).set(auth(other.token)),
    ])
    const statuses = [left.status, right.status].sort()
    expect(statuses).toEqual([200, 409])
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_users
        WHERE organization_id = $1 AND role = 'admin' AND deactivated_at IS NULL`,
      [pair.orgId]
    )
    expect(rows[0].n).toBe(1)
  })

  it('a second admin can turn a login off and back on without reviving the old session', async () => {
    const admin = await signup('cycle')
    const staff = await addUser(admin.token, {
      name: 'Cycle Staff', email: `deact_cycle_staff_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'staff',
    })
    const off = await request(server).post(`/api/users/${staff.id}/deactivate`).set(auth(admin.token))
    expect(off.status).toBe(200)
    const version = (await versionOf(staff.id)).token_version

    const repeat = await request(server).post(`/api/users/${staff.id}/deactivate`).set(auth(admin.token))
    expect(repeat.body).toEqual({ deactivated: true, already: true })
    expect((await versionOf(staff.id)).token_version).toBe(version)

    const on = await request(server).post(`/api/users/${staff.id}/reactivate`).set(auth(admin.token))
    expect(on.status).toBe(200)
    expect(on.body).toEqual({ reactivated: true, already: false })
    expect(on.body.token).toBeUndefined()
    expect((await versionOf(staff.id)).token_version).toBe(version + 1)
    expect((await versionOf(staff.id)).deactivated_at).toBeNull()

    const old = await request(server).get('/api/auth/me').set(auth(staff.token))
    expect(old.status).toBe(401)
    const fresh = await request(server).post('/api/auth/login').send({
      email: staff.email, password: staff.password,
    })
    expect(fresh.status).toBe(200)

    const listed = await request(server).get('/api/users').set(auth(admin.token))
    const row = listed.body.find(u => u.id === staff.id)
    expect(row.deactivated).toBe(false)

    const off2 = await request(server).post(`/api/users/${staff.id}/deactivate`).set(auth(admin.token))
    expect(off2.status).toBe(200)
    const listedOff = await request(server).get('/api/users').set(auth(admin.token))
    expect(listedOff.body.find(u => u.id === staff.id).deactivated).toBe(true)
  })

  it('another parish cannot deactivate this login', async () => {
    const home = await signup('home')
    const away = await signup('away')
    const res = await request(server).post(`/api/users/${home.userId}/deactivate`).set(auth(away.token))
    expect(res.status).toBe(404)
    const me = await request(server).get('/api/auth/me').set(auth(home.token))
    expect(me.status).toBe(200)
    const staffTry = await addUser(home.token, {
      name: 'No Admin', email: `deact_noadmin_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'staff',
    })
    const denied = await request(server).post(`/api/users/${home.userId}/deactivate`).set(auth(staffTry.token))
    expect(denied.status).toBe(403)
  })

  it('a reset link and an invitation do not turn a deactivated login back on', async () => {
    const admin = await signup('loops')
    const staff = await addUser(admin.token, {
      name: 'Loop Staff', email: `deact_loop_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'staff',
    })
    const raw = `reset-${RUN_ID}-loop`
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex')
    await pool.query(
      `INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + interval '1 hour')`,
      [staff.id, tokenHash]
    )
    await request(server).post(`/api/users/${staff.id}/deactivate`).set(auth(admin.token))
    const hashBefore = (await versionOf(staff.id)).password_hash

    const reset = await request(server).post('/api/auth/reset-password').send({
      token: raw, password: 'replacement-pw-1',
    })
    expect(reset.status).toBe(403)
    expect((await versionOf(staff.id)).password_hash).toBe(hashBefore)
    expect((await versionOf(staff.id)).deactivated_at).toBeTruthy()

    const tokensBefore = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_password_reset_tokens WHERE user_id = $1',
      [staff.id]
    )
    const forgot = await request(server).post('/api/auth/forgot-password').send({ email: staff.email })
    expect(forgot.status).toBe(200)
    const tokensAfter = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_password_reset_tokens WHERE user_id = $1',
      [staff.id]
    )
    expect(tokensAfter.rows[0].n).toBe(tokensBefore.rows[0].n)

    await request(server).post(`/api/users/${staff.id}/reactivate`).set(auth(admin.token))
    const oldPassword = await request(server).post('/api/auth/login').send({
      email: staff.email, password: staff.password,
    })
    expect(oldPassword.status).toBe(200)
    const newPassword = await request(server).post('/api/auth/login').send({
      email: staff.email, password: 'replacement-pw-1',
    })
    expect(newPassword.status).toBe(401)

    const invite = await request(server).post('/api/users/invite').set(auth(admin.token)).send({
      name: 'Invited', email: `deact_inv_${RUN_ID}@example.com`, role: 'staff',
    })
    expect(invite.status).toBe(201)
    const inviteToken = new URL(invite.body.invite.url).searchParams.get('token')
    const inviteeId = invite.body.user.id
    await request(server).post(`/api/users/${inviteeId}/deactivate`).set(auth(admin.token))
    const accept = await request(server).post('/api/auth/accept-invite').send({
      token: inviteToken, password: 'invitee-chose-99',
    })
    expect(accept.status).toBe(403)
    expect(accept.body.token).toBeUndefined()
    const pending = await pool.query(
      'SELECT invite_accepted_at, deactivated_at FROM ochr_users WHERE id = $1',
      [inviteeId]
    )
    expect(pending.rows[0].invite_accepted_at).toBeNull()
    expect(pending.rows[0].deactivated_at).toBeTruthy()

    const resend = await request(server).post(`/api/users/${inviteeId}/invite/resend`).set(auth(admin.token))
    expect(resend.status).toBe(409)

    await request(server).post(`/api/users/${inviteeId}/reactivate`).set(auth(admin.token))
    const accepted = await request(server).post('/api/auth/accept-invite').send({
      token: inviteToken, password: 'invitee-chose-99',
    })
    expect(accepted.status).toBe(200)
    expect(accepted.body.token).toBeTruthy()
    const me = await request(server).get('/api/auth/me').set(auth(accepted.body.token))
    expect(me.status).toBe(200)
  })

  it('deactivating a login leaves the member and the gift where they were', async () => {
    const admin = await signup('books')
    const staff = await addUser(admin.token, {
      name: 'Book Staff', email: `deact_book_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'staff',
    })
    const member = await request(server).post('/api/clients').set(auth(admin.token)).send({
      name: 'Ada Parishioner', email: `ada_${RUN_ID}@example.com`,
    })
    expect(member.status).toBe(201)
    const gift = await request(server).post('/api/donations').set(auth(admin.token)).send({
      donor_name: 'Ada Parishioner', amount: 40, date: '2026-09-01',
    })
    expect(gift.status).toBe(201)
    const beforeMember = await pool.query('SELECT * FROM ochr_clients WHERE id = $1', [member.body.id])
    const beforeGift = await pool.query('SELECT * FROM ochr_donations WHERE id = $1', [gift.body.id])
    const beforeOrg = await pool.query('SELECT * FROM ochr_organizations WHERE id = $1', [admin.orgId])

    const off = await request(server).post(`/api/users/${staff.id}/deactivate`).set(auth(admin.token))
    expect(off.status).toBe(200)

    const afterMember = await pool.query('SELECT * FROM ochr_clients WHERE id = $1', [member.body.id])
    const afterGift = await pool.query('SELECT * FROM ochr_donations WHERE id = $1', [gift.body.id])
    const afterOrg = await pool.query('SELECT * FROM ochr_organizations WHERE id = $1', [admin.orgId])
    expect(afterMember.rows).toEqual(beforeMember.rows)
    expect(afterGift.rows).toEqual(beforeGift.rows)
    expect(afterOrg.rows).toEqual(beforeOrg.rows)
    const userStill = await pool.query('SELECT id FROM ochr_users WHERE id = $1', [staff.id])
    expect(userStill.rows.length).toBe(1)
  })

  it('a deactivated admin does not count, so the last active admin cannot be removed', async () => {
    const admin = await signup('last')
    const second = await addUser(admin.token, {
      name: 'Second', email: `deact_second_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'admin',
    })
    const off = await request(server).post(`/api/users/${second.id}/deactivate`).set(auth(admin.token))
    expect(off.status).toBe(200)
    const removed = await request(server).delete(`/api/users/${admin.userId}`).set(auth(admin.token))
    expect(removed.status).toBe(400)
    expect(removed.body.error).toMatch(/only active admin/i)
    const demoted = await request(server).patch(`/api/users/${admin.userId}/role`).set(auth(admin.token)).send({ role: 'staff' })
    expect(demoted.status).toBe(400)
    const still = await pool.query(
      `SELECT role, deactivated_at FROM ochr_users WHERE id = $1`,
      [admin.userId]
    )
    expect(still.rows[0].role).toBe('admin')
    expect(still.rows[0].deactivated_at).toBeNull()
  })

  it('one of two admins can still be demoted or removed when the other stays active', async () => {
    const admin = await signup('pair-ok')
    const second = await addUser(admin.token, {
      name: 'Second Ok', email: `deact_pair_ok_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'admin',
    })
    const before = await versionOf(second.id)
    const demoted = await request(server).patch(`/api/users/${second.id}/role`).set(auth(admin.token)).send({ role: 'staff' })
    expect(demoted.status).toBe(200)
    expect(demoted.body.role).toBe('staff')
    expect((await versionOf(second.id)).token_version).toBe(before.token_version + 1)
    const third = await addUser(admin.token, {
      name: 'Third Ok', email: `deact_pair_del_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'admin',
    })
    const removed = await request(server).delete(`/api/users/${third.id}`).set(auth(admin.token))
    expect(removed.status).toBe(204)
    expect(await activeAdminCount(admin.orgId)).toBe(1)
  })

  it('deactivation and demotion cannot both remove the last two active admins', async () => {
    const admin = await signup('vs-demote')
    const other = await addUser(admin.token, {
      name: 'Other Demote', email: `deact_vs_demote_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'admin',
    })
    const beforeAdmin = await versionOf(admin.userId)
    const beforeOther = await versionOf(other.id)
    const [deact, demote] = await releaseAfterBlocked(
      admin.orgId,
      [admin.userId, other.id],
      () => [
        request(server).post(`/api/users/${other.id}/deactivate`).set(auth(admin.token)),
        request(server).patch(`/api/users/${admin.userId}/role`).set(auth(other.token)).send({ role: 'staff' }),
      ],
      2,
    )
    expect([deact.status, demote.status].filter(status => status === 200)).toHaveLength(1)
    expect(await activeAdminCount(admin.orgId)).toBe(1)
    if (deact.status !== 200) {
      expect(deact.status).toBe(409)
      const row = await versionOf(other.id)
      expect(row.deactivated_at).toBeNull()
      expect(row.role).toBe('admin')
      expect(row.token_version).toBe(beforeOther.token_version)
      expect(row.password_hash).toBe(beforeOther.password_hash)
    } else {
      expect(demote.status).toBe(400)
      const row = await versionOf(admin.userId)
      expect(row.role).toBe('admin')
      expect(row.deactivated_at).toBeNull()
      expect(row.token_version).toBe(beforeAdmin.token_version)
      expect(row.password_hash).toBe(beforeAdmin.password_hash)
    }
  }, 20_000)

  it('deactivation and delete cannot both remove the last two active admins', async () => {
    const admin = await signup('vs-delete')
    const other = await addUser(admin.token, {
      name: 'Other Delete', email: `deact_vs_delete_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'admin',
    })
    const beforeAdmin = await versionOf(admin.userId)
    const beforeOther = await versionOf(other.id)
    const [deact, removed] = await releaseAfterBlocked(
      admin.orgId,
      [admin.userId, other.id],
      () => [
        request(server).post(`/api/users/${admin.userId}/deactivate`).set(auth(other.token)),
        request(server).delete(`/api/users/${other.id}`).set(auth(admin.token)),
      ],
      2,
    )
    const successes = (deact.status === 200 ? 1 : 0) + (removed.status === 204 ? 1 : 0)
    expect(successes).toBe(1)
    expect(await activeAdminCount(admin.orgId)).toBe(1)
    if (deact.status !== 200) {
      expect(deact.status).toBe(409)
      const row = await versionOf(admin.userId)
      expect(row.deactivated_at).toBeNull()
      expect(row.role).toBe('admin')
      expect(row.token_version).toBe(beforeAdmin.token_version)
    } else {
      expect(removed.status).toBe(400)
      const row = await versionOf(other.id)
      expect(row.role).toBe('admin')
      expect(row.deactivated_at).toBeNull()
      expect(row.token_version).toBe(beforeOther.token_version)
      expect(row.email).toBe(beforeOther.email)
    }
  }, 20_000)

  it('two demotions and two deletes each leave one active admin, and a third admin lets both writes through', async () => {
    const admin = await signup('two-reduce')
    const left = await addUser(admin.token, {
      name: 'Left', email: `deact_left_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'admin',
    })
    const beforeAdmin = await versionOf(admin.userId)
    const beforeLeft = await versionOf(left.id)
    const [demoteAdmin, demoteLeft] = await releaseAfterBlocked(
      admin.orgId,
      [admin.userId, left.id],
      () => [
        request(server).patch(`/api/users/${admin.userId}/role`).set(auth(left.token)).send({ role: 'viewer' }),
        request(server).patch(`/api/users/${left.id}/role`).set(auth(admin.token)).send({ role: 'viewer' }),
      ],
      2,
    )
    expect([demoteAdmin.status, demoteLeft.status].filter(status => status === 200)).toHaveLength(1)
    expect(await activeAdminCount(admin.orgId)).toBe(1)
    const refused = demoteAdmin.status === 200 ? left.id : admin.userId
    const refusedBefore = refused === left.id ? beforeLeft : beforeAdmin
    const refusedRow = await versionOf(refused)
    expect(refusedRow.role).toBe('admin')
    expect(refusedRow.token_version).toBe(refusedBefore.token_version)

    const keeper = await signup('two-delete')
    const gone = await addUser(keeper.token, {
      name: 'Gone', email: `deact_gone_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'admin',
    })
    const [deleteKeeper, deleteGone] = await releaseAfterBlocked(
      keeper.orgId,
      [keeper.userId, gone.id],
      () => [
        request(server).delete(`/api/users/${keeper.userId}`).set(auth(gone.token)),
        request(server).delete(`/api/users/${gone.id}`).set(auth(keeper.token)),
      ],
      2,
    )
    expect([deleteKeeper.status, deleteGone.status].filter(status => status === 204)).toHaveLength(1)
    expect(await activeAdminCount(keeper.orgId)).toBe(1)
    const survivorId = deleteKeeper.status === 204 ? gone.id : keeper.userId
    expect((await versionOf(survivorId)).role).toBe('admin')

    const trio = await signup('trio')
    const b = await addUser(trio.token, {
      name: 'Trio B', email: `deact_trio_b_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'admin',
    })
    const c = await addUser(trio.token, {
      name: 'Trio C', email: `deact_trio_c_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'admin',
    })
    const [demoteB, demoteC] = await releaseAfterBlocked(
      trio.orgId,
      [trio.userId, b.id, c.id],
      () => [
        request(server).patch(`/api/users/${b.id}/role`).set(auth(trio.token)).send({ role: 'staff' }),
        request(server).patch(`/api/users/${c.id}/role`).set(auth(b.token)).send({ role: 'staff' }),
      ],
      2,
    )
    expect(demoteB.status).toBe(200)
    expect(demoteC.status).toBe(200)
    expect(await activeAdminCount(trio.orgId)).toBe(1)
    expect((await versionOf(trio.userId)).role).toBe('admin')
  }, 20_000)

  it('a reset in flight cannot finish after deactivation, and a matching cookie is not a session', async () => {
    const admin = await signup('inflight-reset')
    const staff = await addUser(admin.token, {
      name: 'Reset Staff', email: `deact_inflight_reset_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'staff',
    })
    const raw = `reset-${RUN_ID}-inflight`
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex')
    await pool.query(
      `INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + interval '1 hour')`,
      [staff.id, tokenHash]
    )
    const before = await versionOf(staff.id)
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let reset
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM ochr_users WHERE id = $1 FOR UPDATE', [staff.id])
      const pending = Promise.resolve(request(server).post('/api/auth/reset-password').send({
        token: raw, password: 'replacement-pw-9',
      }))
      await waitForBlockedUsersQueries(1)
      await holder.query(
        `UPDATE ochr_users
            SET deactivated_at = NOW(),
                token_version = COALESCE(token_version, 1) + 1
          WHERE id = $1`,
        [staff.id]
      )
      await holder.query('COMMIT')
      reset = await pending
    } finally {
      await holder.end()
    }
    expect(reset.status).toBe(403)
    expect(reset.body.token).toBeUndefined()
    const after = await versionOf(staff.id)
    expect(after.password_hash).toBe(before.password_hash)
    expect(after.deactivated_at).toBeTruthy()
    const unused = await pool.query(
      'SELECT used_at FROM ochr_password_reset_tokens WHERE token_hash = $1',
      [tokenHash]
    )
    expect(unused.rows[0].used_at).toBeNull()

    const oldPassword = await request(server).post('/api/auth/login').send({
      email: staff.email, password: staff.password,
    })
    expect(oldPassword.status).toBe(403)
    const newPassword = await request(server).post('/api/auth/login').send({
      email: staff.email, password: 'replacement-pw-9',
    })
    expect(newPassword.status).toBe(401)

    const cookie = signToken({
      userId: staff.id,
      organizationId: admin.orgId,
      email: staff.email,
      name: 'Reset Staff',
      role: 'staff',
      tv: after.token_version,
    })
    const me = await request(server).get('/api/auth/me').set(auth(cookie))
    expect(me.status).toBe(401)
    expect(me.body.error).toMatch(/deactivated/i)

    const on = await request(server).post(`/api/users/${staff.id}/reactivate`).set(auth(admin.token))
    expect(on.status).toBe(200)
    const stillCookie = await request(server).get('/api/auth/me').set(auth(cookie))
    expect(stillCookie.status).toBe(401)
    const completed = await request(server).post('/api/auth/reset-password').send({
      token: raw, password: 'replacement-pw-9',
    })
    expect(completed.status).toBe(200)
    expect(completed.body.token).toBeUndefined()
    const signedIn = await request(server).post('/api/auth/login').send({
      email: staff.email, password: 'replacement-pw-9',
    })
    expect(signedIn.status).toBe(200)
    expect((await versionOf(staff.id)).deactivated_at).toBeNull()
  }, 20_000)

  it('a password change in flight cannot write a hash after deactivation', async () => {
    const admin = await signup('inflight-pw')
    const staff = await addUser(admin.token, {
      name: 'Password Staff', email: `deact_inflight_pw_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'staff',
    })
    const before = await versionOf(staff.id)
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let changed
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM ochr_users WHERE id = $1 FOR UPDATE', [staff.id])
      const pending = Promise.resolve(
        request(server).patch('/api/auth/password').set(auth(staff.token)).send({
          currentPassword: staff.password, password: 'replacement-pw-9',
        })
      )
      await waitForBlockedUsersQueries(1)
      await holder.query(
        `UPDATE ochr_users
            SET deactivated_at = NOW(),
                token_version = COALESCE(token_version, 1) + 1
          WHERE id = $1`,
        [staff.id]
      )
      await holder.query('COMMIT')
      changed = await pending
    } finally {
      await holder.end()
    }
    expect(changed.status).toBe(403)
    expect(changed.body.error).toBe(PASSWORD_DOES_NOT_REACTIVATE)
    expect(changed.body.token).toBeUndefined()
    const after = await versionOf(staff.id)
    expect(after.password_hash).toBe(before.password_hash)
    expect(after.deactivated_at).toBeTruthy()
    expect(after.token_version).toBe(before.token_version + 1)

    const oldSession = await request(server).get('/api/auth/me').set(auth(staff.token))
    expect(oldSession.status).toBe(401)
    const tried = await request(server).post('/api/auth/login').send({
      email: staff.email, password: 'replacement-pw-9',
    })
    expect(tried.status).toBe(401)
    const oldPassword = await request(server).post('/api/auth/login').send({
      email: staff.email, password: staff.password,
    })
    expect(oldPassword.status).toBe(403)

    const on = await request(server).post(`/api/users/${staff.id}/reactivate`).set(auth(admin.token))
    expect(on.status).toBe(200)
    const stillNew = await request(server).post('/api/auth/login').send({
      email: staff.email, password: 'replacement-pw-9',
    })
    expect(stillNew.status).toBe(401)
    const restored = await request(server).post('/api/auth/login').send({
      email: staff.email, password: staff.password,
    })
    expect(restored.status).toBe(200)
    expect((await versionOf(staff.id)).password_hash).toBe(before.password_hash)
  }, 20_000)

  it('an invitation in flight cannot accept a login that deactivation has turned off', async () => {
    const admin = await signup('inflight-invite')
    const invite = await request(server).post('/api/users/invite').set(auth(admin.token)).send({
      name: 'Inflight Invite', email: `deact_inflight_inv_${RUN_ID}@example.com`, role: 'staff',
    })
    expect(invite.status).toBe(201)
    const inviteToken = new URL(invite.body.invite.url).searchParams.get('token')
    const inviteeId = invite.body.user.id
    const before = await versionOf(inviteeId)
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let accept
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM ochr_users WHERE id = $1 FOR UPDATE', [inviteeId])
      const pending = Promise.resolve(request(server).post('/api/auth/accept-invite').send({
        token: inviteToken, password: 'invitee-chose-99',
      }))
      await waitForBlockedUsersQueries(1)
      await holder.query(
        `UPDATE ochr_users
            SET deactivated_at = NOW(),
                token_version = COALESCE(token_version, 1) + 1
          WHERE id = $1`,
        [inviteeId]
      )
      await holder.query('COMMIT')
      accept = await pending
    } finally {
      await holder.end()
    }
    expect(accept.status).toBe(403)
    expect(accept.body.token).toBeUndefined()
    const after = await versionOf(inviteeId)
    expect(after.password_hash).toBe(before.password_hash)
    expect(after.deactivated_at).toBeTruthy()
    const pendingRow = await pool.query(
      'SELECT invite_accepted_at FROM ochr_users WHERE id = $1',
      [inviteeId]
    )
    expect(pendingRow.rows[0].invite_accepted_at).toBeNull()
    if (accept.body.token) {
      const me = await request(server).get('/api/auth/me').set(auth(accept.body.token))
      expect(me.status).toBe(401)
    }

    await request(server).post(`/api/users/${inviteeId}/reactivate`).set(auth(admin.token))
    const accepted = await request(server).post('/api/auth/accept-invite').send({
      token: inviteToken, password: 'invitee-chose-99',
    })
    expect(accepted.status).toBe(200)
    expect(accepted.body.token).toBeTruthy()
    const me = await request(server).get('/api/auth/me').set(auth(accepted.body.token))
    expect(me.status).toBe(200)
    const off = await request(server).post(`/api/users/${inviteeId}/deactivate`).set(auth(admin.token))
    expect(off.status).toBe(200)
    const stale = await request(server).get('/api/auth/me').set(auth(accepted.body.token))
    expect(stale.status).toBe(401)
  }, 20_000)

  it('sacramental history and an issued giving snapshot stay put across deactivate and reactivate', async () => {
    const admin = await signup('history')
    const staff = await addUser(admin.token, {
      name: 'History Staff', email: `deact_histstaff_${RUN_ID}@example.com`,
      password: 'deact-test-pw', role: 'staff',
    })
    const member = await request(server).post('/api/clients').set(auth(admin.token)).send({
      name: 'Synthetic Member', email: `synthetic_member_${RUN_ID}@example.com`,
    })
    expect(member.status).toBe(201)
    const record = await pool.query(
      `INSERT INTO ochr_sacramental_records
         (organization_id, client_id, type, date, minister, place, certificate_no, notes, member_name, meta_attributes)
       VALUES ($1, $2, 'baptism', '2020-06-07', 'Synthetic Minister', 'Synthetic Chapel',
               $3, 'Synthetic register line', 'Synthetic Member', $4::jsonb)
       RETURNING id`,
      [admin.orgId, member.body.id, `SYN-${RUN_ID}`, JSON.stringify({ godparents: ['Synthetic Sponsor'] })]
    )
    const recordId = record.rows[0].id
    await pool.query(
      `INSERT INTO ochr_sacrament_amendments
         (organization_id, sacrament_id, kind, reason, before_json, after_json,
          amended_by, amended_by_name, amended_by_email)
       VALUES ($1, $2, 'correction', 'Synthetic correction for the test',
               $3::jsonb, $4::jsonb, $5, 'Parish Admin', $6)`,
      [
        admin.orgId, recordId,
        JSON.stringify({ notes: 'Synthetic before' }),
        JSON.stringify({ notes: 'Synthetic after' }),
        admin.userId, admin.email,
      ]
    )
    await pool.query(
      `INSERT INTO ochr_giving_statements
         (organization_id, tax_year, donor_key, donor_key_kind, statement_no, issue_key,
          status, snapshot_version, snapshot_json, issued_by, issued_by_name)
       VALUES ($1, 2026, $2, 'email', $3, $4, 'issued', 1, $5::jsonb, $6, 'Parish Admin')`,
      [
        admin.orgId,
        `synthetic-donor-${RUN_ID}@example.com`,
        `GS-SYN-${RUN_ID}`,
        `issue-${RUN_ID}`,
        JSON.stringify({
          donor: { name: 'Synthetic Donor' },
          total: 40,
          lines: [{ amount: 40, refunded_total: 0 }],
        }),
        admin.userId,
      ]
    )

    const before = await historySnapshot(admin.orgId, recordId)
    const off = await request(server).post(`/api/users/${staff.id}/deactivate`).set(auth(admin.token))
    expect(off.status).toBe(200)
    expect(await historySnapshot(admin.orgId, recordId)).toEqual(before)
    const on = await request(server).post(`/api/users/${staff.id}/reactivate`).set(auth(admin.token))
    expect(on.status).toBe(200)
    expect(await historySnapshot(admin.orgId, recordId)).toEqual(before)
    const userStill = await pool.query('SELECT id, email FROM ochr_users WHERE id = $1', [staff.id])
    expect(userStill.rows).toHaveLength(1)
    expect(userStill.rows[0].email).toBe(staff.email)
  })

  it('a pastoral-lead update still says the login is off', async () => {
    const admin = await signup('lead-state')
    const staff = await addUser(admin.token, {
      name: 'Ada Staff',
      email: `ada_lead_${RUN_ID}@example.com`,
      password: 'deact-test-pw',
      role: 'staff',
    })
    const off = await request(server).post(`/api/users/${staff.id}/deactivate`).set(auth(admin.token))
    expect(off.status).toBe(200)
    const grant = await request(server).patch(`/api/users/${staff.id}/pastoral-lead`)
      .set(auth(admin.token))
      .send({ pastoral_lead: true })
    expect(grant.status).toBe(200)
    expect(grant.body.user.pastoral_lead).toBe(true)
    expect(grant.body.user.deactivated).toBe(true)
  })
})

async function historySnapshot(orgId, recordId) {
  const record = await pool.query('SELECT * FROM ochr_sacramental_records WHERE id = $1', [recordId])
  const amendments = await pool.query(
    'SELECT * FROM ochr_sacrament_amendments WHERE sacrament_id = $1 ORDER BY id',
    [recordId]
  )
  const statements = await pool.query(
    'SELECT * FROM ochr_giving_statements WHERE organization_id = $1 ORDER BY id',
    [orgId]
  )
  const org = await pool.query('SELECT * FROM ochr_organizations WHERE id = $1', [orgId])
  return {
    record: record.rows,
    amendments: amendments.rows,
    statements: statements.rows,
    org: org.rows,
  }
}
