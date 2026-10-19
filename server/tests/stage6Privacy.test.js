// Stage 6 — closure and HOLD privacy regressions on real Postgres:
// late audit writes ABOUT a closed login (migration 113 trigger), the live
// closure review report, late capability rejection, migration idempotency
// and trigger inventory, HOLD history preservation, vault restore and
// cascade cleanup. Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { holdOrganization } from '../src/auth/organizationHold.js'
import { up as up113 } from '../src/migrations/113-closure-subject-copies.js'
import { up as up114 } from '../src/migrations/114-profile-and-organization-hold.js'

let server
const orgIds = []
let sequence = 1
const PW = 'stage6-privacy-pw'
const auth = token => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => { await migrateOnce(); server = await bindServer() }, 60000)
afterAll(async () => {
  for (const id of orgIds) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server); await pool.end()
})

async function parish(tag) {
  const name = `Privacy ${tag} ${RUN_ID}`
  const res = await createOrg(server, { organizationName: name, name: 'Synthetic Admin', email: `privacy_${tag}_${RUN_ID}@example.com`, password: PW }, `10.97.${sequence++}.1`)
  expect(res.status).toBe(201)
  const org = { id: res.body.user.organization.id, name, userId: res.body.user.id, token: res.body.token }
  orgIds.push(org.id)
  return org
}
async function staff(org, tag, name = `Synthetic ${tag}`) {
  const email = `privacy_staff_${tag}_${RUN_ID}@example.com`
  const r = await request(server).post('/api/users').set(auth(org.token)).send({ name, email, password: PW, role: 'staff' })
  expect(r.status).toBe(201)
  return { id: r.body.id, name, email }
}
async function close(org, s) {
  const r = await request(server).post(`/api/users/${s.id}/close`).set(auth(org.token))
  expect(r.status).toBe(200)
  return r.body
}
async function auditInsert(orgId, actorId, entityId, summary, metadata, actorName = 'Synthetic Admin', actorEmail = 'admin@example.com') {
  const { rows: [r] } = await pool.query(
    `INSERT INTO ochr_audit_log (organization_id, user_id, user_email, user_name, action, entity_type, entity_id, summary, metadata, request_method, request_path, status_code)
     VALUES ($1, $2, $3, $4, 'update', 'user', $5, $6, $7, 'PATCH', '/api/users/x', 200)
     RETURNING id, user_name, user_email, summary, metadata, entity_id`,
    [orgId, actorId, actorEmail, actorName, entityId, summary, JSON.stringify(metadata)])
  return r
}

describe('late audit writes about a closed login (active administrator as actor)', () => {
  it('INSERT: generated summary and profile metadata minimized; actor identity kept; zero-padded id covered', async () => {
    const org = await parish('late_insert')
    const s = await staff(org, 'late_insert', 'Synthetic Late Subject')
    await close(org, s)
    const plain = await auditInsert(org.id, org.userId, String(s.id), `Updated user: ${s.name}`, { name: s.name, email: s.email, role: 'staff' })
    expect(plain).toMatchObject({ summary: `Updated user #${s.id}`, user_name: 'Synthetic Admin', user_email: 'admin@example.com' })
    expect(plain.metadata).toEqual({ role: 'staff' })
    const padded = await auditInsert(org.id, org.userId, `000${s.id}`, `Created user: ${s.name}`, { name: s.name, avatar: 'x.png' })
    expect(padded).toMatchObject({ entity_id: `000${s.id}`, summary: `Created user #${s.id}`, metadata: {} })
    // Free text is not a generated summary: kept as written (review exception).
    const free = await auditInsert(org.id, org.userId, String(s.id), `Updated user: ${s.name} (front desk)`, { note: 'synthetic' })
    expect(free.summary).toBe(`Updated user: ${s.name} (front desk)`)
    expect(free.metadata).toEqual({ note: 'synthetic' })
  })

  it('UPDATE that writes a copy back is minimized again', async () => {
    const org = await parish('late_update')
    const s = await staff(org, 'late_update', 'Synthetic Update Subject')
    await close(org, s)
    const row = await auditInsert(org.id, org.userId, String(s.id), 'Updated user', { role: 'staff' })
    const { rows: [after] } = await pool.query(
      `UPDATE ochr_audit_log SET summary = $2, metadata = $3 WHERE id = $1 RETURNING summary, metadata, user_name`,
      [row.id, `Updated user: ${s.name}`, JSON.stringify({ name: s.name, email: s.email, role: 'viewer' })])
    expect(after).toEqual({ summary: `Updated user #${s.id}`, metadata: { role: 'viewer' }, user_name: 'Synthetic Admin' })
  })

  it('tenant isolation: the same entity id in another parish is not touched; an open subject is not touched', async () => {
    const org = await parish('iso_a'), other = await parish('iso_b')
    const s = await staff(org, 'iso', 'Synthetic Iso Subject')
    const open = await staff(org, 'iso_open', 'Synthetic Open Subject')
    await close(org, s)
    const foreign = await auditInsert(other.id, other.userId, String(s.id), `Created user: ${s.name}`, { name: s.name, email: s.email })
    expect(foreign).toMatchObject({ summary: `Created user: ${s.name}`, metadata: { name: s.name, email: s.email } })
    const live = await auditInsert(org.id, org.userId, String(open.id), `Updated user: ${open.name}`, { name: open.name })
    expect(live).toMatchObject({ summary: `Updated user: ${open.name}`, metadata: { name: open.name } })
  })
})

describe('closure review report (live receipt)', () => {
  it('counts arbitrary retained summary and metadata text and feedback as candidates; unknown scope is not zero', async () => {
    const org = await parish('report')
    const s = await staff(org, 'report', 'Synthetic Report Subject')
    // A feedback message written by the person before closure.
    await pool.query(`INSERT INTO ochr_feedback_ledger (organization_id, user_id, user_email, category, message, route) VALUES ($1, $2, $3, 'bug', 'Synthetic feedback text', '/team')`, [org.id, s.id, s.email])
    // Rows about the person: arbitrary summary shape, and a retained metadata key.
    await auditInsert(org.id, org.userId, String(s.id), 'Asked the subject to cover Sunday', {})
    await auditInsert(org.id, org.userId, String(s.id), 'Updated user', { note: 'retained detail' })
    const receipt = await close(org, s)
    const reviews = Object.fromEntries(receipt.reviews.map(r => [r.kind, r]))
    expect(reviews.audit_subject_text).toMatchObject({ row_count: 2, disposition: 'retained_for_review' })
    expect(reviews.feedback_text).toMatchObject({ row_count: 1, disposition: 'retained_for_review' })
    expect(reviews.unmapped_text).toMatchObject({ row_count: null, disposition: 'not_measured' })
    expect(receipt.review_remaining).toBe(true)
    expect(receipt.all_copies_erased).toBe(false)
    expect(receipt.review_refs.length).toBe(3)
    // The receipt re-measures on read.
    const read = await request(server).get(`/api/users/${s.id}/closure`).set(auth(org.token))
    expect(read.body.reviews.find(r => r.kind === 'audit_subject_text').row_count).toBe(2)
    expect(JSON.stringify(read.body)).not.toContain(s.email)
  })

  it('nothing measured still reports unmapped scope as unknown and review remaining', async () => {
    const org = await parish('report_clean')
    const s = await staff(org, 'report_clean')
    const receipt = await close(org, s)
    const reviews = Object.fromEntries(receipt.reviews.map(r => [r.kind, r]))
    expect(reviews.audit_subject_text).toMatchObject({ row_count: 0, disposition: 'none_found' })
    expect(reviews.feedback_text).toMatchObject({ row_count: 0, disposition: 'none_found' })
    expect(reviews.unmapped_text.row_count).toBeNull()
    expect(receipt.review_remaining).toBe(true)
  })
})

describe('late capability writes for a closed login', () => {
  it('a reset/invitation link or push subscription cannot be created; spending an old link still can be recorded', async () => {
    const org = await parish('late_cap')
    const s = await staff(org, 'late_cap')
    await close(org, s)
    await expect(pool.query(`INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`, [s.id, `late-${s.id}-${RUN_ID}`])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`INSERT INTO ochr_push_subscriptions (organization_id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, 'k', 'a')`, [org.id, s.id, `https://push.invalid/late/${s.id}/${RUN_ID}`])).rejects.toMatchObject({ code: '23514' })
    // A used (dead) link is allowed: recording that something was spent is not a capability.
    await pool.query(`INSERT INTO ochr_password_reset_tokens (user_id, token_hash, expires_at, used_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour', NOW())`, [s.id, `late-used-${s.id}-${RUN_ID}`])
    // The closure stays closed.
    await expect(pool.query('UPDATE ochr_users SET closed_at = NULL WHERE id = $1', [s.id])).rejects.toBeTruthy()
  })
})

describe('migrations 113/114: idempotent, complete trigger inventory', () => {
  it('running both again changes nothing and does not fail', async () => {
    const snapshot = async () => (await pool.query(
      `SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname LIKE 'ochr_%' ORDER BY 1, 2`)).rows
    const before = await snapshot()
    await up113(); await up114(); await up113(); await up114()
    expect(await snapshot()).toEqual(before)
  })

  it('every tenant base table except the audit log, closure receipts and billing event receipts carries the HOLD guard; views carry none', async () => {
    const { rows: missing } = await pool.query(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE'
          AND c.table_name LIKE 'ochr_%' AND c.table_name NOT IN ('ochr_audit_log', 'ochr_login_closures', 'ochr_billing_event_receipts')
          AND NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid
                           WHERE r.relname = c.table_name AND g.tgname = 'ochr_organization_hold_guard')`)
    expect(missing).toEqual([])
    const { rows: onViews } = await pool.query(
      `SELECT r.relname FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid WHERE g.tgname = 'ochr_organization_hold_guard' AND r.relkind <> 'r'`)
    expect(onViews).toEqual([])
    const { rows: [reset] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid WHERE r.relname = 'ochr_password_reset_tokens' AND g.tgname IN ('ochr_organization_hold_guard', 'ochr_closed_login_capability_guard')`)
    expect(reset.n).toBe(2)
  })
})

describe('HOLD preserves parish history; vault and cleanup', () => {
  it('register, giving, issued statements, check-ins, intentions and member names are unchanged by HOLD', async () => {
    const org = await parish('hold_history')
    const m = await request(server).post('/api/clients').set(auth(org.token)).send({ name: 'Synthetic Held Member', email: `held_member_${org.id}@example.com` })
    const id = m.body.id
    await pool.query(`INSERT INTO ochr_sacramental_records (organization_id, client_id, type, date, minister, place, member_name) VALUES ($1, $2, 'baptism', '2020-01-01', 'Synthetic Minister', 'Synthetic Chapel', 'Synthetic Held Member')`, [org.id, id])
    await pool.query(`INSERT INTO ochr_giving_statements (organization_id, tax_year, donor_key, donor_key_kind, statement_no, issue_key, status, snapshot_version, snapshot_json, issued_by, issued_by_name) VALUES ($1, 2026, $2, 'email', $3, $4, 'issued', 1, '{"donor":{"name":"Synthetic Held Member"}}'::jsonb, $5, 'Synthetic Admin')`, [org.id, `held_member_${org.id}@example.com`, `GS-HOLD-${org.id}-${RUN_ID}`, `hold-${org.id}-${RUN_ID}`, org.userId])
    const { rows: [ev] } = await pool.query(`INSERT INTO ochr_calendar_events (organization_id, title, date, start_time, end_time) VALUES ($1, 'Synthetic service', CURRENT_DATE, '09:00', '10:00') RETURNING id`, [org.id])
    await pool.query(`INSERT INTO ochr_checkins (organization_id, calendar_event_id, client_id, person_name) VALUES ($1, $2, $3, 'Synthetic Held Member')`, [org.id, ev.id, id])
    await pool.query(`INSERT INTO ochr_mass_intentions (organization_id, intention, requested_by, requested_by_client_id) VALUES ($1, 'Synthetic held intention', 'Synthetic Held Member', $2)`, [org.id, id])
    const tables = ['ochr_clients', 'ochr_sacramental_records', 'ochr_donations', 'ochr_giving_statements', 'ochr_checkins', 'ochr_mass_intentions', 'ochr_calendar_events']
    const fingerprint = async () => {
      const out = {}
      for (const t of tables) out[t] = (await pool.query(`SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h, COUNT(*)::int AS n FROM ${t} x WHERE organization_id = $1`, [org.id])).rows[0]
      out.member = (await pool.query('SELECT id, name, email FROM ochr_clients WHERE id = $1', [id])).rows[0]
      return out
    }
    const before = await fingerprint()
    expect((await holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true })).status).toBe(200)
    const after = await fingerprint()
    // Calendar/swap links on members are cleared by HOLD; everything else is identical.
    for (const t of tables.filter(t => t !== 'ochr_clients')) expect(after[t], t).toEqual(before[t])
    expect(after.ochr_clients.n).toBe(before.ochr_clients.n)
    expect(after.member).toEqual(before.member)
    expect((await pool.query('SELECT id FROM ochr_organizations WHERE id = $1', [org.id])).rows).toHaveLength(1)
  })

  it('vault restore cannot bring back a minimized member\'s contact data (409, not 500)', async () => {
    const org = await parish('vault')
    const m = await request(server).post('/api/clients').set(auth(org.token)).send({ name: 'Synthetic Vaulted', email: `vaulted_${org.id}@example.com`, phone: '5550101' })
    const id = m.body.id
    const del = await request(server).delete(`/api/clients/${id}`).set(auth(org.token))
    expect(del.status).toBeLessThan(300)
    const { rows: [entry] } = await pool.query('SELECT id FROM ochr_vault_entries WHERE organization_id = $1 ORDER BY id DESC LIMIT 1', [org.id])
    // Minimization recorded after the member was vaulted (marker survives removal by design).
    await pool.query('INSERT INTO ochr_profile_minimizations (organization_id, client_id) VALUES ($1, $2)', [org.id, id])
    const r = await request(server).post(`/api/vault/${entry.id}/restore`).set(auth(org.token))
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('minimized')
    expect((await pool.query('SELECT id FROM ochr_clients WHERE id = $1', [id])).rows).toHaveLength(0)
  })

  it('cascade cleanup still works for a held organization (test/admin cleanup path), and a non-held one', async () => {
    for (const held of [true, false]) {
      const org = await parish(`cleanup_${held}`)
      await request(server).post('/api/clients').set(auth(org.token)).send({ name: 'Synthetic Cleanup' })
      if (held) await holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true })
      await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [org.id])
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM ochr_clients WHERE organization_id = $1', [org.id])).rows[0].n).toBe(0)
    }
  })
})
