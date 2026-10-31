// OC-CAT-1 r5 — TARS CHANGES at 2561db7c.
//
// This file runs against the real counselTerms.js (every term null), so
// agreements carry "[COUNSEL TO SUPPLY]" and the counsel gate is closed.
//
// Red at 2561db7c:
//   - re-Approve on a sent agreement whose link expired mints a new link
//     (200 renewed) although counsel's wording is missing
//   - re-Approve on a sent agreement with no kept token mints one (200)
//   - Replace link (rotate) on a sent agreement mints a new link (200)
//   - the booking detail hands the office a copy_path for an expired link
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { bindServer, closeServer, migrateOnce } from './support/harness.js'
import { makeHallFixtures, auth } from './support/hallFixtures.js'
import { newSigningToken, hashSigningToken, sealToken } from '../src/lib/esign/hallTokens.js'

let server, A, roomId
const fx = makeHallFixtures('catr5', 137)

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  fx.server = server
  A = await fx.signup.call(fx, 'a')
  await pool.query(`UPDATE ochr_organizations SET timezone = 'UTC' WHERE id = $1`, [A.id])
  roomId = (await fx.room.call(fx, A)).id
}, 120_000)

afterAll(async () => {
  if (A?.id) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [A.id])
  await closeServer(server)
  await pool.end()
})

// An agreement issued before the gate existed, its link sent `ageDays` ago.
async function issuedBehindGate(host, day, { ageDays = 0, keepToken = true } = {}) {
  const { bookingId, prep } = await fx.preparedBooking.call(fx, A, roomId, host, day)
  expect(prep.counsel_pending).toBe(true)
  const token = newSigningToken(A.id)
  const { rows: [ag] } = await pool.query(
    `UPDATE ochr_cat_agreements
        SET status = 'sent', sent_at = NOW() - make_interval(days => $5::int),
            token_hash = $3, token_sealed = $4
      WHERE organization_id = $1 AND booking_id = $2 AND status = 'draft'
      RETURNING id`,
    [A.id, bookingId, hashSigningToken(token), keepToken ? sealToken(token) : null, ageDays])
  return { bookingId, prep, token, agreementId: ag.id }
}

async function linkState(agreementId) {
  const { rows: [r] } = await pool.query(
    `SELECT status, token_hash, sent_at, signed_at FROM ochr_cat_agreements WHERE id = $1`, [agreementId])
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ochr_cat_agreement_events WHERE agreement_id = $1 AND kind = 'token.rotated'`,
    [agreementId])
  return { ...r, rotations: n }
}

const reApprove = (bookingId, prep) => request(server).post(`/api/catering/bookings/${bookingId}/agreement/send`)
  .set(auth(A.token)).send({ contract_sha256: prep.contract_sha256 })
const rotate = (bookingId) => request(server).post(`/api/catering/bookings/${bookingId}/agreement/rotate`)
  .set(auth(A.token)).send({ confirm_replace: true })

describe('TARS 2: no new link or renewal while counsel wording is missing', () => {
  it('re-Approve on an expired sent agreement does not renew it', async () => {
    const { bookingId, prep, agreementId } = await issuedBehindGate('Gate renew', '2027-05-01', { ageDays: 31 })
    const before = await linkState(agreementId)
    const res = await reApprove(bookingId, prep)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('counsel_pending')
    expect(res.body.copy_path).toBeUndefined()
    expect(await linkState(agreementId)).toEqual(before)
  })

  it('re-Approve on a sent agreement with no kept link does not mint one', async () => {
    const { bookingId, prep, agreementId, token } = await issuedBehindGate('Gate mint', '2027-05-08', { keepToken: false })
    const before = await linkState(agreementId)
    const res = await reApprove(bookingId, prep)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('counsel_pending')
    expect(await linkState(agreementId)).toEqual(before)
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(token)}`)).status).toBe(200)
  })

  it('Replace link on a sent agreement does not mint one, and the family keeps read and decline', async () => {
    const { bookingId, agreementId, token } = await issuedBehindGate('Gate rotate', '2027-05-15')
    const before = await linkState(agreementId)
    const res = await rotate(bookingId)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('counsel_pending')
    expect(await linkState(agreementId)).toEqual(before)
    const opened = await request(server).get(`/api/hall-sign/${encodeURIComponent(token)}`)
    expect(opened.status).toBe(200)
    const declined = await request(server).post(`/api/hall-sign/${encodeURIComponent(token)}/decline`).send({ reason: 'Not yet' })
    expect(declined.status).toBe(200)
  })

  it('re-Approve on a live sent agreement still hands back the same link (read/decline only)', async () => {
    const { bookingId, prep, agreementId, token } = await issuedBehindGate('Gate keep', '2027-05-22')
    const before = await linkState(agreementId)
    const res = await reApprove(bookingId, prep)
    expect(res.status).toBe(200)
    expect(res.body.already_issued).toBe(true)
    expect(decodeURIComponent(res.body.copy_path.replace('/sign/hall/', ''))).toBe(token)
    expect(await linkState(agreementId)).toEqual(before)
  })
})

describe('TARS 1: an expired link is not offered for copying', () => {
  it('the detail has no copy_path for an expired sent link, and says it expired', async () => {
    const { bookingId } = await issuedBehindGate('Expired detail', '2027-05-29', { ageDays: 31 })
    const detail = await request(server).get(`/api/catering/bookings/${bookingId}`).set(auth(A.token))
    expect(detail.status).toBe(200)
    const [a] = detail.body.agreements
    expect(a.status).toBe('sent')
    expect(a.copy_path).toBeNull()
    expect(a.link_expired).toBe(true)
  })

  it('a live sent link is still copyable and not marked expired', async () => {
    const { bookingId } = await issuedBehindGate('Live detail', '2027-06-05')
    const detail = await request(server).get(`/api/catering/bookings/${bookingId}`).set(auth(A.token))
    const [a] = detail.body.agreements
    expect(a.copy_path).toMatch(/^\/sign\/hall\//)
    expect(a.link_expired).toBe(false)
  })

  it('a signed link past its 30 days is not copyable, and the signed record is untouched', async () => {
    const { bookingId, agreementId } = await issuedBehindGate('Signed old', '2027-06-12')
    // SP-247: signed view expiry uses max(signed_at, sent_at). Age both clocks.
    await pool.query(
      `UPDATE ochr_cat_agreements SET status = 'signed', signed_at = NOW() - INTERVAL '31 days',
             sent_at = NOW() - INTERVAL '31 days', signer_name = 'Old Signer'
        WHERE id = $1`, [agreementId])
    const before = await linkState(agreementId)
    const detail = await request(server).get(`/api/catering/bookings/${bookingId}`).set(auth(A.token))
    const [a] = detail.body.agreements
    expect(a.status).toBe('signed')
    expect(a.copy_path).toBeNull()
    expect(a.link_expired).toBe(true)
    expect(await linkState(agreementId)).toEqual(before)
  })
})
