// SP-185. ⌘K "Testwalker" returned no results because /api/search did not
// look at Mass intentions. Staff/admin search must find this org's
// intentions by intention text or requester; Viewers must not; stipend
// must not appear in the payload.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server, tokenA, tokenB, tokenViewer

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `Search Intentions ${RUN_ID}`,
    name: 'Ada Admin',
    email: `sp185_${RUN_ID}@example.com`,
    password: 'sp185-test-pw-0001',
  }, '10.254.2.1')
  expect(a.status).toBe(201)
  tokenA = a.body.token
  const b = await createOrg(server, {
    organizationName: `Search Intentions Other ${RUN_ID}`,
    name: 'Bea Admin',
    email: `sp185b_${RUN_ID}@example.com`,
    password: 'sp185-test-pw-0001',
  }, '10.254.2.2')
  expect(b.status).toBe(201)
  tokenB = b.body.token

  const viewer = await request(server).post('/api/users').set(auth(tokenA)).send({
    name: 'Vera Viewer',
    email: `sp185v_${RUN_ID}@example.com`,
    password: 'sp185-viewer-pw-01',
    role: 'viewer',
  })
  expect(viewer.status).toBe(201)
  const login = await request(server).post('/api/auth/login').send({
    email: `sp185v_${RUN_ID}@example.com`,
    password: 'sp185-viewer-pw-01',
  })
  expect(login.status).toBe(200)
  tokenViewer = login.body.token
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  await pool.end()
})

const auth = token => ({ Authorization: `Bearer ${token}` })

describe('SP-185 search finds Mass intentions in this org', () => {
  it('staff search finds Testwalker by intention text, not the other parish, and never returns stipend', async () => {
    const ours = await request(server).post('/api/mass-intentions').set(auth(tokenA)).send({
      intention: `† Saint test - for the repose of the soul of Joseph Testwalker ${RUN_ID}`,
      requested_by: 'Saint Test - Teresa Testwalker',
      mass_date: '2026-11-01',
      status: 'scheduled',
    })
    expect(ours.status).toBe(201)

    const theirs = await request(server).post('/api/mass-intentions').set(auth(tokenB)).send({
      intention: `† Saint test - for the repose of the soul of Joseph Testwalker ${RUN_ID}`,
      requested_by: 'Other Parish',
      mass_date: '2026-11-08',
      status: 'scheduled',
    })
    expect(theirs.status).toBe(201)

    const res = await request(server)
      .get(`/api/search?q=${encodeURIComponent('Testwalker ' + RUN_ID)}`)
      .set(auth(tokenA))
    expect(res.status).toBe(200)
    const hits = res.body.filter(r => r.type === 'mass_intention')
    expect(hits.map(r => String(r.id))).toContain(String(ours.body.id))
    expect(hits.map(r => String(r.id))).not.toContain(String(theirs.body.id))
    expect(hits.every(r => !('stipend' in r) && !('amount' in r))).toBe(true)
    expect(hits.find(r => String(r.id) === String(ours.body.id)).title).toMatch(/Testwalker/)
  })

  it('a Viewer does not receive Mass intention hits', async () => {
    const res = await request(server)
      .get(`/api/search?q=${encodeURIComponent('Testwalker ' + RUN_ID)}`)
      .set(auth(tokenViewer))
    expect(res.status).toBe(200)
    expect(res.body.some(r => r.type === 'mass_intention')).toBe(false)
  })
})
