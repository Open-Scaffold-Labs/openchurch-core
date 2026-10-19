// Stage 6 — audit copies of a member's contact details racing member
// minimization (TARS #278 review, 14 Oct, finding 3).
//
// Suspected interleaving: a transaction writes an audit row ABOUT a member
// that carries contact details, and is still open when the member is
// minimized. Minimization scrubs only the audit rows it can see, so the
// open row is missed and commits with the contact details afterwards.
//
// Two real connections and deterministic barriers, both operation orders,
// canonical and zero-padded ids, another tenant, and audit UPDATEs.
// Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
const orgIds = []
let sequence = 1
const auth = token => ({ Authorization: `Bearer ${token}` })
const CONFIRM = { confirm: 'DEIDENTIFY', acknowledge_history_retained: true }
const CONTACT = ['email', 'phone', 'notes', 'avatar', 'birth_date']

beforeAll(async () => { await migrateOnce(); server = await bindServer() }, 60000)
afterAll(async () => {
  for (const id of orgIds) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server); await pool.end()
})

async function parish(tag) {
  const name = `AuditRace ${tag} ${RUN_ID}`
  const res = await createOrg(server, { organizationName: name, name: 'Synthetic Admin', email: `auditrace_${tag}_${RUN_ID}@example.com`, password: 'auditrace-test-pw' }, `10.96.${sequence++}.1`)
  expect(res.status).toBe(201)
  const org = { id: res.body.user.organization.id, token: res.body.token }
  orgIds.push(org.id)
  return org
}
async function member(org) {
  const { rows: [m] } = await pool.query(
    `INSERT INTO ochr_clients (organization_id, name, email, phone, status) VALUES ($1, 'Synthetic Person', $2, '5550100', 'active') RETURNING id`,
    [org.id, `race_${org.id}_${RUN_ID}@example.com`])
  return m.id
}
const contactRow = (org, entityId, extra = {}) => pool.query(
  `INSERT INTO ochr_audit_log (organization_id, action, entity_type, entity_id, summary, metadata)
   VALUES ($1, 'update', 'client', $2, 'synthetic', $3::jsonb) RETURNING id`,
  [org.id, String(entityId), JSON.stringify({ name: 'Synthetic Person', email: 'copy@example.com', phone: '5550100', ...extra })])

const settle = p => p.then(value => ({ value }), error => ({ error }))
const pidOf = async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
async function waitUntil(fn, label) {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 15)) }
  throw new Error(`timed out waiting: ${label}`)
}
const isBlocked = async pid => (await pool.query('SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS b', [pid])).rows[0].b
const blocking = async pid => (await pool.query(
  'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS b', [pid])).rows[0].b
// The deidentify request's backend, identified by the statement it waits in.
const deidentifyWaiting = async () => (await pool.query(
  `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%UPDATE ochr_audit_log%SET metadata = metadata - %'`)).rows.length > 0

async function contactCopiesFor(org, memberId) {
  const { rows } = await pool.query(
    `SELECT id, entity_id, metadata FROM ochr_audit_log
      WHERE organization_id = $1 AND entity_type = 'client' AND ltrim(entity_id, '0') = $2`,
    [org.id, String(memberId)])
  return rows.filter(r => CONTACT.some(k => r.metadata && k in r.metadata))
}
const deidentify = (org, id) => settle(new Promise((res, rej) =>
  request(server).post(`/api/clients/${id}/deidentify`).set(auth(org.token)).send(CONFIRM).then(res, rej)))

describe('audit INSERT open while the member is minimized (audit first)', () => {
  for (const padded of [false, true]) {
    it(`${padded ? 'zero-padded' : 'canonical'} id: the open row cannot commit contact details`, async () => {
      const org = await parish(`a_first_${padded ? 'pad' : 'canon'}`)
      const id = await member(org)
      const writer = await pool.connect()
      let minimize
      try {
        await writer.query('BEGIN')
        const writerPid = await pidOf(writer)
        await writer.query(
          `INSERT INTO ochr_audit_log (organization_id, action, entity_type, entity_id, summary, metadata)
           VALUES ($1, 'update', 'client', $2, 'synthetic', $3::jsonb)`,
          [org.id, padded ? `00${id}` : String(id), JSON.stringify({ name: 'Synthetic Person', email: 'open@example.com', phone: '5550100' })])
        let done = false
        minimize = deidentify(org, id).finally(() => { done = true })
        // Either minimization finishes (no serialization) or it waits on the
        // open audit transaction.
        await waitUntil(async () => done || await blocking(writerPid), 'minimization finished or waiting on the open audit row')
        await writer.query('COMMIT')
      } finally {
        await writer.query('ROLLBACK').catch(() => {}); writer.release()
      }
      const result = await minimize
      expect(result.error).toBeUndefined()
      expect(result.value.status).toBe(200)
      expect(await contactCopiesFor(org, id)).toEqual([])
    })
  }
})

describe('audit INSERT while minimization is in flight (minimization first)', () => {
  for (const padded of [false, true]) {
    it(`${padded ? 'zero-padded' : 'canonical'} id: a row written mid-minimization loses its contact details`, async () => {
      const org = await parish(`b_first_${padded ? 'pad' : 'canon'}`)
      const id = await member(org)
      // An existing contact copy, row-locked by a barrier: minimization stops
      // at its audit scrub with the marker written and the member locked.
      const { rows: [existing] } = await contactRow(org, id)
      const barrier = await pool.connect()
      const writer = await pool.connect()
      let minimize, write
      try {
        await barrier.query('BEGIN')
        await barrier.query('SELECT 1 FROM ochr_audit_log WHERE id = $1 FOR UPDATE', [existing.id])
        minimize = deidentify(org, id)
        await waitUntil(deidentifyWaiting, 'minimization waiting at its audit scrub')

        await writer.query('BEGIN')
        const writerPid = await pidOf(writer)
        let writeDone = false
        write = settle(writer.query(
          `INSERT INTO ochr_audit_log (organization_id, action, entity_type, entity_id, summary, metadata)
           VALUES ($1, 'update', 'client', $2, 'synthetic', $3::jsonb) RETURNING metadata`,
          [org.id, padded ? `00${id}` : String(id), JSON.stringify({ name: 'Synthetic Person', email: 'late@example.com', notes: 'private' })]
        )).then(async r => { await writer.query(r.error ? 'ROLLBACK' : 'COMMIT'); return r }).finally(() => { writeDone = true })
        await waitUntil(async () => writeDone || await isBlocked(writerPid), 'audit write finished or waiting')
        await barrier.query('COMMIT')
        const [m, w] = await Promise.all([minimize, write])
        expect(m.error).toBeUndefined()
        expect(m.value.status).toBe(200)
        expect(w.error?.code, 'audit write must not deadlock').not.toBe('40P01')
        expect(w.error).toBeUndefined()
        // Written without the contact keys; the name stays.
        expect(w.value.rows[0].metadata).toEqual({ name: 'Synthetic Person' })
      } finally {
        await barrier.query('ROLLBACK').catch(() => {}); await writer.query('ROLLBACK').catch(() => {})
        barrier.release(); writer.release()
      }
      expect(await contactCopiesFor(org, id)).toEqual([])
    })
  }
})

describe('audit UPDATE adding contact details, both orders', () => {
  it('update open first, then minimization: the copy is scrubbed', async () => {
    const org = await parish('u_first')
    const id = await member(org)
    const { rows: [row] } = await pool.query(
      `INSERT INTO ochr_audit_log (organization_id, action, entity_type, entity_id, summary, metadata)
       VALUES ($1, 'update', 'client', $2, 'synthetic', '{"name":"Synthetic Person"}'::jsonb) RETURNING id`, [org.id, String(id)])
    const writer = await pool.connect()
    let minimize
    try {
      await writer.query('BEGIN')
      const writerPid = await pidOf(writer)
      await writer.query(`UPDATE ochr_audit_log SET metadata = metadata || '{"email":"upd@example.com"}'::jsonb WHERE id = $1`, [row.id])
      let done = false
      minimize = deidentify(org, id).finally(() => { done = true })
      await waitUntil(async () => done || await blocking(writerPid), 'minimization finished or waiting')
      await writer.query('COMMIT')
    } finally { await writer.query('ROLLBACK').catch(() => {}); writer.release() }
    expect((await minimize).value.status).toBe(200)
    expect(await contactCopiesFor(org, id)).toEqual([])
  })

  it('minimization in flight first, then an update: no deadlock, the copy is scrubbed', async () => {
    const org = await parish('u_second')
    const id = await member(org)
    const { rows: [lockRow] } = await contactRow(org, id)
    const { rows: [target] } = await pool.query(
      `INSERT INTO ochr_audit_log (organization_id, action, entity_type, entity_id, summary, metadata)
       VALUES ($1, 'update', 'client', $2, 'synthetic', '{"name":"Synthetic Person"}'::jsonb) RETURNING id`, [org.id, `0${id}`])
    const barrier = await pool.connect()
    let minimize
    try {
      await barrier.query('BEGIN')
      await barrier.query('SELECT 1 FROM ochr_audit_log WHERE id = $1 FOR UPDATE', [lockRow.id])
      minimize = deidentify(org, id)
      await waitUntil(deidentifyWaiting, 'minimization waiting at its audit scrub')
      const upd = await settle(pool.query(`UPDATE ochr_audit_log SET metadata = metadata || '{"phone":"5550199"}'::jsonb WHERE id = $1 RETURNING metadata`, [target.id]))
      expect(upd.error?.code).not.toBe('40P01')
      await barrier.query('COMMIT')
    } finally { await barrier.query('ROLLBACK').catch(() => {}); barrier.release() }
    expect((await minimize).value.status).toBe(200)
    expect(await contactCopiesFor(org, id)).toEqual([])
  })
})

describe('tenant isolation', () => {
  it("another parish's rows, including one carrying the same numeric id, keep their details", async () => {
    const org = await parish('iso_a'), other = await parish('iso_b')
    const id = await member(org)
    const otherId = await member(other)
    await contactRow(other, otherId)
    await contactRow(other, id) // same number, other parish: not this member
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query(
        `INSERT INTO ochr_audit_log (organization_id, action, entity_type, entity_id, summary, metadata)
         VALUES ($1, 'update', 'client', $2, 'synthetic', '{"email":"other-open@example.com"}'::jsonb)`, [other.id, String(id)])
      // An open write in another parish does not hold up this minimization.
      const result = await Promise.race([
        deidentify(org, id).then(r => r.value?.status),
        new Promise(r => setTimeout(() => r('blocked'), 3000)),
      ])
      expect(result).toBe(200)
      await writer.query('COMMIT')
    } finally { await writer.query('ROLLBACK').catch(() => {}); writer.release() }
    expect((await contactCopiesFor(other, otherId))).toHaveLength(1)
    expect((await contactCopiesFor(other, id))).toHaveLength(2)
  })
})
