// C3 concurrency. Real Postgres row locks, synthetic local data only.
//
// Lock order for a deletion is organization, then that login's deletion
// request, then ochr_users in id order. The request is first because its
// user foreign key shares the login row. Two deletions in one parish
// serialize on the admin rows: the parish keeps one active admin, and
// two confirms of the same login leave one tombstone.

import bcrypt from 'bcryptjs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { confirmDeletionRequest, createDeletionRequest } from '../src/auth/deletionRequest.js'
import { tombstoneEmail } from '../src/auth/loginClosure.js'

let server
const orgs = []
const PW = 'c3-race-pw-123'
let n = 0

async function person() {
  n += 1
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', `10.95.4.${n}`)
    .send({ organizationName: `C3R ${n} ${RUN_ID}`, name: `Admin ${n}`, email: `c3r_${n}_${RUN_ID}@example.com`, password: PW })
  expect(res.status).toBe(201)
  orgs.push(res.body.user.organization.id)
  return { organizationId: res.body.user.organization.id, userId: res.body.user.id }
}

async function secondAdmin(organizationId) {
  const hash = await bcrypt.hash(PW, 4)
  const { rows } = await pool.query(
    `INSERT INTO ochr_users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'Second Admin', $2, $3, 'admin') RETURNING id`,
    [organizationId, `c3r_second_${organizationId}_${RUN_ID}@example.com`, hash])
  return rows[0].id
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of orgs) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

async function waitForUserLock() {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query ILIKE '%ochr_users%'
          AND query ILIKE '%FOR UPDATE%'`)
    if (rows.length) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('deletion never blocked on the user row lock')
}

describe('C3 login deletion concurrency', () => {
  it('two admins deleting at once leave exactly one active admin', async () => {
    const first = await person()
    const secondId = await secondAdmin(first.organizationId)
    await createDeletionRequest(first)
    await createDeletionRequest({ organizationId: first.organizationId, userId: secondId })
    const results = await Promise.all([
      confirmDeletionRequest({ ...first, password: PW }),
      confirmDeletionRequest({ organizationId: first.organizationId, userId: secondId, password: PW }),
    ])
    const deleted = results.filter(r => r.status === 200 && r.body.personal_login_deleted === true)
    const blocked = results.filter(r => r.status === 409)
    expect(deleted).toHaveLength(1)
    expect(blocked).toHaveLength(1)
    expect(blocked[0].body.error).toMatch(/Transfer administration first/)
    expect(blocked[0].body.personal_login_deleted).toBe(false)
    const { rows } = await pool.query(
      `SELECT id, closed_at FROM ochr_users
        WHERE organization_id = $1 AND role = 'admin' ORDER BY id`,
      [first.organizationId])
    expect(rows.filter(r => r.closed_at == null)).toHaveLength(1)
    expect(rows.filter(r => r.closed_at != null)).toHaveLength(1)
  })

  it('two confirms of one login wait on the user lock and tombstone once', async () => {
    const who = await person()
    const otherId = await secondAdmin(who.organizationId)
    await createDeletionRequest(who)
    const { rows: [register] } = await pool.query(
      `INSERT INTO ochr_sacramental_records (organization_id, type, notes)
       VALUES ($1, 'baptism', 'Race register') RETURNING id, notes`,
      [who.organizationId])

    const holder = await pool.connect()
    let blocked = false
    let result
    try {
      await holder.query('BEGIN')
      await holder.query(
        'SELECT id FROM ochr_users WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [who.userId, who.organizationId])
      const pending = confirmDeletionRequest({ ...who, password: PW })
      try {
        await waitForUserLock()
        blocked = true
      } catch {
        blocked = false
      }
      await holder.query('COMMIT')
      result = await pending
    } catch (err) {
      await holder.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      holder.release()
    }

    expect(blocked).toBe(true)
    expect(result.status).toBe(200)
    expect(result.body.personal_login_deleted).toBe(true)

    const again = await confirmDeletionRequest({ ...who, password: PW })
    expect(again.status).toBe(200)
    expect(again.body.already).toBe(true)
    expect(again.body.personal_login_deleted).toBe(true)

    const user = await pool.query(
      'SELECT email, closed_at FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [who.userId, who.organizationId])
    expect(user.rows[0].email).toBe(tombstoneEmail(who.userId))
    const tombs = await pool.query(
      'SELECT COUNT(*)::int AS n FROM ochr_login_deletion_tombstones WHERE organization_id = $1 AND user_id = $2',
      [who.organizationId, who.userId])
    expect(tombs.rows[0].n).toBe(1)
    const kept = await pool.query(
      'SELECT notes FROM ochr_sacramental_records WHERE id = $1 AND organization_id = $2',
      [register.id, who.organizationId])
    expect(kept.rows[0].notes).toBe('Race register')
    const survivor = await pool.query(
      'SELECT closed_at FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [otherId, who.organizationId])
    expect(survivor.rows[0].closed_at).toBeNull()
  })
})
