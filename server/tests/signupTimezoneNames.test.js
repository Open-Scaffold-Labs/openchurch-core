// Signup must store a zone Postgres can use in AT TIME ZONE.
// Legacy browser names are rewritten. Offsets and names this
// database does not list become UTC. Settings rejects those
// instead of writing them.

import 'dotenv/config'
import request from 'supertest'
import { classifyDatabaseUrl } from '../../scripts/lib/db-target-guard.mjs'

const dbTarget = classifyDatabaseUrl(process.env.DATABASE_URL)
if (dbTarget.kind !== 'local') {
  throw new Error(
    `signupTimezoneNames.test.js refuses to run (database target kind=${dbTarget.kind}). Export a loopback DATABASE_URL.`
  )
}

const { default: pool } = await import('../src/db.js')
const { migrateOnce, RUN_ID, bindServer, closeServer } = await import('./support/harness.js')
const {
  PARISH_TIMEZONE_ALIASES,
  canonicalParishTimeZone,
  acceptedParishTimeZone,
  _setParishTimeZoneLookupForTests,
} = await import('../src/utils/timezone.js')

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

let server
let signupN = 0
const orgIds = []

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  await closeServer(server)
  if (orgIds.length) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1::int[])', [orgIds])
  }
  await pool.end()
})

async function signup(timezone) {
  signupN += 1
  const name = `Zone Parish ${RUN_ID} ${signupN}`
  const body = {
    organizationName: name,
    name: 'Secretary',
    email: `zone-${RUN_ID}-${signupN}@example.com`,
    password: 'signup-zone-pw-1',
    tradition: 'catholic',
  }
  if (timezone !== undefined) body.timezone = timezone
  const res = await request(server)
    .post('/api/auth/signup')
    .set('X-Forwarded-For', `10.228.0.${signupN}`)
    .send(body)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  const orgId = res.body.user.organization.id
  orgIds.push(orgId)
  return { orgId, token: res.body.token, name }
}

async function storedZone(orgId) {
  const { rows } = await pool.query(
    'SELECT name, timezone FROM ochr_organizations WHERE id = $1',
    [orgId]
  )
  return rows[0]
}

async function removeOrg(orgId) {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId])
  const i = orgIds.indexOf(orgId)
  if (i >= 0) orgIds.splice(i, 1)
}

async function expectClockRoutes(orgId, token) {
  const kioskToken = `zonekiosk${String(orgId).padStart(12, '0')}`
  await pool.query(
    'UPDATE ochr_organizations SET kiosk_token = $1 WHERE id = $2',
    [kioskToken, orgId]
  )
  const auth = { Authorization: `Bearer ${token}` }
  const kiosk = await request(server).get(`/api/kiosk/${kioskToken}`)
  const today = await request(server).get('/api/checklists/today').set(auth)
  const packet = await request(server).get('/api/packet').set(auth)
  expect(kiosk.status, kiosk.text).toBe(200)
  expect(today.status, today.text).toBe(200)
  expect(packet.status, packet.text).toBe(200)
}

describe('signup stores a Postgres timezone name', () => {
  it('maps each legacy alias and the clock routes answer 200', async () => {
    for (const [legacy, modern] of Object.entries(PARISH_TIMEZONE_ALIASES)) {
      const { orgId, token } = await signup(legacy)
      const row = await storedZone(orgId)
      expect(row.timezone, legacy).toBe(modern)
      await expectClockRoutes(orgId, token)
      await removeOrg(orgId)
    }
  }, 180_000)

  it('trims the submitted zone before mapping it', async () => {
    const { orgId } = await signup('  Asia/Calcutta  ')
    expect((await storedZone(orgId)).timezone).toBe('Asia/Kolkata')
    await removeOrg(orgId)
  }, 60_000)

  it('stores UTC for a bare offset or a POSIX string', async () => {
    // EST5EDT is a real pg_timezone_names entry on this build and on a
    // full tzdata. The refusal is the syntax guard, not a missing row.
    for (const bad of ['+05:00', '+0500', 'EST5EDT']) {
      const { orgId } = await signup(bad)
      expect((await storedZone(orgId)).timezone, bad).toBe('UTC')
      await removeOrg(orgId)
    }
  }, 60_000)

  it('the syntax guard rejects offsets and POSIX strings with no catalog lookup', () => {
    expect(canonicalParishTimeZone('+05:00')).toBeNull()
    expect(canonicalParishTimeZone('+0500')).toBeNull()
    expect(canonicalParishTimeZone('EST5EDT')).toBeNull()
    expect(canonicalParishTimeZone('PST8PDT')).toBeNull()
    expect(canonicalParishTimeZone('<+05>5')).toBeNull()
    expect(canonicalParishTimeZone('Etc/GMT+5')).toBe('Etc/GMT+5')
    expect(canonicalParishTimeZone('America/New_York')).toBe('America/New_York')
  })

  it('a catalog error stores UTC and signup still succeeds', async () => {
    _setParishTimeZoneLookupForTests(async (db) => {
      return db.query('SELECT 1 FROM pg_catalog.pg_timezone_names_not_a_table')
    })
    try {
      const { orgId } = await signup('America/Los_Angeles')
      expect((await storedZone(orgId)).timezone).toBe('UTC')
      await removeOrg(orgId)
    } finally {
      _setParishTimeZoneLookupForTests(null)
    }
  }, 60_000)

  it('a catalog miss stores UTC without depending on which names this tzdata lacks', async () => {
    _setParishTimeZoneLookupForTests(async () => ({ rows: [] }))
    try {
      const { orgId } = await signup('America/Chicago')
      expect((await storedZone(orgId)).timezone).toBe('UTC')
      await removeOrg(orgId)
    } finally {
      _setParishTimeZoneLookupForTests(null)
    }
  }, 60_000)

  it('every Intl zone resolves to a name this database lists', async () => {
    const utcFamily = new Set([
      'UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'UCT', 'Universal', 'Zulu',
      'Etc/GMT0', 'Etc/GMT+0', 'Etc/GMT-0', 'Etc/Greenwich', 'Greenwich',
    ])
    const names = typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : []
    expect(names.length).toBeGreaterThan(100)
    const resolved = []
    for (const name of names) {
      const result = await acceptedParishTimeZone(pool, name)
      expect(result.ok, name).toBe(true)
      if (!utcFamily.has(name)) expect(result.zone, name).not.toBe('UTC')
      resolved.push(result.zone)
    }
    const unique = [...new Set(resolved)]
    const listed = await pool.query(
      'SELECT name FROM pg_timezone_names WHERE name = ANY($1::text[])',
      [unique]
    )
    const have = new Set(listed.rows.map(r => r.name))
    for (const zone of unique) expect(have.has(zone), zone).toBe(true)
  }, 60_000)

  it('keeps Etc/GMT+5, which is a real zone name', async () => {
    const { orgId, token } = await signup('Etc/GMT+5')
    expect((await storedZone(orgId)).timezone).toBe('Etc/GMT+5')
    await expectClockRoutes(orgId, token)
    await removeOrg(orgId)
  }, 60_000)
})

describe('org settings refuse a zone Postgres cannot use', () => {
  it('returns 400 for +05:00 and +0500 and writes nothing', async () => {
    const { orgId, token, name } = await signup('America/Los_Angeles')
    const auth = { Authorization: `Bearer ${token}` }
    for (const bad of ['+05:00', '+0500']) {
      const res = await request(server)
        .patch('/api/organization')
        .set(auth)
        .send({ timezone: bad, name: 'Renamed Parish' })
      expect(res.status, res.text).toBe(400)
      const row = await storedZone(orgId)
      expect(row.timezone).toBe('America/Los_Angeles')
      expect(row.name).toBe(name)
    }
    await removeOrg(orgId)
  }, 60_000)

  it('a catalog miss is a 400 and writes nothing, including a UTC fallback', async () => {
    const { orgId, token, name } = await signup('America/Los_Angeles')
    _setParishTimeZoneLookupForTests(async () => ({ rows: [] }))
    try {
      const res = await request(server)
        .patch('/api/organization')
        .set('Authorization', `Bearer ${token}`)
        .send({ timezone: 'America/Chicago', name: 'Renamed Parish' })
      expect(res.status, res.text).toBe(400)
      const row = await storedZone(orgId)
      expect(row.timezone).toBe('America/Los_Angeles')
      expect(row.name).toBe(name)
    } finally {
      _setParishTimeZoneLookupForTests(null)
    }
    await removeOrg(orgId)
  }, 60_000)

  it('a blank timezone resets to UTC', async () => {
    const { orgId, token } = await signup('America/Los_Angeles')
    const auth = { Authorization: `Bearer ${token}` }
    for (const blank of ['', '   ', null]) {
      const set = await request(server)
        .patch('/api/organization')
        .set(auth)
        .send({ timezone: 'America/Denver' })
      expect(set.status, set.text).toBe(200)
      const res = await request(server)
        .patch('/api/organization')
        .set(auth)
        .send({ timezone: blank })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.timezone).toBe('UTC')
      expect((await storedZone(orgId)).timezone).toBe('UTC')
    }
    await removeOrg(orgId)
  }, 60_000)

  it('stores the modern name when settings are given a legacy alias', async () => {
    const { orgId, token } = await signup('UTC')
    const res = await request(server)
      .patch('/api/organization')
      .set('Authorization', `Bearer ${token}`)
      .send({ timezone: 'US/Pacific' })
    expect(res.status, res.text).toBe(200)
    expect(res.body.timezone).toBe('America/Los_Angeles')
    expect((await storedZone(orgId)).timezone).toBe('America/Los_Angeles')
    await removeOrg(orgId)
  }, 60_000)
})
