// OC-CAT-1 r3 — cancel/sign race (Argus N1) and re-Approve keeping the
// family's link (Vesper R1, Saint SP-236).
//
// Counsel's wording is stood in with synthetic text here, so the send and
// sign paths can run. hallCounselGate.test.js covers the real (null) terms.
//
// Red at 63f076e4:
//   - a staff cancel that reads before a signature commits voids the
//     just-signed agreement (200, status voided)
//   - a second Approve mints a new token, so the link the family has 404s
//   - rotate replaces the link with no confirmation
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { bindServer, closeServer, migrateOnce } from './support/harness.js'
import { makeHallFixtures, auth, tokenOf } from './support/hallFixtures.js'

vi.mock('../src/lib/catering/counselTerms.js', async (importOriginal) => {
  const real = await importOriginal()
  const words = (lang) => Object.fromEntries(
    ['cancellation', 'refund', 'liability', 'insurance', 'effect'].map(k => [k, `Synthetic counsel wording (${lang}): ${k}.`]))
  const supplied = { en: words('en'), es: words('es') }
  return { ...real, COUNSEL_TERMS: supplied, counselText: (l, t, terms = supplied) => real.counselText(l, t, terms) }
})

let server, A, staff, roomId
const fx = makeHallFixtures('catr3', 135)

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  fx.server = server
  A = await fx.signup.call(fx, 'a')
  staff = await fx.addUser.call(fx, A, 'staff', 'staff')
  await pool.query(`UPDATE ochr_organizations SET timezone = 'UTC' WHERE id = $1`, [A.id])
  roomId = (await fx.room.call(fx, A)).id
}, 120_000)

afterAll(async () => {
  if (A?.id) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [A.id])
  await closeServer(server)
  await pool.end()
})

async function issued(host, day) {
  const { bookingId, prep } = await fx.preparedBooking.call(fx, A, roomId, host, day)
  expect(prep.contract_en).not.toMatch(/\[COUNSEL TO SUPPLY\]/)
  const sent = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/send`).set(auth(A.token))
    .send({ contract_sha256: prep.contract_sha256 })
  expect(sent.status).toBe(200)
  const { rows: [ag] } = await pool.query(
    `SELECT id FROM ochr_cat_agreements WHERE organization_id = $1 AND booking_id = $2 AND status = 'sent'`,
    [A.id, bookingId])
  return { bookingId, prep, sent: sent.body, agreementId: ag.id }
}

async function waitUntilBlockedBy(pid) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid])
    if (rows[0].n > 0) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return false
}

describe('Argus N1: cancel locks before it checks for a signature', () => {
  it('a staff cancel racing a signature does not void the signed agreement', async () => {
    const { bookingId, agreementId } = await issued('Race couple', '2027-03-06')
    // The host's signature is mid-transaction: the agreement row is locked
    // and already says signed, but has not committed.
    const signer = await pool.connect()
    let res
    try {
      await signer.query('BEGIN')
      const { rows: [{ pid }] } = await signer.query('SELECT pg_backend_pid() AS pid')
      await signer.query(`SELECT id FROM ochr_cat_agreements WHERE id = $1 FOR UPDATE`, [agreementId])
      await signer.query(
        `UPDATE ochr_cat_agreements SET status = 'signed', signed_at = NOW(), signer_name = 'Race Signer'
          WHERE id = $1 AND organization_id = $2`, [agreementId, A.id])
      const pending = request(server).post(`/api/catering/bookings/${bookingId}/cancel`).set(auth(staff.token)).send({})
        .then(r => r)
      expect(await waitUntilBlockedBy(pid)).toBe(true)
      await signer.query('COMMIT')
      res = await pending
    } finally {
      signer.release()
    }
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('admin')
    const after = await pool.query(
      `SELECT a.status, a.token_hash IS NOT NULL AS has_token, b.status AS booking_status
         FROM ochr_cat_agreements a JOIN ochr_cat_bookings b ON b.id = a.booking_id
        WHERE a.id = $1`, [agreementId])
    expect(after.rows[0]).toEqual({ status: 'signed', has_token: true, booking_status: 'held' })
    const voided = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_cat_agreement_events WHERE agreement_id = $1 AND kind = 'request.voided'`,
      [agreementId])
    expect(voided.rows[0].n).toBe(0)
  })
})

describe('Vesper R1 / SP-236: Approve again keeps the family\'s link', () => {
  it('a second Approve returns the live link instead of replacing it', async () => {
    const { bookingId, prep, sent, agreementId } = await issued('Keep link', '2027-03-13')
    const first = tokenOf(sent.copy_path)
    const again = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: prep.contract_sha256 })
    expect(again.status).toBe(200)
    expect(again.body.copy_path).toBe(sent.copy_path)
    expect(again.body.already_issued).toBe(true)
    const stillOpens = await request(server).get(`/api/hall-sign/${encodeURIComponent(first)}`)
    expect(stillOpens.status).toBe(200)
    const rotations = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_cat_agreement_events WHERE agreement_id = $1 AND kind = 'token.rotated'`,
      [agreementId])
    expect(rotations.rows[0].n).toBe(0)
  })

  it('replacing the link needs an explicit confirm, and then the old link stops', async () => {
    const { bookingId, sent } = await issued('Replace link', '2027-03-20')
    const first = tokenOf(sent.copy_path)
    const unconfirmed = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/rotate`).set(auth(A.token)).send({})
    expect(unconfirmed.status).toBe(409)
    expect(unconfirmed.body.code).toBe('confirm_replace')
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(first)}`)).status).toBe(200)
    const replaced = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/rotate`).set(auth(A.token))
      .send({ confirm_replace: true })
    expect(replaced.status).toBe(200)
    expect(replaced.body.copy_path).not.toBe(sent.copy_path)
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(first)}`)).status).toBe(404)
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(tokenOf(replaced.body.copy_path))}`)).status).toBe(200)
  })
})

describe('SP-232: a DB that ran the earlier 133 gets the token index', () => {
  it('re-asserts the index when 133 is already in the ledger', async () => {
    const { ensureHallAgreementGuards } = await import('../src/migrations/133-parish-catering.js')
    const { readFileSync } = await import('node:fs')
    const runner = readFileSync(new URL('../src/migrations/index.js', import.meta.url), 'utf8')
    expect(runner).toMatch(/if \(name === '133-parish-catering'\) await ensureHallAgreementGuards\(\)/)
    // The earlier 133 (68ab9dca) had no token index. Drop it, as such a DB
    // would be, and run what the runner runs for an already-applied 133.
    await pool.query('DROP INDEX IF EXISTS ochr_cat_agreements_token_hash_key')
    // N7: the first run repairs; the second finds it current and does nothing.
    expect(await ensureHallAgreementGuards()).toBe('repaired')
    expect(await ensureHallAgreementGuards()).toBe('current')
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'ochr_cat_agreements_token_hash_key'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/UNIQUE INDEX .*\(token_hash\) WHERE \(token_hash IS NOT NULL\)/)
  })
})
