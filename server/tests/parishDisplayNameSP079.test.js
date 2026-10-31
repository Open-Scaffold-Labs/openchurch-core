// SP-079. Staff who print the order of worship were refused GET
// /api/organization (admin settings: letterhead, EIN, signatory), so the
// sheet said the parish name did not load and a reload could not fix it.
//
// The display-name read returns the caller's parish name and nothing else.
// Staff and Admin may read it. A Viewer may not. The full settings block
// stays admin-only. A query organization id cannot select another parish.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { signToken } from '../src/middleware/auth.js'

const SENTINEL_EIN = `EIN-SP079-${RUN_ID}`
const SENTINEL_LETTERHEAD = `LETTERHEAD-SP079-${RUN_ID}`

let server
const orgs = []
const tokens = {}

async function addUser(orgId, role) {
  const email = `sp079_${role}_${orgId}_${RUN_ID}@example.com`
  const name = `SP079 ${role}`
  const { rows } = await pool.query(
    `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
     VALUES ($1, $2, 'x', $3, $4) RETURNING id, token_version`,
    [orgId, email, name, role],
  )
  return signToken({
    userId: rows[0].id,
    organizationId: orgId,
    email,
    name,
    role,
    tv: rows[0].token_version ?? 1,
  })
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `Parish A ${RUN_ID}`,
    name: 'Admin A',
    email: `sp079_admin_a_${RUN_ID}@example.com`,
    password: 'display-name-pw-1',
  }, '10.79.1.1')
  expect(a.status).toBe(201)
  const b = await createOrg(server, {
    organizationName: `Parish B ${RUN_ID}`,
    name: 'Admin B',
    email: `sp079_admin_b_${RUN_ID}@example.com`,
    password: 'display-name-pw-1',
  }, '10.79.1.2')
  expect(b.status).toBe(201)
  orgs.push(a.body.user.organization.id, b.body.user.organization.id)
  tokens.adminA = a.body.token
  tokens.adminB = b.body.token
  tokens.staffA = await addUser(orgs[0], 'staff')
  tokens.viewerA = await addUser(orgs[0], 'viewer')
  tokens.staffB = await addUser(orgs[1], 'staff')
  await pool.query(
    `UPDATE ochr_organizations
        SET tax_id = $2, statement_letterhead = $3, signatory_name = $4
      WHERE id = $1`,
    [orgs[0], SENTINEL_EIN, SENTINEL_LETTERHEAD, 'Pastor Ada'],
  )
}, 60_000)

afterAll(async () => {
  for (const id of orgs) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

const get = (token, path) => request(server).get(path).set('Authorization', `Bearer ${token}`)

describe('SP-079 parish display name', () => {
  it('Staff receives this parish name and none of the admin settings', async () => {
    const res = await get(tokens.staffA, '/api/organization/display-name')
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['name'])
    expect(res.body.name).toBe(`Parish A ${RUN_ID}`)
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain(SENTINEL_EIN)
    expect(raw).not.toContain(SENTINEL_LETTERHEAD)
    expect(raw).not.toContain('Pastor Ada')
  })

  it('Admin receives the same name-only read', async () => {
    const res = await get(tokens.adminA, '/api/organization/display-name')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ name: `Parish A ${RUN_ID}` })
  })

  it('Admin still receives the settings block, including the letterhead', async () => {
    const res = await get(tokens.adminA, '/api/organization')
    expect(res.status).toBe(200)
    expect(res.body.name).toBe(`Parish A ${RUN_ID}`)
    expect(res.body.tax_id).toBe(SENTINEL_EIN)
    expect(res.body.statement_letterhead).toBe(SENTINEL_LETTERHEAD)
  })

  it('Staff is still refused the settings block', async () => {
    const res = await get(tokens.staffA, '/api/organization')
    expect(res.status).toBe(403)
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain(SENTINEL_EIN)
    expect(raw).not.toContain(SENTINEL_LETTERHEAD)
    expect(raw).not.toContain(`Parish A ${RUN_ID}`)
  })

  it('a Viewer is refused the display name and the settings block', async () => {
    const name = await get(tokens.viewerA, '/api/organization/display-name')
    expect(name.status).toBe(403)
    const settings = await get(tokens.viewerA, '/api/organization')
    expect(settings.status).toBe(403)
    for (const body of [name.body, settings.body]) {
      const raw = JSON.stringify(body)
      expect(raw).not.toContain(SENTINEL_EIN)
      expect(raw).not.toContain(SENTINEL_LETTERHEAD)
      expect(raw).not.toContain(`Parish A ${RUN_ID}`)
    }
  })

  it('a query organization id cannot select another parish', async () => {
    const res = await get(
      tokens.staffB,
      `/api/organization/display-name?organization_id=${orgs[0]}&id=${orgs[0]}`,
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ name: `Parish B ${RUN_ID}` })
    expect(JSON.stringify(res.body)).not.toContain(`Parish A ${RUN_ID}`)
  })

  it('an anonymous caller is refused', async () => {
    const res = await request(server).get('/api/organization/display-name')
    expect(res.status).toBe(401)
  })

  // R346-1. The URL is the same for every parish. private,max-age would
  // let one browser profile reuse the previous parish's name after a
  // login switch. The API no-store policy has to survive this handler.
  it('does not store the display name in the browser cache', async () => {
    const responses = [
      await get(tokens.staffA, '/api/organization/display-name'),
      await get(tokens.adminA, '/api/organization/display-name'),
      await get(tokens.staffB, `/api/organization/display-name?organization_id=${orgs[0]}&id=${orgs[0]}`),
      await get(tokens.viewerA, '/api/organization/display-name'),
    ]
    expect(responses[0].status).toBe(200)
    expect(responses[0].body).toEqual({ name: `Parish A ${RUN_ID}` })
    expect(responses[1].status).toBe(200)
    expect(responses[1].body).toEqual({ name: `Parish A ${RUN_ID}` })
    expect(responses[2].status).toBe(200)
    expect(responses[2].body).toEqual({ name: `Parish B ${RUN_ID}` })
    expect(responses[3].status).toBe(403)
    for (const res of responses) {
      const cache = String(res.headers['cache-control'] || '')
      expect(cache).toMatch(/no-store/i)
      expect(cache).not.toMatch(/max-age/i)
      expect(cache).not.toMatch(/\bprivate\b/i)
    }
  })
})
