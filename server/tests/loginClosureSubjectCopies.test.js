// Stage 6 — closure minimizes the closed login's profile copies in audit rows
// ABOUT that login (entity user, entity_id = its id), not only rows it wrote.
//
// Accepted design (OC-STAGE6-REVIEW-BUILD-2026-10-03 §6): minimize directly
// attributable account-profile identity copies in the operational audit
// where mapping is reliable; preserve record/action/actor continuity; do
// not blanket-rewrite free text; count what could not be mapped for review.
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
const PW = 'subject-copies-pw'
const auth = (token) => ({ Authorization: `Bearer ${token}` })

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

async function signup(tag) {
  const res = await createOrg(server, {
    organizationName: `Subject ${tag} ${RUN_ID}`,
    name: 'Parish Admin',
    email: `subj_${tag}_${RUN_ID}@example.com`,
    password: PW,
  }, `10.93.${ip++}.1`)
  expect(res.status).toBe(201)
  cleanupOrgIds.push(res.body.user.organization.id)
  return { token: res.body.token, orgId: res.body.user.organization.id, userId: res.body.user.id }
}

async function addUser(org, name, tag) {
  const email = `subj_${tag}_${RUN_ID}@example.com`
  const res = await request(server).post('/api/users').set(auth(org.token)).send({ name, email, password: PW, role: 'staff' })
  expect(res.status).toBe(201)
  return { id: res.body.id, name, email }
}

async function settle(orgId, n) {
  for (let i = 0; i < 40; i++) {
    const { rows: [{ c }] } = await pool.query('SELECT COUNT(*)::int AS c FROM ochr_audit_log WHERE organization_id = $1', [orgId])
    if (c >= n) return
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function insertRow(orgId, actorId, entityId, summary, metadata, method = 'PATCH') {
  const { rows: [r] } = await pool.query(
    `INSERT INTO ochr_audit_log
       (organization_id, user_id, user_email, user_name, action, entity_type, entity_id,
        summary, metadata, request_method, request_path, status_code)
     VALUES ($1, $2, 'admin@example.com', 'Parish Admin', 'update', 'user', $3, $4, $5, $6, '/api/users/x', 200)
     RETURNING id`,
    [orgId, actorId, entityId, summary, JSON.stringify(metadata), method]
  )
  return r.id
}

const rowById = async (id) => (await pool.query(
  'SELECT action, entity_type, entity_id, user_id, user_name, user_email, summary, metadata FROM ochr_audit_log WHERE id = $1', [id]
)).rows[0]

describe('closure minimizes copies about the closed login', () => {
  it('generated summaries and profile metadata about the login are minimized; everything else stays', async () => {
    const org = await signup('main')
    const other = await signup('other')
    const carl = await addUser(org, 'Synthetic Carl Closer', 'carl')
    const dee = await addUser(org, 'Synthetic Dee Keeps', 'dee')
    await settle(org.orgId, 2)

    const { rows: before } = await pool.query(
      `SELECT id, summary FROM ochr_audit_log WHERE organization_id = $1 AND entity_type = 'user' AND entity_id = $2 ORDER BY id`,
      [org.orgId, String(carl.id)]
    )
    const createId = before.find((r) => r.summary === `Created user: ${carl.name}`)?.id
    expect(createId, 'create row as written').toBeTruthy()
    // A generated summary carrying his current name where the row's metadata
    // has no name copy (a route that answers with the user record).
    const leadId = await insertRow(org.orgId, org.userId, String(carl.id), `Updated user: ${carl.name}`, { pastoral_lead: true })

    // An older row against a zero-padded id, a free-text row naming him
    // differently, a row about Dee, and a row in another parish with the
    // same entity id.
    const paddedId = await insertRow(org.orgId, org.userId, `00${carl.id}`, `Updated user: ${carl.name}`, { name: carl.name, role: 'staff' })
    const freeId = await insertRow(org.orgId, org.userId, String(carl.id), 'Updated user: Carl (the sacristan)', { note: 'kept' })
    const deeId = (await pool.query(
      `SELECT id FROM ochr_audit_log WHERE organization_id = $1 AND entity_type = 'user' AND entity_id = $2`, [org.orgId, String(dee.id)]
    )).rows[0].id
    const foreignId = await insertRow(other.orgId, other.userId, String(carl.id), `Created user: ${carl.name}`, { name: carl.name, email: carl.email })
    const { rows: [{ total: totalBefore }] } = await pool.query('SELECT COUNT(*)::int AS total FROM ochr_audit_log WHERE organization_id = $1', [org.orgId])

    const res = await request(server).post(`/api/users/${carl.id}/close`).set(auth(org.token))
    expect(res.status).toBe(200)
    expect(res.body.review_remaining).toBe(true)

    const create = await rowById(createId)
    expect(create).toMatchObject({ action: 'create', entity_id: String(carl.id), user_id: org.userId, user_name: 'Parish Admin', summary: `Created user #${carl.id}` })
    expect(create.metadata.name).toBeUndefined()
    expect(create.metadata.email).toBeUndefined()
    expect(create.metadata.role).toBe('staff')

    const lead = await rowById(leadId)
    expect(lead).toMatchObject({ action: 'update', summary: `Updated user #${carl.id}`, user_name: 'Parish Admin' })
    expect(lead.metadata.pastoral_lead).toBe(true)

    const padded = await rowById(paddedId)
    expect(padded).toMatchObject({ entity_id: `00${carl.id}`, summary: `Updated user #${carl.id}` })
    expect(padded.metadata).toEqual({ role: 'staff' })

    // Free text that is not a generated summary is left as written and counted.
    expect(await rowById(freeId)).toMatchObject({ summary: 'Updated user: Carl (the sacristan)', metadata: { note: 'kept' } })
    // Another person's row and another parish's row are untouched.
    expect(await rowById(deeId)).toMatchObject({ summary: `Created user: ${dee.name}` })
    expect((await rowById(deeId)).metadata.email).toBe(dee.email)
    expect(await rowById(foreignId)).toMatchObject({ summary: `Created user: ${carl.name}`, metadata: { name: carl.name, email: carl.email } })

    // Nothing deleted; one new row (the closure itself).
    await settle(org.orgId, totalBefore + 1)
    const { rows: [{ total: totalAfter }] } = await pool.query('SELECT COUNT(*)::int AS total FROM ochr_audit_log WHERE organization_id = $1', [org.orgId])
    expect(totalAfter).toBe(totalBefore + 1)

    const receipt = await request(server).get(`/api/users/${carl.id}/closure`).set(auth(org.token))
    expect(receipt.status).toBe(200)
    expect(receipt.body.reviews.find((r) => r.kind === 'audit_subject_text')).toMatchObject({ row_count: 1, disposition: 'retained_for_review' })

    // The closed person's name and email appear nowhere in this parish's audit rows about him.
    const { rows: leak } = await pool.query(
      `SELECT id FROM ochr_audit_log
        WHERE organization_id = $1 AND entity_type = 'user' AND ltrim(entity_id, '0') = $2
          AND (summary LIKE '%' || $3 || '%' OR metadata::text LIKE '%' || $3 || '%' OR metadata::text LIKE '%' || $4 || '%')`,
      [org.orgId, String(carl.id), carl.name, carl.email]
    )
    expect(leak).toEqual([])
  })

  it('nothing to minimize: no review rows claimed', async () => {
    const org = await signup('clean')
    const s = await addUser(org, 'Synthetic Plain', 'plain')
    await settle(org.orgId, 1)
    expect((await request(server).post(`/api/users/${s.id}/close`).set(auth(org.token))).status).toBe(200)
    const receipt = await request(server).get(`/api/users/${s.id}/closure`).set(auth(org.token))
    expect(receipt.body.reviews.find((r) => r.kind === 'audit_subject_text')).toMatchObject({ row_count: 0, disposition: 'none_found' })
  })
})
