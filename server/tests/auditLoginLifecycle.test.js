// Stage 6 — the audit log tells the truth about login lifecycle.
//
// Before this, the generic audit middleware read every POST as "create"
// and every DELETE as "delete": closing, turning off, or turning back on
// a login was stored as "Created user", and the legacy DELETE /users/:id
// (which closes, never deletes) as "Deleted user". Self-service closure
// and turn-off left no row at all. Earlier rows are not rewritten.
//
// The route that changed the login marks the row with the id it parsed,
// so the label survives case-insensitive routing and zero-padded ids, and
// the row's action (close / deactivate / reactivate) is a value no earlier
// row can carry.
//
// Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

let server
const cleanupOrgIds = []
let ip = 1

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
}, 60_000)

afterAll(async () => {
  for (const id of cleanupOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

const auth = (token) => ({ Authorization: `Bearer ${token}` })
const PW = 'lifecycle-test-pw'

async function signup(tag) {
  const res = await createOrg(server, {
    organizationName: `Lifecycle ${tag} ${RUN_ID}`,
    name: 'Parish Admin',
    email: `life_${tag}_${RUN_ID}@example.com`,
    password: PW,
  }, `10.91.${ip++}.1`)
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return { token: res.body.token, orgId: res.body.user.organization.id, userId: res.body.user.id }
}

async function addUser(org, tag, role = 'staff') {
  const email = `life_${tag}_${RUN_ID}@example.com`
  const res = await request(server).post('/api/users').set(auth(org.token)).send({
    name: `Synthetic ${tag}`, email, password: PW, role,
  })
  expect(res.status).toBe(201)
  const login = await request(server).post('/api/auth/login').send({ email, password: PW })
  expect(login.status).toBe(200)
  return { id: res.body.id, token: login.body.token }
}

// The middleware writes after the response finishes; give it a moment.
async function rowsFor(orgId, method, path, n = 1) {
  let rows = []
  for (let i = 0; i < 20; i++) {
    ;({ rows } = await pool.query(
      `SELECT user_id, user_name, user_email, action, entity_type, entity_id, summary, metadata, request_path
         FROM ochr_audit_log
        WHERE organization_id = $1 AND request_method = $2 AND request_path = $3
        ORDER BY id`,
      [orgId, method, path]
    ))
    if (rows.length >= n) return rows
    await new Promise((r) => setTimeout(r, 50))
  }
  return rows
}

describe('login lifecycle rows say what happened', () => {
  it('admin turn-off, repeat turn-off and turn-on are updates, not creations', async () => {
    const org = await signup('toggle')
    const s = await addUser(org, 'toggle_staff')

    expect((await request(server).post(`/api/users/${s.id}/deactivate`).set(auth(org.token))).status).toBe(200)
    let [row] = await rowsFor(org.orgId, 'POST', `/api/users/${s.id}/deactivate`)
    expect(row).toMatchObject({
      action: 'deactivate', entity_type: 'user', entity_id: String(s.id),
      summary: `Turned login off #${s.id}`,
      metadata: { via: 'admin' },
      user_id: org.userId,
    })

    // Second turn-off changes nothing and the row says so.
    await request(server).post(`/api/users/${s.id}/deactivate`).set(auth(org.token))
    const both = await rowsFor(org.orgId, 'POST', `/api/users/${s.id}/deactivate`, 2)
    expect(both).toHaveLength(2)
    expect(both[1].summary).toBe(`Turned login off #${s.id} (already off)`)
    expect(both[1].metadata).toEqual({ via: 'admin', already: true })

    expect((await request(server).post(`/api/users/${s.id}/reactivate`).set(auth(org.token))).status).toBe(200)
    ;[row] = await rowsFor(org.orgId, 'POST', `/api/users/${s.id}/reactivate`)
    expect(row).toMatchObject({
      action: 'reactivate', entity_id: String(s.id),
      summary: `Turned login back on #${s.id}`,
      metadata: { via: 'admin' },
    })
  })

  it('admin closure is a closure', async () => {
    const org = await signup('close')
    const s = await addUser(org, 'close_staff')
    const res = await request(server).post(`/api/users/${s.id}/close`).set(auth(org.token))
    expect(res.status).toBe(200)
    const [row] = await rowsFor(org.orgId, 'POST', `/api/users/${s.id}/close`)
    expect(row).toMatchObject({
      action: 'close', entity_type: 'user', entity_id: String(s.id),
      summary: `Closed login #${s.id}`,
      metadata: { via: 'admin' },
      user_id: org.userId,
      user_name: 'Parish Admin',
    })

    // Closing it again changes nothing; the second row says so.
    expect((await request(server).post(`/api/users/${s.id}/close`).set(auth(org.token))).status).toBe(200)
    const both = await rowsFor(org.orgId, 'POST', `/api/users/${s.id}/close`, 2)
    expect(both).toHaveLength(2)
    expect(both[1].summary).toBe(`Closed login #${s.id} (already closed)`)
  })

  it('the legacy DELETE closes and is recorded as a closure, not a deletion', async () => {
    const org = await signup('legacy')
    const s = await addUser(org, 'legacy_staff')
    const res = await request(server).delete(`/api/users/${s.id}`).set(auth(org.token))
    expect(res.status).toBe(204)
    const { rows: [u] } = await pool.query('SELECT closed_at FROM ochr_users WHERE id = $1', [s.id])
    expect(u.closed_at).not.toBeNull()
    const [row] = await rowsFor(org.orgId, 'DELETE', `/api/users/${s.id}`)
    expect(row.action).toBe('close')
    expect(row.summary).toBe(`Closed login #${s.id}`)
    expect(row.metadata).toEqual({ via: 'legacy-delete' })

    // A second legacy DELETE confirms rather than changes; the row says so.
    expect((await request(server).delete(`/api/users/${s.id}`).set(auth(org.token))).status).toBe(204)
    const both = await rowsFor(org.orgId, 'DELETE', `/api/users/${s.id}`, 2)
    expect(both[1].summary).toBe(`Closed login #${s.id} (already closed)`)
  })

  it('self turn-off and self closure leave a row; the closure row carries no name or email', async () => {
    const org = await signup('self')
    const off = await addUser(org, 'self_off')
    const gone = await addUser(org, 'self_gone')

    expect((await request(server).post('/api/auth/deactivate').set(auth(off.token))).status).toBe(200)
    const [offRow] = await rowsFor(org.orgId, 'POST', '/api/auth/deactivate')
    expect(offRow).toMatchObject({
      action: 'deactivate', entity_type: 'user', entity_id: String(off.id), user_id: off.id,
      summary: `Turned own login off #${off.id}`,
      metadata: { via: 'self' },
    })

    expect((await request(server).post('/api/auth/close').set(auth(gone.token))).status).toBe(200)
    const [closeRow] = await rowsFor(org.orgId, 'POST', '/api/auth/close')
    expect(closeRow).toMatchObject({
      action: 'close', entity_id: String(gone.id), user_id: gone.id,
      summary: `Closed own login #${gone.id}`,
      metadata: { via: 'self' },
      user_name: null,
      user_email: null,
    })

    // The admin read shows the closed actor as a former operator.
    const read = await request(server).get('/api/audit-log?entity_type=user').set(auth(org.token))
    const shown = read.body.rows.find((r) => r.request_path === '/api/auth/close')
    expect(shown).toMatchObject({ actor_closed: true, user_email: null })
  })

  it('a refused closure (last active admin) writes no lifecycle row', async () => {
    const org = await signup('refused')
    const res = await request(server).post(`/api/users/${org.userId}/close`).set(auth(org.token))
    expect(res.status).toBe(409)
    expect(await rowsFor(org.orgId, 'POST', `/api/users/${org.userId}/close`)).toEqual([])
  })

  it('earlier rows are not rewritten', async () => {
    const org = await signup('history')
    const s = await addUser(org, 'history_staff')
    // A row as the old middleware wrote it for a closure.
    const { rows: [old] } = await pool.query(
      `INSERT INTO ochr_audit_log
         (organization_id, user_id, user_email, user_name, action, entity_type, entity_id,
          summary, metadata, request_method, request_path, status_code)
       VALUES ($1, $2, NULL, 'Parish Admin', 'create', 'user', $3, 'Created user', '{}',
               'POST', $4, 200)
       RETURNING id`,
      [org.orgId, org.userId, String(s.id), `/api/users/${s.id}/close`]
    )
    await request(server).post(`/api/users/${s.id}/close`).set(auth(org.token))
    const rows = await rowsFor(org.orgId, 'POST', `/api/users/${s.id}/close`, 2)
    expect(rows).toHaveLength(2)
    const { rows: [still] } = await pool.query('SELECT action, summary FROM ochr_audit_log WHERE id = $1', [old.id])
    expect(still).toEqual({ action: 'create', summary: 'Created user' })
    expect(rows[1].summary).toBe(`Closed login #${s.id}`)
  })

  it('an earlier ordinary update carrying client-sent op/via metadata stays an update', async () => {
    const org = await signup('forged')
    const s = await addUser(org, 'forged_staff')
    // Before the reserved-key strip, a client body could put these in metadata.
    await pool.query(
      `INSERT INTO ochr_audit_log
         (organization_id, user_id, user_email, user_name, action, entity_type, entity_id,
          summary, metadata, request_method, request_path, status_code)
       VALUES ($1, $2, NULL, 'Parish Admin', 'update', 'user', $3, $4,
               '{"op":"close","via":"admin","already":true}', 'PATCH', $5, 200)`,
      [org.orgId, org.userId, String(s.id), `Updated user #${s.id}`, `/api/users/${s.id}/role`]
    )
    const read = await request(server).get(`/api/audit-log?entity_type=user&entity_id=${s.id}`).set(auth(org.token))
    const row = read.body.rows.find((r) => r.request_path === `/api/users/${s.id}/role`)
    expect(row).toMatchObject({ action: 'update', summary: `Updated user #${s.id}` })
    const closes = await request(server).get(`/api/audit-log?entity_type=user&entity_id=${s.id}&action=close`).set(auth(org.token))
    expect(closes.body.rows).toEqual([])
  })
})

describe('a request body cannot label its own row', () => {
  it('op/via/already sent by a client are not stored', async () => {
    const org = await signup('spoof')
    const res = await request(server).post('/api/users').set(auth(org.token)).send({
      name: 'Synthetic spoof', email: `life_spoof_user_${RUN_ID}@example.com`, password: PW, role: 'staff',
      op: 'close', via: 'admin', already: true,
    })
    expect(res.status).toBe(201)
    const [row] = await rowsFor(org.orgId, 'POST', '/api/users')
    expect(row.action).toBe('create')
    expect(row.metadata.op).toBeUndefined()
    expect(row.metadata.via).toBeUndefined()
    expect(row.metadata.already).toBeUndefined()
  })
})

describe('the label follows the route that acted, not a re-read of the URL', () => {
  it('a zero-padded id is recorded as the user it closed', async () => {
    const org = await signup('padded')
    const s = await addUser(org, 'padded_staff')
    const padded = `00${s.id}`
    const res = await request(server).post(`/api/users/${padded}/close`).set(auth(org.token))
    expect(res.status).toBe(200)
    const [row] = await rowsFor(org.orgId, 'POST', `/api/users/${padded}/close`)
    expect(row).toMatchObject({ action: 'close', entity_id: String(s.id), summary: `Closed login #${s.id}` })
    // The record's history view (entity_id = the real id) finds it.
    const read = await request(server)
      .get(`/api/audit-log?entity_type=user&entity_id=${s.id}&action=close`).set(auth(org.token))
    expect(read.status).toBe(200)
    expect(read.body.rows.map((r) => r.request_path)).toContain(`/api/users/${padded}/close`)
  })

  it('mixed-case routes still record lifecycle rows', async () => {
    const org = await signup('casing')
    const a = await addUser(org, 'casing_a')
    const b = await addUser(org, 'casing_b')

    expect((await request(server).post(`/API/Users/${a.id}/Deactivate`).set(auth(org.token))).status).toBe(200)
    const [off] = await rowsFor(org.orgId, 'POST', `/API/Users/${a.id}/Deactivate`)
    expect(off).toMatchObject({ action: 'deactivate', entity_id: String(a.id), summary: `Turned login off #${a.id}` })

    expect((await request(server).post(`/api/USERS/${a.id}/REACTIVATE`).set(auth(org.token))).status).toBe(200)
    const [on] = await rowsFor(org.orgId, 'POST', `/api/USERS/${a.id}/REACTIVATE`)
    expect(on).toMatchObject({ action: 'reactivate', entity_id: String(a.id) })

    expect((await request(server).delete(`/Api/Users/${a.id}`).set(auth(org.token))).status).toBe(204)
    const [del] = await rowsFor(org.orgId, 'DELETE', `/Api/Users/${a.id}`)
    expect(del).toMatchObject({ action: 'close', entity_id: String(a.id), metadata: { via: 'legacy-delete' } })

    expect((await request(server).post('/API/Auth/Close').set(auth(b.token))).status).toBe(200)
    const [self] = await rowsFor(org.orgId, 'POST', '/API/Auth/Close')
    expect(self).toMatchObject({ action: 'close', entity_id: String(b.id), user_name: null, user_email: null, metadata: { via: 'self' } })
  })

  it('the action filter accepts the lifecycle actions and nothing invented', async () => {
    const org = await signup('filter')
    const s = await addUser(org, 'filter_staff')
    await request(server).post(`/api/users/${s.id}/deactivate`).set(auth(org.token))
    await rowsFor(org.orgId, 'POST', `/api/users/${s.id}/deactivate`)
    const ok = await request(server).get('/api/audit-log?action=deactivate').set(auth(org.token))
    expect(ok.status).toBe(200)
    expect(ok.body.rows.length).toBeGreaterThan(0)
    expect(ok.body.rows.every((r) => r.action === 'deactivate')).toBe(true)
    const bad = await request(server).get('/api/audit-log?action=closed').set(auth(org.token))
    expect(bad.status).toBe(400)
  })
})

describe('boundaries: tenants, refusals, forging, same-actor closure, export', () => {
  it('a lifecycle call on another parish\'s login is refused and leaves no lifecycle row in either parish', async () => {
    const a = await signup('tenant_a')
    const b = await signup('tenant_b')
    const victim = await addUser(b, 'tenant_victim')
    for (const [method, path] of [
      ['post', `/api/users/${victim.id}/close`],
      ['post', `/api/users/${victim.id}/deactivate`],
      ['post', `/api/users/${victim.id}/reactivate`],
      ['delete', `/api/users/${victim.id}`],
    ]) {
      const res = await request(server)[method](path).set(auth(a.token))
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    const { rows } = await pool.query(
      `SELECT organization_id, action FROM ochr_audit_log
        WHERE organization_id = ANY($1::int[]) AND action = ANY($2::text[])`,
      [[a.orgId, b.orgId], ['close', 'deactivate', 'reactivate']]
    )
    expect(rows).toEqual([])
    const { rows: [u] } = await pool.query('SELECT closed_at, deactivated_at FROM ochr_users WHERE id = $1', [victim.id])
    expect(u).toEqual({ closed_at: null, deactivated_at: null })
  })

  it('refused operations write no lifecycle row: last admin turn-off, turning a closed login back on', async () => {
    const org = await signup('refusals')
    expect((await request(server).post(`/api/users/${org.userId}/deactivate`).set(auth(org.token))).status).toBe(409)
    const s = await addUser(org, 'refusals_staff')
    expect((await request(server).post(`/api/users/${s.id}/close`).set(auth(org.token))).status).toBe(200)
    expect((await request(server).post(`/api/users/${s.id}/reactivate`).set(auth(org.token))).status).toBe(409)
    await rowsFor(org.orgId, 'POST', `/api/users/${s.id}/close`)
    const { rows } = await pool.query(
      `SELECT action, request_path FROM ochr_audit_log
        WHERE organization_id = $1 AND action IN ('deactivate', 'reactivate')`,
      [org.orgId]
    )
    expect(rows).toEqual([])
  })

  it('a client cannot choose the action: a body action of close on an ordinary create stays create', async () => {
    const org = await signup('forge_action')
    const res = await request(server).post('/api/users').set(auth(org.token)).send({
      name: 'Synthetic forger', email: `life_forge_action_user_${RUN_ID}@example.com`, password: PW, role: 'staff',
      action: 'close', op: 'close', via: 'admin',
    })
    expect(res.status).toBe(201)
    const [row] = await rowsFor(org.orgId, 'POST', '/api/users')
    expect(row.action).toBe('create')
    expect(row.metadata.op).toBeUndefined()
    expect(row.metadata.via).toBeUndefined()
  })

  it('an admin closing their own login through a zero-padded admin route: canonical id, no name or email on the row', async () => {
    const org = await signup('selfpad')
    await addUser(org, 'selfpad_second_admin', 'admin') // so the first admin is not the last
    const res = await request(server).post(`/api/users/000${org.userId}/close`).set(auth(org.token))
    expect(res.status).toBe(200)
    const [row] = await rowsFor(org.orgId, 'POST', `/api/users/000${org.userId}/close`)
    expect(row).toMatchObject({
      action: 'close', entity_id: String(org.userId), user_id: org.userId,
      user_name: null, user_email: null, summary: `Closed login #${org.userId}`,
    })
  })

  it('CSV export carries lifecycle actions and honours the lifecycle filter', async () => {
    const org = await signup('csv')
    const s = await addUser(org, 'csv_staff')
    await request(server).post(`/api/users/${s.id}/deactivate`).set(auth(org.token))
    await request(server).post(`/api/users/${s.id}/close`).set(auth(org.token))
    await rowsFor(org.orgId, 'POST', `/api/users/${s.id}/close`)
    const all = await request(server).get('/api/audit-log/export.csv').set(auth(org.token))
    expect(all.status).toBe(200)
    expect(all.text).toContain(`"close","user","${s.id}","Closed login #${s.id}"`)
    expect(all.text).toContain(`"deactivate","user","${s.id}","Turned login off #${s.id}"`)
    const closes = await request(server).get('/api/audit-log/export.csv?action=close').set(auth(org.token))
    const lines = closes.text.trim().split('\n').slice(1)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain(`"Closed login #${s.id}"`)
  })
})
