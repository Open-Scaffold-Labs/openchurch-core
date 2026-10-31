// SP-177. Search finds Maria Garcia's $150 gift. Her member profile says
// "No gifts recorded."
//
// The profile read preferred email and, once a member had an email, never
// looked at a gift recorded under her name with no address. The signup
// sample is that case: the member is "[Sample] Maria Garcia" with
// maria.sample@example.com, and the $150 cash gift is stored as
// donor_name "Maria Garcia" with no email — the sample marker stays off
// donor_name on purpose (onboarding/sampleSeed.js).
//
// Synthetic rows only. Another parish's gift under the same name must not
// appear, and a name that two members of this parish share must not be
// handed to either of them.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

let server
const cleanupOrgIds = []

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

let ipSeq = 0
async function signup() {
  const res = await request(server).post('/api/auth/signup')
    .set('X-Forwarded-For', `10.177.4.${++ipSeq}`)
    .send({
      organizationName: `SP177 ${RUN_ID}-${ipSeq}`,
      name: 'Admin',
      email: `sp177_${RUN_ID}_${ipSeq}@example.com`,
      password: 'sp177-test-pw-1',
    })
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return res.body.token
}
const auth = t => ({ Authorization: `Bearer ${t}` })

async function memberNamed(token, name) {
  const res = await request(server)
    .get(`/api/clients?search=${encodeURIComponent(name)}`)
    .set(auth(token))
  expect(res.status).toBe(200)
  const row = res.body.find(m => m.name === name)
  expect(row, name).toBeTruthy()
  return row
}

async function history(token, memberId) {
  const res = await request(server)
    .get(`/api/clients/${memberId}/donations`)
    .set(auth(token))
  expect(res.status).toBe(200)
  return res.body
}

function giftIds(body) {
  return body.lines.map(l => l.id)
}

describe('SP-177 profile giving history', () => {
  it('shows the seeded Maria Garcia $150 gift on her profile, not another parish\'s copy', async () => {
    const tokenA = await signup()
    const tokenB = await signup()
    const maria = await memberNamed(tokenA, '[Sample] Maria Garcia')

    const searchA = await request(server).get('/api/search?q=Maria%20Garcia').set(auth(tokenA))
    const searchB = await request(server).get('/api/search?q=Maria%20Garcia').set(auth(tokenB))
    expect(searchA.status).toBe(200)
    expect(searchB.status).toBe(200)
    const hit = rows => rows.body.filter(r =>
      r.type === 'donation' && r.donor_name === 'Maria Garcia' && Number(r.amount) === 150)
    const [giftA] = hit(searchA)
    const [giftB] = hit(searchB)
    expect(giftA, 'search should find her $150 gift').toBeTruthy()
    expect(giftB, 'the other parish has its own $150 gift').toBeTruthy()
    expect(giftA.id).not.toBe(giftB.id)

    const hers = await history(tokenA, maria.id)
    expect(giftIds(hers), 'the profile dropped the name-only gift search found').toContain(giftA.id)
    expect(Number(hers.lines.find(l => l.id === giftA.id).live_amount)).toBe(150)
    expect(giftIds(hers)).not.toContain(giftB.id)
    expect(hers.lines.some(l => l.donor_name === 'John Rivera')).toBe(false)

    const asOtherParish = await request(server)
      .get(`/api/clients/${maria.id}/donations`)
      .set(auth(tokenB))
    expect(asOtherParish.status).toBe(404)
  })

  it('includes a name-only gift for a member who already has an email, and excludes another org and a different email', async () => {
    const tokenA = await signup()
    const tokenB = await signup()
    const name = `Rosa Vega ${RUN_ID}`
    const created = await request(server).post('/api/clients').set(auth(tokenA))
      .send({ name, email: `rosa.${RUN_ID}@example.com` })
    expect(created.status).toBe(201)

    const emailed = await request(server).post('/api/donations').set(auth(tokenA))
      .send({ donor_name: name, donor_email: `Rosa.${RUN_ID}@Example.com`, amount: 40, date: '2026-01-15' })
    const walkIn = await request(server).post('/api/donations').set(auth(tokenA))
      .send({ donor_name: name, amount: 150, date: '2026-02-02' })
    const otherEmail = await request(server).post('/api/donations').set(auth(tokenA))
      .send({ donor_name: name, donor_email: `other.${RUN_ID}@example.com`, amount: 80, date: '2026-03-03' })
    const foreign = await request(server).post('/api/donations').set(auth(tokenB))
      .send({ donor_name: name, amount: 999, date: '2026-02-02' })
    const foreignEmail = await request(server).post('/api/donations').set(auth(tokenB))
      .send({ donor_name: name, donor_email: `rosa.${RUN_ID}@example.com`, amount: 70, date: '2026-01-20' })
    expect(emailed.status).toBe(201)
    expect(walkIn.status).toBe(201)
    expect(otherEmail.status).toBe(201)
    expect(foreign.status).toBe(201)
    expect(foreignEmail.status).toBe(201)

    const hers = await history(tokenA, created.body.id)
    expect(giftIds(hers)).toContain(walkIn.body.id)
    expect(giftIds(hers)).toContain(emailed.body.id)
    expect(giftIds(hers)).not.toContain(foreign.body.id)
    expect(giftIds(hers)).not.toContain(foreignEmail.body.id)
    expect(giftIds(hers)).not.toContain(otherEmail.body.id)
    expect(Number(hers.total)).toBe(190)
    expect(hers.by).toBe('email')
  })

  it('does not hand a name-only gift to the active member when a namesake is inactive', async () => {
    const token = await signup()
    const name = `Status Pair ${RUN_ID}`
    const inactive = await request(server).post('/api/clients').set(auth(token))
      .send({ name, email: `pair.a.${RUN_ID}@example.com` })
    const active = await request(server).post('/api/clients').set(auth(token))
      .send({ name, email: `pair.b.${RUN_ID}@example.com` })
    expect(inactive.status).toBe(201)
    expect(active.status).toBe(201)
    const gift = await request(server).post('/api/donations').set(auth(token))
      .send({ donor_name: name, amount: 150, date: '2026-06-06' })
    expect(gift.status).toBe(201)
    expect(giftIds(await history(token, inactive.body.id))).not.toContain(gift.body.id)
    expect(giftIds(await history(token, active.body.id))).not.toContain(gift.body.id)

    const parked = await request(server).patch(`/api/clients/${inactive.body.id}`).set(auth(token))
      .send({ status: 'inactive' })
    expect(parked.status).toBe(200)
    expect(parked.body.status).toBe('inactive')
    expect(parked.body.name).toBe(name)

    expect(giftIds(await history(token, active.body.id)), 'inactivity handed the gift to the active namesake').not.toContain(gift.body.id)
    expect(giftIds(await history(token, inactive.body.id)), 'the inactive profile also received the gift').not.toContain(gift.body.id)
  })

  it('does not show a name-only gift on either profile when both same-name members are inactive', async () => {
    const token = await signup()
    const name = `Both Inactive ${RUN_ID}`
    const a = await request(server).post('/api/clients').set(auth(token))
      .send({ name, email: `both.a.${RUN_ID}@example.com` })
    const b = await request(server).post('/api/clients').set(auth(token))
      .send({ name, email: `both.b.${RUN_ID}@example.com` })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const gift = await request(server).post('/api/donations').set(auth(token))
      .send({ donor_name: name, amount: 150, date: '2026-06-07' })
    expect(gift.status).toBe(201)

    const parkA = await request(server).patch(`/api/clients/${a.body.id}`).set(auth(token)).send({ status: 'inactive' })
    const parkB = await request(server).patch(`/api/clients/${b.body.id}`).set(auth(token)).send({ status: 'inactive' })
    expect(parkA.status).toBe(200)
    expect(parkB.status).toBe(200)

    expect(giftIds(await history(token, a.body.id)), 'both-inactive duplicated the gift').not.toContain(gift.body.id)
    expect(giftIds(await history(token, b.body.id)), 'both-inactive duplicated the gift').not.toContain(gift.body.id)
  })

  it('does not hand a name-only gift to the active member when a namesake is de-identified', async () => {
    const token = await signup()
    const name = `Minimized Pair ${RUN_ID}`
    const minimized = await request(server).post('/api/clients').set(auth(token))
      .send({ name, email: `min.a.${RUN_ID}@example.com` })
    const active = await request(server).post('/api/clients').set(auth(token))
      .send({ name, email: `min.b.${RUN_ID}@example.com` })
    expect(minimized.status).toBe(201)
    expect(active.status).toBe(201)
    const gift = await request(server).post('/api/donations').set(auth(token))
      .send({ donor_name: name, amount: 150, date: '2026-06-08' })
    expect(gift.status).toBe(201)

    const gone = await request(server).post(`/api/clients/${minimized.body.id}/deidentify`).set(auth(token))
      .send({ confirm: 'DEIDENTIFY', acknowledge_history_retained: true })
    expect(gone.status).toBe(200)
    const still = await request(server).get(`/api/clients/${minimized.body.id}`).set(auth(token))
    expect(still.status).toBe(200)
    expect(still.body.name, 'de-identification keeps the name').toBe(name)
    expect(still.body.deidentified_at).toBeTruthy()

    expect(giftIds(await history(token, active.body.id)), 'de-identification handed the gift to the active namesake').not.toContain(gift.body.id)
    expect(giftIds(await history(token, minimized.body.id)), 'the de-identified profile also received the gift').not.toContain(gift.body.id)
  })

  it('keeps a unique member\'s own name-only gift while she is inactive', async () => {
    const token = await signup()
    const name = `Sole Inactive ${RUN_ID}`
    const created = await request(server).post('/api/clients').set(auth(token))
      .send({ name, email: `sole.${RUN_ID}@example.com` })
    expect(created.status).toBe(201)
    const gift = await request(server).post('/api/donations').set(auth(token))
      .send({ donor_name: name, amount: 150, date: '2026-06-08' })
    expect(gift.status).toBe(201)

    const parked = await request(server).patch(`/api/clients/${created.body.id}`).set(auth(token))
      .send({ status: 'inactive' })
    expect(parked.status).toBe(200)
    expect(parked.body.name).toBe(name)
    expect(parked.body.status).toBe('inactive')

    const hers = await history(token, created.body.id)
    expect(giftIds(hers), 'inactivity hid her own name-only gift').toContain(gift.body.id)
    expect(Number(hers.total)).toBe(150)
  })

  it('keeps a unique de-identified member\'s own name-only gift', async () => {
    const token = await signup()
    const name = `Sole Minimized ${RUN_ID}`
    const created = await request(server).post('/api/clients').set(auth(token))
      .send({ name, email: `sole.min.${RUN_ID}@example.com` })
    expect(created.status).toBe(201)
    const gift = await request(server).post('/api/donations').set(auth(token))
      .send({ donor_name: name, amount: 40, date: '2026-06-09' })
    expect(gift.status).toBe(201)

    const gone = await request(server).post(`/api/clients/${created.body.id}/deidentify`).set(auth(token))
      .send({ confirm: 'DEIDENTIFY', acknowledge_history_retained: true })
    expect(gone.status).toBe(200)
    const still = await request(server).get(`/api/clients/${created.body.id}`).set(auth(token))
    expect(still.status).toBe(200)
    expect(still.body.name, 'de-identification keeps the name').toBe(name)
    expect(still.body.deidentified_at).toBeTruthy()

    const hers = await history(token, created.body.id)
    expect(giftIds(hers), 'de-identification hid her own name-only gift').toContain(gift.body.id)
    expect(Number(hers.total)).toBe(40)
    expect(hers.by).toBe('name')
  })

  it('does not attach a name-only gift when two members in the org share the name', async () => {
    const token = await signup()
    const name = `Twin Donor ${RUN_ID}`
    const a = await request(server).post('/api/clients').set(auth(token))
      .send({ name, email: `twin.a.${RUN_ID}@example.com` })
    const b = await request(server).post('/api/clients').set(auth(token))
      .send({ name, email: `twin.b.${RUN_ID}@example.com` })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const gift = await request(server).post('/api/donations').set(auth(token))
      .send({ donor_name: name, amount: 150, date: '2026-04-04' })
    expect(gift.status).toBe(201)

    expect(giftIds(await history(token, a.body.id))).not.toContain(gift.body.id)
    expect(giftIds(await history(token, b.body.id))).not.toContain(gift.body.id)
  })

  it('does not give the sample walk-in to either person when a real Maria Garcia is also on the roll', async () => {
    const token = await signup()
    const sample = await memberNamed(token, '[Sample] Maria Garcia')
    const real = await request(server).post('/api/clients').set(auth(token))
      .send({ name: 'Maria Garcia', email: `real.maria.${RUN_ID}@example.com` })
    expect(real.status).toBe(201)
    const search = await request(server).get('/api/search?q=Maria%20Garcia').set(auth(token))
    const gift = search.body.find(r =>
      r.type === 'donation' && r.donor_name === 'Maria Garcia' && Number(r.amount) === 150)
    expect(gift).toBeTruthy()

    expect(giftIds(await history(token, sample.id))).not.toContain(gift.id)
    expect(giftIds(await history(token, real.body.id))).not.toContain(gift.id)
  })

  it('still matches a member with no email to her own name-only gift', async () => {
    const token = await signup()
    const name = `No Email ${RUN_ID}`
    const created = await request(server).post('/api/clients').set(auth(token)).send({ name })
    expect(created.status).toBe(201)
    const gift = await request(server).post('/api/donations').set(auth(token))
      .send({ donor_name: name, amount: 25, date: '2026-05-05' })
    expect(gift.status).toBe(201)

    const hers = await history(token, created.body.id)
    expect(hers.by).toBe('name')
    expect(hers.match_key).toBe(name)
    expect(giftIds(hers)).toContain(gift.body.id)
    expect(Number(hers.total)).toBe(25)
  })

  it('does not treat a gift under someone else\'s email as this member\'s because the names match', async () => {
    const token = await signup()
    const sarah = await memberNamed(token, '[Sample] Sarah Chen')
    const hers = await history(token, sarah.id)
    expect(hers.lines.some(l => l.donor_email === 'sarah.chen@example.org')).toBe(false)
    expect(hers.gift_count).toBe(0)
  })
})
