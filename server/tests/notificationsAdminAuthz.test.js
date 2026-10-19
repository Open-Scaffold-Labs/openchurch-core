// OC-OP-1 / OC-OP-2 containment — the two GLOBAL notification operator
// actions must be reachable only by the env-identified super-admin, never by
// an ordinary parish or diocesan admin holding the live DB role 'admin'.
//
//   POST /api/admin/notifications/enqueue-birthdays  (walks every org)
//   POST /api/admin/notifications/drain              (claims/sends any org's mail)
//
// The tenant-scoped GET views (/scheduled, /log) and the CRON_SECRET-guarded
// /api/cron/* execution paths must keep working. Authorization layering is:
//   requireAuth (401) -> requireRole('admin') (403) -> requireSuperAdmin (404).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { signToken } from '../src/middleware/auth.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { clearPlatformIds } from './support/platform.js'

let server
const createdOrgIds = []
const savedEnv = {}

async function mkOrg(tag, orgType = 'parish') {
  const slug = `naz-${tag}-${RUN_ID}`
  const o = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type, tradition)
     VALUES ($1, $2, $3, 'episcopal') RETURNING id`,
    [`NAZ ${tag} ${RUN_ID}`, slug, orgType])
  createdOrgIds.push(o.rows[0].id)
  return o.rows[0].id
}

async function mkUser(orgId, tag, role) {
  const email = `naz_${tag}_${RUN_ID}@example.com`
  const u = await pool.query(
    `INSERT INTO ochr_users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'x', $4) RETURNING id, token_version`,
    [orgId, `NAZ ${tag}`, email, role])
  const token = signToken({
    userId: u.rows[0].id, organizationId: orgId, email,
    name: `NAZ ${tag}`, role, tv: u.rows[0].token_version,
  })
  return { id: u.rows[0].id, orgId, email, token }
}

const auth = t => ({ Authorization: `Bearer ${t}` })
const enqueue = t => {
  const r = request(server).post('/api/admin/notifications/enqueue-birthdays')
  return t ? r.set(auth(t)) : r
}
const drain = t => {
  const r = request(server).post('/api/admin/notifications/drain')
  return t ? r.set(auth(t)) : r
}

// F-01: founder privilege is by user id only. The email var is set too, to
// prove it is inert on its own (it is only the notification address).
const setSuperAdmin = user => {
  if (user === null) { delete process.env.SUPER_ADMIN_EMAIL; clearPlatformIds(); return }
  process.env.SUPER_ADMIN_EMAIL = user.email
  process.env.SUPER_ADMIN_USER_IDS = String(user.id)
}

let orgA, adminA, staffA, viewerA
let orgB, adminB
let orgD, adminD

async function insertPending(orgId, recipient) {
  const r = await pool.query(
    `INSERT INTO ochr_scheduled_notifications
       (organization_id, recipient_email, notification_type, vars, send_at, status)
     VALUES ($1, $2, 'assignment_reminder', '{}'::jsonb, NOW() - INTERVAL '5 minutes', 'pending')
     RETURNING id`,
    [orgId, recipient])
  return r.rows[0].id
}

async function insertLog(orgId, recipient) {
  await pool.query(
    `INSERT INTO ochr_notification_log
       (organization_id, recipient_email, notification_type, status, subject)
     VALUES ($1, $2, 'assignment_reminder', 'stubbed', $3)`,
    [orgId, recipient, `Log ${RUN_ID}`])
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  savedEnv.SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL
  savedEnv.CRON_SECRET = process.env.CRON_SECRET

  orgA = await mkOrg('a', 'parish')
  adminA = await mkUser(orgA, 'a_admin', 'admin')
  staffA = await mkUser(orgA, 'a_staff', 'staff')
  viewerA = await mkUser(orgA, 'a_viewer', 'viewer')

  orgB = await mkOrg('b', 'parish')
  adminB = await mkUser(orgB, 'b_admin', 'admin')

  orgD = await mkOrg('d', 'diocese')
  adminD = await mkUser(orgD, 'd_admin', 'admin')
}, 60_000)

afterAll(async () => {
  // Restore env exactly as found — never leak SUPER_ADMIN_EMAIL / CRON_SECRET.
  setSuperAdmin(null)
  if (savedEnv.CRON_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedEnv.CRON_SECRET

  for (const id of createdOrgIds) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

// 1
it('anonymous callers cannot reach either global POST (401)', async () => {
  setSuperAdmin(null)
  expect((await enqueue()).status).toBe(401)
  expect((await drain()).status).toBe(401)
})

// 2
it('staff and viewer roles cannot reach either global POST (403)', async () => {
  // Even with a configured super-admin, the role gate stops non-admins first.
  setSuperAdmin(adminA)
  for (const tok of [staffA.token, viewerA.token]) {
    expect((await enqueue(tok)).status).toBe(403)
    expect((await drain(tok)).status).toBe(403)
  }
})

// 3
it('an ordinary parish admin cannot enqueue birthdays globally (404)', async () => {
  // A real super-admin exists (orgB's admin) — orgA's admin still is not it.
  setSuperAdmin(adminB)
  expect((await enqueue(adminA.token)).status).toBe(404)
})

// 4
it('an ordinary parish admin cannot drain the global queue (404)', async () => {
  setSuperAdmin(adminB)
  expect((await drain(adminA.token)).status).toBe(404)
})

// 5
it('a diocesan admin has no additional operator authority (404)', async () => {
  setSuperAdmin(adminB)
  expect((await enqueue(adminD.token)).status).toBe(404)
  expect((await drain(adminD.token)).status).toBe(404)
})

// 6
it('a correctly configured super-admin can invoke both actions (200)', async () => {
  setSuperAdmin(adminA)
  expect((await enqueue(adminA.token)).status).toBe(200)
  expect((await drain(adminA.token)).status).toBe(200)
})

// 7
it('missing SUPER_ADMIN_EMAIL fails closed for both actions (404)', async () => {
  setSuperAdmin(null)
  // adminA WOULD be the operator if one were configured; unset ⇒ nobody is.
  expect((await enqueue(adminA.token)).status).toBe(404)
  expect((await drain(adminA.token)).status).toBe(404)
})

// 8
it('tenant-admin GET scheduled/log stay available and organization-scoped', async () => {
  setSuperAdmin(null) // the GET views must NOT be behind the super-admin gate
  const aSched = `sched_a_${RUN_ID}@example.com`
  const bSched = `sched_b_${RUN_ID}@example.com`
  const aLog = `log_a_${RUN_ID}@example.com`
  const bLog = `log_b_${RUN_ID}@example.com`
  await insertPending(orgA, aSched)
  await insertPending(orgB, bSched)
  await insertLog(orgA, aLog)
  await insertLog(orgB, bLog)

  const sched = await request(server).get('/api/admin/notifications/scheduled').set(auth(adminA.token))
  expect(sched.status).toBe(200)
  const schedEmails = sched.body.scheduled.map(r => r.recipient_email)
  expect(schedEmails).toContain(aSched)
  expect(schedEmails).not.toContain(bSched)

  const log = await request(server).get('/api/admin/notifications/log').set(auth(adminA.token))
  expect(log.status).toBe(200)
  const logEmails = log.body.log.map(r => r.recipient_email)
  expect(logEmails).toContain(aLog)
  expect(logEmails).not.toContain(bLog)
})

// 9
it('CRON_SECRET-protected birthday enqueue and drain paths still function (200)', async () => {
  setSuperAdmin(null) // irrelevant to the cron path; prove it is independent
  process.env.CRON_SECRET = `cron-${RUN_ID}`
  const cronAuth = { Authorization: `Bearer ${process.env.CRON_SECRET}` }
  const e = await request(server).post('/api/cron/enqueue-birthdays').set(cronAuth)
  expect(e.status).toBe(200)
  const d = await request(server).post('/api/cron/drain-notifications').set(cronAuth)
  expect(d.status).toBe(200)
})

// 10
it('a denied admin drain leaves another organization\'s pending notification untouched', async () => {
  setSuperAdmin(adminB) // orgA's admin is denied
  const recipient = `untouched_${RUN_ID}@example.com`
  const pendingId = await insertPending(orgB, recipient)

  const res = await drain(adminA.token)
  expect(res.status).toBe(404)

  const { rows } = await pool.query(
    'SELECT status FROM ochr_scheduled_notifications WHERE id = $1', [pendingId])
  expect(rows[0].status).toBe('pending') // never claimed or sent
})

// 11
it('a denied admin enqueue creates no notification rows for another organization', async () => {
  setSuperAdmin(adminB) // orgA's admin is denied
  const countB = async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_scheduled_notifications
        WHERE organization_id = $1
          AND notification_type IN ('member_birthday', 'member_anniversary')`,
      [orgB])
    return rows[0].n
  }
  const before = await countB()
  const res = await enqueue(adminA.token)
  expect(res.status).toBe(404)
  const after = await countB()
  expect(after).toBe(before) // the global service never ran
})
