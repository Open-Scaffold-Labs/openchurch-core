// OC-CYCLE-MAX-04 / AUDIT-L2-04 — operational audit-trail completeness
// for Golden Journey 1–2 actions (success + refuse), within the existing
// audit architecture (ochr_audit_log + middleware). No schema redesign.
//
// CLAIM (bounded):
//   For GJ1–2 actions, audit rows answer who / which church / entity+action /
//   when; safe before/after where already supported (sacrament amendments);
//   correlation to correction/void; no secrets / no alternate canonical
//   register in audit metadata; no cross-tenant audit visibility; refused
//   attempts follow current policy (no row on non-2xx).
//
// Evidence: LOCAL POSTGRES RUNTIME VERIFIED on disposable openchurch_local.
// Synthetic parish only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import 'dotenv/config'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { _auditInternalsForTests } from '../src/middleware/auditLog.js'

let server
let tokenA, tokenB
let orgAId, orgBId
let adminEmail

const MARKER = `AUDIT_L204_${RUN_ID}`
const MASS_DATE = '2033-04-17'
const auth = token => ({ Authorization: `Bearer ${token}` })

async function waitForAuditRow(orgId, predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query(
      `SELECT * FROM ochr_audit_log
        WHERE organization_id = $1
        ORDER BY id DESC
        LIMIT 40`,
      [orgId]
    )
    const hit = rows.find(predicate)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 40))
  }
  return null
}

async function auditCount(orgId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS c FROM ochr_audit_log WHERE organization_id = $1',
    [orgId]
  )
  return rows[0].c
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const a = await createOrg(server, {
    organizationName: `Audit L204 Church A ${RUN_ID}`,
    name: 'Ada Audit',
    email: `audit_l204_a_${RUN_ID}@example.com`,
    password: 'audit-l204-pw-a1',
  }, '10.254.4.1')
  expect(a.status).toBe(201)
  tokenA = a.body.token
  orgAId = a.body.user.organization.id
  adminEmail = a.body.user.email.toLowerCase()

  const b = await createOrg(server, {
    organizationName: `Audit L204 Church B ${RUN_ID}`,
    name: 'Bea Audit',
    email: `audit_l204_b_${RUN_ID}@example.com`,
    password: 'audit-l204-pw-b1',
  }, '10.254.4.2')
  expect(b.status).toBe(201)
  tokenB = b.body.token
  orgBId = b.body.user.organization.id
})

afterAll(async () => {
  await closeServer(server)
})

describe('AUDIT-L2-04 · GJ1 mass intention trail', () => {
  let memberId, massId, intentionId

  it('create records who / church / entity / when (not a secret dump)', async () => {
    const member = await request(server).post('/api/clients').set(auth(tokenA)).send({
      name: `${MARKER} Member`,
      email: `audit_l204_m_${RUN_ID}@example.com`,
    })
    expect(member.status).toBe(201)
    memberId = member.body.id

    const mass = await request(server).post('/api/calendar').set(auth(tokenA)).send({
      title: `${MARKER} Sunday Mass`,
      date: MASS_DATE,
      start_time: '09:00',
      end_time: '10:00',
      type: 'service',
    })
    expect(mass.status).toBe(201)
    massId = mass.body.id

    const mi = await request(server).post('/api/mass-intentions').set(auth(tokenA)).send({
      intention: `${MARKER} For the parish`,
      requested_by_name: 'Requester',
      status: 'open',
    })
    expect(mi.status).toBe(201)
    intentionId = mi.body.id

    const row = await waitForAuditRow(orgAId, r =>
      r.entity_type === 'mass_intention' &&
      r.action === 'create' &&
      r.entity_id === String(intentionId) &&
      !String(r.request_path || '').includes('/assign'))
    expect(row).toBeTruthy()
    expect(row.organization_id).toBe(orgAId)
    expect(row.user_email).toBe(adminEmail)
    expect(row.user_id).toBeTruthy()
    expect(row.created_at).toBeTruthy()
    expect(row.summary).toMatch(/Created mass_intention/i)
    expect(JSON.stringify(row.metadata)).not.toMatch(/password|token|secret/i)
  })

  it('assign / unassign log as update with op tags (not false create)', async () => {
    const assign = await request(server)
      .post(`/api/mass-intentions/${intentionId}/assign`)
      .set(auth(tokenA))
      .send({ calendar_event_id: massId })
    expect(assign.status).toBe(200)

    const assignRow = await waitForAuditRow(orgAId, r =>
      r.entity_type === 'mass_intention' &&
      r.entity_id === String(intentionId) &&
      String(r.request_path || '').includes('/assign') &&
      !String(r.request_path || '').includes('/unassign'))
    expect(assignRow).toBeTruthy()
    expect(assignRow.action).toBe('update')
    expect(assignRow.metadata?.op).toBe('assign')
    expect(assignRow.summary).toMatch(/^Assigned mass_intention/i)
    expect(assignRow.organization_id).toBe(orgAId)
    expect(assignRow.user_email).toBe(adminEmail)

    const unassign = await request(server)
      .post(`/api/mass-intentions/${intentionId}/unassign`)
      .set(auth(tokenA))
      .send({})
    expect(unassign.status).toBe(200)

    const unassignRow = await waitForAuditRow(orgAId, r =>
      r.entity_type === 'mass_intention' &&
      String(r.request_path || '').includes('/unassign'))
    expect(unassignRow).toBeTruthy()
    expect(unassignRow.action).toBe('update')
    expect(unassignRow.metadata?.op).toBe('unassign')
    expect(unassignRow.summary).toMatch(/^Unassigned mass_intention/i)
  })

  it('refused assign does not write an audit row (current policy)', async () => {
    const before = await auditCount(orgAId)
    const refused = await request(server)
      .post(`/api/mass-intentions/${intentionId}/assign`)
      .set(auth(tokenA))
      .send({ calendar_event_id: 999999999 })
    expect([400, 404]).toContain(refused.status)
    await new Promise(r => setTimeout(r, 200))
    expect(await auditCount(orgAId)).toBe(before)
  })
})

describe('AUDIT-L2-04 · GJ2 sacrament trail + correlation', () => {
  let memberId, sacramentId, correctionReason, voidReason

  beforeAll(async () => {
    const member = await request(server).post('/api/clients').set(auth(tokenA)).send({
      name: `${MARKER} Baptism Subject`,
      email: `audit_l204_sac_${RUN_ID}@example.com`,
    })
    expect(member.status).toBe(201)
    memberId = member.body.id
  })

  it('draft commit audits the register record id (not the draft id alone)', async () => {
    const draft = await request(server).post('/api/sacraments/drafts').set(auth(tokenA)).send({
      drafts: [{
        draft: {
          type: 'baptism',
          date: '2012-06-10',
          member_name: `${MARKER} Baptized`,
          client_id: memberId,
          minister: 'Fr Probe',
          place: 'St Probe',
        },
      }],
    })
    expect(draft.status).toBe(201)
    const draftId = draft.body.drafts[0].id

    const commit = await request(server)
      .post(`/api/sacraments/drafts/${draftId}/commit`)
      .set(auth(tokenA))
      .send({})
    expect(commit.status).toBe(201)
    sacramentId = commit.body.record.id
    expect(String(sacramentId)).not.toBe('')
    // Draft id and record id can collide numerically across sequences; the
    // audit row must name the permanent record and tag the commit op.
    expect(commit.body.draft.committed_record_id).toBe(sacramentId)

    const row = await waitForAuditRow(orgAId, r =>
      r.entity_type === 'sacrament' &&
      String(r.request_path || '').includes('/commit') &&
      r.entity_id === String(sacramentId))
    expect(row).toBeTruthy()
    expect(row.action).toBe('create')
    expect(row.metadata?.op).toBe('commit')
    expect(row.summary).toMatch(/^Committed sacrament/i)
    expect(row.organization_id).toBe(orgAId)
    expect(row.user_email).toBe(adminEmail)
    // Audit must not become a second register: no before/after dump.
    expect(row.metadata).not.toHaveProperty('before_json')
    expect(row.metadata).not.toHaveProperty('after_json')
    expect(row.metadata).not.toHaveProperty('before')
    expect(row.metadata).not.toHaveProperty('after')
  })

  it('correction: audit op + amendment before/after correlate on entity_id', async () => {
    correctionReason = 'Spelling on the register page'
    const patch = await request(server)
      .patch(`/api/sacraments/${sacramentId}`)
      .set(auth(tokenA))
      .send({ place: 'Corrected Chapel', reason: correctionReason })
    expect(patch.status).toBe(200)

    const audit = await waitForAuditRow(orgAId, r =>
      r.entity_type === 'sacrament' &&
      r.action === 'update' &&
      r.entity_id === String(sacramentId) &&
      r.metadata?.op === 'correction')
    expect(audit).toBeTruthy()
    expect(audit.metadata.reason).toBe(correctionReason)
    expect(audit.metadata).not.toHaveProperty('before_json')
    expect(audit.metadata).not.toHaveProperty('after_json')

    const { rows: amends } = await pool.query(
      `SELECT id, kind, reason,
              before_json IS NOT NULL AS has_before,
              after_json IS NOT NULL AS has_after
         FROM ochr_sacrament_amendments
        WHERE organization_id = $1 AND sacrament_id = $2 AND kind = 'correction'
        ORDER BY id DESC
        LIMIT 1`,
      [orgAId, sacramentId]
    )
    expect(amends).toHaveLength(1)
    expect(amends[0].reason).toBe(correctionReason)
    expect(amends[0].has_before).toBe(true)
    expect(amends[0].has_after).toBe(true)
  })

  it('void: audit update+op correlates to amendment; refuse writes nothing', async () => {
    const beforeRefuse = await auditCount(orgAId)
    const refused = await request(server)
      .post(`/api/sacraments/${sacramentId}/void`)
      .set(auth(tokenA))
      .send({ reason: 'no' })
    expect(refused.status).toBe(400)
    await new Promise(r => setTimeout(r, 200))
    expect(await auditCount(orgAId)).toBe(beforeRefuse)

    voidReason = 'Entered on the wrong page of the register'
    const voided = await request(server)
      .post(`/api/sacraments/${sacramentId}/void`)
      .set(auth(tokenA))
      .send({ reason: voidReason })
    expect(voided.status).toBe(200)

    const audit = await waitForAuditRow(orgAId, r =>
      r.entity_type === 'sacrament' &&
      r.entity_id === String(sacramentId) &&
      String(r.request_path || '').includes('/void'))
    expect(audit).toBeTruthy()
    expect(audit.action).toBe('update')
    expect(audit.metadata?.op).toBe('void')
    expect(audit.metadata?.reason).toBe(voidReason)
    expect(audit.summary).toMatch(/^Voided sacrament/i)
    expect(audit.user_email).toBe(adminEmail)
    expect(audit.organization_id).toBe(orgAId)

    const { rows: amends } = await pool.query(
      `SELECT kind, reason,
              before_json IS NOT NULL AS has_before,
              after_json IS NOT NULL AS has_after
         FROM ochr_sacrament_amendments
        WHERE organization_id = $1 AND sacrament_id = $2 AND kind = 'void'
        ORDER BY id DESC
        LIMIT 1`,
      [orgAId, sacramentId]
    )
    expect(amends).toHaveLength(1)
    expect(amends[0].reason).toBe(voidReason)
    expect(amends[0].has_before).toBe(true)
    expect(amends[0].has_after).toBe(true)
  })

  it('secrets are stripped from audit metadata on user create', async () => {
    const created = await request(server).post('/api/users').set(auth(tokenA)).send({
      name: `${MARKER} Viewer`,
      email: `audit_l204_viewer_${RUN_ID}@example.com`,
      password: 'never-store-this-password-xyz',
      role: 'viewer',
    })
    expect(created.status).toBe(201)

    const row = await waitForAuditRow(orgAId, r =>
      r.entity_type === 'user' && r.entity_id === String(created.body.id))
    expect(row).toBeTruthy()
    expect(JSON.stringify(row.metadata)).not.toContain('never-store-this-password-xyz')
    expect(row.metadata).not.toHaveProperty('password')
  })
})

describe('AUDIT-L2-04 · tenant boundary on the trail', () => {
  it('Church B cannot see Church A audit markers', async () => {
    const listB = await request(server).get('/api/audit-log?limit=100').set(auth(tokenB))
    expect(listB.status).toBe(200)
    const blob = JSON.stringify(listB.body)
    expect(blob).not.toContain(MARKER)
    expect(blob).not.toContain(adminEmail)

    const listA = await request(server).get('/api/audit-log?limit=100').set(auth(tokenA))
    expect(listA.status).toBe(200)
    expect(JSON.stringify(listA.body)).toContain(MARKER)

    // Org ids differ — B's trail is its own church only.
    expect(orgAId).not.toBe(orgBId)
  })
})

describe('AUDIT-L2-04 · internals + mutation probe target', () => {
  it('subpath void resolves to update/void (source contract)', () => {
    const op = _auditInternalsForTests.resolveSubpathOp('/api/sacraments/42/void')
    expect(op).toEqual(expect.objectContaining({ action: 'update', op: 'void', verb: 'Voided' }))
    const assign = _auditInternalsForTests.resolveSubpathOp('/api/mass-intentions/9/assign')
    expect(assign).toEqual(expect.objectContaining({ action: 'update', op: 'assign' }))
    const commit = _auditInternalsForTests.resolveSubpathOp('/api/sacraments/drafts/3/commit')
    expect(commit).toEqual(expect.objectContaining({ action: 'create', op: 'commit' }))
  })

  it('commit entity_id prefers responseBody.record.id over draft :id', () => {
    const id = _auditInternalsForTests.resolveEntityId(
      { params: { id: '99' } },
      { record: { id: '77' }, draft: { id: '99' } },
    )
    expect(id).toBe('77')
  })

  it('sanitizeBody drops password / token / secret keys', () => {
    const clean = _auditInternalsForTests.sanitizeBody({
      name: 'Ada',
      password: 'secret',
      reset_token: 'abc',
      api_key: 'k',
      reason: 'Spelling on the page',
    })
    expect(clean).toEqual({ name: 'Ada', reason: 'Spelling on the page' })
  })

  it('middleware source keeps the 2xx-only write gate (refuse policy)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/middleware/auditLog.js', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/statusCode < 200 \|\| res\.statusCode >= 300/)
    expect(src).toMatch(/SUBPATH_OPS/)
    expect(src).toMatch(/metadata\.op = subOp\.op/)
  })
})
