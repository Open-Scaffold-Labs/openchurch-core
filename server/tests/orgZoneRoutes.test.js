// Two parishes, one instant. Pledge totals and care days must follow
// each parish's own timezone. A UTC clock, or the other parish's zone,
// swaps or collapses the answers below.
//
// Frozen at 2026-09-27T04:17:00Z:
//   Los Angeles is still 2026-09-26. Auckland and UTC are 2026-09-27.
//   Open weekly $7 starting 2026-09-27: LA $0, Auckland $1.
//   A contact on 2026-06-19 is 99 LA days (ready) and 100 Auckland days
//   (awaiting_update).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'

const INSTANT = new Date('2026-09-27T04:17:00.000Z')
const CONTACT = '2026-06-19'
const LA = 'America/Los_Angeles'
const AKL = 'Pacific/Auckland'

let server
let dioceseId
let laId
let aklId
let userIds = []

function sign(userId, organizationId, tv) {
  return jwt.sign(
    { userId, organizationId, role: 'admin', tv },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  )
}

async function insertOrg(name, slug, orgType, timezone) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type, timezone)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, orgType, timezone],
  )
  return rows[0].id
}

async function insertUser(organizationId, email) {
  const { rows } = await pool.query(
    `INSERT INTO ochr_users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'Admin', $2, 'x', 'admin') RETURNING id, token_version`,
    [organizationId, email],
  )
  userIds.push(rows[0].id)
  return rows[0]
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  dioceseId = await insertOrg(`Zone Diocese ${RUN_ID}`, `zone-dio-${RUN_ID}`, 'diocese', 'UTC')
  laId = await insertOrg(`Zone LA ${RUN_ID}`, `zone-la-${RUN_ID}`, 'parish', LA)
  aklId = await insertOrg(`Zone Auckland ${RUN_ID}`, `zone-akl-${RUN_ID}`, 'parish', AKL)
  await pool.query(
    `INSERT INTO ochr_diocese_affiliations (diocese_org_id, parish_org_id, status, grant_level)
     VALUES ($1, $2, 'active', 'summary'), ($1, $3, 'active', 'summary')`,
    [dioceseId, laId, aklId],
  )
  for (const parishId of [laId, aklId]) {
    await pool.query(
      `INSERT INTO ochr_parish_timeline
         (diocese_org_id, parish_org_id, kind, summary, occurred_on, visibility)
       VALUES ($1, $2, 'note', 'A shared note', $3, 'shared')`,
      [dioceseId, parishId, CONTACT],
    )
    await pool.query(
      `INSERT INTO ochr_pledges (organization_id, donor_email, amount, frequency, start_date, status)
       VALUES ($1, $2, 7, 'weekly', '2026-09-27', 'active')`,
      [parishId, `donor_${parishId}_${RUN_ID}@example.com`],
    )
  }
}, 60_000)

afterAll(async () => {
  vi.useRealTimers()
  const orgs = [dioceseId, laId, aklId].filter(Boolean)
  if (orgs.length) {
    await pool.query('DELETE FROM ochr_pledges WHERE organization_id = ANY($1)', [orgs]).catch(() => {})
    await pool.query('DELETE FROM ochr_parish_timeline WHERE diocese_org_id = $1', [dioceseId]).catch(() => {})
    await pool.query('DELETE FROM ochr_diocese_affiliations WHERE diocese_org_id = $1', [dioceseId]).catch(() => {})
    if (userIds.length) await pool.query('DELETE FROM ochr_users WHERE id = ANY($1)', [userIds]).catch(() => {})
    await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1)', [orgs]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

function freeze() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(INSTANT)
}

describe('parish timezone on the pledge and care routes', () => {
  it('pledge totals follow each parish, not UTC and not each other', async () => {
    freeze()
    try {
      const laUser = await insertUser(laId, `zone_la_${RUN_ID}@example.com`)
      const aklUser = await insertUser(aklId, `zone_akl_${RUN_ID}@example.com`)
      const auth = (token) => ({ Authorization: `Bearer ${token}` })
      const laList = await request(server).get('/api/pledges').set(auth(sign(laUser.id, laId, laUser.token_version)))
      const aklList = await request(server).get('/api/pledges').set(auth(sign(aklUser.id, aklId, aklUser.token_version)))
      expect(laList.status, JSON.stringify(laList.body)).toBe(200)
      expect(aklList.status, JSON.stringify(aklList.body)).toBe(200)
      expect([
        laList.body.pledges[0].period_total,
        aklList.body.pledges[0].period_total,
      ]).toEqual([0, 1])
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('care list, detail, and brief follow each parish', async () => {
    freeze()
    try {
      const dioUser = await insertUser(dioceseId, `zone_dio_${RUN_ID}@example.com`)
      const auth = { Authorization: `Bearer ${sign(dioUser.id, dioceseId, dioUser.token_version)}` }
      const list = await request(server).get('/api/diocese/care').set(auth)
      expect(list.status, JSON.stringify(list.body)).toBe(200)
      const byId = new Map(list.body.parishes.map(p => [p.parish_org_id, p.status.key]))
      expect([byId.get(laId), byId.get(aklId)]).toEqual(['ready', 'awaiting_update'])

      for (const [parishId, key] of [[laId, 'ready'], [aklId, 'awaiting_update']]) {
        const detail = await request(server).get(`/api/diocese/care/${parishId}`).set(auth)
        const brief = await request(server).get(`/api/diocese/care/${parishId}/brief`).set(auth)
        expect(detail.status, JSON.stringify(detail.body)).toBe(200)
        expect(brief.status, JSON.stringify(brief.body)).toBe(200)
        expect(detail.body.status.key).toBe(key)
        expect(brief.body.situation.key).toBe(key)
      }
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)
})
