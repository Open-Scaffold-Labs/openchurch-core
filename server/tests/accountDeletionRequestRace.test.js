// TARS R383-1 — a confirm/withdraw that loses its race must answer about the
// request it acted on, never a newer one. Real Postgres, deterministic: a held
// transaction row-locks request A, the helper blocks on its conditional
// UPDATE, the held transaction withdraws A and opens B, then commits.
// Before the fix the helper fell back to latest() and returned 200 with B.
// Synthetic local data only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import bcrypt from 'bcryptjs'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createDeletionRequest, confirmDeletionRequest, withdrawDeletionRequest } from '../src/auth/deletionRequest.js'

let server
const orgs = []
const PW = 'adr-race-pw-123'
let n = 0

async function secondAdmin(organizationId) {
  const hash = await bcrypt.hash(PW, 4)
  await pool.query(
    `INSERT INTO ochr_users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'Second Admin', $2, $3, 'admin')`,
    [organizationId, `adrr_second_${organizationId}_${RUN_ID}@example.com`, hash])
}

async function person() {
  n += 1
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', `10.94.2.${n}`)
    .send({ organizationName: `ADRR ${n} ${RUN_ID}`, name: `Admin ${n}`, email: `adrr_${n}_${RUN_ID}@example.com`, password: PW })
  expect(res.status).toBe(201)
  orgs.push(res.body.user.organization.id)
  return { organizationId: res.body.user.organization.id, userId: res.body.user.id }
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

async function waitBlocked() {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query ILIKE '%ochr_account_deletion_requests%'
          AND (query ILIKE '%FOR UPDATE%' OR query ILIKE '%UPDATE ochr_account_deletion_requests%')`)
    if (rows.length) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('helper never blocked on the held row lock')
}

// Hold A's row lock, start `action`, then run `inTx` and commit.
async function race(who, idA, action, inTx) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query('SELECT id FROM ochr_account_deletion_requests WHERE id = $1 FOR UPDATE', [idA])
    const pending = action()
    await waitBlocked()
    await inTx(c)
    await c.query('COMMIT')
    return await pending
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    c.release()
  }
}

const withdrawAndRecreate = (who, idA) => async (c) => {
  await c.query(`UPDATE ochr_account_deletion_requests SET status = 'withdrawn', withdrawn_at = NOW() WHERE id = $1`, [idA])
  const { rows } = await c.query(
    'INSERT INTO ochr_account_deletion_requests (organization_id, user_id) VALUES ($1, $2) RETURNING id',
    [who.organizationId, who.userId])
  return rows[0].id
}

describe('deletion request transitions keep the original request identity', () => {
  it('confirm vs withdraw+recreate → 409 about A, never 200 with B', async () => {
    const who = await person()
    const a = (await createDeletionRequest(who)).body.request
    const r = await race(who, a.id, () => confirmDeletionRequest({ ...who, password: PW }), withdrawAndRecreate(who, a.id))
    expect(r.body.request.id).toBe(a.id)
    expect(r.status).toBe(409)
    expect(r.body.request.status).toBe('withdrawn')
    expect(r.body.data_deleted).toBe(false)
    const { rows } = await pool.query(
      'SELECT id, status FROM ochr_account_deletion_requests WHERE user_id = $1 ORDER BY id', [who.userId])
    expect(rows.map(x => x.status)).toEqual(['withdrawn', 'requested']) // B was not confirmed
  })

  it('withdraw vs withdraw+recreate → same-request idempotent 200 about A; B untouched', async () => {
    const who = await person()
    const a = (await createDeletionRequest(who)).body.request
    const r = await race(who, a.id, () => withdrawDeletionRequest(who), withdrawAndRecreate(who, a.id))
    expect(r.body.request.id).toBe(a.id)
    expect(r.status).toBe(200)
    expect(r.body.already).toBe(true)
    expect(r.body.request.status).toBe('withdrawn')
    const { rows } = await pool.query(
      'SELECT status FROM ochr_account_deletion_requests WHERE user_id = $1 ORDER BY id', [who.userId])
    expect(rows.map(x => x.status)).toEqual(['withdrawn', 'requested'])
  })

  it('confirm vs a status-only confirm of the same request still deletes that login', async () => {
    const who = await person()
    await secondAdmin(who.organizationId)
    const a = (await createDeletionRequest(who)).body.request
    const r = await race(who, a.id, () => confirmDeletionRequest({ ...who, password: PW }), async (c) => {
      await c.query(`UPDATE ochr_account_deletion_requests SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`, [a.id])
    })
    expect(r.status).toBe(200)
    expect(r.body.personal_login_deleted).toBe(true)
    expect(r.body.request).toMatchObject({ id: a.id, status: 'confirmed', fulfilment_status: 'completed' })
    const { rows } = await pool.query('SELECT email, closed_at FROM ochr_users WHERE id = $1', [who.userId])
    expect(rows[0].closed_at).toBeTruthy()
    expect(rows[0].email).not.toBe(`adrr_${n}_${RUN_ID}@example.com`)
  })

  it('a repeated confirm is idempotent, and withdrawal cannot restore a deleted login', async () => {
    const who = await person()
    await secondAdmin(who.organizationId)
    const a = (await createDeletionRequest(who)).body.request
    const c1 = await confirmDeletionRequest({ ...who, password: PW })
    expect(c1.status).toBe(200)
    expect(c1.body.personal_login_deleted).toBe(true)
    expect(c1.body.request).toMatchObject({ id: a.id, status: 'confirmed', fulfilment_status: 'completed' })
    const c2 = await confirmDeletionRequest({ ...who, password: 'wrong-after' })
    expect(c2.status).toBe(200)
    expect(c2.body.already).toBe(true)
    expect(c2.body.personal_login_deleted).toBe(true)
    const w1 = await withdrawDeletionRequest(who)
    expect(w1.status).toBe(409)
    expect(w1.body.request).toMatchObject({ id: a.id, status: 'confirmed', fulfilment_status: 'completed' })
    const { rows } = await pool.query('SELECT closed_at FROM ochr_users WHERE id = $1', [who.userId])
    expect(rows[0].closed_at).toBeTruthy()
  })
})
