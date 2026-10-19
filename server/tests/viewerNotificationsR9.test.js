// Jarvis R9: /api/notifications is open to Viewers (the header bell) but
// returns the whole parish's task/event assignment feed, i.e. titles of
// Events and Daily Tasks that Viewers are otherwise refused. Viewers now get
// an empty list while VIEWER_OPTIONS.eventsTasks is closed; Staff unchanged.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { signToken } from '../src/middleware/auth.js'

let server, orgId
const tokens = {}
beforeAll(async () => {
  await migrateOnce(); server = await bindServer()
  const res = await createOrg(server, {
    organizationName: `R9 Notif ${RUN_ID}`, name: 'Admin', email: `r9n_admin_${RUN_ID}@example.com`, password: 'r9n-test-pw-long',
  }, '10.219.9.1')
  expect(res.status).toBe(201)
  orgId = res.body.user.organization.id
  for (const role of ['staff', 'viewer']) {
    const email = `r9n_${role}_${RUN_ID}@example.com`
    const { rows } = await pool.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, 'x', $3, $4) RETURNING id, token_version`, [orgId, email, `R9 ${role}`, role])
    tokens[role] = signToken({ userId: rows[0].id, organizationId: orgId, email, name: `R9 ${role}`, role, tv: rows[0].token_version ?? 1 })
  }
  await pool.query(`INSERT INTO ochr_notifications (organization_id, type, task_title, message)
                    VALUES ($1, 'task', 'Secret task R9', 'Assigned: Secret task R9')`, [orgId])
}, 60_000)
afterAll(async () => {
  await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  await closeServer(server); await pool.end()
})

describe('viewer notifications bell', () => {
  it('Viewer gets 200 and no task/event titles', async () => {
    const r = await request(server).get('/api/notifications').set('Authorization', `Bearer ${tokens.viewer}`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual([])
    expect(JSON.stringify(r.body)).not.toMatch(/Secret task R9/)
  })
  it('Staff still sees the feed', async () => {
    const r = await request(server).get('/api/notifications').set('Authorization', `Bearer ${tokens.staff}`)
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.body)).toMatch(/Secret task R9/)
  })
})
