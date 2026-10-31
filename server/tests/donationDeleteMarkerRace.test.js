// R365-1 (TARS, #365 at 8fa60d2f): DELETE /api/donations/:id must not race a
// void/refund marker. Real Postgres, controlled interleavings via test seams:
//   A. DELETE pauses after any preliminary work; a void commits; DELETE
//      resumes and must refuse, leaving gift, reversal, live net and the
//      issued-statement evidence in place.
//   B. Opposite order: DELETE holds the gift lock; a void starts and blocks;
//      DELETE commits; the void must NOT report success for a deleted gift.
//   C. Control: an unmarked manual gift still deletes (204).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { deleteRouteTestHooks } from '../src/vault/deleteRoute.js'
import { vaultTestHooks } from '../src/vault/index.js'

let server, par
const cleanup = []
let ipSeq = 0
const ip = () => `10.65.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const res = await createOrg(server, {
    organizationName: `Race ${RUN_ID}`, name: 'Ada Admin',
    email: `race_${RUN_ID}@example.com`, password: 'race-pw-1',
  }, ip())
  expect(res.status).toBe(201)
  cleanup.push(res.body.user.organization.id)
  par = { token: res.body.token, orgId: res.body.user.organization.id }
}, 60_000)

afterEach(() => {
  deleteRouteTestHooks.afterBefore = null
  vaultTestHooks.afterLock = null
})

afterAll(async () => {
  for (const id of cleanup) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

async function gift(amount, extra = {}) {
  const res = await request(server).post('/api/donations').set(auth(par.token)).send({
    donor_name: extra.name || `Race Donor ${RUN_ID}`, donor_email: extra.email,
    amount, category: 'tithe', method: 'cash', ...(extra.date ? { date: extra.date } : {}),
  })
  expect(res.status).toBe(201)
  return res.body
}
const del = id => request(server).delete(`/api/donations/${id}`).set(auth(par.token))
const voidGift = id => request(server).post(`/api/donations/${id}/void`).set(auth(par.token)).send({ reason: 'Race' })

async function facts(id) {
  const g = await pool.query('SELECT id FROM ochr_donations WHERE id = $1', [id])
  const r = await pool.query(`SELECT id, status FROM ochr_donation_refunds WHERE donation_id = $1`, [id])
  const live = await pool.query('SELECT live_amount FROM ochr_donation_live WHERE id = $1', [id])
  return { gift: g.rows[0], refunds: r.rows, live: live.rows[0] }
}

async function waitForLockWaiter(ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)
    if (rows.length) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return false
}

describe('R365-1 delete vs marker, real Postgres', () => {
  it('A: a void committed after DELETE starts makes DELETE refuse; facts and statement survive', async () => {
    const email = `race_stmt_${RUN_ID}@example.com`
    const g = await gift(120, { name: 'Race Statement', email, date: '2026-06-02' })
    const issued = await request(server).post('/api/giving-statements/issue').set(auth(par.token))
      .send({ year: 2026, key: email, by: 'email', issue_key: `ik-race-${RUN_ID}` })
    expect(issued.status).toBe(201)
    const snap = issued.body.statement.snapshot_json

    let voidRes
    deleteRouteTestHooks.afterBefore = async ({ kind, id }) => {
      if (kind === 'donation' && id === g.id) voidRes = await voidGift(g.id)
    }
    const res = await del(g.id)
    expect(voidRes.status).toBe(200)
    expect(res.status).toBe(409)
    expect(res.body.code ?? res.body.error).toBeTruthy()

    const f = await facts(g.id)
    expect(f.gift).toBeTruthy()
    expect(f.refunds).toHaveLength(1)
    expect(f.refunds[0].status).toBe('posted')
    expect(Number(f.live.live_amount)).toBe(0)
    const again = await request(server).get(`/api/giving-statements/issued/${issued.body.statement.id}`).set(auth(par.token))
    expect(again.body.statement.status).toBe('issued')
    expect(again.body.statement.snapshot_json).toEqual(snap)
    const listed = (await request(server).get('/api/donations').set(auth(par.token))).body.find(d => d.id === g.id)
    expect(listed.books.statement_drift).toBe(true)
  }, 30_000)

  it('B: DELETE holding the gift lock wins; the waiting void does not report success', async () => {
    const g = await gift(40)
    let voidP
    vaultTestHooks.afterLock = async ({ kind, rootIds }) => {
      if (kind !== 'donation' || !rootIds.includes(g.id)) return
      voidP = voidGift(g.id).then(r => r)
      expect(await waitForLockWaiter()).toBe(true)
    }
    const res = await del(g.id)
    expect(res.status).toBe(204)
    const v = await voidP
    expect(v.status).not.toBe(200)
    expect(v.status).toBe(404)
    const f = await facts(g.id)
    expect(f.gift).toBeUndefined()
    expect(f.refunds).toHaveLength(0)
  }, 30_000)

  it('C: an unmarked manual gift still deletes', async () => {
    const g = await gift(15)
    const res = await del(g.id)
    expect(res.status).toBe(204)
    expect((await facts(g.id)).gift).toBeUndefined()
  })
})
