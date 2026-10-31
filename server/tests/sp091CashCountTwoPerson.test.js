// SP-091 (pre-123 typed-name counts) — a legacy cash count confirms only with a different, named verifier,
// and a confirmed (ledger-posted) count cannot be deleted.
// Synthetic tenant only. Runs against the real Postgres in DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, token, orgId, tokenB, orgBId
const auth = () => ({ Authorization: `Bearer ${token}` })
const posted = async name => (await pool.query(
  'SELECT COUNT(*)::int AS n FROM ochr_donations WHERE donor_name = $1', [`${name} (Cash Collection)`])).rows[0].n

// 123: counts saved through the API now carry a signed-in counter and use
// signed-in verification. This file keeps the #357 typed-name rules covered
// for counts saved BEFORE 123, so it builds such a row: saved by the API,
// then counted_by_user_id cleared and the typed verifier set, as a pre-123
// row would look.
async function session(name, extra = {}) {
  const { verified_by, ...rest } = extra
  const r = await request(server).post('/api/donations/cash-counts').set(auth())
    .send({ service_name: name, counted_by: 'Margaret', total: 40, ...rest })
  expect(r.status).toBe(201)
  await pool.query(
    'UPDATE ochr_cash_count_sessions SET counted_by_user_id = NULL, verified_by = $2 WHERE id = $1',
    [r.body.id, verified_by ?? null])
  return r.body.id
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `SP091 Parish ${RUN_ID}`, name: 'Synthetic Admin',
    email: `sp091_${RUN_ID}@example.com`, password: 'sp091-test-pw',
  }, '10.91.0.1')
  expect(a.status).toBe(201)
  token = a.body.token
  orgId = a.body.user.organization.id
  const b = await createOrg(server, {
    organizationName: `SP091 Other ${RUN_ID}`, name: 'Synthetic Other',
    email: `sp091b_${RUN_ID}@example.com`, password: 'sp091-test-pw',
  }, '10.91.0.2')
  expect(b.status).toBe(201)
  tokenB = b.body.token
  orgBId = b.body.user.organization.id
}, 60_000)

afterAll(async () => {
  for (const o of [orgId, orgBId]) if (o) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [o]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('SP-091 two-person cash count', () => {
  it('refuses confirm with no verifier and posts nothing', async () => {
    const name = `NoVerifier ${RUN_ID}`
    const id = await session(name)
    const r = await request(server).patch(`/api/donations/cash-counts/${id}/confirm`).set(auth())
    expect(r.status).toBe(422)
    expect(await posted(name)).toBe(0)
  })

  it('refuses confirm when verifier is the counter (case/space-insensitive)', async () => {
    const name = `SameVerifier ${RUN_ID}`
    const id = await session(name, { verified_by: '  margaret ' })
    const r = await request(server).patch(`/api/donations/cash-counts/${id}/confirm`).set(auth())
    expect(r.status).toBe(422)
    expect(await posted(name)).toBe(0)
  })

  it('confirms with a different verifier, then refuses delete of the confirmed count', async () => {
    const name = `TwoPerson ${RUN_ID}`
    const id = await session(name, { verified_by: 'Joseph' })
    const c = await request(server).patch(`/api/donations/cash-counts/${id}/confirm`).set(auth())
    expect(c.status).toBe(200)
    expect(await posted(name)).toBe(1)
    const d = await request(server).delete(`/api/donations/cash-counts/${id}`).set(auth())
    expect(d.status).toBe(409)
    const { rows } = await pool.query('SELECT status FROM ochr_cash_count_sessions WHERE id = $1', [id])
    expect(rows[0]?.status).toBe('confirmed')
  })

  it('still deletes a pending count, and 404s an unknown one', async () => {
    const id = await session(`Pending ${RUN_ID}`)
    const d = await request(server).delete(`/api/donations/cash-counts/${id}`).set(auth())
    expect(d.status).toBe(204)
    const again = await request(server).delete(`/api/donations/cash-counts/${id}`).set(auth())
    expect(again.status).toBe(404)
  })

  // R357-1 — a pending count saved without (or with a wrong) verifier is not
  // stranded: confirm records the second name under the lock, once.
  const row = async id => (await pool.query(
    'SELECT status, verified_by, total, denominations FROM ochr_cash_count_sessions WHERE id = $1', [id])).rows[0]
  const confirm = (id, body, tok = token) => request(server)
    .patch(`/api/donations/cash-counts/${id}/confirm`).set({ Authorization: `Bearer ${tok}` }).send(body)

  it('R357-1: existing pending count → record verifier at confirm → posts exactly once, count preserved', async () => {
    const name = `Recorded ${RUN_ID}`
    const id = await session(name, { denominations: { 20: 2 } })
    const before = await row(id)
    expect(before.verified_by).toBeNull()
    const r = await confirm(id, { verified_by: '  Joseph ' })
    expect(r.status).toBe(200)
    expect(r.body.session.verified_by).toBe('Joseph')
    expect(await posted(name)).toBe(1)
    const after = await row(id)
    expect(after.status).toBe('confirmed')
    expect(Number(after.total)).toBe(Number(before.total))
    expect(after.denominations).toEqual(before.denominations)
    // confirmed row is immutable: a later confirm with a new name changes nothing
    const again = await confirm(id, { verified_by: 'Someone Else' })
    expect(again.status).toBe(409)
    expect((await row(id)).verified_by).toBe('Joseph')
    expect(await posted(name)).toBe(1)
  })

  it('R357-1: a saved same-name verifier can be corrected at confirm', async () => {
    const name = `Corrected ${RUN_ID}`
    const id = await session(name, { verified_by: 'Margaret' })
    expect((await confirm(id, {})).status).toBe(422)
    const r = await confirm(id, { verified_by: 'Teresa' })
    expect(r.status).toBe(200)
    expect((await row(id)).verified_by).toBe('Teresa')
    expect(await posted(name)).toBe(1)
  })

  it('R357-1: a same-name verifier sent at confirm is refused and nothing is stored', async () => {
    const name = `SameBody ${RUN_ID}`
    const id = await session(name)
    const r = await confirm(id, { verified_by: 'MARGARET' })
    expect(r.status).toBe(422)
    const after = await row(id)
    expect(after.status).toBe('pending')
    expect(after.verified_by).toBeNull()
    expect(await posted(name)).toBe(0)
  })

  it('R357-1: another parish cannot record a verifier on or confirm this count', async () => {
    const name = `CrossParish ${RUN_ID}`
    const id = await session(name)
    const r = await confirm(id, { verified_by: 'Intruder' }, tokenB)
    expect(r.status).toBe(404)
    const after = await row(id)
    expect(after.status).toBe('pending')
    expect(after.verified_by).toBeNull()
    expect(await posted(name)).toBe(0)
  })

  // R357-2 — an explicit invalid replacement never falls back to the saved name.
  it.each([
    ['blank', ''],
    ['whitespace', '   '],
    ['object', { name: 'Joseph' }],
    ['number', 7],
    ['null', null],
  ])('R357-2: explicit %s verified_by with a saved valid verifier → 422, nothing posted or changed', async (_label, value) => {
    const name = `Explicit ${_label} ${RUN_ID}`
    const id = await session(name, { verified_by: 'Joseph' })
    const before = await row(id)
    const r = await confirm(id, { verified_by: value })
    expect(r.status).toBe(422)
    expect(await row(id)).toEqual(before)
    expect(await posted(name)).toBe(0)
  })

  it('R357-2 control: omitted verified_by keeps the saved valid name and posts once', async () => {
    const name = `Omitted ${RUN_ID}`
    const id = await session(name, { verified_by: 'Joseph' })
    const r = await confirm(id, {})
    expect(r.status).toBe(200)
    expect((await row(id)).verified_by).toBe('Joseph')
    expect(await posted(name)).toBe(1)
  })

  it('R357-2 control: a valid explicit replacement wins over the saved name', async () => {
    const name = `Replaced ${RUN_ID}`
    const id = await session(name, { verified_by: 'Joseph' })
    const r = await confirm(id, { verified_by: 'Teresa' })
    expect(r.status).toBe(200)
    expect((await row(id)).verified_by).toBe('Teresa')
    expect(await posted(name)).toBe(1)
  })
})
