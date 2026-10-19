// OC-STAGE7-001 — pickup code must not land in the persisted audit trail.
//
// Synthetic tenants only. The checkout route is the real one. The row is
// read back from ochr_audit_log. Included by server `npm test` (vitest's
// default test pattern). That command is the CI job "Server smoke tests
// (real Postgres)" in .github/workflows/ci.yml. It already has DATABASE_URL,
// JWT_SECRET, and CHECKIN_CODE_PEPPER. This file adds no secret.
//
// Two protections, proved here rather than by sanitizeBody alone:
//   - checkoutAuditMetadata returns {} (metadata-only, TARS 6206064745).
//     Check-in rows keep ids/kind only (CK-1); no names, no note.
//   - request_path is pathOnly(originalUrl). Storing originalUrl keeps
//     ?code= in the row.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { hashSecurityCode } from '../src/utils/pickupCode.js'
import { _setDispatchForTests } from '../src/monitoring/index.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { _auditInternalsForTests } from '../src/middleware/auditLog.js'

const PW = 'stage7-test-pw'
const HARMLESS = 'door'

let server
let orgA
let orgB
let staff
let viewer
let eventId
let ipSeq = 1

const auth = token => ({ Authorization: `Bearer ${token}` })
const nextIp = () => `10.77.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const a = await createOrg(server, {
    organizationName: `Stage7 Parish A ${RUN_ID}`,
    name: 'Synthetic Admin',
    email: `stage7_admin_${RUN_ID}@example.com`,
    password: PW,
  }, nextIp())
  expect(a.status).toBe(201)
  orgA = {
    id: a.body.user.organization.id,
    userId: a.body.user.id,
    token: a.body.token,
    email: `stage7_admin_${RUN_ID}@example.com`,
  }

  const b = await createOrg(server, {
    organizationName: `Stage7 Parish B ${RUN_ID}`,
    name: 'Synthetic Other Admin',
    email: `stage7_other_${RUN_ID}@example.com`,
    password: PW,
  }, nextIp())
  expect(b.status).toBe(201)
  orgB = { id: b.body.user.organization.id, userId: b.body.user.id, token: b.body.token }

  staff = await addUser(orgA, 'staff', 'Synthetic Staff', `stage7_staff_${RUN_ID}@example.com`)
  viewer = await addUser(orgA, 'viewer', 'Synthetic Viewer', `stage7_viewer_${RUN_ID}@example.com`)

  const ev = await request(server).post('/api/calendar').set(auth(orgA.token)).set('X-Forwarded-For', nextIp())
    .send({ title: `Stage7 Service ${RUN_ID}`, date: '2026-10-15', start_time: '09:00', end_time: '10:30', type: 'service' })
  expect(ev.status).toBe(201)
  eventId = ev.body.id
}, 60_000)

afterAll(async () => {
  for (const id of [orgA?.id, orgB?.id]) {
    if (id) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  }
  await closeServer(server)
  await pool.end()
})

async function addUser(org, role, name, email) {
  const created = await request(server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', nextIp())
    .send({ name, email, password: PW, role })
  expect(created.status).toBe(201)
  const login = await request(server).post('/api/auth/login').set('X-Forwarded-For', nextIp())
    .send({ email, password: PW })
  expect(login.status).toBe(200)
  return { id: login.body.user.id, token: login.body.token, email, role }
}

// Real check-in route, then pin a known synthetic pickup code. The code the
// route minted is not the value under test; checkout must accept this one.
async function childRow(code, name) {
  const ci = await request(server).post('/api/checkins').set(auth(orgA.token)).set('X-Forwarded-For', nextIp())
    .send({
      calendar_event_id: eventId,
      person_name: name,
      kind: 'child',
      guardian_name: 'Synthetic Guardian',
    })
  expect(ci.status).toBe(201)
  expect(ci.body.security_code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/)
  const issued = ci.body.security_code
  await pool.query(
    'UPDATE ochr_checkins SET security_code_hash = $2 WHERE id = $1 AND organization_id = $3',
    [ci.body.id, hashSecurityCode(code), orgA.id],
  )
  return { id: ci.body.id, issued }
}

function checkout(token, id, body, query = '') {
  const path = `/api/checkins/${id}/checkout${query}`
  return request(server).post(path).set(auth(token)).set('X-Forwarded-For', nextIp()).send(body)
}

const LEAKY_BODY_EXTRAS = {
  pickup_code: 'SYNTH-PICKUP-ALT',
  pickupCode: 'SYNTH-PICKUP-CAMEL',
  pin: 'SYNTH-PIN-9',
  security_code: 'SYNTH-SEC-9',
  wrapper: { code: 'SYNTH-NESTED-9' },
}

async function checkinState(id) {
  const { rows } = await pool.query(
    'SELECT checked_out_at, security_code_hash FROM ochr_checkins WHERE id = $1 AND organization_id = $2',
    [id, orgA.id],
  )
  return rows[0]
}

async function auditForPath(orgId, path, { waitFor = 0 } = {}) {
  let rows = []
  for (let i = 0; i < 40; i++) {
    ;({ rows } = await pool.query(
      `SELECT user_id, action, entity_type, entity_id, summary, metadata,
              request_method, request_path, status_code
         FROM ochr_audit_log
        WHERE organization_id = $1 AND request_path = $2
        ORDER BY id`,
      [orgId, path],
    ))
    if (rows.length >= waitFor) return rows
    await new Promise(r => setTimeout(r, 50))
  }
  return rows
}

async function orgAuditBlob(orgId) {
  const { rows } = await pool.query(
    `SELECT summary, metadata::text AS metadata, request_path, status_code::text AS status_code
       FROM ochr_audit_log WHERE organization_id = $1`,
    [orgId],
  )
  return JSON.stringify(rows)
}

// stderr/stdout plus the monitor dispatch, for the duration of one attempt.
async function captureLogs(fn) {
  const chunks = []
  const writeErr = process.stderr.write.bind(process.stderr)
  const writeOut = process.stdout.write.bind(process.stdout)
  process.stderr.write = (chunk, ...rest) => { chunks.push(String(chunk)); return writeErr(chunk, ...rest) }
  process.stdout.write = (chunk, ...rest) => { chunks.push(String(chunk)); return writeOut(chunk, ...rest) }
  const restoreMonitor = _setDispatchForTests((level, scope, message, context) => {
    chunks.push(JSON.stringify({ level, scope, message, context }))
  })
  try {
    const result = await fn()
    return { result, text: chunks.join('\n') }
  } finally {
    process.stderr.write = writeErr
    process.stdout.write = writeOut
    restoreMonitor()
  }
}

function assertNoPlaintext(blob, ...secrets) {
  const hay = String(blob).toLowerCase()
  for (const secret of secrets) {
    expect(hay).not.toContain(String(secret).toLowerCase())
  }
}

describe('pickup code stays out of the persisted checkout audit', () => {
  it('staff checkout succeeds, clears the spent hash, and stores no note and no code (metadata-only)', async () => {
    const code = 'SYNTH-PICKUP-STAFF7'
    const child = await childRow(code, 'Synthetic Child Staff')
    const path = `/api/checkins/${child.id}/checkout`
    const { result, text } = await captureLogs(() => checkout(staff.token, child.id, { code, note: HARMLESS }))
    expect(result.status).toBe(200)
    expect(result.body.checked_out_at).toBeTruthy()
    expect(result.body).not.toHaveProperty('code')
    assertNoPlaintext(JSON.stringify(result.body), code, child.issued)

    const state = await checkinState(child.id)
    expect(state.checked_out_at).toBeTruthy()
    expect(state.security_code_hash).toBeNull()

    const [row] = await auditForPath(orgA.id, path, { waitFor: 1 })
    expect(row).toMatchObject({
      user_id: staff.id,
      action: 'create',
      entity_type: 'checkin',
      entity_id: String(child.id),
      summary: 'Created checkin',
      request_method: 'POST',
      request_path: path,
      status_code: 200,
      metadata: {},
    })
    expect(row.metadata).toEqual({})
    expect(row.metadata).not.toHaveProperty('code')
    assertNoPlaintext(row.summary, code, child.issued)
    assertNoPlaintext(row.request_path, code, child.issued)
    assertNoPlaintext(JSON.stringify(row.metadata), code, child.issued)
    assertNoPlaintext(await orgAuditBlob(orgA.id), code)
    assertNoPlaintext(text, code, child.issued)

    const again = await captureLogs(() => checkout(staff.token, child.id, { code, note: HARMLESS }))
    expect(again.result.status).toBe(409)
    expect(again.result.body.error).toBe('Already checked out')
    assertNoPlaintext(JSON.stringify(again.result.body), code)
    assertNoPlaintext(again.text, code)
    await new Promise(r => setTimeout(r, 300))
    const after = await auditForPath(orgA.id, path)
    expect(after).toHaveLength(1)
    expect(after[0].status_code).toBe(200)
    expect((await checkinState(child.id)).security_code_hash).toBeNull()
  })

  it('admin checkout of another child in the same parish does the same', async () => {
    const code = 'SYNTH-PICKUP-ADMIN7'
    const child = await childRow(code, 'Synthetic Child Admin')
    const path = `/api/checkins/${child.id}/checkout`
    const { result, text } = await captureLogs(() => checkout(orgA.token, child.id, { code, note: HARMLESS }))
    expect(result.status).toBe(200)
    expect((await checkinState(child.id)).security_code_hash).toBeNull()
    const [row] = await auditForPath(orgA.id, path, { waitFor: 1 })
    expect(row.user_id).toBe(orgA.userId)
    expect(row.metadata).toEqual({})
    expect(row.summary).toBe('Created checkin')
    expect(row.status_code).toBe(200)
    assertNoPlaintext(JSON.stringify(row), code, child.issued)
    assertNoPlaintext(text, code, child.issued)
  })

  it('a wrong code and a missing code are refused and write no success audit row', async () => {
    const right = 'SYNTH-PICKUP-RIGHT7'
    const wrong = 'SYNTH-PICKUP-WRONG7'
    const child = await childRow(right, 'Synthetic Child Wrong')
    const path = `/api/checkins/${child.id}/checkout`

    const bad = await captureLogs(() => checkout(staff.token, child.id, { code: wrong, note: HARMLESS }))
    expect(bad.result.status).toBe(403)
    expect(bad.result.body.error).toBe('Pickup code does not match')
    assertNoPlaintext(JSON.stringify(bad.result.body), wrong, right)
    assertNoPlaintext(bad.text, wrong, right)
    expect((await checkinState(child.id)).security_code_hash).toBe(hashSecurityCode(right))

    const missing = await captureLogs(() => checkout(staff.token, child.id, { note: HARMLESS }))
    expect(missing.result.status).toBe(400)
    expect(missing.result.body.error).toBe('A pickup code is required')
    assertNoPlaintext(missing.text, wrong, right)
    expect((await checkinState(child.id)).checked_out_at).toBeNull()

    await new Promise(r => setTimeout(r, 300))
    const rows = await auditForPath(orgA.id, path)
    expect(rows.filter(r => r.status_code >= 200 && r.status_code < 300)).toEqual([])
    expect(rows).toEqual([])
    assertNoPlaintext(await orgAuditBlob(orgA.id), wrong, right)
  })

  it('a viewer cannot check a child out and writes no success audit row', async () => {
    const code = 'SYNTH-PICKUP-VIEW7'
    const child = await childRow(code, 'Synthetic Child Viewer')
    const path = `/api/checkins/${child.id}/checkout`
    const { result, text } = await captureLogs(() => checkout(viewer.token, child.id, { code, note: HARMLESS }))
    expect(result.status).toBe(403)
    assertNoPlaintext(JSON.stringify(result.body), code)
    assertNoPlaintext(text, code)
    const state = await checkinState(child.id)
    expect(state.checked_out_at).toBeNull()
    expect(state.security_code_hash).toBe(hashSecurityCode(code))
    await new Promise(r => setTimeout(r, 300))
    const rows = await auditForPath(orgA.id, path)
    expect(rows.filter(r => r.status_code >= 200 && r.status_code < 300)).toEqual([])
    expect(rows).toEqual([])
  })

  it('another parish cannot check this child out', async () => {
    const code = 'SYNTH-PICKUP-CROS7'
    const child = await childRow(code, 'Synthetic Child Cross')
    const path = `/api/checkins/${child.id}/checkout`
    const before = (await auditForPath(orgA.id, path)).length
    const { result, text } = await captureLogs(() => checkout(orgB.token, child.id, { code, note: HARMLESS }))
    expect(result.status).toBe(404)
    expect(result.body.error).toBe('Not found')
    assertNoPlaintext(JSON.stringify(result.body), code)
    assertNoPlaintext(text, code)
    const state = await checkinState(child.id)
    expect(state.checked_out_at).toBeNull()
    expect(state.security_code_hash).toBe(hashSecurityCode(code))
    await new Promise(r => setTimeout(r, 300))
    expect(await auditForPath(orgA.id, path)).toHaveLength(before)
    const attacker = await auditForPath(orgB.id, path)
    expect(attacker.filter(r => r.status_code >= 200 && r.status_code < 300)).toEqual([])
    expect(attacker).toEqual([])
    assertNoPlaintext(await orgAuditBlob(orgB.id), code)
  })

  it('checkout metadata is empty, and a query-string code is not stored', async () => {
    const code = 'SYNTH-PICKUP-BODY7'
    const queryCode = 'SYNTH-QUERY-CODE'
    const child = await childRow(code, 'Synthetic Child Query')
    const path = `/api/checkins/${child.id}/checkout`
    const { result, text } = await captureLogs(() => checkout(staff.token, child.id, {
      code,
      note: HARMLESS,
      ...LEAKY_BODY_EXTRAS,
    }, `?code=${queryCode}`))
    expect(result.status).toBe(200)
    expect((await checkinState(child.id)).security_code_hash).toBeNull()

    let rows = []
    for (let i = 0; i < 40; i++) {
      ;({ rows } = await pool.query(
        `SELECT summary, metadata, request_path, status_code
           FROM ochr_audit_log
          WHERE organization_id = $1 AND request_path LIKE $2
          ORDER BY id`,
        [orgA.id, `${path}%`],
      ))
      if (rows.length) break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(rows).toHaveLength(1)
    expect(rows[0].request_path).toBe(path)
    expect(rows[0].request_path).not.toContain('?')
    expect(rows[0].request_path).not.toContain(queryCode)
    expect(rows[0].metadata).toEqual({})
    expect(rows[0].status_code).toBe(200)
    const stored = JSON.stringify(rows[0])
    for (const secret of [queryCode, code, 'SYNTH-PICKUP-ALT', 'SYNTH-PICKUP-CAMEL', 'SYNTH-PIN-9', 'SYNTH-SEC-9', 'SYNTH-NESTED-9', child.issued]) {
      expect(stored).not.toContain(secret)
    }
    assertNoPlaintext(await orgAuditBlob(orgA.id), queryCode, 'SYNTH-PICKUP-ALT', 'SYNTH-NESTED-9', 'SYNTH-SEC-9')
    assertNoPlaintext(text, queryCode, code, 'SYNTH-NESTED-9')
  })

  it('the check-in that minted a code does not store that code on its own audit row', async () => {
    const code = 'SYNTH-PICKUP-MINT7'
    const child = await childRow(code, 'Synthetic Child Mint')
    let row = null
    for (let i = 0; i < 40 && !row; i++) {
      const { rows } = await pool.query(
        `SELECT summary, metadata, request_path FROM ochr_audit_log
          WHERE organization_id = $1 AND entity_type = 'checkin' AND entity_id = $2
            AND request_path = '/api/checkins'`,
        [orgA.id, String(child.id)],
      )
      row = rows[0]
      if (!row) await new Promise(r => setTimeout(r, 50))
    }
    expect(row).toBeTruthy()
    // CK-1: ids/kind only; no child or guardian names on the audit row
    expect(row.metadata).toEqual({ calendar_event_id: eventId, kind: 'child' })
    assertNoPlaintext(JSON.stringify(row), 'Synthetic Child Mint', 'Synthetic Guardian')
    expect(row.metadata).not.toHaveProperty('security_code')
    expect(row.metadata).not.toHaveProperty('code')
    assertNoPlaintext(JSON.stringify(row), child.issued, code)
  })

  // TARS 6206064745: checkout audit is metadata-only. A desk note (which may
  // repeat the code in any spelling) is not stored at all; no masking heuristic.
  it('does not store a checkout note at all, whatever it contains', async () => {
    const code = 'SYNTH-PICKUP-NOTE7'
    const child = await childRow(code, 'Synthetic Child Note')
    const path = `/api/checkins/${child.id}/checkout`
    const { result } = await captureLogs(() => checkout(staff.token, child.id, {
      code,
      note: `released at door, code ${code.toLowerCase()} / ${code}`,
    }))
    expect(result.status).toBe(200)
    expect((await checkinState(child.id)).security_code_hash).toBeNull()
    const rows = await auditForPath(orgA.id, path, { waitFor: 1 })
    expect(rows).toHaveLength(1)
    expect(rows[0].metadata).toEqual({})
    assertNoPlaintext(JSON.stringify(rows[0]), 'released at door')
    assertNoPlaintext(JSON.stringify(rows[0]), code)
  })

  // D-3: a code/PIN spelling on a non-checkout check-in route is not audit metadata.
  it('drops security_code / pickup_code / pin from a check-in create row', async () => {
    const ci = await request(server).post('/api/checkins').set(auth(orgA.token)).set('X-Forwarded-For', nextIp())
      .send({
        calendar_event_id: eventId,
        person_name: 'Synthetic Child Extras',
        kind: 'child',
        guardian_name: 'Synthetic Guardian',
        security_code: 'SYNTH-SEC-CREATE',
        securityCode: 'SYNTH-SEC-CAMEL',
        pickup_code: 'SYNTH-PICKUP-CREATE',
        pin: 'SYNTH-PIN-CREATE',
      })
    expect(ci.status).toBe(201)
    let row = null
    for (let i = 0; i < 40 && !row; i++) {
      const { rows } = await pool.query(
        `SELECT metadata FROM ochr_audit_log
          WHERE organization_id = $1 AND entity_type = 'checkin' AND entity_id = $2
            AND request_path = '/api/checkins'`,
        [orgA.id, String(ci.body.id)],
      )
      row = rows[0]
      if (!row) await new Promise(r => setTimeout(r, 50))
    }
    expect(row).toBeTruthy()
    expect(row.metadata).toEqual({ calendar_event_id: eventId, kind: 'child' })
    assertNoPlaintext(JSON.stringify(row), 'Synthetic Child Extras', 'Synthetic Guardian')
    for (const k of ['security_code', 'securityCode', 'pickup_code', 'pin']) expect(row.metadata).not.toHaveProperty(k)
    assertNoPlaintext(JSON.stringify(row), 'SYNTH-SEC-CREATE', 'SYNTH-SEC-CAMEL', 'SYNTH-PICKUP-CREATE', 'SYNTH-PIN-CREATE', ci.body.security_code)
  })

  it('R280-1/4: persisted rows drop a spaced-code note and any nested pin', async () => {
    const code = 'K7QM'
    const child = await childRow(code, 'Synthetic Child Spaced')
    const path = `/api/checkins/${child.id}/checkout`
    const { result } = await captureLogs(() => checkout(staff.token, child.id, { code, note: 'gave K 7-Q.M at door' }))
    expect(result.status).toBe(200)
    const rows = await auditForPath(orgA.id, path, { waitFor: 1 })
    expect(rows[0].metadata).toEqual({})

    const ci = await request(server).post('/api/checkins').set(auth(orgA.token)).set('X-Forwarded-For', nextIp())
      .send({ calendar_event_id: eventId, person_name: 'Synthetic Child Nested', kind: 'child', guardian_name: 'Synthetic Guardian', extra: { pin: 'SYNTH-NESTED-PIN', pin_code: 'SYNTH-PINCODE' } })
    expect(ci.status).toBe(201)
    let row = null
    for (let i = 0; i < 40 && !row; i++) {
      const { rows: r } = await pool.query(
        `SELECT metadata FROM ochr_audit_log WHERE organization_id = $1 AND entity_type = 'checkin' AND entity_id = $2 AND request_path = '/api/checkins'`,
        [orgA.id, String(ci.body.id)])
      row = r[0]
      if (!row) await new Promise(r2 => setTimeout(r2, 50))
    }
    expect(row.metadata).toEqual({ calendar_event_id: eventId, kind: 'child' })
    assertNoPlaintext(JSON.stringify(row), 'SYNTH-NESTED-PIN', 'SYNTH-PINCODE', ci.body.security_code)
  })
})

describe('plaintext security_code guard (migration 116, non-destructive)', () => {
  it('refuses a new plaintext code, leaves a legacy row readable and checkout-able', async () => {
    const child = await childRow('SYNTH-PICKUP-LEG7', 'Synthetic Child Legacy')
    await expect(pool.query('UPDATE ochr_checkins SET security_code = $2 WHERE id = $1', [child.id, 'SYNTH-PLAIN']))
      .rejects.toMatchObject({ code: '23514' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE ochr_checkins DISABLE TRIGGER trg_checkins_no_plaintext_code')
      await client.query('UPDATE ochr_checkins SET security_code = $2 WHERE id = $1', [child.id, 'LEGACY'])
      await client.query('ALTER TABLE ochr_checkins ENABLE TRIGGER trg_checkins_no_plaintext_code')
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await checkout(staff.token, child.id, { code: 'SYNTH-PICKUP-LEG7' })
    expect(r.status).toBe(200)
    const { rows: [after] } = await pool.query('SELECT security_code FROM ochr_checkins WHERE id = $1', [child.id])
    expect(after.security_code).toBe('LEGACY')
  })
})

describe('R3-3: check-in audit summary is not built from the body', () => {
  it('a body name/title handle never reaches the summary', async () => {
    const ci = await request(server).post('/api/checkins').set(auth(orgA.token)).set('X-Forwarded-For', nextIp())
      .send({ calendar_event_id: eventId, person_name: 'Synthetic Child Summary', kind: 'child', guardian_name: 'Synthetic Guardian',
        name: 'SYNTH-HANDLE-NAME', title: 'SYNTH-HANDLE-TITLE' })
    expect(ci.status).toBe(201)
    let row = null
    for (let i = 0; i < 40 && !row; i++) {
      const { rows } = await pool.query(
        `SELECT summary FROM ochr_audit_log WHERE organization_id = $1 AND entity_type = 'checkin' AND entity_id = $2 AND request_path = '/api/checkins'`,
        [orgA.id, String(ci.body.id)])
      row = rows[0]
      if (!row) await new Promise(r => setTimeout(r, 50))
    }
    expect(row.summary).toBe('Created checkin')
    assertNoPlaintext(row.summary, 'SYNTH-HANDLE', 'Synthetic Child Summary', 'Synthetic Guardian')
  })
})

// R5-3: the auditLog() call site (auditLog.js ~303) must route through
// summaryFor. A spy on the seam proves the live middleware calls it for a
// real check-in request; the persisted row is checked too.
describe('R5-3: the audit middleware call site uses summaryFor', () => {
  it('a real check-in request is summarised by summaryFor, with no body handle', async () => {
    const spy = vi.spyOn(_auditInternalsForTests, 'summaryFor')
    try {
      const ci = await request(server).post('/api/checkins').set(auth(orgA.token)).set('X-Forwarded-For', nextIp())
        .send({ calendar_event_id: eventId, person_name: 'Synthetic Child R53', kind: 'child', guardian_name: 'Synthetic Guardian',
          name: 'SYNTH-R53-NAME', title: 'SYNTH-R53-TITLE' })
      expect(ci.status).toBe(201)
      let rows = []
      for (let i = 0; i < 40 && !rows.length; i++) {
        ;({ rows } = await pool.query(
          `SELECT summary FROM ochr_audit_log WHERE organization_id = $1 AND entity_type = 'checkin' AND entity_id = $2`,
          [orgA.id, String(ci.body.id)]))
        if (!rows.length) await new Promise(r => setTimeout(r, 50))
      }
      expect(rows.length).toBeGreaterThan(0)
      const calls = spy.mock.calls.filter(c => c[0] === 'checkin')
      expect(calls.length).toBeGreaterThan(0)
      expect(spy.mock.results.map(r => r.value)).toContain(rows[0].summary)
      for (const r of rows) assertNoPlaintext(r.summary, 'SYNTH-R53', 'Synthetic Child R53', 'Synthetic Guardian')
    } finally { spy.mockRestore() }
  })
})
