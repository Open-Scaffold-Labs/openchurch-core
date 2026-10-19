// HT-VIEW-01 — the sacristy weekly manifest joins the calendar the same
// way it already joins the requester: same organization, or no Mass
// title/time. Defense-in-depth. The composite tenant FK (071) already
// refuses a cross-org calendar_event_id on the book row, so this file
// does not claim a live exploit. It proves the view text carries the
// predicate, and that a same-parish assignment still prints.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let tokenA
let tokenB
let massId
let intentionId

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const a = await createOrg(server, {
    organizationName: `Manifest Parish A ${RUN_ID}`,
    name: 'Ada Admin',
    email: `manifest_a_${RUN_ID}@example.com`,
    password: 'manifest-test-pw-1',
  })
  expect(a.status).toBe(201)
  tokenA = a.body.token

  const b = await createOrg(server, {
    organizationName: `Manifest Parish B ${RUN_ID}`,
    name: 'Bea Admin',
    email: `manifest_b_${RUN_ID}@example.com`,
    password: 'manifest-test-pw-2',
  })
  expect(b.status).toBe(201)
  tokenB = b.body.token

  const mass = await request(server).post('/api/calendar')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      title: `Tenant Mass ${RUN_ID}`,
      date: '2030-04-07',
      start_time: '08:00',
      end_time: '09:00',
      type: 'service',
    })
  expect(mass.status).toBe(201)
  massId = mass.body.id

  const made = await request(server).post('/api/mass-intentions')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ intention: `† Manifest tenant ${RUN_ID}` })
  const offered = await request(server).post(`/api/mass-intentions/${made.body.id}/assign`)
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ calendar_event_id: massId, expected_calendar_event_id: null })
  expect(offered.status).toBe(200)
  intentionId = offered.body.id
})

afterAll(async () => {
  await closeServer(server)
})

describe('ochr_sacristy_weekly_manifest calendar join (HT-VIEW-01)', () => {
  it('the installed view scopes the calendar join by organization_id', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_viewdef('ochr_sacristy_weekly_manifest', true) AS def`
    )
    const def = rows[0].def
    expect(def).toMatch(/ce\.organization_id\s*=\s*mi\.organization_id/)
    expect(def).toMatch(/c\.organization_id\s*=\s*mi\.organization_id/)
    expect(def).toMatch(/calendar_event_id/)
  })

  it('same-parish assignment still carries the Mass title on the weekly sheet', async () => {
    const res = await request(server)
      .get('/api/mass-intentions/weekly?start=2030-04-07&end=2030-04-13')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(res.status).toBe(200)
    const row = res.body.intentions.find(r => r.id === intentionId)
    expect(row).toBeTruthy()
    expect(row.mass_title).toBe(`Tenant Mass ${RUN_ID}`)
    expect(row.mass_time).toBe('08:00')
    expect(row.calendar_event_id).toBe(massId)
  })

  it('the other parish never sees this week\'s row', async () => {
    const res = await request(server)
      .get('/api/mass-intentions/weekly?start=2030-04-07&end=2030-04-13')
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    expect(res.body.intentions.some(r => r.id === intentionId)).toBe(false)
    expect(res.body.intentions.some(r =>
      String(r.mass_title || '').includes(`Tenant Mass ${RUN_ID}`)
    )).toBe(false)
  })
})
