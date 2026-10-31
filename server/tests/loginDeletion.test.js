// C3 (Dale, #342 comment 6429592110) — self-serve login deletion.
// Synthetic local data only.
//
// A confirmed deletion removes this login's personal profile, sessions,
// push tokens, and personal preferences, and replaces telemetry/audit
// actor references with a tombstone UUID.
//
// It keeps ochr_sacramental_records and the contribution/financial
// ledger byte for byte. Voiding a gift is not deletion. A parish cannot
// lose its last active admin. Another parish's rows are not touched.

import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { tombstoneEmail } from '../src/auth/loginClosure.js'
import { confirmDeletionRequest } from '../src/auth/deletionRequest.js'

let server
const orgs = []
const auth = (t) => ({ Authorization: `Bearer ${t}` })
const PW = 'c3-delete-pw-123'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function canon(row) {
  return JSON.parse(JSON.stringify(row))
}

async function signup(tag, ip) {
  const res = await request(server).post('/api/auth/signup').set('X-Forwarded-For', ip)
    .send({ organizationName: `C3 ${tag} ${RUN_ID}`, name: `Admin ${tag}`, email: `c3_${tag}_${RUN_ID}@example.com`, password: PW })
  expect(res.status).toBe(201)
  orgs.push(res.body.user.organization.id)
  return {
    token: res.body.token,
    userId: res.body.user.id,
    orgId: res.body.user.organization.id,
    email: `c3_${tag}_${RUN_ID}@example.com`,
  }
}

async function addStaff(admin, tag) {
  const email = `c3_${tag}_${RUN_ID}@example.com`
  const u = await request(server).post('/api/users').set(auth(admin.token))
    .send({ name: `Staff ${tag}`, email, password: PW, role: 'staff' })
  expect(u.status).toBe(201)
  const login = await request(server).post('/api/auth/login').set('X-Forwarded-For', '10.95.1.20')
    .send({ email, password: PW })
  expect(login.status).toBe(200)
  return { token: login.body.token, userId: u.body.id, email, name: `Staff ${tag}` }
}

async function one(sql, params) {
  const { rows } = await pool.query(sql, params)
  return rows[0] || null
}

let admin, staff, other
let registerBefore, ledgerBefore, giftBefore, amendmentBefore
let auditId, otherAuditId, adminAuditId
let giftId

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  admin = await signup('a', '10.95.1.1')
  staff = await addStaff(admin, 'staff')
  other = await signup('b', '10.95.1.3')

  const { rows: [register] } = await pool.query(
    `INSERT INTO ochr_sacramental_records
       (organization_id, type, date, minister, place, certificate_no, notes)
     VALUES ($1, 'baptism', '2014-06-08', 'Rev. Synthetic', 'St Test', $2, 'Kept register line')
     RETURNING *`,
    [admin.orgId, `C3-${RUN_ID}`])
  registerBefore = canon(register)

  const { rows: [amendment] } = await pool.query(
    `INSERT INTO ochr_sacrament_amendments
       (organization_id, sacrament_id, kind, reason, before_json, after_json, amended_by, amended_by_name, amended_by_email)
     VALUES ($1, $2, 'correction', 'Spelling of the place', $3::jsonb, $4::jsonb, $5, $6, $7)
     RETURNING *`,
    [admin.orgId, register.id, JSON.stringify({ place: 'Old' }), JSON.stringify({ place: 'St Test' }), staff.userId, staff.name, staff.email])
  amendmentBefore = canon(amendment)

  const { rows: [gift] } = await pool.query(
    `INSERT INTO ochr_donations
       (organization_id, donor_name, amount, category, method, date, notes, payment_status)
     VALUES ($1, 'Synthetic Donor', 40.00, 'Offertory', 'cash', '2018-03-04', 'Kept gift', NULL)
     RETURNING *`,
    [admin.orgId])
  giftBefore = canon(gift)
  giftId = gift.id

  const { rows: [ledger] } = await pool.query(
    `INSERT INTO ochr_ledger_entries
       (organization_id, entry_date, account_code, amount, memo, source_type, created_by)
     VALUES ($1, '2018-03-04', '4100', 40.00, 'Kept ledger line', 'manual', $2)
     RETURNING *`,
    [admin.orgId, staff.userId])
  ledgerBefore = canon(ledger)

  const { rows: [audit] } = await pool.query(
    `INSERT INTO ochr_audit_log
       (organization_id, user_id, user_email, user_name, action, entity_type, summary, ip_address, metadata)
     VALUES ($1, $2, $3, $4, 'update', 'client', $5, '203.0.113.10', $6::jsonb)
     RETURNING id`,
    [admin.orgId, staff.userId, staff.email, staff.name, `Kept summary for ${staff.name}`, JSON.stringify({ name: staff.name, email: staff.email, note: 'kept' })])
  auditId = audit.id

  const { rows: [adminAudit] } = await pool.query(
    `INSERT INTO ochr_audit_log
       (organization_id, user_id, user_email, user_name, action, entity_type, summary)
     VALUES ($1, $2, $3, 'Admin a', 'update', 'client', 'Admin summary stays')
     RETURNING id`,
    [admin.orgId, admin.userId, admin.email])
  adminAuditId = adminAudit.id

  const { rows: [otherAudit] } = await pool.query(
    `INSERT INTO ochr_audit_log
       (organization_id, user_id, user_email, user_name, action, entity_type, summary)
     VALUES ($1, $2, $3, 'Admin b', 'update', 'client', 'Other parish stays')
     RETURNING id`,
    [other.orgId, other.userId, other.email])
  otherAuditId = otherAudit.id

  await pool.query(
    `INSERT INTO ochr_ai_audit
       (application, environment, organization_id, actor_id, request_id, event)
     VALUES ('openchurch', 'test', $1, $2, $3, 'succeeded')`,
    [admin.orgId, staff.userId, `c3-${RUN_ID}`])
  await pool.query(
    `INSERT INTO ochr_ai_usage (organization_id, endpoint, user_id)
     VALUES ($1, 'generate', $2)`,
    [admin.orgId, staff.userId])
  await pool.query(
    `INSERT INTO ochr_push_subscriptions
       (organization_id, user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, 'k', 'a')`,
    [admin.orgId, staff.userId, `https://push.example.test/${RUN_ID}/${staff.userId}`])
  await pool.query(
    `INSERT INTO ochr_push_subscriptions
       (organization_id, user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, 'k', 'a')`,
    [other.orgId, other.userId, `https://push.example.test/${RUN_ID}/other`])
  await pool.query(
    `INSERT INTO ochr_notification_prefs (user_id, notification_type, enabled)
     VALUES ($1, 'c3-pref', false)`,
    [staff.userId])
  await pool.query(
    `INSERT INTO ochr_notification_prefs (user_id, notification_type, enabled)
     VALUES ($1, 'c3-pref', true)`,
    [admin.userId])
  await pool.query(
    `INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
    [staff.userId, crypto.randomBytes(16).toString('hex')])
  await pool.query(
    `INSERT INTO ochr_feedback_ledger
       (organization_id, user_id, user_email, user_role, category, message, route)
     VALUES ($1, $2, $3, 'staff', 'suggestion', 'Kept parish note', '/preferences')`,
    [admin.orgId, staff.userId, staff.email])
  await pool.query(
    `INSERT INTO ochr_scheduled_notifications
       (organization_id, user_id, recipient_email, notification_type, send_at, status)
     VALUES ($1, $2, $3, 'reminder', NOW() + INTERVAL '1 day', 'pending')`,
    [admin.orgId, staff.userId, staff.email])
  await pool.query(
    `INSERT INTO ochr_native_ai_consents (organization_id, user_id, disclosure_version)
     VALUES ($1, $2, 'c3-test')`,
    [admin.orgId, staff.userId])
  await pool.query(
    `INSERT INTO ochr_support_tickets (organization_id, user_id, description)
     VALUES ($1, $2, 'Kept ticket text')`,
    [admin.orgId, staff.userId])
}, 60_000)

afterAll(async () => {
  for (const id of orgs) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('C3 self-serve login deletion', () => {
  it('confirm deletes personal login data and replaces audit actors with one tombstone UUID', async () => {
    const opened = await request(server).post('/api/auth/deletion-request').set(auth(staff.token))
    expect(opened.status).toBe(201)
    expect(opened.body.personal_login_deleted).toBe(false)
    expect(opened.body.sacramental_registers_retained).toBe(true)
    expect(opened.body.financial_ledger_retained).toBe(true)
    expect(opened.body.financial_retention_years).toBe(7)
    expect(opened.body.exception_contact).toBe('support@openscaffoldlabs.com')
    expect(opened.body.purge_performed).toBe(false)

    const wrong = await request(server).post('/api/auth/deletion-request/confirm').set(auth(staff.token))
      .send({ password: 'wrong-pw-000' })
    expect(wrong.status).toBe(403)
    expect((await one('SELECT email FROM ochr_users WHERE id = $1', [staff.userId])).email).toBe(staff.email)

    const ok = await request(server).post('/api/auth/deletion-request/confirm').set(auth(staff.token))
      .send({ password: PW })
    expect(ok.status).toBe(200)
    expect(ok.body.personal_login_deleted).toBe(true)
    expect(ok.body.data_deleted).toBe(true)
    expect(ok.body.purge_performed).toBe(false)
    expect(ok.body.fulfilment_implemented).toBe(true)
    expect(ok.body.disposition_policy).toBe('c3_self_serve_login_deletion')
    expect(ok.body.sacramental_registers_retained).toBe(true)
    expect(ok.body.financial_ledger_retained).toBe(true)
    expect(ok.body.financial_retention_years).toBe(7)
    expect(ok.body.exception_contact).toBe('support@openscaffoldlabs.com')
    expect(ok.body.request).toMatchObject({ status: 'confirmed', fulfilment_status: 'completed' })

    const after = await one(
      'SELECT id, email, name, avatar, closed_at, password_hash FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [staff.userId, admin.orgId])
    expect(after.id).toBe(staff.userId)
    expect(after.email).toBe(tombstoneEmail(staff.userId))
    expect(after.name).toBe('')
    expect(after.avatar).toBeNull()
    expect(after.closed_at).toBeTruthy()
    expect(await bcrypt.compare(PW, after.password_hash)).toBe(false)

    expect((await request(server).get('/api/auth/me').set(auth(staff.token))).status).toBe(401)
    const relogin = await request(server).post('/api/auth/login').set('X-Forwarded-For', '10.95.1.21')
      .send({ email: staff.email, password: PW })
    expect(relogin.status).toBe(401)

    expect(await one(
      'SELECT COUNT(*)::int AS n FROM ochr_push_subscriptions WHERE organization_id = $1 AND user_id = $2',
      [admin.orgId, staff.userId])).toEqual({ n: 0 })
    expect(await one(
      'SELECT COUNT(*)::int AS n FROM ochr_push_subscriptions WHERE organization_id = $1 AND user_id = $2',
      [other.orgId, other.userId])).toEqual({ n: 1 })
    expect(await one(
      'SELECT COUNT(*)::int AS n FROM ochr_notification_prefs WHERE user_id = $1',
      [staff.userId])).toEqual({ n: 0 })
    expect(await one(
      'SELECT enabled FROM ochr_notification_prefs WHERE user_id = $1',
      [admin.userId])).toEqual({ enabled: true })
    expect(await one(
      'SELECT COUNT(*)::int AS n FROM ochr_password_reset_tokens WHERE user_id = $1',
      [staff.userId])).toEqual({ n: 0 })
    expect(await one(
      'SELECT COUNT(*)::int AS n FROM ochr_native_ai_consents WHERE organization_id = $1 AND user_id = $2',
      [admin.orgId, staff.userId])).toEqual({ n: 0 })
    const queued = await one(
      `SELECT status FROM ochr_scheduled_notifications
        WHERE organization_id = $1 AND user_id = $2`,
      [admin.orgId, staff.userId])
    expect(queued.status).toBe('cancelled')

    const feedback = await one(
      'SELECT user_email, message FROM ochr_feedback_ledger WHERE organization_id = $1 AND user_id = $2',
      [admin.orgId, staff.userId])
    expect(feedback.user_email).toBeNull()
    expect(feedback.message).toBe('Kept parish note')

    const ticket = await one(
      'SELECT user_id, description FROM ochr_support_tickets WHERE organization_id = $1 AND user_id = $2',
      [admin.orgId, staff.userId])
    expect(ticket).toEqual({ user_id: staff.userId, description: 'Kept ticket text' })

    const audit = await one(
      `SELECT user_id, user_email, user_name, actor_tombstone_id, summary, ip_address, metadata
         FROM ochr_audit_log WHERE id = $1 AND organization_id = $2`,
      [auditId, admin.orgId])
    expect(audit.user_id).toBeNull()
    expect(audit.user_email).toBeNull()
    expect(audit.user_name).toBeNull()
    expect(audit.actor_tombstone_id).toMatch(UUID)
    expect(audit.summary).toBe(`Kept summary for ${staff.name}`)
    expect(audit.ip_address).toBe('203.0.113.10')
    // CAROLINA-423 H2: a row this person only WROTE keeps its metadata.
    // Only the actor columns are replaced with the tombstone.
    expect(audit.metadata).toEqual({ name: staff.name, email: staff.email, note: 'kept' })

    const ai = await one(
      `SELECT actor_id, actor_tombstone_id FROM ochr_ai_audit
        WHERE organization_id = $1 AND request_id = $2`,
      [admin.orgId, `c3-${RUN_ID}`])
    expect(ai.actor_id).toBeNull()
    expect(ai.actor_tombstone_id).toBe(audit.actor_tombstone_id)

    const usage = await one(
      `SELECT user_id, actor_tombstone_id FROM ochr_ai_usage
        WHERE organization_id = $1 AND user_id IS NULL AND actor_tombstone_id = $2`,
      [admin.orgId, audit.actor_tombstone_id])
    expect(usage.user_id).toBeNull()
    expect(usage.actor_tombstone_id).toBe(audit.actor_tombstone_id)

    const adminAudit = await one(
      'SELECT user_id, actor_tombstone_id, summary FROM ochr_audit_log WHERE id = $1',
      [adminAuditId])
    expect(adminAudit.user_id).toBe(admin.userId)
    expect(adminAudit.actor_tombstone_id).toBeNull()
    expect(adminAudit.summary).toBe('Admin summary stays')

    const otherAudit = await one(
      'SELECT user_id, user_email, actor_tombstone_id, summary FROM ochr_audit_log WHERE id = $1',
      [otherAuditId])
    expect(otherAudit).toEqual({
      user_id: other.userId,
      user_email: other.email,
      actor_tombstone_id: null,
      summary: 'Other parish stays',
    })

    const again = await confirmDeletionRequest({
      organizationId: admin.orgId, userId: staff.userId, password: 'wrong-after',
    })
    expect(again.status).toBe(200)
    expect(again.body.already).toBe(true)
    expect(again.body.personal_login_deleted).toBe(true)
    const tombstone = await one(
      'SELECT tombstone_id FROM ochr_login_deletion_tombstones WHERE organization_id = $1 AND user_id = $2',
      [admin.orgId, staff.userId])
    expect(tombstone.tombstone_id).toBe(audit.actor_tombstone_id)
    const audits = await one(
      `SELECT COUNT(*)::int AS n FROM ochr_audit_log
        WHERE organization_id = $1 AND actor_tombstone_id = $2`,
      [admin.orgId, audit.actor_tombstone_id])
    // The seeded actor row plus the deletion's own row (CAROLINA-423 M3).
    // The second confirm above added nothing.
    expect(audits.n).toBe(2)
  })

  it('retains the sacramental register and the financial ledger byte for byte', async () => {
    // Retention is only meaningful once the login deletion has happened.
    // A green result while the login is still intact does not prove the
    // register was spared. This test performs the deletion itself when a
    // previous test has not.
    let deleted = await one(
      'SELECT email, closed_at FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [staff.userId, admin.orgId])
    if (!deleted.closed_at) {
      await request(server).post('/api/auth/deletion-request').set(auth(staff.token))
      const ok = await request(server).post('/api/auth/deletion-request/confirm').set(auth(staff.token))
        .send({ password: PW })
      expect(ok.status).toBe(200)
      expect(ok.body.personal_login_deleted).toBe(true)
      deleted = await one(
        'SELECT email, closed_at FROM ochr_users WHERE id = $1 AND organization_id = $2',
        [staff.userId, admin.orgId])
    }
    expect(deleted.email).toBe(tombstoneEmail(staff.userId))
    expect(deleted.closed_at).toBeTruthy()

    const register = canon(await one('SELECT * FROM ochr_sacramental_records WHERE id = $1', [registerBefore.id]))
    const amendment = canon(await one('SELECT * FROM ochr_sacrament_amendments WHERE id = $1', [amendmentBefore.id]))
    const gift = canon(await one('SELECT * FROM ochr_donations WHERE id = $1', [giftId]))
    const ledger = canon(await one('SELECT * FROM ochr_ledger_entries WHERE id = $1', [ledgerBefore.id]))
    const refunds = await one(
      'SELECT COUNT(*)::int AS n FROM ochr_donation_refunds WHERE organization_id = $1 AND donation_id = $2',
      [admin.orgId, giftId])

    expect(register).toEqual(registerBefore)
    expect(amendment).toEqual(amendmentBefore)
    expect(amendment.amended_by).toBe(staff.userId)
    expect(amendment.kind).toBe('correction')
    expect(gift).toEqual(giftBefore)
    expect(gift.payment_status).toBeNull()
    expect(gift.amount).toBe(giftBefore.amount)
    expect(ledger).toEqual(ledgerBefore)
    expect(Number(ledger.created_by)).toBe(staff.userId)
    expect(refunds.n).toBe(0)
  })

  it('refuses the only active admin and changes nothing', async () => {
    const before = await one(
      'SELECT email, name, closed_at FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [other.userId, other.orgId])
    const { rows: [reg] } = await pool.query(
      `INSERT INTO ochr_sacramental_records (organization_id, type, date, notes)
       VALUES ($1, 'baptism', '2020-01-01', 'Other parish register') RETURNING id`,
      [other.orgId])
    const opened = await request(server).post('/api/auth/deletion-request').set(auth(other.token))
    expect(opened.status).toBe(201)
    expect(opened.body.last_active_admin).toBe(true)
    const refused = await request(server).post('/api/auth/deletion-request/confirm').set(auth(other.token))
      .send({ password: PW })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/Transfer administration first/)
    expect(refused.body.personal_login_deleted).toBe(false)
    expect(refused.body.data_deleted).toBe(false)
    const after = await one(
      'SELECT email, name, closed_at FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [other.userId, other.orgId])
    expect(after).toEqual(before)
    expect((await request(server).get('/api/auth/me').set(auth(other.token))).status).toBe(200)
    const still = await one('SELECT notes FROM ochr_sacramental_records WHERE id = $1', [reg.id])
    expect(still.notes).toBe('Other parish register')
  })

  it('does not delete a login when the organization id is another parish', async () => {
    const stranger = await addStaff(admin, 'stranger')
    const before = await one('SELECT email, closed_at FROM ochr_users WHERE id = $1', [stranger.userId])
    await request(server).post('/api/auth/deletion-request').set(auth(stranger.token))
    const crossed = await confirmDeletionRequest({
      organizationId: other.orgId, userId: stranger.userId, password: PW,
    })
    expect(crossed.status).toBe(404)
    expect(crossed.body.personal_login_deleted).toBe(false)
    expect(await one('SELECT email, closed_at FROM ochr_users WHERE id = $1', [stranger.userId])).toEqual(before)
  })
})
