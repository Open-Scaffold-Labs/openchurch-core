// A failed search scope used to come back as 200 []. The palette then
// said the parish had no matches. Any scope that throws fails the whole
// search. The body is a fixed sentence — the database text stays in the
// log. Auth and the organization_id filter are unchanged.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { _setSentryForTests } from '../src/monitoring/index.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const DB_MARKER = 'search-failure-marker-not-a-parish'

let server, token, orgId

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const res = await createOrg(server, {
    organizationName: `Search Failure ${RUN_ID}`,
    name: 'Search Admin',
    email: `search_fail_${RUN_ID}@example.com`,
    password: 'smoke-test-pw-233',
  }, '10.233.0.14')
  expect(res.status).toBe(201)
  token = res.body.token
  orgId = res.body.user.organization.id
}, 60_000)

afterAll(async () => {
  if (orgId) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId])
  await closeServer(server)
  await pool.end()
})

function auth() {
  return { Authorization: `Bearer ${token}` }
}

describe('GET /api/search failure is not an empty parish', () => {
  it('still returns matching rows when every scope succeeds', async () => {
    const res = await request(server).get('/api/search?q=maria').set(auth())
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.some(row => row.type === 'member' && /maria/i.test(row.name))).toBe(true)
  })

  it('an empty query is still an empty list', async () => {
    const res = await request(server).get('/api/search?q=').set(auth())
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('rejects an unauthenticated caller', async () => {
    const res = await request(server).get('/api/search?q=maria')
    expect(res.status).toBe(401)
    expect(res.text).not.toContain(DB_MARKER)
  })

  it('returns 500 with no database text when a scope fails', async () => {
    const real = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes('websearch_to_tsquery')) {
        return Promise.reject(new Error(`relation blew up ${DB_MARKER}`))
      }
      return real(sql, params)
    })
    try {
      const res = await request(server).get('/api/search?q=maria').set(auth())
      expect(res.status).toBe(500)
      expect(res.body).toEqual({ error: 'Search failed' })
      expect(JSON.stringify(res.body)).not.toContain(DB_MARKER)
      expect(res.text).not.toContain(DB_MARKER)
      expect(Array.isArray(res.body)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('returns 500 when only one scope fails, rather than a partial list', async () => {
    const real = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation((sql, params) => {
      if (
        typeof sql === 'string'
        && sql.includes('ochr_donations')
        && sql.includes('websearch_to_tsquery')
      ) {
        return Promise.reject(new Error(`donations scope down ${DB_MARKER}`))
      }
      return real(sql, params)
    })
    try {
      const res = await request(server).get('/api/search?q=maria').set(auth())
      expect(res.status).toBe(500)
      expect(res.body).toEqual({ error: 'Search failed' })
      expect(JSON.stringify(res.body)).not.toContain(DB_MARKER)
      expect(res.text).not.toContain(DB_MARKER)
      expect(res.text).not.toContain('Maria')
    } finally {
      spy.mockRestore()
    }
  })

  it('logs the query length and never the query text', async () => {
    const needle = `NomenPrivate233${RUN_ID}`
    const lines = []
    const sentryCalls = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk, encoding, cb) => {
      lines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      return write(chunk, encoding, cb)
    }
    const restoreSentry = _setSentryForTests({
      captureException(err, hint) {
        sentryCalls.push({
          message: err?.message,
          stack: err?.stack,
          hint,
        })
      },
    })
    const real = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes('websearch_to_tsquery')) {
        return Promise.reject(new Error('scope unavailable'))
      }
      return real(sql, params)
    })
    try {
      const res = await request(server)
        .get(`/api/search?q=${encodeURIComponent(needle)}`)
        .set(auth())
      expect(res.status).toBe(500)
      expect(res.text).not.toContain(needle)

      const handlerLines = lines.filter(line => line.includes('"scope":"search.handler"'))
      expect(handlerLines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line).not.toContain(needle)
      const logged = JSON.parse(handlerLines[0])
      expect(logged.qLength).toBe(needle.length)
      expect(logged.q).toBeUndefined()

      const handlerSentry = sentryCalls.filter(call => call.hint?.tags?.scope === 'search.handler')
      expect(handlerSentry).toHaveLength(1)
      expect(handlerSentry[0].hint.extra).toEqual({ qLength: needle.length })
      for (const call of sentryCalls) {
        expect(JSON.stringify(call)).not.toContain(needle)
      }
    } finally {
      process.stderr.write = write
      restoreSentry()
      spy.mockRestore()
    }
  })
})
