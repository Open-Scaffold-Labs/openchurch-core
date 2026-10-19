// Stage 7 — legacy check-in audit rows in the parish export.
//
// Before #280 the audit middleware copied the check-in request body into
// ochr_audit_log.metadata (child / guardian names, notes, the checkout code).
// The parish export (GET /api/organization/export and the weekly backup,
// both buildOrgExport) shipped those rows whole. The export now applies the
// new-write allowlist to check-in audit rows at read time and says so in
// its header; the stored rows are not changed.
//
// Synthetic tenants and names only.
//
// WHAT WOULD MAKE THESE FAIL
//   - a legacy name, note or code reaching the export (route or function)
//   - the stored audit row being rewritten
//   - org B's legacy row appearing in org A's export
//   - the export header not stating the redaction and its row count

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { buildOrgExport } from '../src/services/orgExport.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const CHILD = `Zephyrine Testchild ${RUN_ID}`
const GUARDIAN = `Quillon Testguardian ${RUN_ID}`
const NOTE = `allergic-synthetic-note-${RUN_ID}`
const CODE = '4K7Q'
const OTHER_CHILD = `Otherparish Child ${RUN_ID}`

const QUERY_NAME = `Querystring Child ${RUN_ID}`
const LONG = 'L'.repeat(41)

let server, orgA, orgB, legacyId, checkoutId, modernId, pathId, nestedId, longId, scalarId, arrayId, opId, extraKeyId
const auth = t => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  const mk = async (tag) => {
    const r = await createOrg(server, {
      organizationName: `Export Redact ${tag} ${RUN_ID}`,
      name: 'Synthetic Admin',
      email: `exred_${tag}_${RUN_ID}@example.com`,
      password: 'exred-test-pw',
    })
    expect(r.status).toBe(201)
    return { id: r.body.user.organization.id, token: r.body.token, userId: r.body.user.id }
  }
  orgA = await mk('a')
  orgB = await mk('b')

  const ins = async (org, summary, metadata, path = '/api/checkins') => {
    const { rows } = await pool.query(
      `INSERT INTO ochr_audit_log
         (organization_id, user_id, action, entity_type, entity_id, summary, metadata, request_method, request_path)
       VALUES ($1, $2, 'create', 'checkin', '1', $3, $4, 'POST', $5) RETURNING id`,
      [org.id, org.userId, summary, JSON.stringify(metadata), path])
    return rows[0].id
  }
  legacyId = await ins(orgA, `Created checkin: ${CHILD}`,
    { calendar_event_id: 7, kind: 'child', person_name: CHILD, guardian_name: GUARDIAN, note: NOTE, room_id: 3 })
  checkoutId = await ins(orgA, 'Checked out checkin #1',
    { code: CODE, security_code: CODE, note: NOTE }, '/api/checkins/1/checkout')
  modernId = await ins(orgA, 'Created checkin #2', { calendar_event_id: 7, kind: 'child' })
  await ins(orgB, `Created checkin: ${OTHER_CHILD}`, { person_name: OTHER_CHILD })
  // R282-1: pre-#280 rows stored the full URL, query string included.
  pathId = await ins(orgA, 'Created checkin #3', { calendar_event_id: 7 },
    `/api/checkins?person_name=${encodeURIComponent(QUERY_NAME)}&code=${CODE}`)
  // R282-8: nested values under allowlisted keys, long strings, non-object metadata.
  nestedId = await ins(orgA, 'Created checkin #4',
    { calendar_event_id: { name: CHILD }, kind: ['child', CHILD], room_id: { nested: { note: NOTE } } })
  longId = await ins(orgA, 'Created checkin #5', { kind: LONG, client_id: LONG })
  scalarId = await ins(orgA, 'Created checkin #6', `${CHILD} ${NOTE}`)
  arrayId = await ins(orgA, 'Created checkin #7', [CHILD, NOTE])
  // R282-2: short free text under kind/op/via, and string ids.
  opId = await ins(orgA, 'Created checkin #8',
    { kind: 'Zed Kid', op: 'Zed', via: 'Zed', already: true, calendar_event_id: '7', client_id: 'Zed', room_id: -1 })
  // Numbers under keys the writer never keeps.
  extraKeyId = await ins(orgA, 'Created checkin #9', { op: 1, via: 2, already: 3, person_id: 4 })
})

afterAll(async () => { await closeServer(server) })

const auditRows = dump => dump.tables.ochr_audit_log.filter(r => [legacyId, checkoutId, modernId].includes(r.id))
const rowById = (dump, id) => dump.tables.ochr_audit_log.find(r => r.id === id)
const EXPECTED_REDACTED = 9

describe('parish export redacts legacy check-in audit content', () => {
  it('buildOrgExport drops names, notes and codes and keeps operational ids', async () => {
    const dump = await buildOrgExport(orgA.id)
    const text = JSON.stringify(dump.tables.ochr_audit_log)
    for (const s of [CHILD, GUARDIAN, NOTE, CODE, OTHER_CHILD]) expect(text).not.toContain(s)
    const rows = auditRows(dump)
    expect(rows).toHaveLength(3)
    const legacy = rows.find(r => r.id === legacyId)
    expect(legacy.metadata).toEqual({ calendar_event_id: 7, kind: 'child', room_id: 3 })
    expect(legacy.summary).toBe('Created checkin')
    expect(rows.find(r => r.id === checkoutId).metadata).toEqual({})
    expect(rows.find(r => r.id === modernId).metadata).toEqual({ calendar_event_id: 7, kind: 'child' })
  })

  it('states the redaction and counts only the rows it changed', async () => {
    const dump = await buildOrgExport(orgA.id)
    expect(dump.redactions.ochr_audit_log.rows).toBe(EXPECTED_REDACTED)
    expect(dump.redactions.ochr_audit_log.rule).toMatch(/stored audit log is unchanged/)
  })

  it('the download route carries the same redaction, tenant-scoped', async () => {
    const res = await request(server).get('/api/organization/export').set(auth(orgA.token))
    expect(res.status).toBe(200)
    const body = typeof res.body === 'object' && res.body.tables ? res.body : JSON.parse(res.text)
    const text = JSON.stringify(body)
    for (const s of [CHILD, GUARDIAN, NOTE, OTHER_CHILD]) expect(text).not.toContain(s)
    expect(body.redactions.ochr_audit_log.rows).toBe(EXPECTED_REDACTED)
  })

  it('stored rows are unchanged', async () => {
    const { rows } = await pool.query(
      'SELECT summary, metadata FROM ochr_audit_log WHERE id = $1', [legacyId])
    expect(rows[0].summary).toBe(`Created checkin: ${CHILD}`)
    expect(rows[0].metadata.person_name).toBe(CHILD)
  })

  it('R282-1: a stored request_path keeps only the part before ?', async () => {
    const dump = await buildOrgExport(orgA.id)
    const row = rowById(dump, pathId)
    expect(row.request_path).toBe('/api/checkins')
    expect(JSON.stringify(dump.tables.ochr_audit_log)).not.toContain('Querystring')
  })

  it('R282-8: nested values under allowlisted keys are dropped', async () => {
    const dump = await buildOrgExport(orgA.id)
    expect(rowById(dump, nestedId).metadata).toEqual({})
  })

  it('R282-8: strings over 40 characters are dropped', async () => {
    const dump = await buildOrgExport(orgA.id)
    expect(rowById(dump, longId).metadata).toEqual({})
  })

  it('R282-8: non-object metadata (scalar, array) exports as {}', async () => {
    const dump = await buildOrgExport(orgA.id)
    expect(rowById(dump, scalarId).metadata).toEqual({})
    expect(rowById(dump, arrayId).metadata).toEqual({})
  })

  it('R282-2: only the writer keys, known kind values and numeric ids survive', async () => {
    const dump = await buildOrgExport(orgA.id)
    expect(rowById(dump, opId).metadata).toEqual({})
    expect(rowById(dump, extraKeyId).metadata).toEqual({})
  })

  it('R282-7: redactions.rows matches the rows actually redacted, even through projectRow', async () => {
    const ids = [legacyId, checkoutId, pathId, nestedId, longId, scalarId, arrayId, opId, extraKeyId]
    const passthrough = (_t, row) => ({ ...row })
    const dump = await buildOrgExport(orgA.id, { projectRow: passthrough })
    const text = JSON.stringify(dump.tables.ochr_audit_log)
    for (const s of [CHILD, GUARDIAN, NOTE, 'Querystring']) expect(text).not.toContain(s)
    for (const id of ids) expect(rowById(dump, id)).toBeTruthy()
    expect(dump.redactions.ochr_audit_log.rows).toBe(EXPECTED_REDACTED)
  })
})
