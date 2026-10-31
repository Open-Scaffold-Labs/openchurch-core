// R384-1 (TARS, 2026-10-24) — the swap-accept handler must hand its pool
// slot back before the pool-based reminder re-sync. With `c` held across
// syncEventReminders, concurrent accepts on a small pool each wait for a
// second slot while keeping their first: the syncs hit the 10 s acquisition
// timeout, log, and the committed swaps keep their stale reminders.
//
// Two-slot pool, two concurrent accepts. Synthetic fixtures, local DB only.

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'
vi.hoisted(() => { process.env.PG_POOL_MAX = '2' })
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let org
const auth = () => ({ Authorization: `Bearer ${org.token}` })

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  const res = await createOrg(server, { organizationName: `SwapPool ${RUN_ID}`, name: 'Synthetic Admin', email: `swappool_${RUN_ID}@example.com`, password: 'swap-pool-pw-1' }, '10.97.2.1')
  expect(res.status).toBe(201)
  org = { id: res.body.user.organization.id, token: res.body.token }
}, 60000)

afterAll(async () => {
  if (org) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.id]).catch(() => {})
  await closeServer(server); await pool.end()
})

async function pendingRecipients(eventId) {
  const { rows } = await pool.query(
    `SELECT recipient_email AS r FROM ochr_scheduled_notifications
      WHERE organization_id = $1 AND source_type = 'calendar_event' AND source_id = $2
        AND notification_type = 'assignment_reminder' AND status = 'pending'
      ORDER BY recipient_email`, [org.id, eventId])
  return rows.map(x => x.r)
}

async function member(tag) {
  const email = `swappool_${tag}_${RUN_ID}@example.com`
  const m = await request(server).post('/api/clients').set(auth())
    .send({ name: `Pool ${tag} ${RUN_ID}`, status: 'active', role: 'Member', email })
  expect(m.status).toBe(201)
  const t = await request(server).post(`/api/swap-admin/clients/${m.body.id}/rotate-token`).set(auth())
  return { id: m.body.id, email, token: t.body.swap_token }
}

describe('swap accept on a bounded (2-slot) pool', () => {
  it('concurrent accepts commit and move reminders without pool-acquisition timeouts', async () => {
    expect(pool.options.max).toBe(2)
    const pairs = []
    for (const n of [1, 2]) {
      const out = await member(`out${n}`), inn = await member(`in${n}`)
      const ev = await request(server).post('/api/calendar').set(auth())
        .send({ title: `Pool Swap ${n} ${RUN_ID}`, date: '2027-11-14', start_time: `0${n + 7}:00`, end_time: `0${n + 8}:00`, type: 'service', assigned_to: [out.id] })
      expect(ev.status).toBe(201)
      expect(await pendingRecipients(ev.body.id)).toEqual([out.email])
      const rq = await request(server).post(`/api/swap/by-token/${out.token}/request`)
        .send({ calendar_event_id: ev.body.id, target_client_id: inn.id })
      expect(rq.status).toBe(201)
      pairs.push({ out, inn, ev: ev.body.id, req: rq.body.id })
    }

    const started = Date.now()
    const results = await Promise.all(pairs.map(p =>
      request(server).post(`/api/swap/by-token/${p.inn.token}/accept`).send({ request_id: p.req })))
    const elapsed = Date.now() - started

    for (const r of results) expect(r.status).toBe(200)
    // Well under the 10 s connectionTimeoutMillis: nobody waited on a slot.
    expect(elapsed).toBeLessThan(8000)
    for (const p of pairs) expect(await pendingRecipients(p.ev)).toEqual([p.inn.email])
  }, 60000)
})
