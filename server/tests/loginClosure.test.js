// Level B — permanent staff/login closure.
//
// Synthetic fixtures on the local database only. The login row stays.
// The personal name, email, avatar, and usable password do not. A later
// signup with the released email is a new person. Register, giving,
// member, and payroll rows are not rewritten. A closed login cannot be
// turned back on, and a late audit write cannot put the name or email back.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import pg from 'pg'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { tombstoneEmail, FORMER_OPERATOR_LABEL } from '../src/auth/loginClosure.js'

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

async function signup(tag) {
  const email = `close_${tag}_${RUN_ID}@example.com`
  const password = 'close-test-pw'
  const res = await createOrg(server, {
    organizationName: `Close ${tag} ${RUN_ID}`,
    name: 'Parish Admin',
    email,
    password,
  }, `10.89.${ip++}.1`)
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return {
    token: res.body.token,
    orgId: res.body.user.organization.id,
    userId: res.body.user.id,
    email,
    password,
    orgName: `Close ${tag} ${RUN_ID}`,
  }
}

async function addUser(adminToken, { name, email, password, role }) {
  const res = await request(server).post('/api/users').set(auth(adminToken)).send({
    name, email, password, role,
  })
  expect(res.status).toBe(201)
  const login = await request(server).post('/api/auth/login').send({ email, password })
  expect(login.status).toBe(200)
  return { id: res.body.id, token: login.body.token, email, password, name, role }
}

async function rowOf(userId) {
  const { rows } = await pool.query(
    `SELECT id, email, name, avatar, password_hash, token_version, role,
            deactivated_at, closed_at, closed_by, pastoral_lead, organization_id
       FROM ochr_users WHERE id = $1`,
    [userId]
  )
  return rows[0]
}

describe('permanent login closure', () => {
  it('closes the login, releases the email, and keeps the actor id', async () => {
    const admin = await signup('identity')
    const staff = await addUser(admin.token, {
      name: 'Ada Staff',
      email: `ada_close_${RUN_ID}@example.com`,
      password: 'close-test-pw',
      role: 'staff',
    })
    const before = await rowOf(staff.id)
    await pool.query(
      `UPDATE ochr_users SET avatar = 'data:image/png;base64,abc' WHERE id = $1`,
      [staff.id]
    )
    await pool.query(
      `INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [staff.id, crypto.randomBytes(16).toString('hex')]
    )
    await pool.query(
      `INSERT INTO ochr_push_subscriptions
         (organization_id, user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, 'k', 'a')`,
      [admin.orgId, staff.id, `https://push.example.test/${RUN_ID}/${staff.id}`]
    )
    await pool.query(
      `INSERT INTO ochr_audit_log
         (organization_id, user_id, user_email, user_name, action, entity_type, summary, ip_address)
       VALUES ($1, $2, $3, $4, 'update', 'client', $5, '203.0.113.10')`,
      [admin.orgId, staff.id, staff.email, staff.name, `Kept summary for ${staff.name}`]
    )

    const closed = await request(server).post(`/api/users/${staff.id}/close`).set(auth(admin.token))
    expect(closed.status).toBe(200)
    expect(closed.body.closed).toBe(true)
    expect(closed.body.already).toBe(false)
    expect(closed.body.access_revoked).toBe(true)
    expect(closed.body.live_profile_processed).toBe(true)
    expect(closed.body.all_copies_erased).toBe(false)
    expect(closed.body.provider_status).toBe('unavailable')
    expect(closed.body.backup_status).toBe('not_in_this_environment')
    expect(closed.body.review_remaining).toBe(true)
    expect(JSON.stringify(closed.body)).not.toMatch(/erased everything|all copies erased/i)

    const after = await rowOf(staff.id)
    expect(after.id).toBe(before.id)
    expect(after.email).toBe(tombstoneEmail(staff.id))
    expect(after.email).not.toBe(staff.email)
    expect(after.name).toBe('')
    expect(after.avatar).toBeNull()
    expect(after.closed_at).toBeTruthy()
    expect(after.deactivated_at).toBeTruthy()
    expect(after.token_version).toBe(before.token_version + 1)
    expect(after.password_hash).not.toBe(before.password_hash)
    expect(await bcrypt.compare(staff.password, after.password_hash)).toBe(false)
    expect(after.role).toBe('staff')

    const login = await request(server).post('/api/auth/login').send({
      email: staff.email, password: staff.password,
    })
    expect(login.status).toBe(401)
    expect(login.body.token).toBeUndefined()

    const me = await request(server).get('/api/auth/me').set(auth(staff.token))
    expect(me.status).toBe(401)

    const unused = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_password_reset_tokens
        WHERE user_id = $1 AND used_at IS NULL`,
      [staff.id]
    )
    expect(unused.rows[0].n).toBe(0)
    const push = await pool.query(
      `SELECT removed_at FROM ochr_push_subscriptions WHERE user_id = $1`,
      [staff.id]
    )
    expect(push.rows[0].removed_at).toBeTruthy()

    const audit = await pool.query(
      `SELECT user_email, user_name, summary, ip_address FROM ochr_audit_log
        WHERE organization_id = $1 AND user_id = $2`,
      [admin.orgId, staff.id]
    )
    expect(audit.rows[0].user_email).toBeNull()
    expect(audit.rows[0].user_name).toBeNull()
    expect(audit.rows[0].summary).toBe(`Kept summary for ${staff.name}`)
    expect(audit.rows[0].ip_address).toBe('203.0.113.10')

    const listed = await request(server)
      .get(`/api/audit-log?user_id=${staff.id}`)
      .set(auth(admin.token))
    expect(listed.status).toBe(200)
    expect(listed.body.rows.length).toBeGreaterThan(0)
    for (const row of listed.body.rows) {
      expect(row.user_id).toBe(staff.id)
      expect(row.actor_closed).toBe(true)
      expect(row.user_name).toBe(FORMER_OPERATOR_LABEL)
      expect(row.user_email).toBeNull()
    }

    const team = await request(server).get('/api/users').set(auth(admin.token))
    const shown = team.body.find(u => u.id === staff.id)
    expect(shown.closed).toBe(true)
    expect(shown.name).toBe(FORMER_OPERATOR_LABEL)
    expect(shown.email).toBeNull()
    expect(shown.id).toBe(staff.id)
  })

  it('a second close is the same receipt and does not mint another secret', async () => {
    const admin = await signup('again')
    const staff = await addUser(admin.token, {
      name: 'Bea Staff',
      email: `bea_close_${RUN_ID}@example.com`,
      password: 'close-test-pw',
      role: 'staff',
    })
    const first = await request(server).post(`/api/users/${staff.id}/close`).set(auth(admin.token))
    expect(first.status).toBe(200)
    const hash = (await rowOf(staff.id)).password_hash
    const second = await request(server).post(`/api/users/${staff.id}/close`).set(auth(admin.token))
    expect(second.status).toBe(200)
    expect(second.body.already).toBe(true)
    expect(second.body.all_copies_erased).toBe(false)
    expect((await rowOf(staff.id)).password_hash).toBe(hash)
    const receipts = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_login_closures
        WHERE organization_id = $1 AND user_id = $2`,
      [admin.orgId, staff.id]
    )
    expect(receipts.rows[0].n).toBe(1)
    const review = await request(server).get(`/api/users/${staff.id}/closure`).set(auth(admin.token))
    expect(review.status).toBe(200)
    expect(review.body.reviews.some(item => item.kind === 'unmapped_text' && item.disposition === 'not_measured' && item.row_count === null)).toBe(true)
    expect(review.body.reviews.some(item => item.kind === 'provider' && item.disposition === 'unavailable')).toBe(true)
    expect(JSON.stringify(review.body)).not.toContain(staff.email)
  })

  it('the released email opens a new login with no inherited access', async () => {
    const admin = await signup('reuse')
    const staff = await addUser(admin.token, {
      name: 'Cara Staff',
      email: `cara_close_${RUN_ID}@example.com`,
      password: 'close-test-pw',
      role: 'staff',
    })
    await request(server).patch(`/api/users/${staff.id}/pastoral-lead`).set(auth(admin.token)).send({ pastoral_lead: true })
    const closed = await request(server).post(`/api/users/${staff.id}/close`).set(auth(admin.token))
    expect(closed.status).toBe(200)

    const blocked = await request(server).post('/api/users').set(auth(admin.token)).send({
      name: 'Not A Person',
      email: tombstoneEmail(staff.id),
      password: 'close-test-pw',
      role: 'admin',
    })
    expect(blocked.status).toBe(400)

    const created = await request(server).post('/api/users').set(auth(admin.token)).send({
      name: 'New Person',
      email: staff.email,
      password: 'another-close-pw',
      role: 'viewer',
    })
    expect(created.status).toBe(201)
    expect(created.body.id).not.toBe(staff.id)
    expect(created.body.role).toBe('viewer')
    expect(created.body.pastoral_lead).toBe(false)
    expect(created.body.closed).toBe(false)
    const fresh = await rowOf(created.body.id)
    expect(fresh.organization_id).toBe(admin.orgId)
    expect(fresh.email).toBe(staff.email)
    expect(fresh.closed_at).toBeNull()
    const old = await rowOf(staff.id)
    expect(old.closed_at).toBeTruthy()
    expect(old.email).toBe(tombstoneEmail(staff.id))
    const login = await request(server).post('/api/auth/login').send({
      email: staff.email, password: 'another-close-pw',
    })
    expect(login.status).toBe(200)
    expect(login.body.user.id).toBe(created.body.id)
    expect(login.body.user.role).toBe('viewer')
  })

  it('refuses to turn a closed login back on, and a reset or invite does not reopen it', async () => {
    const admin = await signup('reopen')
    const staff = await addUser(admin.token, {
      name: 'Dee Staff',
      email: `dee_close_${RUN_ID}@example.com`,
      password: 'close-test-pw',
      role: 'staff',
    })
    const closed = await request(server).post(`/api/users/${staff.id}/close`).set(auth(admin.token))
    expect(closed.status).toBe(200)
    const snapshot = await rowOf(staff.id)

    const on = await request(server).post(`/api/users/${staff.id}/reactivate`).set(auth(admin.token))
    expect(on.status).toBe(409)
    expect(on.body.error).toMatch(/closed/i)
    expect(await rowOf(staff.id)).toMatchObject({
      email: snapshot.email,
      name: '',
      password_hash: snapshot.password_hash,
      token_version: snapshot.token_version,
    })

    const forgot = await request(server).post('/api/auth/forgot-password').send({ email: staff.email })
    expect(forgot.status).toBe(200)
    const unused = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_password_reset_tokens
        WHERE user_id = $1 AND used_at IS NULL`,
      [staff.id]
    )
    expect(unused.rows[0].n).toBe(0)

    const resend = await request(server).post(`/api/users/${staff.id}/invite/resend`).set(auth(admin.token))
    expect(resend.status).toBe(409)

    const password = await request(server).patch('/api/auth/password').set(auth(staff.token)).send({
      currentPassword: staff.password, password: 'a-new-close-pw',
    })
    expect(password.status).toBe(401)
  })

  it('the only active admin cannot be closed, and the row stays as it was', async () => {
    const admin = await signup('last')
    const before = await rowOf(admin.userId)
    const closed = await request(server).post('/api/auth/close').set(auth(admin.token))
    expect(closed.status).toBe(409)
    expect(closed.body.error).toMatch(/only active admin/i)
    const after = await rowOf(admin.userId)
    expect(after.email).toBe(before.email)
    expect(after.name).toBe(before.name)
    expect(after.password_hash).toBe(before.password_hash)
    expect(after.closed_at).toBeNull()
    expect(after.token_version).toBe(before.token_version)

    const removed = await request(server).delete(`/api/users/${admin.userId}`).set(auth(admin.token))
    expect(removed.status).toBe(400)
    expect(removed.body.error).toMatch(/only active admin/i)
    expect((await rowOf(admin.userId)).email).toBe(before.email)
  })

  it('an older delete call closes the login and does not drop the row', async () => {
    const admin = await signup('delete')
    const staff = await addUser(admin.token, {
      name: 'Eli Staff',
      email: `eli_close_${RUN_ID}@example.com`,
      password: 'close-test-pw',
      role: 'staff',
    })
    const removed = await request(server).delete(`/api/users/${staff.id}`).set(auth(admin.token))
    expect(removed.status).toBe(204)
    const after = await rowOf(staff.id)
    expect(after).toBeTruthy()
    expect(after.email).toBe(tombstoneEmail(staff.id))
    expect(after.closed_at).toBeTruthy()
  })

  it('another parish cannot close this login', async () => {
    const home = await signup('home')
    const away = await signup('away')
    const staff = await addUser(home.token, {
      name: 'Fay Staff',
      email: `fay_close_${RUN_ID}@example.com`,
      password: 'close-test-pw',
      role: 'staff',
    })
    const closed = await request(server).post(`/api/users/${staff.id}/close`).set(auth(away.token))
    expect(closed.status).toBe(404)
    expect((await rowOf(staff.id)).email).toBe(staff.email)
    expect((await rowOf(staff.id)).closed_at).toBeNull()
  })

  it('register, giving, member, and payroll facts stay, and a late write cannot restore the login', async () => {
    const admin = await signup('facts')
    const staff = await addUser(admin.token, {
      name: 'Gus Staff',
      email: `gus_close_${RUN_ID}@example.com`,
      password: 'close-test-pw',
      role: 'staff',
    })
    const member = await request(server).post('/api/clients').set(auth(admin.token)).send({
      name: `Synthetic Member ${RUN_ID}`,
      email: `synthetic_member_${RUN_ID}@example.com`,
    })
    expect(member.status).toBe(201)
    const record = await pool.query(
      `INSERT INTO ochr_sacramental_records
         (organization_id, client_id, type, date, minister, place, certificate_no, notes, member_name)
       VALUES ($1, $2, 'baptism', '2020-06-07', 'Synthetic Minister', 'Synthetic Chapel', $3, 'Synthetic register line', $4)
       RETURNING id`,
      [admin.orgId, member.body.id, `SYN-${RUN_ID}`, `Synthetic Member ${RUN_ID}`]
    )
    await pool.query(
      `INSERT INTO ochr_sacrament_amendments
         (organization_id, sacrament_id, kind, reason, before_json, after_json,
          amended_by, amended_by_name, amended_by_email)
       VALUES ($1, $2, 'correction', 'Synthetic correction', '{}'::jsonb, '{}'::jsonb, $3, $4, $5)`,
      [admin.orgId, record.rows[0].id, staff.id, staff.name, staff.email]
    )
    const gift = await request(server).post('/api/donations').set(auth(admin.token)).send({
      donor_name: `Synthetic Donor ${RUN_ID}`, amount: 40, category: 'tithe', method: 'cash',
    })
    expect(gift.status).toBe(201)
    await pool.query(
      `INSERT INTO ochr_giving_statements
         (organization_id, tax_year, donor_key, donor_key_kind, statement_no, issue_key,
          status, snapshot_version, snapshot_json, issued_by, issued_by_name)
       VALUES ($1, 2026, $2, 'email', $3, $4, 'issued', 1, $5::jsonb, $6, $7)`,
      [
        admin.orgId,
        `synthetic-donor-${RUN_ID}@example.com`,
        `GS-CLOSE-${RUN_ID}`,
        `issue-close-${RUN_ID}`,
        JSON.stringify({ donor: { name: `Synthetic Donor ${RUN_ID}` }, total: 40 }),
        staff.id,
        staff.name,
      ]
    )
    const sextonName = `Sextonclose${String(RUN_ID).replace(/[^a-z0-9]/gi, '')}`
    const payroll = await request(server).post('/api/payroll/staff').set(auth(admin.token)).send({
      name: sextonName, role: 'Sexton', pay_rate: 15, status: 'active',
    })
    expect(payroll.status).toBe(201)

    const beforeMember = await pool.query('SELECT name, email FROM ochr_clients WHERE id = $1', [member.body.id])
    const beforeAmend = await pool.query(
      'SELECT amended_by, amended_by_name, amended_by_email FROM ochr_sacrament_amendments WHERE sacrament_id = $1',
      [record.rows[0].id]
    )
    const beforeGift = await pool.query('SELECT donor_name, amount FROM ochr_donations WHERE id = $1', [gift.body.id])
    const beforeStatement = await pool.query(
      'SELECT issued_by, issued_by_name, snapshot_json FROM ochr_giving_statements WHERE statement_no = $1',
      [`GS-CLOSE-${RUN_ID}`]
    )
    const beforePay = await pool.query(
      'SELECT name, role, pay_rate FROM ochr_payroll_staff WHERE id = $1',
      [payroll.body.id]
    )
    const beforeOrg = await pool.query('SELECT name FROM ochr_organizations WHERE id = $1', [admin.orgId])

    const closed = await request(server).post(`/api/users/${staff.id}/close`).set(auth(admin.token))
    expect(closed.status).toBe(200)

    expect(await pool.query('SELECT name, email FROM ochr_clients WHERE id = $1', [member.body.id])).toEqual(beforeMember)
    expect(await pool.query(
      'SELECT amended_by, amended_by_name, amended_by_email FROM ochr_sacrament_amendments WHERE sacrament_id = $1',
      [record.rows[0].id]
    )).toEqual(beforeAmend)
    expect(await pool.query('SELECT donor_name, amount FROM ochr_donations WHERE id = $1', [gift.body.id])).toEqual(beforeGift)
    expect(await pool.query(
      'SELECT issued_by, issued_by_name, snapshot_json FROM ochr_giving_statements WHERE statement_no = $1',
      [`GS-CLOSE-${RUN_ID}`]
    )).toEqual(beforeStatement)
    expect(await pool.query(
      'SELECT name, role, pay_rate FROM ochr_payroll_staff WHERE id = $1',
      [payroll.body.id]
    )).toEqual(beforePay)
    expect(await pool.query('SELECT name FROM ochr_organizations WHERE id = $1', [admin.orgId])).toEqual(beforeOrg)

    const found = await request(server)
      .get(`/api/search?q=${encodeURIComponent(sextonName)}`)
      .set(auth(admin.token))
    expect(found.status).toBe(200)
    expect(found.body.some(row => row.type === 'staff' && row.name === sextonName)).toBe(true)

    const review = await pool.query(
      `SELECT kind, disposition FROM ochr_login_closure_reviews
        WHERE organization_id = $1 AND user_id = $2 AND kind = 'amendment_snapshot'`,
      [admin.orgId, staff.id]
    )
    expect(review.rows[0].disposition).toBe('retained_for_review')

    await pool.query(
      `INSERT INTO ochr_audit_log
         (organization_id, user_id, user_email, user_name, action, entity_type, summary)
       VALUES ($1, $2, 'late@example.com', 'Gus Staff', 'update', 'client', 'Late summary stays')`,
      [admin.orgId, staff.id]
    )
    const late = await pool.query(
      `SELECT user_email, user_name, summary FROM ochr_audit_log
        WHERE organization_id = $1 AND user_id = $2 AND summary = 'Late summary stays'`,
      [admin.orgId, staff.id]
    )
    expect(late.rows[0].user_email).toBeNull()
    expect(late.rows[0].user_name).toBeNull()
    expect(late.rows[0].summary).toBe('Late summary stays')

    await pool.query(
      `UPDATE ochr_audit_log SET user_email = 'back@example.com', user_name = 'Gus Staff'
        WHERE organization_id = $1 AND user_id = $2 AND summary = 'Late summary stays'`,
      [admin.orgId, staff.id]
    )
    const rewritten = await pool.query(
      `SELECT user_email, user_name FROM ochr_audit_log
        WHERE organization_id = $1 AND user_id = $2 AND summary = 'Late summary stays'`,
      [admin.orgId, staff.id]
    )
    expect(rewritten.rows[0].user_email).toBeNull()
    expect(rewritten.rows[0].user_name).toBeNull()

    await expect(pool.query(
      `UPDATE ochr_users SET email = $2, name = 'Gus Staff', closed_at = NULL, deactivated_at = NULL
        WHERE id = $1`,
      [staff.id, staff.email]
    )).rejects.toThrow(/closed login cannot be restored/)
    expect((await rowOf(staff.id)).email).toBe(tombstoneEmail(staff.id))
  })

  it('two closed logins stay distinguishable by actor id', async () => {
    const admin = await signup('pair')
    const left = await addUser(admin.token, {
      name: 'Left Staff', email: `left_close_${RUN_ID}@example.com`,
      password: 'close-test-pw', role: 'staff',
    })
    const right = await addUser(admin.token, {
      name: 'Right Staff', email: `right_close_${RUN_ID}@example.com`,
      password: 'close-test-pw', role: 'staff',
    })
    await pool.query(
      `INSERT INTO ochr_audit_log
         (organization_id, user_id, user_email, user_name, action, entity_type, summary)
       VALUES ($1, $2, $3, 'Left Staff', 'update', 'client', 'left-marker'),
              ($1, $4, $5, 'Right Staff', 'update', 'client', 'right-marker')`,
      [admin.orgId, left.id, left.email, right.id, right.email]
    )
    expect((await request(server).post(`/api/users/${left.id}/close`).set(auth(admin.token))).status).toBe(200)
    expect((await request(server).post(`/api/users/${right.id}/close`).set(auth(admin.token))).status).toBe(200)

    const leftRows = await request(server).get(`/api/audit-log?user_id=${left.id}`).set(auth(admin.token))
    const rightRows = await request(server).get(`/api/audit-log?user_id=${right.id}`).set(auth(admin.token))
    expect(leftRows.body.rows.every(row => row.user_id === left.id && row.actor_closed === true)).toBe(true)
    expect(rightRows.body.rows.every(row => row.user_id === right.id && row.actor_closed === true)).toBe(true)
    expect(leftRows.body.rows.some(row => row.summary === 'left-marker')).toBe(true)
    expect(leftRows.body.rows.some(row => row.summary === 'right-marker')).toBe(false)
    expect(left.id).not.toBe(right.id)
  })

  it('an audit insert that arrives while closure is still open does not keep the name or email', async () => {
    const admin = await signup('inflightwrite')
    const staff = await addUser(admin.token, {
      name: 'Race Staff',
      email: `race_write_${RUN_ID}@example.com`,
      password: 'close-test-pw',
      role: 'staff',
    })
    const holder = await pool.connect()
    const writer = await pool.connect()
    const feedbackWriter = await pool.connect()
    const marker = `inflight-write-${RUN_ID}`
    let auditLanded = false
    let feedbackLanded = false
    try {
      await holder.query('BEGIN')
      await holder.query(
        `SELECT id FROM ochr_users WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [staff.id, admin.orgId]
      )
      await holder.query(
        `UPDATE ochr_users
            SET closed_at = NOW(),
                deactivated_at = COALESCE(deactivated_at, NOW()),
                email = $3,
                name = '',
                avatar = NULL,
                token_version = COALESCE(token_version, 1) + 1
          WHERE id = $1 AND organization_id = $2`,
        [staff.id, admin.orgId, tombstoneEmail(staff.id)]
      )
      const auditInsert = writer.query(
        `INSERT INTO ochr_audit_log
           (organization_id, user_id, user_email, user_name, action, entity_type, summary)
         VALUES ($1, $2, 'inflight@example.com', 'Race Staff', 'update', 'client', $3)`,
        [admin.orgId, staff.id, marker]
      ).then((result) => {
        auditLanded = true
        return result
      })
      const feedbackInsert = feedbackWriter.query(
        `INSERT INTO ochr_feedback_ledger
           (organization_id, user_id, user_email, user_role, category, message)
         VALUES ($1, $2, 'inflight@example.com', 'staff', 'suggestion', $3)`,
        [admin.orgId, staff.id, marker]
      ).then((result) => {
        feedbackLanded = true
        return result
      })
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(auditLanded).toBe(false)
      expect(feedbackLanded).toBe(false)
      await holder.query('COMMIT')
      await auditInsert
      await feedbackInsert
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      writer.release()
      feedbackWriter.release()
    }

    const late = await pool.query(
      `SELECT user_email, user_name, summary FROM ochr_audit_log
        WHERE organization_id = $1 AND user_id = $2 AND summary = $3`,
      [admin.orgId, staff.id, marker]
    )
    expect(late.rows).toHaveLength(1)
    expect(late.rows[0].user_email).toBeNull()
    expect(late.rows[0].user_name).toBeNull()
    expect(late.rows[0].summary).toBe(marker)
    const note = await pool.query(
      `SELECT user_email, message FROM ochr_feedback_ledger
        WHERE organization_id = $1 AND user_id = $2 AND message = $3`,
      [admin.orgId, staff.id, marker]
    )
    expect(note.rows).toHaveLength(1)
    expect(note.rows[0].user_email).toBeNull()
    expect(note.rows[0].message).toBe(marker)
  })

  it('a push subscribe already in flight cannot restore a closed login', async () => {
    const admin = await signup('push')
    const staff = await addUser(admin.token, {
      name: 'Push Staff',
      email: `push_close_${RUN_ID}@example.com`,
      password: 'close-test-pw',
      role: 'staff',
    })
    const endpoint = `https://push.example.test/inflight/${RUN_ID}`
    const sub = { endpoint, keys: { p256dh: 'k', auth: 'a' } }
    const first = await request(server).post('/api/push/subscribe').set(auth(staff.token)).send(sub)
    expect(first.status).toBe(201)

    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let pending
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM ochr_users WHERE id = $1 FOR UPDATE', [staff.id])
      pending = request(server).post('/api/push/subscribe').set(auth(staff.token)).send(sub)
      const started = Promise.resolve(pending)
      await waitForBlockedUsersQueries(1)
      await holder.query(
        `UPDATE ochr_users
            SET closed_at = NOW(),
                deactivated_at = COALESCE(deactivated_at, NOW()),
                email = $2,
                name = '',
                avatar = NULL,
                password_hash = $3,
                token_version = COALESCE(token_version, 1) + 1
          WHERE id = $1`,
        [staff.id, tombstoneEmail(staff.id), 'discarded-secret']
      )
      await holder.query(
        `UPDATE ochr_push_subscriptions SET removed_at = NOW()
          WHERE user_id = $1 AND endpoint = $2`,
        [staff.id, endpoint]
      )
      await holder.query('COMMIT')
      const res = await started
      expect(res.status).toBe(403)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      await holder.end()
    }
    const push = await pool.query(
      `SELECT removed_at FROM ochr_push_subscriptions WHERE endpoint = $1`,
      [endpoint]
    )
    expect(push.rows[0].removed_at).toBeTruthy()
    expect((await rowOf(staff.id)).email).toBe(tombstoneEmail(staff.id))
  }, 20_000)

  it('two administrators cannot both close each other', async () => {
    const admin = await signup('race')
    const other = await addUser(admin.token, {
      name: 'Other Admin',
      email: `other_close_${RUN_ID}@example.com`,
      password: 'close-test-pw',
      role: 'admin',
    })
    const [a, b] = await releaseAfterBlocked(
      admin.orgId,
      [admin.userId, other.id],
      () => [
        request(server).post(`/api/users/${other.id}/close`).set(auth(admin.token)),
        request(server).post(`/api/users/${admin.userId}/close`).set(auth(other.token)),
      ],
      2,
    )
    const successes = [a, b].filter(res => res.status === 200)
    const refusals = [a, b].filter(res => res.status === 409)
    expect(successes).toHaveLength(1)
    expect(refusals).toHaveLength(1)
    expect(refusals[0].body.error).toMatch(/only active admin/i)
    const openAdmins = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_users
        WHERE organization_id = $1 AND role = 'admin' AND closed_at IS NULL AND deactivated_at IS NULL`,
      [admin.orgId]
    )
    expect(openAdmins.rows[0].n).toBe(1)
  }, 20_000)
})

async function releaseAfterBlocked(orgId, userIds, start, waiters) {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  const pending = []
  try {
    await holder.query('BEGIN')
    await holder.query(
      `SELECT id FROM ochr_users
        WHERE organization_id = $1 AND id = ANY($2::int[])
        ORDER BY id
        FOR UPDATE`,
      [orgId, userIds]
    )
    pending.push(...start().map(req => Promise.resolve(req)))
    await waitForBlockedUsersQueries(waiters)
    await holder.query('COMMIT')
  } catch (err) {
    await holder.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await holder.end()
    if (pending.length) await Promise.allSettled(pending)
  }
  return Promise.all(pending)
}

async function waitForBlockedUsersQueries(min) {
  const start = Date.now()
  let last = []
  while (Date.now() - start < 8000) {
    const { rows } = await pool.query(
      `SELECT pid, left(query, 160) AS query
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query ILIKE '%ochr_users%'`
    )
    last = rows
    if (rows.length >= min) return
    await new Promise(r => setTimeout(r, 40))
  }
  throw new Error(`timed out waiting for ${min} blocked ochr_users queries; blocked=${JSON.stringify(last)}`)
}
