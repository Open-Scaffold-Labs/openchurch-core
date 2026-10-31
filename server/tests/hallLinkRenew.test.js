// Saint SP-241 — replacing an expired link hands out a link that works.
//
// Red at 4bd41010:
//   - rotate on an agreement sent 31 days ago mints a new token but keeps
//     sent_at, so the new link opens 410 expired
//   - Approve on that agreement hands back the kept, expired link as
//     "already issued"
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
const fx = makeHallFixtures('catr4', 136)

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

async function expiredIssue(host, day) {
  const { bookingId, prep } = await fx.preparedBooking.call(fx, A, roomId, host, day)
  const sent = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/send`).set(auth(A.token))
    .send({ contract_sha256: prep.contract_sha256 })
  expect(sent.status).toBe(200)
  const { rows: [ag] } = await pool.query(
    `UPDATE ochr_cat_agreements SET sent_at = NOW() - INTERVAL '31 days'
      WHERE organization_id = $1 AND booking_id = $2 AND status = 'sent' RETURNING id`, [A.id, bookingId])
  const first = tokenOf(sent.body.copy_path)
  expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(first)}`)).status).toBe(410)
  return { bookingId, prep, first, agreementId: ag.id, copyPath: sent.body.copy_path }
}

async function sentAgeDays(agreementId) {
  const { rows: [r] } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - sent_at)) / 86400 AS d FROM ochr_cat_agreements WHERE id = $1`, [agreementId])
  return Number(r.d)
}

describe('SP-241: a replaced link starts its own 30 days', () => {
  it('Replace link on an expired agreement gives a link that opens', async () => {
    const { bookingId, first, agreementId } = await expiredIssue('Expired replace', '2027-04-03')
    const replaced = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/rotate`).set(auth(A.token))
      .send({ confirm_replace: true })
    expect(replaced.status).toBe(200)
    const fresh = tokenOf(replaced.body.copy_path)
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(fresh)}`)).status).toBe(200)
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(first)}`)).status).toBe(404)
    expect(await sentAgeDays(agreementId)).toBeLessThan(1)
  })

  it('Approve on an expired agreement does not hand back the expired link', async () => {
    const { bookingId, prep, first, copyPath, agreementId } = await expiredIssue('Expired approve', '2027-04-10')
    const again = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: prep.contract_sha256 })
    expect(again.status).toBe(200)
    expect(again.body.copy_path).not.toBe(copyPath)
    expect(again.body.already_issued).toBe(false)
    expect(again.body.renewed).toBe(true)
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(tokenOf(again.body.copy_path))}`)).status).toBe(200)
    expect((await request(server).get(`/api/hall-sign/${encodeURIComponent(first)}`)).status).toBe(404)
    expect(await sentAgeDays(agreementId)).toBeLessThan(1)
  })

  it('Approve on a live agreement still keeps the family\'s link', async () => {
    const { bookingId, prep } = await fx.preparedBooking.call(fx, A, roomId, 'Live keep', '2027-04-17')
    const sent = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: prep.contract_sha256 })
    const again = await request(server).post(`/api/catering/bookings/${bookingId}/agreement/send`).set(auth(A.token))
      .send({ contract_sha256: prep.contract_sha256 })
    expect(again.body.copy_path).toBe(sent.body.copy_path)
    expect(again.body.already_issued).toBe(true)
    expect(again.body.renewed).toBe(false)
  })
})


describe('Beacon B-H8: office plain-expired via test COUNSEL_TERMS', () => {
  // Stock tip cannot reach hall.linkExpired because null COUNSEL_TERMS keeps
  // counsel_pending true. This suite injects wording (above) so the office
  // can send, expire, and see link_expired without counsel_pending. Production
  // gating is unchanged.
  it('detail reports link_expired with counsel_pending false after TTL', async () => {
    const { bookingId, first } = await expiredIssue('Plain expired office', '2027-08-14')
    const detail = await request(server).get(`/api/catering/bookings/${bookingId}`).set(auth(A.token))
    expect(detail.status).toBe(200)
    const ag = detail.body.agreements.find(a => a.status === 'sent')
    expect(ag).toBeTruthy()
    expect(ag.link_expired).toBe(true)
    expect(ag.counsel_pending).toBe(false)
    expect(first).toBeTruthy()
  })
})
