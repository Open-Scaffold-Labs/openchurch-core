// PATCH /api/events/:id — moving an event moves its liturgical day.
//
// POST stamps season, color and feast from the date when the body leaves
// them out. PATCH did not: an event moved from Christmas Day into July kept
// "Christmas" and White, and the Events list, Check-in and the event reminder
// repeated it. The Events form now leaves the three out when its own lookup
// fails (it used to save blanks, or the old date's values), so the server
// has to stamp them on PATCH too. Values sent explicitly still win.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { resolveLiturgicalContext } from '../src/routes/liturgical.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, token, orgId
const auth = () => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const res = await createOrg(server, {
    organizationName: `EPL ${RUN_ID}`, name: 'Admin',
    email: `epl_${RUN_ID}@example.com`, password: 'epl-verify-pw-1',
  }, '10.66.4.1')
  expect(res.status).toBe(201)
  token = res.body.token
  orgId = res.body.user.organization.id
}, 60_000)

afterAll(async () => {
  if (orgId) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

const CHRISTMAS = '2026-12-25'
const JULY = '2026-07-12'

async function christmasEvent() {
  const res = await request(server).post('/api/events').set(auth()).send({ title: `Mass ${RUN_ID}`, date: CHRISTMAS })
  expect(res.status).toBe(201)
  const want = await resolveLiturgicalContext(CHRISTMAS, orgId)
  expect(res.body.liturgical_season).toBe(want.season)
  return res.body
}

describe('PATCH /api/events/:id liturgical day', () => {
  it('re-stamps season, color and feast from a new date when the body omits them', async () => {
    const ev = await christmasEvent()
    const want = await resolveLiturgicalContext(JULY, orgId)
    expect(want.season).not.toBe(ev.liturgical_season)

    const res = await request(server).patch(`/api/events/${ev.id}`).set(auth()).send({ date: JULY })
    expect(res.status).toBe(200)
    expect(res.body.liturgical_season).toBe(want.season)
    expect(res.body.liturgical_color).toBe(want.color)
    expect(res.body.feast_name ?? null).toBe(want.feast_name ?? null)
  })

  it('keeps values the body sends explicitly', async () => {
    const ev = await christmasEvent()
    const res = await request(server).patch(`/api/events/${ev.id}`).set(auth())
      .send({ date: JULY, liturgical_season: 'Ordinary Time', liturgical_color: 'Red', feast_name: 'Parish patronal' })
    expect(res.status).toBe(200)
    expect(res.body.liturgical_color).toBe('Red')
    expect(res.body.feast_name).toBe('Parish patronal')
  })

  it('leaves the liturgical day alone when the date is not in the body', async () => {
    const ev = await christmasEvent()
    const res = await request(server).patch(`/api/events/${ev.id}`).set(auth()).send({ location: 'Main Hall' })
    expect(res.status).toBe(200)
    expect(res.body.liturgical_season).toBe(ev.liturgical_season)
    expect(res.body.liturgical_color).toBe(ev.liturgical_color)
  })

  // R340-2: each omitted field follows the new date on its own.
  it('date + color only: season and feast follow the new date, color is kept', async () => {
    const ev = await christmasEvent()
    const want = await resolveLiturgicalContext(JULY, orgId)
    const res = await request(server).patch(`/api/events/${ev.id}`).set(auth()).send({ date: JULY, liturgical_color: 'Red' })
    expect(res.status).toBe(200)
    expect(res.body.liturgical_color).toBe('Red')
    expect(res.body.liturgical_season).toBe(want.season)
    expect(res.body.liturgical_season).not.toBe(ev.liturgical_season)
    expect(res.body.feast_name ?? null).toBe(want.feast_name ?? null)
    expect(res.body.feast_name ?? null).not.toBe(ev.feast_name ?? null)
  })

  it('date + season only: color and feast follow the new date', async () => {
    const ev = await christmasEvent()
    const want = await resolveLiturgicalContext(JULY, orgId)
    const res = await request(server).patch(`/api/events/${ev.id}`).set(auth()).send({ date: JULY, liturgical_season: 'Parish Jubilee' })
    expect(res.status).toBe(200)
    expect(res.body.liturgical_season).toBe('Parish Jubilee')
    expect(res.body.liturgical_color).toBe(want.color)
    expect(res.body.feast_name ?? null).toBe(want.feast_name ?? null)
  })

  it('an explicit null is kept as null while the others are derived', async () => {
    const ev = await christmasEvent()
    const want = await resolveLiturgicalContext(JULY, orgId)
    const res = await request(server).patch(`/api/events/${ev.id}`).set(auth()).send({ date: JULY, feast_name: null, liturgical_color: null })
    expect(res.status).toBe(200)
    expect(res.body.feast_name).toBeNull()
    expect(res.body.liturgical_color).toBeNull()
    expect(res.body.liturgical_season).toBe(want.season)
  })

  it('a full override is kept exactly', async () => {
    const ev = await christmasEvent()
    const res = await request(server).patch(`/api/events/${ev.id}`).set(auth())
      .send({ date: JULY, liturgical_season: 'Advent', liturgical_color: 'Rose', feast_name: 'Parish patronal' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ liturgical_season: 'Advent', liturgical_color: 'Rose', feast_name: 'Parish patronal' })
  })

  it('clearing the date clears the omitted fields and keeps an explicit one', async () => {
    const ev = await christmasEvent()
    const res = await request(server).patch(`/api/events/${ev.id}`).set(auth()).send({ date: null, liturgical_color: 'White' })
    expect(res.status).toBe(200)
    expect(res.body.date ?? null).toBeNull()
    expect(res.body.liturgical_season).toBeNull()
    expect(res.body.feast_name).toBeNull()
    expect(res.body.liturgical_color).toBe('White')
  })

  it('no date: an explicit season alone changes only the season', async () => {
    const ev = await christmasEvent()
    const res = await request(server).patch(`/api/events/${ev.id}`).set(auth()).send({ liturgical_season: 'Parish Jubilee' })
    expect(res.status).toBe(200)
    expect(res.body.liturgical_season).toBe('Parish Jubilee')
    expect(res.body.liturgical_color).toBe(ev.liturgical_color)
    expect(res.body.feast_name ?? null).toBe(ev.feast_name ?? null)
  })
})
