// SP-247 — rotate on a signed agreement older than 30 days must hand out
// a live view link (expiry from rotation), without moving signed_at.
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

let server, A, roomId
const fx = makeHallFixtures('cat247', 137)

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

describe('SP-247: rotate on a signed agreement older than 30 days', () => {
  it('mints a live view link and leaves signed_at untouched', async () => {
    const { bookingId, prep } = await fx.preparedBooking.call(fx, A, roomId, 'Signed rotate', '2027-07-03')
    const sent = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: prep.contract_sha256 })
    expect(sent.status).toBe(200)
    const first = tokenOf(sent.body.copy_path)
    const opened = await request(server).get(`/api/hall-sign/${encodeURIComponent(first)}`)
    expect(opened.status).toBe(200)
    const signed = await request(server).post(`/api/hall-sign/${encodeURIComponent(first)}/sign`).send({
      signer_name: 'Old Signer',
      accepted: opened.body.consent.map(p => p.id),
      locale: 'en',
    })
    expect(signed.status).toBe(200)
    const { rows: [ag] } = await pool.query(
      `UPDATE ochr_cat_agreements
          SET signed_at = NOW() - INTERVAL '31 days',
              sent_at = NOW() - INTERVAL '40 days'
        WHERE organization_id = $1 AND booking_id = $2 AND status = 'signed'
        RETURNING id, signed_at`, [A.id, bookingId])
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(first)}`)).status).toBe(410)

    const replaced = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/rotate`).set(auth(A.token))
      .send({ confirm_replace: true })
    expect(replaced.status).toBe(200)
    const fresh = tokenOf(replaced.body.copy_path)
    expect(fresh).not.toBe(first)
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(fresh)}`)).status).toBe(200)
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(first)}`)).status).toBe(404)

    const { rows: [after] } = await pool.query(
      `SELECT signed_at, signer_name, status,
              EXTRACT(EPOCH FROM (NOW() - sent_at)) / 86400 AS sent_age_days
         FROM ochr_cat_agreements WHERE id = $1`, [ag.id])
    expect(after.status).toBe('signed')
    expect(after.signer_name).toBe('Old Signer')
    expect(new Date(after.signed_at).getTime()).toBe(new Date(ag.signed_at).getTime())
    expect(Number(after.sent_age_days)).toBeLessThan(1)
  })
})
