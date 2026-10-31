// SP-190. Ctrl+K search could not find Worship, a service plan, or a Mass.
// Plans and Masses come back from /api/search, inside the caller's org,
// and only when that role may see them. A Viewer may see Masses (Schedule)
// and not service plans.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, tokenA, orgA, tokenB, tokenViewer

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `Search Worship ${RUN_ID}`,
    name: 'Ada Admin',
    email: `sp190_${RUN_ID}@example.com`,
    password: 'sp190-test-pw-0001',
  }, '10.254.1.1')
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgA = a.body.user.organization.id
  const b = await createOrg(server, {
    organizationName: `Search Worship Other ${RUN_ID}`,
    name: 'Bea Admin',
    email: `sp190b_${RUN_ID}@example.com`,
    password: 'sp190-test-pw-0001',
  }, '10.254.1.2')
  expect(b.status).toBe(201)
  tokenB = b.body.token

  const viewer = await request(server).post('/api/users').set(auth(tokenA)).send({
    name: 'Vera Viewer',
    email: `sp190v_${RUN_ID}@example.com`,
    password: 'sp190-viewer-pw-01',
    role: 'viewer',
  })
  expect(viewer.status).toBe(201)
  const login = await request(server).post('/api/auth/login').send({
    email: `sp190v_${RUN_ID}@example.com`,
    password: 'sp190-viewer-pw-01',
  })
  expect(login.status).toBe(200)
  tokenViewer = login.body.token
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

const auth = token => ({ Authorization: `Bearer ${token}` })

async function mass(token, title, date, type = 'service') {
  const res = await request(server).post('/api/calendar').set(auth(token)).send({
    title, date, start_time: '10:00', end_time: '11:00', type,
  })
  expect(res.status).toBe(201)
  return res.body
}

describe('SP-190 search finds service plans and Masses in this org', () => {
  it('staff search returns this org\'s plan and Mass, not the other parish, and not a meeting', async () => {
    const plan = await request(server).post('/api/service-plans').set(auth(tokenA)).send({
      date: '2026-11-01', title: `Advent Worship ${RUN_ID}`,
    })
    expect(plan.status).toBe(201)
    const ours = await mass(tokenA, `Sunday Mass ${RUN_ID}`, '2026-11-01', 'service')
    await mass(tokenA, `Finance meeting ${RUN_ID}`, '2026-11-01', 'meeting')
    const theirs = await mass(tokenB, `Sunday Mass ${RUN_ID}`, '2026-11-08', 'service')
    await request(server).post('/api/service-plans').set(auth(tokenB)).send({
      date: '2026-11-08', title: `Advent Worship ${RUN_ID}`,
    })

    const res = await request(server).get(`/api/search?q=${encodeURIComponent('Advent Worship ' + RUN_ID)}`).set(auth(tokenA))
    expect(res.status).toBe(200)
    const plans = res.body.filter(r => r.type === 'service_plan')
    const masses = res.body.filter(r => r.type === 'mass')
    expect(plans.map(r => String(r.id))).toContain(String(plan.body.id))
    expect(plans.every(r => String(r.title).includes(RUN_ID))).toBe(true)
    expect(masses.map(r => String(r.id))).not.toContain(String(ours.id))

    const byMass = await request(server).get(`/api/search?q=${encodeURIComponent('Sunday Mass ' + RUN_ID)}`).set(auth(tokenA))
    expect(byMass.status).toBe(200)
    const found = byMass.body.filter(r => r.type === 'mass')
    expect(found.map(r => String(r.id))).toContain(String(ours.id))
    expect(found.map(r => String(r.id))).not.toContain(String(theirs.id))
    expect(byMass.body.some(r => r.type === 'mass' && String(r.title).includes('Finance meeting'))).toBe(false)
    expect(found.find(r => String(r.id) === String(ours.id)).date).toBe('2026-11-01')
  })

  it('a mass-word query finds Masses, and a Viewer does not receive service plans', async () => {
    const res = await request(server).get('/api/search?q=misa').set(auth(tokenViewer))
    expect(res.status).toBe(200)
    expect(res.body.some(r => r.type === 'service_plan')).toBe(false)
    expect(res.body.some(r => r.type === 'mass' && String(r.title).includes(RUN_ID))).toBe(true)
    expect(res.body.some(r => r.type === 'donation' || r.type === 'staff')).toBe(false)
  })
})
