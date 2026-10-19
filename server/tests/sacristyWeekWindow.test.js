// No-parameter weekly window. A faked instant that is Sunday evening in
// the parish and Monday in UTC catches both "the route ignores the org
// zone" and "the route went back to today through six days".

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import pool from '../src/db.js'
import { bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
let token
let orgId
const email = `vigil-${Date.now()}@test.dev`
const password = 'testpass123'

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const created = await createOrg(server, {
    organizationName: `Vigil Week ${Date.now()}`,
    name: 'Secretary',
    email,
    password,
  }, '10.88.1.9')
  expect(created.status).toBe(201)
  token = created.body.token
  orgId = created.body.user.organization.id
}, 60_000)

afterAll(async () => {
  vi.useRealTimers()
  await closeServer(server)
  await pool.end()
})

describe('weekly sacristy window', () => {
  it('no start uses the parish vigil week, not UTC today through six days', async () => {
    await pool.query(
      `UPDATE ochr_organizations SET timezone = 'America/Los_Angeles' WHERE id = $1`,
      [orgId]
    )
    vi.useFakeTimers({ toFake: ['Date'] })
    // Sunday 2026-10-04 21:00 Pacific. Monday 2026-10-05 04:00 UTC.
    // Sign in under that clock so the token's issued-at matches it.
    vi.setSystemTime(new Date('2026-10-05T04:00:00.000Z'))
    try {
      const login = await request(server).post('/api/auth/login')
        .set('X-Forwarded-For', '10.88.1.10')
        .send({ email, password })
      expect(login.status).toBe(200)
      const res = await request(server)
        .get('/api/mass-intentions/weekly')
        .set('Authorization', `Bearer ${login.body.token}`)
      expect(res.status).toBe(200)
      expect(res.body.start).toBe('2026-10-03')
      expect(res.body.end).toBe('2026-10-09')
      expect(res.body.timezone).toBe('America/Los_Angeles')
      expect(res.body.truncated).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('impossible dates are 400, and year 0999 keeps four digits', async () => {
    for (const start of ['2026-02-31', '2026-13-01']) {
      const res = await request(server)
        .get(`/api/mass-intentions/weekly?start=${start}`)
        .set('Authorization', `Bearer ${token}`)
      expect(res.status, start).toBe(400)
      expect(res.body.error).toMatch(/real calendar dates/i)
    }
    const early = await request(server)
      .get('/api/mass-intentions/weekly?start=0999-01-01')
      .set('Authorization', `Bearer ${token}`)
    expect(early.status).toBe(200)
    expect(early.body.start).toBe('0999-01-01')
    expect(early.body.end).toBe('0999-01-07')
  })

  it('echoes an invalid stored zone as UTC', async () => {
    await pool.query(
      `UPDATE ochr_organizations SET timezone = 'Not/AZone' WHERE id = $1`,
      [orgId]
    )
    const res = await request(server)
      .get('/api/mass-intentions/weekly?start=2026-10-03&end=2026-10-09')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.timezone).toBe('UTC')
    expect(res.body.intention_total).toBe(0)
    expect(res.body.truncated).toBe(false)
  })

  it('intention_total does not count cancelled rows', async () => {
    await pool.query(
      `INSERT INTO ochr_mass_intentions (organization_id, intention, mass_date, status)
       VALUES ($1, 'SCHEDULED SAMPLE', '2031-06-07', 'scheduled'),
              ($1, 'CANCELLED SAMPLE', '2031-06-07', 'cancelled')`,
      [orgId]
    )
    const res = await request(server)
      .get('/api/mass-intentions/weekly?start=2031-06-06&end=2031-06-12')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.intentions).toHaveLength(1)
    expect(res.body.intentions[0].formatted_intention).toBe('SCHEDULED SAMPLE')
    expect(JSON.stringify(res.body.intentions)).not.toContain('CANCELLED SAMPLE')
    expect(res.body.intention_total).toBe(1)
    expect(res.body.truncated).toBe(false)
  })

  it('truncated is true when the week has more rows than the page', async () => {
    await pool.query(
      `INSERT INTO ochr_mass_intentions (organization_id, intention, mass_date, status)
       SELECT $1, 'CAP SAMPLE ' || g, '2031-07-04', 'scheduled'
         FROM generate_series(1, 501) AS g`,
      [orgId]
    )
    const res = await request(server)
      .get('/api/mass-intentions/weekly?start=2031-07-03&end=2031-07-09')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.intentions).toHaveLength(500)
    expect(res.body.intention_total).toBe(501)
    expect(res.body.truncated).toBe(true)
  })

  it('login echoes an invalid stored zone as UTC', async () => {
    await pool.query(
      `UPDATE ochr_organizations SET timezone = 'Not/AZone' WHERE id = $1`,
      [orgId]
    )
    const login = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.88.1.11')
      .send({ email, password })
    expect(login.status).toBe(200)
    expect(login.body.user.organization.timezone).toBe('UTC')
  })

  it('/me echoes an invalid stored zone as UTC', async () => {
    await pool.query(
      `UPDATE ochr_organizations SET timezone = 'Not/AZone' WHERE id = $1`,
      [orgId]
    )
    const me = await request(server).get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(me.status).toBe(200)
    expect(me.body.user.organization.timezone).toBe('UTC')
  })
})

// The weekly list and the count must share one REPEATABLE READ client.
// These assertions go red if BEGIN disappears, if ROLLBACK disappears,
// or if the count runs on a different client than the list.
function watchWeeklyClient(fault) {
  const log = []
  const releases = []
  const origConnect = pool.connect.bind(pool)
  const spy = vi.spyOn(pool, 'connect').mockImplementation((...args) => {
    if (typeof args[args.length - 1] === 'function') return origConnect(...args)
    return origConnect(...args).then((client) => {
      const originalQuery = client.query
      const originalRelease = client.release
      client.query = async (text, params) => {
        const sql = String(typeof text === 'string' ? text : (text?.text ?? '')).replace(/\s+/g, ' ').trim()
        log.push({ client, sql })
        if (typeof fault === 'function' && fault(sql)) throw new Error('weekly probe')
        return originalQuery.call(client, text, params)
      }
      client.release = (err) => {
        client.query = originalQuery
        client.release = originalRelease
        releases.push(err ?? null)
        return originalRelease(err)
      }
      return client
    })
  })
  return { log, releases, restore: () => spy.mockRestore() }
}

describe('weekly snapshot client', () => {
  const week = '/api/mass-intentions/weekly?start=2031-08-01&end=2031-08-07'

  it('runs BEGIN, the list, and the count on one client, then COMMIT', async () => {
    const watch = watchWeeklyClient()
    try {
      const res = await request(server).get(week).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      const sqls = watch.log.map((entry) => entry.sql)
      const begin = sqls.findIndex((sql) => sql.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
      const list = sqls.findIndex((sql) => sql.includes('FROM ochr_sacristy_weekly_manifest') && sql.includes('LIMIT'))
      const count = sqls.findIndex((sql) => sql.includes('COUNT(*)'))
      const commit = sqls.findIndex((sql) => sql === 'COMMIT')
      expect(begin).toBe(0)
      expect(list).toBeGreaterThan(begin)
      expect(count).toBeGreaterThan(list)
      expect(commit).toBeGreaterThan(count)
      expect(new Set(watch.log.map((entry) => entry.client)).size).toBe(1)
    } finally {
      watch.restore()
    }
  })

  it('rolls the snapshot back on that same client when a query fails', async () => {
    const watch = watchWeeklyClient((sql) => sql.includes('COUNT(*)'))
    try {
      const res = await request(server).get(week).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(500)
      const count = watch.log.findIndex((entry) => entry.sql.includes('COUNT(*)'))
      const rollback = watch.log.findIndex((entry) => entry.sql === 'ROLLBACK')
      expect(count).toBeGreaterThanOrEqual(0)
      expect(rollback).toBeGreaterThan(count)
      expect(watch.log[rollback].client).toBe(watch.log[count].client)
    } finally {
      watch.restore()
    }
  })

  it('destroys the client when ROLLBACK itself fails', async () => {
    const watch = watchWeeklyClient((sql) => sql.includes('COUNT(*)') || sql === 'ROLLBACK')
    try {
      const res = await request(server).get(week).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(500)
      expect(watch.releases).toEqual([expect.any(Error)])
    } finally {
      watch.restore()
    }
  })
})
