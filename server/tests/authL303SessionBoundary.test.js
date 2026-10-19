// OC-CYCLE-MAX-04 / AUTH-L3-03 — session and permission boundary audit.
//
// CLAIM: Existing custom-JWT auth handles missing / malformed / expired /
// revoked tokens; logout vs logout-all as currently claimed; password-reset
// failure and reuse; route/API agreement on 401 vs 403 vs 404; role checks on
// Mass Intention, member, register (sacraments), and export; error bodies do
// not leak tenant existence or secrets.
//
// WHAT WOULD MAKE THESE FAIL
//   - Missing / garbage / expired / wrong-secret / tv-mismatched JWT → not 401
//   - Parish A userId + parish B organizationId (valid signature, live tv) → not 401
//   - logout-all leaving sibling sessions live; plain logout bumping tv
//   - POST /logout 204 without a clearing ochr_session Set-Cookie
//   - Reset token replay / expired / garbage succeeding; reset not killing sessions
//   - Viewer writing intentions / members / register, including PATCH / DELETE / PUT
//   - Forged JWT role:admin for a live viewer (matching tv) passing a DB role check
//   - staff or viewer pulling export
//   - Cross-tenant resource probe answering 403 (existence leak) instead of 404
//   - Error JSON carrying password_hash, JWT secret material, or raw reset tokens
//
// Evidence: LOCAL POSTGRES RUNTIME VERIFIED on disposable openchurch_local.
// Synthetic accounts only. Tokens never printed. No auth architecture change.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const SECRET = process.env.JWT_SECRET || 'dev-only-change-me-please'
const MARKER = `AUTH_L303_${RUN_ID}`
const MASS_DATE = '2032-04-18'

let server
let orgId
let adminId
let adminToken
let staffToken
let viewerToken
let memberId
let intentionId
let sacramentId
let foreignMemberId
let foreignToken
let foreignOrgId
let adminEmail
let adminPassword

const auth = token => ({ Authorization: `Bearer ${token}` })

function sign(claims) {
  return jwt.sign(claims, SECRET, { expiresIn: '1h' })
}

function swappedParishToken() {
  const home = jwt.decode(viewerToken)
  return sign({
    userId: home.userId,
    organizationId: foreignOrgId,
    email: home.email,
    name: home.name,
    role: home.role,
    tv: home.tv ?? 1,
  })
}

function forgedViewerAdminToken() {
  const home = jwt.decode(viewerToken)
  return sign({
    userId: home.userId,
    organizationId: home.organizationId,
    email: home.email,
    name: home.name,
    role: 'admin',
    tv: home.tv ?? 1,
  })
}

function assertSessionCookieCleared(res) {
  const raw = res.headers['set-cookie']
  const cookies = Array.isArray(raw) ? raw : (raw ? [String(raw)] : [])
  const session = cookies.find(c => /^ochr_session=/i.test(c))
  expect(session, 'logout must send a clearing ochr_session Set-Cookie').toBeTruthy()
  expect(session).toMatch(/^ochr_session=;/i)
  expect(session).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/)
  expect(session).toMatch(/HttpOnly/i)
  expect(session).not.toMatch(/eyJ/)
}

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function assertNoSecretLeak(res) {
  const text = typeof res.text === 'string' ? res.text : JSON.stringify(res.body ?? {})
  expect(text).not.toMatch(/password_hash/i)
  expect(text).not.toMatch(/JWT_SECRET/i)
  expect(text).not.toMatch(/dev-only-change-me-please/)
  expect(text).not.toMatch(/local-dev-jwt-secret/)
  expect(text).not.toMatch(/BEGIN (RSA |EC )?PRIVATE KEY/)
  // Raw reset tokens are base64url blobs; never echo the request token back.
  if (res.body && typeof res.body === 'object') {
    expect(res.body).not.toHaveProperty('token_hash')
    expect(res.body).not.toHaveProperty('password_hash')
  }
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  adminEmail = `auth_l303_admin_${RUN_ID}@example.com`
  adminPassword = 'auth-l303-admin-pw-1'

  const admin = await createOrg(server, {
    organizationName: `AUTH L303 Parish ${RUN_ID}`,
    name: 'Avery Admin',
    email: adminEmail,
    password: adminPassword,
  }, '10.253.3.1')
  expect(admin.status).toBe(201)
  adminToken = admin.body.token
  orgId = admin.body.user.organization.id
  adminId = admin.body.user.id

  const staff = await request(server).post('/api/users').set(auth(adminToken)).send({
    name: 'Sam Staff',
    email: `auth_l303_staff_${RUN_ID}@example.com`,
    password: 'auth-l303-staff-pw-1',
    role: 'staff',
  })
  expect(staff.status).toBe(201)
  const staffLogin = await request(server).post('/api/auth/login')
    .set('X-Forwarded-For', '10.253.3.2')
    .send({ email: `auth_l303_staff_${RUN_ID}@example.com`, password: 'auth-l303-staff-pw-1' })
  expect(staffLogin.status).toBe(200)
  staffToken = staffLogin.body.token

  const viewer = await request(server).post('/api/users').set(auth(adminToken)).send({
    name: 'Vera Viewer',
    email: `auth_l303_viewer_${RUN_ID}@example.com`,
    password: 'auth-l303-viewer-pw-1',
    role: 'viewer',
  })
  expect(viewer.status).toBe(201)
  const viewerLogin = await request(server).post('/api/auth/login')
    .set('X-Forwarded-For', '10.253.3.3')
    .send({ email: `auth_l303_viewer_${RUN_ID}@example.com`, password: 'auth-l303-viewer-pw-1' })
  expect(viewerLogin.status).toBe(200)
  viewerToken = viewerLogin.body.token

  const member = await request(server).post('/api/clients').set(auth(adminToken)).send({
    name: `${MARKER} Member`,
    email: `auth_l303_member_${RUN_ID}@example.com`,
  })
  expect(member.status).toBe(201)
  memberId = member.body.id

  const intention = await request(server).post('/api/mass-intentions').set(auth(adminToken)).send({
    intention: `† ${MARKER} Intention`,
    requested_by_client_id: memberId,
    status: 'open',
    stipend: 10,
  })
  expect(intention.status).toBe(201)
  intentionId = intention.body.id

  const sacrament = await request(server).post('/api/sacraments').set(auth(adminToken)).send({
    client_id: memberId,
    type: 'baptism',
    date: '2010-04-11',
    minister: `${MARKER} Minister`,
    place: `${MARKER} Font`,
    certificate_no: `CERT-${RUN_ID}`,
  })
  expect(sacrament.status).toBe(201)
  sacramentId = sacrament.body.id

  const foreign = await createOrg(server, {
    organizationName: `AUTH L303 Foreign ${RUN_ID}`,
    name: 'Fran Foreign',
    email: `auth_l303_foreign_${RUN_ID}@example.com`,
    password: 'auth-l303-foreign-pw-1',
  }, '10.253.3.4')
  expect(foreign.status).toBe(201)
  foreignToken = foreign.body.token
  foreignOrgId = foreign.body.user.organization.id
  const foreignMember = await request(server).post('/api/clients').set(auth(foreignToken)).send({
    name: `${MARKER} Foreign Member`,
    email: `auth_l303_foreign_m_${RUN_ID}@example.com`,
  })
  expect(foreignMember.status).toBe(201)
  foreignMemberId = foreignMember.body.id
}, 90_000)

afterAll(async () => {
  if (orgId) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [orgId]).catch(() => {})
  if (foreignOrgId) {
    await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [foreignOrgId]).catch(() => {})
  }
  await closeServer(server)
})

describe('attack class: missing / malformed / expired / revoked tokens', () => {
  it('missing Authorization is 401 on /me and protected parish mounts', async () => {
    for (const path of [
      '/api/auth/me',
      '/api/clients',
      '/api/mass-intentions',
      '/api/sacraments',
      '/api/organization/export',
    ]) {
      const res = await request(server).get(path)
      expect(res.status).toBe(401)
      assertNoSecretLeak(res)
    }
  })

  it('garbage Bearer is 401', async () => {
    const res = await request(server).get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.jwt')
    expect(res.status).toBe(401)
    assertNoSecretLeak(res)
  })

  it('expired JWT is 401', async () => {
    const expired = jwt.sign(
      { userId: adminId, organizationId: orgId, role: 'admin', tv: 1 },
      SECRET,
      { expiresIn: '-30s' },
    )
    const res = await request(server).get('/api/auth/me').set(auth(expired))
    expect(res.status).toBe(401)
    assertNoSecretLeak(res)
  })

  it('JWT signed with a foreign secret is 401', async () => {
    const forged = jwt.sign(
      { userId: adminId, organizationId: orgId, role: 'admin', tv: 1 },
      'attacker-supplied-secret',
      { expiresIn: '1h' },
    )
    const res = await request(server).get('/api/auth/me').set(auth(forged))
    expect(res.status).toBe(401)
  })

  it('token missing userId / organizationId claims is 401', async () => {
    const bare = jwt.sign({ role: 'admin', tv: 1 }, SECRET, { expiresIn: '1h' })
    const res = await request(server).get('/api/auth/me').set(auth(bare))
    expect(res.status).toBe(401)
  })

  it('token_version mismatch (revoked) is 401', async () => {
    const claims = jwt.decode(adminToken)
    const stale = jwt.sign(
      {
        userId: claims.userId,
        organizationId: claims.organizationId,
        email: claims.email,
        name: claims.name,
        role: claims.role,
        tv: (claims.tv ?? 1) - 1,
      },
      SECRET,
      { expiresIn: '1h' },
    )
    const res = await request(server).get('/api/auth/me').set(auth(stale))
    expect(res.status).toBe(401)
    expect(String(res.body?.error || '')).toMatch(/session expired|invalid|unauthorized/i)
  })
})

describe('attack class: logout / session invalidation', () => {
  it('plain logout clears cookie but does not bump token_version (sibling still live)', async () => {
    const login = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.253.3.11')
      .send({ email: adminEmail, password: adminPassword })
    expect(login.status).toBe(200)
    const live = login.body.token
    const claims = jwt.decode(live)
    const sibling = jwt.sign(
      {
        userId: claims.userId,
        organizationId: claims.organizationId,
        email: claims.email,
        name: claims.name,
        role: claims.role,
        tv: claims.tv,
      },
      SECRET,
      { expiresIn: '6d' },
    )

    const out = await request(server).post('/api/auth/logout').set(auth(live))
    expect(out.status).toBe(204)
    assertSessionCookieCleared(out)

    const siblingStill = await request(server).get('/api/auth/me').set(auth(sibling))
    expect(siblingStill.status).toBe(200)
  })

  it('logout Set-Cookie clears ochr_session even with no bearer', async () => {
    const out = await request(server).post('/api/auth/logout')
    expect(out.status).toBe(204)
    assertSessionCookieCleared(out)
  })

  it('logout-all bumps token_version and kills every outstanding sibling', async () => {
    const login = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.253.3.12')
      .send({ email: adminEmail, password: adminPassword })
    expect(login.status).toBe(200)
    const live = login.body.token
    const claims = jwt.decode(live)
    const sibling = jwt.sign(
      {
        userId: claims.userId,
        organizationId: claims.organizationId,
        email: claims.email,
        name: claims.name,
        role: claims.role,
        tv: claims.tv,
      },
      SECRET,
      { expiresIn: '6d' },
    )

    const revoke = await request(server).post('/api/auth/logout-all').set(auth(live))
    expect(revoke.status).toBe(204)

    expect((await request(server).get('/api/auth/me').set(auth(live))).status).toBe(401)
    expect((await request(server).get('/api/auth/me').set(auth(sibling))).status).toBe(401)

    // Refresh adminToken for later role probes (previous token may still be fine
    // if logout-all used a different login than the beforeAll signup token).
    const again = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.253.3.13')
      .send({ email: adminEmail, password: adminPassword })
    expect(again.status).toBe(200)
    adminToken = again.body.token
  })
})

describe('attack class: password-reset failure / reuse', () => {
  it('forgot-password returns identical 200 body for known and unknown emails', async () => {
    const real = await request(server).post('/api/auth/forgot-password')
      .set('X-Forwarded-For', '10.253.3.21')
      .send({ email: adminEmail })
    expect(real.status).toBe(200)
    assertNoSecretLeak(real)

    const ghost = await request(server).post('/api/auth/forgot-password')
      .set('X-Forwarded-For', '10.253.3.21')
      .send({ email: `nobody_${RUN_ID}@example.com` })
    expect(ghost.status).toBe(200)
    expect(ghost.body).toEqual(real.body)
    assertNoSecretLeak(ghost)
  })

  it('garbage / expired reset tokens fail closed; spent token cannot be replayed', async () => {
    const garbage = await request(server).post('/api/auth/reset-password')
      .send({ token: 'not-a-real-reset-token', password: 'brand-new-password-99' })
    expect(garbage.status).toBe(400)
    assertNoSecretLeak(garbage)

    const rawExpired = crypto.randomBytes(32).toString('base64url')
    await pool.query(
      `INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [adminId, sha(rawExpired), new Date(Date.now() - 5 * 60 * 1000)],
    )
    const expired = await request(server).post('/api/auth/reset-password')
      .send({ token: rawExpired, password: 'brand-new-password-99' })
    expect(expired.status).toBe(400)

    const raw = crypto.randomBytes(32).toString('base64url')
    await pool.query(
      `INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [adminId, sha(raw), new Date(Date.now() + 60 * 60 * 1000)],
    )
    const first = await request(server).post('/api/auth/reset-password')
      .send({ token: raw, password: 'auth-l303-admin-pw-2' })
    expect(first.status).toBe(200)

    const replay = await request(server).post('/api/auth/reset-password')
      .send({ token: raw, password: 'auth-l303-admin-pw-3' })
    expect(replay.status).toBe(400)

    // Sessions minted before the reset must die.
    expect((await request(server).get('/api/auth/me').set(auth(adminToken))).status).toBe(401)

    adminPassword = 'auth-l303-admin-pw-2'
    const login = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.253.3.22')
      .send({ email: adminEmail, password: adminPassword })
    expect(login.status).toBe(200)
    adminToken = login.body.token
  })
})

describe('attack class: 401 vs 403 vs 404 agreement', () => {
  it('unauthenticated writes are 401 (auth before role)', async () => {
    for (const [method, path, body] of [
      ['post', '/api/clients', { name: 'Nope' }],
      ['post', '/api/mass-intentions', { intention: 'Nope', status: 'open' }],
      ['post', '/api/sacraments', { client_id: memberId, type: 'baptism', date: '2010-04-11' }],
      ['get', '/api/organization/export', null],
    ]) {
      const req = request(server)[method](path)
      const res = body ? await req.send(body) : await req
      expect(res.status).toBe(401)
      assertNoSecretLeak(res)
    }
  })

  it('wrong current password on PATCH /password is 403 not 401', async () => {
    const res = await request(server).patch('/api/auth/password')
      .set(auth(adminToken))
      .send({ currentPassword: 'not-the-password', password: 'something-else-long' })
    expect(res.status).toBe(403)
    assertNoSecretLeak(res)
  })

  it('parish admin probing vendor maintenance is 404 not 403', async () => {
    const res = await request(server).post('/api/admin/maintenance/retention-prune')
      .set(auth(adminToken))
    expect(res.status).toBe(404)
    assertNoSecretLeak(res)
  })

  it('cross-tenant resource ids answer 404 (no existence leak via 403)', async () => {
    for (const path of [
      `/api/clients/${memberId}`,
      `/api/mass-intentions/${intentionId}`,
      `/api/sacraments/${sacramentId}`,
    ]) {
      const res = await request(server).get(path).set(auth(foreignToken))
      expect(res.status).toBe(404)
      assertNoSecretLeak(res)
    }
  })
})

describe('attack class: role checks on Mass Intention / member / register / export', () => {
  // SP-014..022: Viewers read Members only of these three (Help role table).
  it('viewer may read members, not intentions or register, and writes none of them', async () => {
    expect((await request(server).get('/api/mass-intentions').set(auth(viewerToken))).status).toBe(403)
    expect((await request(server).get('/api/clients').set(auth(viewerToken))).status).toBe(200)
    expect((await request(server).get('/api/sacraments').set(auth(viewerToken))).status).toBe(403)

    expect((await request(server).post('/api/mass-intentions').set(auth(viewerToken))
      .send({ intention: 'Viewer Blocked', status: 'open' })).status).toBe(403)
    expect((await request(server).post('/api/clients').set(auth(viewerToken))
      .send({ name: 'Viewer Blocked' })).status).toBe(403)
    expect((await request(server).post('/api/sacraments').set(auth(viewerToken))
      .send({ client_id: memberId, type: 'baptism', date: '2010-04-11' })).status).toBe(403)
  })

  it('viewer and staff cannot pull organization export (admin-only)', async () => {
    expect((await request(server).get('/api/organization/export').set(auth(viewerToken))).status).toBe(403)
    expect((await request(server).get('/api/organization/export').set(auth(staffToken))).status).toBe(403)
    const adminExport = await request(server).get('/api/organization/export').set(auth(adminToken))
    expect(adminExport.status).toBe(200)
    expect(adminExport.body?.organization?.id).toBe(orgId)
    // Export must not ship credential columns even to an admin.
    const dumped = JSON.stringify(adminExport.body)
    expect(dumped).not.toMatch(/password_hash/i)
    expect(dumped).not.toMatch(/token_hash/i)
    assertNoSecretLeak(adminExport)
  })

  it('staff may write Mass Intention / member / register (writeGate admin+staff)', async () => {
    const mi = await request(server).post('/api/mass-intentions').set(auth(staffToken)).send({
      intention: `${MARKER} Staff Intention`,
      status: 'open',
      stipend: 5,
    })
    expect(mi.status).toBe(201)

    const client = await request(server).post('/api/clients').set(auth(staffToken)).send({
      name: `${MARKER} Staff Member`,
      email: `auth_l303_staff_m_${RUN_ID}@example.com`,
    })
    expect(client.status).toBe(201)

    const sac = await request(server).post('/api/sacraments').set(auth(staffToken)).send({
      client_id: client.body.id,
      type: 'baptism',
      date: '2011-05-12',
      minister: `${MARKER} Staff Minister`,
      place: `${MARKER} Staff Font`,
    })
    expect(sac.status).toBe(201)
  })

  it('register void remains admin-only (staff 403)', async () => {
    const res = await request(server).post(`/api/sacraments/${sacramentId}/void`)
      .set(auth(staffToken))
      .send({ reason: 'should not void' })
    expect(res.status).toBe(403)
  })
})

describe('attack class: error bodies avoid tenant / secret leaks', () => {
  it('failed login does not disclose whether the email exists via distinct status', async () => {
    const badPw = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.253.3.31')
      .send({ email: adminEmail, password: 'wrong-password-here' })
    const unknown = await request(server).post('/api/auth/login')
      .set('X-Forwarded-For', '10.253.3.31')
      .send({ email: `unknown_${RUN_ID}@example.com`, password: 'wrong-password-here' })
    // Both must be auth failures; shapes must not advertise existence.
    expect(badPw.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(badPw.body).toEqual(unknown.body)
    assertNoSecretLeak(badPw)
    assertNoSecretLeak(unknown)
  })

  it('foreign member id on same-tenant create refuses without echoing foreign PII', async () => {
    const res = await request(server).post('/api/sacraments').set(auth(adminToken)).send({
      client_id: foreignMemberId,
      type: 'baptism',
      date: MASS_DATE,
      place: 'Should Fail',
    })
    expect([400, 404]).toContain(res.status)
    assertNoSecretLeak(res)
    const text = JSON.stringify(res.body ?? {})
    expect(text).not.toContain(MARKER)
    expect(text).not.toContain(`auth_l303_foreign_m_${RUN_ID}@example.com`)
  })
})

describe('attack class: cross-parish JWT claim swap', () => {
  it('parish A userId + parish B organizationId is 401 on GET /api/auth/me', async () => {
    const res = await request(server).get('/api/auth/me').set(auth(swappedParishToken()))
    expect(res.status).toBe(401)
    assertNoSecretLeak(res)
    expect(JSON.stringify(res.body ?? {})).not.toContain(`auth_l303_foreign`)
  })

  it('claim swap is 401 on an identity read that does not repeat the org predicate', async () => {
    const res = await request(server).get('/api/notification-prefs').set(auth(swappedParishToken()))
    expect(res.status).toBe(401)
    assertNoSecretLeak(res)
    expect(res.body).not.toHaveProperty('prefs')
  })

  it('claim swap is 401 on parish member data and does not return the other parish', async () => {
    const res = await request(server).get('/api/clients').set(auth(swappedParishToken()))
    expect(res.status).toBe(401)
    assertNoSecretLeak(res)
    const text = JSON.stringify(res.body ?? {})
    expect(text).not.toContain(`${MARKER} Foreign Member`)
    expect(text).not.toContain(`auth_l303_foreign_m_${RUN_ID}@example.com`)
  })

  it('claim swap is 401 on a requireAuth write and inserts nothing', async () => {
    const userId = jwt.decode(viewerToken).userId
    const notificationType = 'task_due_reminder'
    try {
      const res = await request(server).patch('/api/notification-prefs')
        .set(auth(swappedParishToken()))
        .send({ notification_type: notificationType, enabled: false })
      expect(res.status).toBe(401)
      assertNoSecretLeak(res)
      const { rowCount } = await pool.query(
        'SELECT 1 FROM ochr_notification_prefs WHERE user_id = $1 AND notification_type = $2',
        [userId, notificationType],
      )
      expect(rowCount).toBe(0)
    } finally {
      await pool.query(
        'DELETE FROM ochr_notification_prefs WHERE user_id = $1 AND notification_type = $2',
        [userId, notificationType],
      ).catch(() => {})
    }
  })
})

describe('attack class: viewer non-POST writes', () => {
  it('viewer PATCH of an in-tenant member is 403 and leaves notes unchanged', async () => {
    const before = await request(server).get(`/api/clients/${memberId}`).set(auth(adminToken))
    expect(before.status).toBe(200)
    const notesBefore = before.body.notes ?? null
    const poisoned = `VIEWER_PATCH_${RUN_ID}`
    try {
      const patch = await request(server).patch(`/api/clients/${memberId}`)
        .set(auth(viewerToken))
        .send({ notes: poisoned })
      expect(patch.status).toBe(403)
      assertNoSecretLeak(patch)
      const after = await request(server).get(`/api/clients/${memberId}`).set(auth(adminToken))
      expect(after.status).toBe(200)
      expect(after.body.notes ?? null).toBe(notesBefore)
    } finally {
      await pool.query(
        'UPDATE ochr_clients SET notes = $1 WHERE id = $2 AND organization_id = $3',
        [notesBefore, memberId, orgId],
      ).catch(() => {})
    }
  })

  it('viewer DELETE of an in-tenant Mass intention is 403 and the row remains', async () => {
    const planted = await request(server).post('/api/mass-intentions').set(auth(adminToken)).send({
      intention: `${MARKER} Delete Probe`,
      status: 'open',
    })
    expect(planted.status).toBe(201)
    const id = planted.body.id
    const del = await request(server).delete(`/api/mass-intentions/${id}`).set(auth(viewerToken))
    expect(del.status).toBe(403)
    assertNoSecretLeak(del)
    const still = await request(server).get(`/api/mass-intentions/${id}`).set(auth(adminToken))
    expect(still.status).toBe(200)
    expect(still.body?.id).toBe(id)
  })

  it('viewer PUT of finance mappings is 403 and writes no mapping row', async () => {
    const sourceKey = `l303-put-${RUN_ID}`
    try {
      const put = await request(server).put('/api/finance/mappings')
        .set(auth(viewerToken))
        .send({
          mappings: [{ source_type: 'donation_category', source_key: sourceKey, account_code: '' }],
        })
      expect(put.status).toBe(403)
      assertNoSecretLeak(put)
      const { rowCount } = await pool.query(
        `SELECT 1 FROM ochr_coa_mappings
          WHERE organization_id = $1 AND source_type = 'donation_category' AND source_key = $2`,
        [orgId, sourceKey],
      )
      expect(rowCount).toBe(0)
    } finally {
      await pool.query(
        `DELETE FROM ochr_coa_mappings
          WHERE organization_id = $1 AND source_type = 'donation_category' AND source_key = $2`,
        [orgId, sourceKey],
      ).catch(() => {})
    }
  })
})

describe('attack class: forged JWT role checked against the database', () => {
  it('forged role:admin on a live viewer cannot export', async () => {
    const res = await request(server).get('/api/organization/export').set(auth(forgedViewerAdminToken()))
    expect(res.status).toBe(403)
    assertNoSecretLeak(res)
    expect(res.body).not.toHaveProperty('organization')
  })

  it('forged role:admin on a live viewer cannot PATCH a member', async () => {
    const before = await request(server).get(`/api/clients/${memberId}`).set(auth(adminToken))
    expect(before.status).toBe(200)
    const notesBefore = before.body.notes ?? null
    const poisoned = `FORGED_ADMIN_${RUN_ID}`
    try {
      const patch = await request(server).patch(`/api/clients/${memberId}`)
        .set(auth(forgedViewerAdminToken()))
        .send({ notes: poisoned })
      expect(patch.status).toBe(403)
      assertNoSecretLeak(patch)
      const after = await request(server).get(`/api/clients/${memberId}`).set(auth(adminToken))
      expect(after.status).toBe(200)
      expect(after.body.notes ?? null).toBe(notesBefore)
    } finally {
      await pool.query(
        'UPDATE ochr_clients SET notes = $1 WHERE id = $2 AND organization_id = $3',
        [notesBefore, memberId, orgId],
      ).catch(() => {})
    }
  })
})

describe('MUTATION probes — auth gates remain in source', () => {
  it('requireAuth still compares payload.tv to live token_version', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/middleware/auth.js', import.meta.url)),
      'utf8',
    )
    // Active (uncommented) gate — a commented-out copy must not satisfy this.
    expect(src).toMatch(
      /^\s*if \(\(payload\.tv \?\? 1\) !== \(rows\[0\]\.token_version \?\? 1\)\) \{/m,
    )
    expect(src).toMatch(/return res\.status\(401\)\.json\(\{ error: 'Unauthorized' \}\)/)
  })

  it('logout-all still bumps token_version; plain logout does not', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/auth.js', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/router\.post\('\/logout'/)
    expect(src).toMatch(/router\.post\('\/logout-all'/)
    expect(src).toMatch(
      /UPDATE ochr_users SET token_version = token_version \+ 1 WHERE id = \$1 AND organization_id = \$2/,
    )
    // Plain logout must only clear the cookie — no token_version UPDATE in its handler.
    const logoutStart = src.indexOf("router.post('/logout'")
    const logoutEnd = src.indexOf('})', logoutStart) + 2
    const logoutBlock = src.slice(logoutStart, logoutEnd)
    expect(logoutBlock).toMatch(/clearSessionCookie/)
    expect(logoutBlock).not.toMatch(/token_version/)
    expect(logoutBlock).not.toMatch(/UPDATE ochr_users/)
  })

  it('reset-password still single-uses tokens and bumps token_version', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/auth.js', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/if \(!tok \|\| tok\.used_at \|\| new Date\(tok\.expires_at\) < new Date\(\)\)/)
    expect(src).toMatch(/token_version = token_version \+ 1 WHERE id = \$2/)
  })

  it('export mount stays requireRole(admin); writeGate stays admin+staff', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/app.js', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/const writeGate = gateMutations\('admin', 'staff'\)/)
    expect(src).toMatch(
      /app\.use\('\/api\/organization',\s*requireAuth,\s*requireRole\('admin'\)/,
    )
    expect(src).toMatch(
      /app\.use\('\/api\/mass-intentions',\s*requireAuth,\s*writeGate/,
    )
    expect(src).toMatch(
      /app\.use\('\/api\/clients',\s*requireAuth,\s*writeGate/,
    )
    expect(src).toMatch(
      /app\.use\('\/api\/sacraments',\s*requireAuth,\s*writeGate/,
    )
  })
})
