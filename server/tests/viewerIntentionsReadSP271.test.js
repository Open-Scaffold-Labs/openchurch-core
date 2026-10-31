// SP-271 / SP-275: Viewers may READ Mass Intentions (weekly sheet + book GETs).
// José, Oct 28 2026 PM PT: view-only staff can SEE intentions, read-only.
// Writes stay 403. Cross-tenant GETs must not leak another parish's rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { signToken } from '../src/middleware/auth.js'
import { viewerMayRead, viewerMayOpen } from '../src/middleware/viewerScope.js'

let server, orgA, orgB, massId, intentionId
const tok = {}

async function addUser(orgId, role, tag) {
  const email = `vi_${tag}_${role}_${RUN_ID}@example.com`
  const { rows } = await pool.query(
    `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
     VALUES ($1, $2, 'x', $3, $4) RETURNING id, token_version`,
    [orgId, email, `VI ${role}`, role])
  return signToken({
    userId: rows[0].id, organizationId: orgId, email,
    name: `VI ${role}`, role, tv: rows[0].token_version ?? 1,
  })
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const a = await createOrg(server, {
    organizationName: `VI A ${RUN_ID}`, name: 'Admin A',
    email: `vi_a_${RUN_ID}@example.com`, password: 'vi-test-pw-a',
  }, '10.216.1.1')
  expect(a.status).toBe(201)
  orgA = a.body.user.organization.id
  tok.admin = a.body.token
  const b = await createOrg(server, {
    organizationName: `VI B ${RUN_ID}`, name: 'Admin B',
    email: `vi_b_${RUN_ID}@example.com`, password: 'vi-test-pw-b',
  }, '10.216.1.2')
  expect(b.status).toBe(201)
  orgB = b.body.user.organization.id
  tok.adminB = b.body.token
  tok.viewer = await addUser(orgA, 'viewer', 'a')
  tok.viewerB = await addUser(orgB, 'viewer', 'b')

  const mass = await request(server).post('/api/calendar')
    .set('Authorization', `Bearer ${tok.admin}`)
    .send({
      title: `All Saints ${RUN_ID}`,
      date: '2026-11-01',
      start_time: '10:00',
      end_time: '11:00',
      type: 'service',
    })
  expect(mass.status).toBe(201)
  massId = mass.body.id

  const mi = await request(server).post('/api/mass-intentions')
    .set('Authorization', `Bearer ${tok.admin}`)
    .send({
      intention: `† Joseph Testwalker ${RUN_ID}`,
      requested_by: 'Teresa Testwalker',
      calendar_event_id: massId,
    })
  expect(mi.status).toBe(201)
  intentionId = mi.body.id
}, 60_000)

afterAll(async () => {
  for (const id of [orgA, orgB]) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

const as = (who) => ({ Authorization: `Bearer ${tok[who]}` })

describe('SP-271/275 Viewer may read Mass Intentions', () => {
  it('allowlist: weekly + book GETs open; print page opens; book editor stays closed', () => {
    expect(viewerMayRead('/api/mass-intentions')).toBe(true)
    expect(viewerMayRead('/api/mass-intentions/weekly')).toBe(true)
    expect(viewerMayOpen('/mass-intentions/print')).toBe(true)
    expect(viewerMayOpen('/mass-intentions')).toBe(false)
  })

  it('Viewer GET weekly sees the booked intention for their parish', async () => {
    const res = await request(server)
      .get('/api/mass-intentions/weekly?start=2026-10-31&end=2026-11-06')
      .set(as('viewer'))
    expect(res.status).toBe(200)
    const rows = res.body.intentions || []
    const hit = rows.find(r => r.id === intentionId)
    expect(hit).toBeTruthy()
    expect(String(hit.formatted_intention || hit.intention)).toMatch(/Joseph Testwalker/)
    expect(Number(hit.calendar_event_id)).toBe(massId)
  })

  it('Viewer writes still 403 on intention and event endpoints', async () => {
    const posts = await Promise.all([
      request(server).post('/api/mass-intentions').set(as('viewer'))
        .send({ intention: `Should refuse ${RUN_ID}` }),
      request(server).post(`/api/mass-intentions/${intentionId}/assign`).set(as('viewer'))
        .send({ calendar_event_id: massId }),
      request(server).post(`/api/mass-intentions/${intentionId}/unassign`).set(as('viewer'))
        .send({ expected_calendar_event_id: massId }),
      request(server).patch(`/api/mass-intentions/${intentionId}`).set(as('viewer'))
        .send({ intention: 'nope' }),
      request(server).delete(`/api/mass-intentions/${intentionId}`).set(as('viewer')),
      request(server).patch(`/api/calendar/${massId}`).set(as('viewer'))
        .send({ title: 'nope', date: '2026-11-01', start_time: '10:00', end_time: '11:00', type: 'service' }),
      request(server).delete(`/api/calendar/${massId}`).set(as('viewer')),
    ])
    for (const res of posts) expect(res.status).toBe(403)
    const still = await request(server).get(`/api/mass-intentions/${intentionId}`).set(as('admin'))
    expect(still.status).toBe(200)
    expect(still.body.intention || still.body.formatted_intention).toMatch(/Joseph Testwalker/)
  })

  it('cross-tenant Viewer cannot read another parish weekly or by id', async () => {
    const weekly = await request(server)
      .get('/api/mass-intentions/weekly?start=2026-10-31&end=2026-11-06')
      .set(as('viewerB'))
    expect(weekly.status).toBe(200)
    const ids = (weekly.body.intentions || []).map(r => r.id)
    expect(ids).not.toContain(intentionId)

    const one = await request(server)
      .get(`/api/mass-intentions/${intentionId}`)
      .set(as('viewerB'))
    expect([403, 404]).toContain(one.status)
    expect(JSON.stringify(one.body)).not.toMatch(/Joseph Testwalker|Testwalker/)
  })
})
