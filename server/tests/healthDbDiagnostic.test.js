// Health-check failures used to share one bare catch, so a ping throw
// and a ledger throw were the same discarded exception. The public
// payload stays that single database failure. The log line is the only
// new signal, and it is three fields: event, stage, code.
//
// Synthetic. pool.query is replaced before the app loads. Nothing here
// opens a database connection.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('dotenv/config', () => ({}))

vi.mock('../src/db.js', () => ({
  default: {
    query: (...args) => query(...args),
    on() { return this },
    end: () => Promise.resolve(),
  },
}))

import request from 'supertest'
import app, { HEALTH_PING_SQL } from '../src/app.js'
import { EXPECTED_MIGRATION } from '../src/migrations/names.js'
import { _resetForTests } from '../src/release/log.js'

const TOKEN = 'fixture-health-token-9f3a'
const LEAK_URL = 'https://fixture.example/health-db-leak'
const LEAK_MESSAGE = `connect failed ${LEAK_URL} bearer ${TOKEN}`

const lines = []
let errorSpy

function leakyError(code) {
  const err = new Error(LEAK_MESSAGE)
  err.code = code
  err.stack = `Error: ${LEAK_MESSAGE}\n    at healthHandler (${LEAK_URL})`
  err.detail = `detail ${TOKEN} ${LEAK_URL}`
  err.hint = `hint ${TOKEN}`
  err.where = `where ${LEAK_URL}`
  return err
}

function health() {
  return request(app).get('/api/health')
}

beforeEach(() => {
  lines.length = 0
  query.mockReset()
  _resetForTests()
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    lines.push(args.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join(' '))
  })
})

afterEach(() => {
  errorSpy.mockRestore()
})

function assertNoLeak(text) {
  expect(text).not.toContain(TOKEN)
  expect(text).not.toContain(LEAK_URL)
  expect(text).not.toContain(LEAK_MESSAGE)
  expect(text).not.toContain('bearer')
  expect(text).not.toContain('detail')
  expect(text).not.toContain('hint')
  expect(text).not.toContain('where')
  expect(text).not.toContain('at healthHandler')
}

function assertClosedFailure(res) {
  expect(res.status).toBe(503)
  expect(res.body.status).toBe('degraded')
  expect(res.body.db).toBe('error')
  expect(res.body.schema).toBe('unknown')
}

describe('health database failures are logged by stage', () => {
  it('a healthy probe stays 200 ok and writes no health_db line', async () => {
    query.mockImplementation(async (sql) => {
      if (sql === HEALTH_PING_SQL) return { rows: [{ '?column?': 1 }] }
      if (typeof sql === 'string' && sql.includes('ochr_schema_migrations')) {
        return { rows: [{ name: EXPECTED_MIGRATION }] }
      }
      if (typeof sql === 'string' && sql.includes('ochr_release_log')) {
        return { rows: [{ id: 1 }] }
      }
      throw leakyError('unexpected')
    })

    const res = await health()
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.db).toBe('ok')
    expect(res.body.schema).toBe('ok')
    expect(lines.filter(line => line.includes('health_db'))).toEqual([])
    assertNoLeak(res.text)
  })

  it('a ping failure logs stage ping with a SQLSTATE and stays a closed 503', async () => {
    const seen = []
    query.mockImplementation(async (sql) => {
      seen.push(sql)
      if (sql === HEALTH_PING_SQL) throw leakyError('08006')
      throw leakyError('ECONNRESET')
    })

    const res = await health()
    assertClosedFailure(res)
    expect(seen).toEqual([HEALTH_PING_SQL])
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ event: 'health_db', stage: 'ping', code: '08006' })
    expect(Object.keys(JSON.parse(lines[0]))).toEqual(['event', 'stage', 'code'])
    assertNoLeak(lines[0])
    assertNoLeak(res.text)
  })

  it('a ledger failure logs stage ledger and stays the same closed 503', async () => {
    query.mockImplementation(async (sql) => {
      if (sql === HEALTH_PING_SQL) return { rows: [{ '?column?': 1 }] }
      if (typeof sql === 'string' && sql.includes('ochr_schema_migrations')) throw leakyError('ECONNREFUSED')
      if (typeof sql === 'string' && sql.includes('ochr_release_log')) return { rows: [{ id: 1 }] }
      throw leakyError('unexpected')
    })

    const res = await health()
    assertClosedFailure(res)
    const healthLines = lines.filter(line => line.includes('health_db'))
    expect(healthLines).toHaveLength(1)
    expect(JSON.parse(healthLines[0])).toEqual({
      event: 'health_db',
      stage: 'ledger',
      code: 'ECONNREFUSED',
    })
    assertNoLeak(healthLines[0])
    assertNoLeak(lines.join('\n'))
    assertNoLeak(res.text)
  })

  it('an unrecognized code, including a token used as code, logs unknown', async () => {
    query.mockImplementation(async (sql) => {
      if (sql === HEALTH_PING_SQL) throw leakyError(TOKEN)
      throw leakyError('ECONNRESET')
    })

    const res = await health()
    assertClosedFailure(res)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ event: 'health_db', stage: 'ping', code: 'unknown' })
    assertNoLeak(lines[0])
    assertNoLeak(res.text)
  })

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
  ])('network code %s is logged and a near-miss is unknown', async (code) => {
    query.mockImplementation(async (sql) => {
      if (sql === HEALTH_PING_SQL) throw leakyError(code)
      throw leakyError('unexpected')
    })
    const allowed = await health()
    assertClosedFailure(allowed)
    expect(JSON.parse(lines[0]).code).toBe(code)

    lines.length = 0
    query.mockImplementation(async (sql) => {
      if (sql === HEALTH_PING_SQL) throw leakyError(`${code}-extra`)
      throw leakyError('unexpected')
    })
    const rejected = await health()
    assertClosedFailure(rejected)
    expect(JSON.parse(lines[0])).toEqual({ event: 'health_db', stage: 'ping', code: 'unknown' })
    expect(lines[0]).not.toContain(code)
    assertNoLeak(lines[0])
  })
})
