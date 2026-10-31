// OC-CAT-1 — the agreement cannot be issued or signed while counsel's
// wording is missing (Vesper HOLD on 63f076e4, Saint SP-233).
//
// This file does NOT stand in counsel text: it runs against the real
// counselTerms.js, where every term is still null, so the agreement and
// the consent list carry locale-matched counsel placeholders.
//
// Red at 63f076e4: send answers 200 and mints a link, and a link that was
// issued before the gate signs with 200.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { bindServer, closeServer, migrateOnce } from './support/harness.js'
import { makeHallFixtures, auth } from './support/hallFixtures.js'
import { newSigningToken, hashSigningToken, sealToken } from '../src/lib/esign/hallTokens.js'

let server, A, roomId
const fx = makeHallFixtures('catgate', 134)

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

async function issueBehindTheGate(bookingId) {
  // An agreement that was issued before this gate existed (a DB that ran
  // 63f076e4). The text is unchanged; only the status and link are set.
  const token = newSigningToken(A.id)
  await pool.query(
    `UPDATE ochr_cat_agreements
        SET status = 'sent', sent_at = NOW(), token_hash = $3, token_sealed = $4
      WHERE organization_id = $1 AND booking_id = $2 AND status = 'draft'`,
    [A.id, bookingId, hashSigningToken(token), sealToken(token)])
  return token
}

describe('counsel placeholders gate send and sign', () => {
  it('the office cannot issue a link while the agreement has a placeholder', async () => {
    const { bookingId, prep } = await fx.preparedBooking.call(fx, A, roomId, 'Gate send', '2027-02-06')
    expect(prep.contract_en).toMatch(/\[COUNSEL TO SUPPLY\]/)
    expect(prep.contract_es).toMatch(/\[ASESORÍA LEGAL POR ENTREGAR\]/)
    const sent = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: prep.contract_sha256 })
    expect(sent.status).toBe(409)
    expect(sent.body.code).toBe('counsel_pending')
    expect(sent.body.copy_path).toBeUndefined()
    const row = await pool.query(
      `SELECT status, token_hash, sent_at FROM ochr_cat_agreements WHERE organization_id = $1 AND booking_id = $2`,
      [A.id, bookingId])
    expect(row.rows).toEqual([{ status: 'draft', token_hash: null, sent_at: null }])
    const events = await pool.query(
      `SELECT kind FROM ochr_cat_agreement_events e JOIN ochr_cat_agreements a ON a.id = e.agreement_id
        WHERE a.organization_id = $1 AND a.booking_id = $2`, [A.id, bookingId])
    expect(events.rows).toEqual([])
    const detail = await request(server).get(`/api/catering/bookings/${bookingId}`).set(auth(A.token))
    expect(detail.body.agreements[0].counsel_pending).toBe(true)
    expect(prep.counsel_pending).toBe(true)
  })

  it('a link issued before the gate opens, says why, and cannot be signed', async () => {
    const { bookingId } = await fx.preparedBooking.call(fx, A, roomId, 'Gate sign', '2027-02-13')
    const token = await issueBehindTheGate(bookingId)
    const opened = await request(server).get(`/api/hall-sign/${encodeURIComponent(token)}`)
    expect(opened.status).toBe(200)
    const signed = await request(server).post(`/api/hall-sign/${encodeURIComponent(token)}/sign`).send({
      signer_name: 'Gate Signer', accepted: opened.body.consent.map(p => p.id), locale: 'en',
    })
    expect(signed.status).toBe(409)
    expect(signed.body.code).toBe('counsel_pending')
    expect(opened.body.counsel_pending).toBe(true)
    const row = await pool.query(
      `SELECT status, signed_at, signer_name FROM ochr_cat_agreements WHERE organization_id = $1 AND booking_id = $2`,
      [A.id, bookingId])
    expect(row.rows).toEqual([{ status: 'sent', signed_at: null, signer_name: null }])
    const kinds = (await pool.query(
      `SELECT e.kind FROM ochr_cat_agreement_events e JOIN ochr_cat_agreements a ON a.id = e.agreement_id
        WHERE a.organization_id = $1 AND a.booking_id = $2`, [A.id, bookingId])).rows.map(r => r.kind)
    expect(kinds).not.toContain('signer.signed')
    expect(kinds).not.toContain('signer.consented')
    // Declining is not signing; the family can still say no.
    const declined = await request(server).post(`/api/hall-sign/${encodeURIComponent(token)}/decline`).send({ reason: 'Not yet' })
    expect(declined.status).toBe(200)
  })

  it('a placeholder in the consent list alone also blocks signing', async () => {
    const { bookingId } = await fx.preparedBooking.call(fx, A, roomId, 'Gate consent', '2027-02-20')
    // Simulate a text with every agreement term supplied: only the consent
    // sentence ("the legal effect of signing") still has a placeholder.
    await pool.query(
      `UPDATE ochr_cat_agreements SET contract_en = 'Supplied wording.', contract_es = 'Texto dado.'
        WHERE organization_id = $1 AND booking_id = $2 AND status = 'draft'`, [A.id, bookingId])
    const token = await issueBehindTheGate(bookingId)
    const opened = await request(server).get(`/api/hall-sign/${encodeURIComponent(token)}`)
    expect(opened.body.consent.some(p => /\[COUNSEL TO SUPPLY\]/.test(p.text))).toBe(true)
    const signed = await request(server).post(`/api/hall-sign/${encodeURIComponent(token)}/sign`).send({
      signer_name: 'Gate Signer', accepted: opened.body.consent.map(p => p.id), locale: 'es',
    })
    expect(signed.status).toBe(409)
    expect(signed.body.code).toBe('counsel_pending')
    expect(opened.body.counsel_pending).toBe(true)
  })
})
