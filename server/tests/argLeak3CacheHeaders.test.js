// ARG-LEAK-3: authenticated API responses are Cache-Control: no-store and
// Express is not advertised. Synthetic data only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

const R = RUN_ID.replace(/[^a-z0-9]/gi, '').toLowerCase()
const email = `leak3_${R}@argus.test`
let server, orgId, token
const auth = () => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', '10.95.1.1')
    .send({ organizationName: `Leak3 ${R}`, name: 'Admin', email, password: 'leak3-test-pw' })
  expect(res.status).toBe(201)
  orgId = res.body.user.organization.id; token = res.body.token
}, 60_000)
afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})

describe('ARG-LEAK-3 cache and framework headers', () => {
  it('login response is no-store and has no X-Powered-By', async () => {
    const res = await request(server).post('/api/auth/login').set('X-Forwarded-For', '10.95.1.2').send({ email, password: 'leak3-test-pw' })
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })
  it.each(['/api/auth/me', '/api/donations', '/api/organization/export', '/api/clients'])('%s is no-store', async (p) => {
    const res = await request(server).get(p).set(auth())
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })
  it('error responses on /api are no-store too', async () => {
    const res = await request(server).get('/api/donations')
    expect(res.status).toBe(401)
    expect(res.headers['cache-control']).toBe('no-store')
  })
})
