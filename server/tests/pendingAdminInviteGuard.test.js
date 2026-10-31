// Pending admin invites do not count toward the last-admin guard
// (CAROLINA-423-R2 known gap, pre-existing on main).
//
// #423 made self-serve deletion count only USABLE admins: role admin,
// not deactivated, not closed, and either added directly (invited_at
// NULL) or invited and accepted. Self-deactivate, self-close, admin
// close/deactivate and demotion still counted an admin invite nobody
// accepted, so a sole real admin could leave the parish with no admin
// who can sign in. These cases are red on main and green with the fix.
// Synthetic local data only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { lockLoginForAdminCount, countOtherUsableAdmins } from '../src/auth/loginDeactivation.js'

let server
let ipN = 1
const ip = () => `10.97.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`
const auth = (t) => ({ Authorization: `Bearer ${t}` })
const PW = 'pai-guard-pw-123'
const em = (t) => `pai_${t}_${RUN_ID}@example.com`

async function one(sql, params) {
  const { rows } = await pool.query(sql, params)
  return rows[0] || null
}

async function signup(tag) {
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', ip())
    .send({ organizationName: `PAI ${tag} ${RUN_ID}`, name: `Fic Admin ${tag}`, email: em(tag), password: PW })
  expect(res.status).toBe(201)
  return { token: res.body.token, id: res.body.user.id, org: res.body.user.organization.id }
}

// A sole real admin plus one admin invite nobody accepted.
async function soloWithPendingAdmin(tag) {
  const solo = await signup(tag)
  const invite = await request(server).post('/api/users/invite').set(auth(solo.token))
    .send({ name: `Fic Pending ${tag}`, email: em(`${tag}p`), role: 'admin' })
  expect(invite.status).toBe(201)
  const pendingId = invite.body.user.id
  const row = await one('SELECT role, invited_at, invite_accepted_at FROM ochr_users WHERE id = $1', [pendingId])
  expect(row.role).toBe('admin')
  expect(row.invited_at).not.toBeNull()
  expect(row.invite_accepted_at).toBeNull()
  return { solo, pendingId }
}

const loginState = (id) => one(
  'SELECT role, email, name, deactivated_at, closed_at, token_version FROM ochr_users WHERE id = $1', [id])

async function expectUnchanged(solo, before) {
  expect(await loginState(solo.id)).toEqual(before)
  expect((await request(server).get('/api/auth/me').set(auth(solo.token))).status).toBe(200)
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
})

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

describe('last-admin guard ignores pending admin invites', () => {
  it('self-deactivate of the sole real admin is refused', async () => {
    const { solo } = await soloWithPendingAdmin('sdeact')
    const before = await loginState(solo.id)
    const r = await request(server).post('/api/auth/deactivate').set(auth(solo.token)).send({})
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/only active admin/)
    await expectUnchanged(solo, before)
  })

  it('self-close of the sole real admin is refused', async () => {
    const { solo } = await soloWithPendingAdmin('sclose')
    const before = await loginState(solo.id)
    const r = await request(server).post('/api/auth/close').set(auth(solo.token)).send({})
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/only active admin/)
    await expectUnchanged(solo, before)
  })

  it('self-demotion of the sole real admin is refused', async () => {
    const { solo } = await soloWithPendingAdmin('sdemote')
    const before = await loginState(solo.id)
    const r = await request(server).patch(`/api/users/${solo.id}/role`).set(auth(solo.token)).send({ role: 'staff' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/only active admin/)
    await expectUnchanged(solo, before)
  })

  it('admin routes (deactivate, close, legacy delete) on the sole real admin are refused', async () => {
    const { solo } = await soloWithPendingAdmin('aroutes')
    const before = await loginState(solo.id)
    const d = await request(server).post(`/api/users/${solo.id}/deactivate`).set(auth(solo.token)).send({})
    expect(d.status).toBe(409)
    const c = await request(server).post(`/api/users/${solo.id}/close`).set(auth(solo.token)).send({})
    expect(c.status).toBe(409)
    const del = await request(server).delete(`/api/users/${solo.id}`).set(auth(solo.token))
    expect(del.status).toBe(400)
    await expectUnchanged(solo, before)
  })

  it('controls: the pending invite itself can still be closed, and an ACCEPTED admin invite counts', async () => {
    const { solo, pendingId } = await soloWithPendingAdmin('ctl')
    // Revoking the pending invite does not reduce usable admins.
    const c = await request(server).post(`/api/users/${pendingId}/close`).set(auth(solo.token)).send({})
    expect(c.status).toBe(200)

    const second = await soloWithPendingAdmin('ctl2')
    await pool.query('UPDATE ochr_users SET invite_accepted_at = NOW() WHERE id = $1', [second.pendingId])
    const d = await request(server).post('/api/auth/deactivate').set(auth(second.solo.token)).send({})
    expect(d.status).toBe(200)
    expect((await loginState(second.solo.id)).deactivated_at).not.toBeNull()
  })

  it('locking: the count holds the pending row, so an acceptance racing it waits', async () => {
    const { solo, pendingId } = await soloWithPendingAdmin('lock')
    const holder = await pool.connect()
    const racer = await pool.connect()
    try {
      await holder.query('BEGIN')
      const { rows } = await lockLoginForAdminCount(holder, solo.org, solo.id)
      expect(rows.map(r => Number(r.id))).toContain(Number(pendingId))
      expect(countOtherUsableAdmins(rows, solo.id)).toBe(0)
      await racer.query('BEGIN')
      await racer.query("SET LOCAL lock_timeout = '300ms'")
      await expect(racer.query('UPDATE ochr_users SET invite_accepted_at = NOW() WHERE id = $1', [pendingId]))
        .rejects.toThrow(/lock timeout/)
    } finally {
      await racer.query('ROLLBACK').catch(() => {})
      await holder.query('ROLLBACK').catch(() => {})
      racer.release()
      holder.release()
    }
  })
})
