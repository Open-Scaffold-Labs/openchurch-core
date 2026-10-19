// Stage 6 — a held organization must not stop work for every other parish,
// must never be charged, and its cleanup must be repairable.
//
// Independent review (13 Oct) found background jobs that throw on the first
// held organization (scheduler reapers, retention), a recurring-gift run that
// charged a held parish with nowhere to record the gift, organization-row
// FOR UPDATE serializers that deadlock with the KEY SHARE admission lock, a
// HOLD whose cleanup failure left no record and no repair, a public form that
// still served a held parish, and audit copies of a minimized member's
// contact details. Each test here fails on that behaviour.
//
// Synthetic fixtures on the local database only.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { holdOrganization } from '../src/auth/organizationHold.js'
import { processDueNotifications } from '../src/notifications/scheduler.js'
import { pruneOldRecords } from '../src/services/retention.js'
import { chargeDueRecurringGifts } from '../src/services/recurringGifts.js'

let server
const orgIds = []
let sequence = 1
const auth = token => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => { await migrateOnce(); server = await bindServer() }, 60000)
afterAll(async () => {
  for (const id of orgIds) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server); await pool.end()
})
afterEach(() => { vi.restoreAllMocks() })

async function parish(tag) {
  const name = `HoldJobs ${tag} ${RUN_ID}`
  const email = `holdjobs_${tag}_${RUN_ID}@example.com`
  const res = await createOrg(server, { organizationName: name, name: 'Synthetic Admin', email, password: 'holdjobs-test-pw' }, `10.95.${sequence++}.1`)
  expect(res.status).toBe(201)
  const org = { id: res.body.user.organization.id, name, email, userId: res.body.user.id, token: res.body.token }
  orgIds.push(org.id)
  return org
}
const hold = org => holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true })

// FLAKE FIX (shared state): other files run the same global jobs
// (processDueNotifications, pruneOldRecords) against this database in
// parallel. A row inserted for the "held" parish BEFORE hold() was visible
// to them in the gap and could be pruned or claimed before the hold landed,
// which is not what these tests are about. Fixture rows for a held parish
// are therefore written AFTER the hold, in a transaction that carries the
// same marker HOLD's own revocation phase uses, so no other job ever sees
// them in an unheld parish. Same end state: a held parish that has them.
async function asHeld(org, sql, params) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query("SELECT set_config('ochr.hold_revocation_org', $1, true)", [String(org.id)])
    const r = await c.query(sql, params)
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

async function waitFor(fn, label) {
  for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 15)) }
  throw new Error(`timed out waiting: ${label}`)
}

describe('background jobs skip a held organization and keep going', () => {
  it('notification drainer: a held parish neither stops the reapers nor loses its queued rows', async () => {
    const held = await parish('sched_held'), live = await parish('sched_live')
    const insert = (org, status, attempts, aged, heldOrg = false) => (heldOrg ? (q, v) => asHeld(org, q, v) : (q, v) => pool.query(q, v))(
      `INSERT INTO ochr_scheduled_notifications (organization_id, recipient_email, notification_type, send_at, status, attempts, attempted_at)
       VALUES ($1, $2, 'event_reminder', NOW() - INTERVAL '1 minute', $3, $4, CASE WHEN $5 THEN NOW() - INTERVAL '1 hour' END) RETURNING id`,
      [org.id, `sched_${org.id}@example.com`, status, attempts, aged])
    expect((await hold(held)).status).toBe(200)
    const { rows: [stranded] } = await insert(held, 'processing', 5, true, true)
    const { rows: [reapable] } = await insert(held, 'processing', 1, true, true)
    const { rows: [queued] } = await insert(held, 'pending', 0, false, true)
    const { rows: [other] } = await insert(live, 'processing', 1, true)

    await expect(processDueNotifications({ batchSize: 500 })).resolves.toBeDefined()

    const { rows } = await pool.query('SELECT id, status, attempts FROM ochr_scheduled_notifications WHERE id = ANY($1::int[]) ORDER BY id', [[stranded.id, reapable.id, queued.id]])
    expect(rows.map(r => [r.status, r.attempts])).toEqual([['processing', 5], ['processing', 1], ['pending', 0]])
    // The other parish's stranded claim was reaped and handled.
    // A parallel file's drainer may have claimed it (SKIP LOCKED) and still be
    // mid-send when ours returns, so wait (bounded, 3s) for it to settle.
    const after = await waitFor(async () => {
      const { rows: [r] } = await pool.query('SELECT status FROM ochr_scheduled_notifications WHERE id = $1', [other.id])
      return r.status !== 'processing' && r
    }, 'live parish row handled')
    expect(after.status).not.toBe('processing')
  })

  it('retention: a held parish is skipped (history as it stood) and later parishes are still pruned', async () => {
    const held = await parish('ret_held'), live = await parish('ret_live')
    const sql = `INSERT INTO ochr_notification_log (organization_id, notification_type, status, created_at)
       VALUES ($1, 'synthetic', 'sent', NOW() - INTERVAL '800 days') RETURNING id`
    expect((await hold(held)).status).toBe(200)
    const { rows: [heldRow] } = await asHeld(held, sql, [held.id])
    const { rows: [liveRow] } = await pool.query(sql, [live.id])

    await expect(pruneOldRecords()).resolves.toBeDefined()

    expect((await pool.query('SELECT id FROM ochr_notification_log WHERE id = $1', [heldRow.id])).rows).toHaveLength(1)
    expect((await pool.query('SELECT id FROM ochr_notification_log WHERE id = $1', [liveRow.id])).rows).toHaveLength(0)
  })

  it('vault retention: one held parish with an expired entry does not stop pruning for the others', async () => {
    const held = await parish('vault_held'), live = await parish('vault_live')
    const sql = `INSERT INTO ochr_vault_entries (organization_id, kind, entity_table, entity_id, label, snapshot, retention_until)
       VALUES ($1, 'synthetic', 'ochr_clients', '1', 'Synthetic', '{}'::jsonb, CURRENT_DATE - 1) RETURNING id`
    expect((await hold(held)).status).toBe(200)
    const { rows: [heldEntry] } = await asHeld(held, sql, [held.id])
    const { rows: [liveEntry] } = await pool.query(sql, [live.id])
    const errors = vi.spyOn((await import('../src/monitoring/index.js')).monitor, 'error')

    const result = await pruneOldRecords()

    expect(errors.mock.calls.filter(([scope]) => scope === 'retention.vault')).toEqual([])
    // FLAKE FIX: vault_entries_pruned is a GLOBAL count. Other files run
    // pruneOldRecords() against the same database in parallel and can prune
    // this test's live entry first, leaving this call's count at 0. The
    // property is about THIS test's rows: the held parish's expired entry
    // stays, the live parish's is gone, and this run reported no vault error.
    expect(result).toHaveProperty('vault_entries_pruned')
    expect((await pool.query('SELECT id FROM ochr_vault_entries WHERE id = $1', [heldEntry.id])).rows).toHaveLength(1)
    expect((await pool.query('SELECT id FROM ochr_vault_entries WHERE id = $1', [liveEntry.id])).rows).toHaveLength(0)
  })

  it('recurring gifts: a held parish is never charged; other parishes are', async () => {
    const held = await parish('gift_held'), live = await parish('gift_live')
    const gift = (org, name) => pool.query(
      `INSERT INTO ochr_recurring_gifts (organization_id, donor_name, amount, frequency, next_charge_date)
       VALUES ($1, $2, 25, 'monthly', CURRENT_DATE - 1) RETURNING id, next_charge_date::text AS due`, [org.id, name])
    const { rows: [heldGift] } = await gift(held, `Held Donor ${RUN_ID}`)
    const { rows: [liveGift] } = await gift(live, `Live Donor ${RUN_ID}`)
    expect((await hold(held)).status).toBe(200)

    // The stub transport logs one line per charge it makes (reset PR6:
    // without donor name or amount), and each charge records a donation.
    const log = vi.spyOn(console, 'log')
    process.env.PAYMENTS_PROVIDER = 'stub'
    try {
      await chargeDueRecurringGifts()
    } finally { delete process.env.PAYMENTS_PROVIDER }
    const charges = log.mock.calls.map(c => String(c[0])).filter(line => line.startsWith('[pay:stub] charge'))
    expect(charges.some(line => line.includes('Donor'))).toBe(false)
    const { rows: [lg] } = await pool.query('SELECT last_charged_at FROM ochr_recurring_gifts WHERE id = $1', [liveGift.id])
    expect(lg.last_charged_at).not.toBeNull()
    expect((await pool.query("SELECT id FROM ochr_donations WHERE organization_id = $1 AND source = 'recurring'", [live.id])).rows).toHaveLength(1)

    // Not charged, nothing recorded, schedule untouched.
    const { rows: [h] } = await pool.query('SELECT next_charge_date::text AS due, failure_count, last_charged_at FROM ochr_recurring_gifts WHERE id = $1', [heldGift.id])
    expect(h).toEqual({ due: heldGift.due, failure_count: 0, last_charged_at: null })
    expect((await pool.query("SELECT id FROM ochr_donations WHERE organization_id = $1 AND source = 'recurring'", [held.id])).rows).toHaveLength(0)
    // The other parish was charged and recorded.
    const { rows: [l] } = await pool.query('SELECT next_charge_date::text AS due, last_charged_at FROM ochr_recurring_gifts WHERE id = $1', [liveGift.id])
    expect(l.due).not.toBe(liveGift.due)
    expect(l.last_charged_at).not.toBeNull()
    expect((await pool.query("SELECT id FROM ochr_donations WHERE organization_id = $1 AND source = 'recurring'", [live.id])).rows).toHaveLength(1)
  })

  it('recurring gifts: a HOLD placed while a gift is in flight waits for it to be recorded', async () => {
    // The run holds the admission lock from the hold check through the
    // donation insert and schedule advance. A barrier on the gift row stalls
    // the run after the insert; HOLD must queue behind it.
    const org = await parish('gift_race')
    const { rows: [g] } = await pool.query(
      `INSERT INTO ochr_recurring_gifts (organization_id, donor_name, amount, frequency, next_charge_date)
       VALUES ($1, $2, 30, 'monthly', CURRENT_DATE - 1) RETURNING id`, [org.id, `Race Donor ${RUN_ID}`])
    const barrier = await pool.connect()
    process.env.PAYMENTS_PROVIDER = 'stub'
    let run, holding
    try {
      await barrier.query('BEGIN')
      await barrier.query('SELECT 1 FROM ochr_recurring_gifts WHERE id = $1 FOR UPDATE', [g.id])
      run = chargeDueRecurringGifts()
      await waitFor(async () => (await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%UPDATE ochr_recurring_gifts%next_charge_date + %'`)).rows.length, 'run waiting on the gift row')
      holding = hold(org)
      await new Promise(r => setTimeout(r, 200))
      expect((await pool.query('SELECT held_at FROM ochr_organizations WHERE id = $1', [org.id])).rows[0].held_at).toBeNull()
      await barrier.query('COMMIT')
      await run
      expect((await holding).status).toBe(200)
    } finally {
      await barrier.query('ROLLBACK').catch(() => {}); barrier.release()
      delete process.env.PAYMENTS_PROVIDER; await run?.catch(() => {}); await holding?.catch(() => {})
    }
    expect((await pool.query("SELECT id FROM ochr_donations WHERE organization_id = $1 AND source = 'recurring'", [org.id])).rows).toHaveLength(1)
    expect((await pool.query('SELECT last_charged_at FROM ochr_recurring_gifts WHERE id = $1', [g.id])).rows[0].last_charged_at).not.toBeNull()
  })
})

describe('organization serializers do not deadlock with the admission lock', () => {
  it('only HOLD takes a lock on the organization row that conflicts with KEY SHARE', () => {
    // KEY SHARE conflicts with FOR UPDATE, with DELETE, and with an UPDATE of
    // a key column (id, slug: the non-partial unique indexes). Any SQL string that names ochr_organizations
    // and could take one of those is listed; the allowlist says why each is
    // safe. A new entry needs the same argument.
    const ALLOWED = {
      'auth/organizationHold.js': 'the HOLD itself; its locking phase holds only the organization row',
      'notifications/scheduler.js': 'FOR UPDATE SKIP LOCKED locks queue rows; the organization appears only inside EXISTS',
    }
    const root = path.resolve(import.meta.dirname, '../src')
    const found = new Set()
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== 'migrations') walk(file); continue }
        if (!file.endsWith('.js')) continue
        const code = fs.readFileSync(file, 'utf8')
        for (const [literal] of code.matchAll(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g)) {
          const sql = literal.replace(/--[^\n]*/g, '')
          if (!/\bochr_organizations\b/i.test(sql)) continue
          const strong = /\bFOR\s+UPDATE\b/i.test(sql)
            || /\bDELETE\s+FROM\s+ochr_organizations\b/i.test(sql)
            // Only the SET list counts: "WHERE id = $1" is not a key update.
            || /\b(id|slug)\s*=/i.test(sql.match(/\bUPDATE\s+ochr_organizations\s+SET\b((?:(?!\bWHERE\b)[\s\S])*)/i)?.[1] ?? '')
          if (strong) found.add(path.relative(root, file))
        }
      }
    }
    walk(root)
    expect([...found].sort()).toEqual(Object.keys(ALLOWED).sort())
  })

  it('invoice numbering proceeds while another transaction holds the admission lock', async () => {
    const org = await parish('invoice')
    const draft = await request(server).post('/api/invoices').set(auth(org.token))
      .send({ title: `Hall ${RUN_ID}`, category: 'facility', payer_name: 'Synthetic Group', lines: [{ description: 'Hall', unit_amount: 100 }] })
    expect(draft.status).toBe(201)
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('SELECT 1 FROM ochr_organizations WHERE id = $1 FOR KEY SHARE', [org.id])
      const issued = await Promise.race([
        request(server).post(`/api/invoices/${draft.body.id}/issue`).set(auth(org.token)).then(r => r.status),
        new Promise(r => setTimeout(() => r('blocked'), 3000)),
      ])
      expect(issued).toBe(200)
    } finally {
      await writer.query('ROLLBACK').catch(() => {}); writer.release()
    }
  })
})

describe('HOLD does not wait forever behind a slow writer', () => {
  it('gives up with 503 and changes nothing when admission is held past its lock timeout', async () => {
    const org = await parish('locktimeout')
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('SELECT 1 FROM ochr_organizations WHERE id = $1 FOR KEY SHARE', [org.id])
      const result = await holdOrganization({ organizationId: org.id, actorId: org.userId, confirm: org.name, acknowledgeExportWarning: true, lockTimeout: '200ms' })
      expect(result.status).toBe(503)
    } finally { await writer.query('ROLLBACK').catch(() => {}); writer.release() }
    expect((await pool.query('SELECT held_at FROM ochr_organizations WHERE id = $1', [org.id])).rows[0].held_at).toBeNull()
    expect((await hold(org)).status).toBe(200)
  })
})

describe('HOLD cleanup failure is recorded and repairable', () => {
  it('reports revocation_complete:false, marks the audit row incomplete, and the operator re-run completes it', async () => {
    const org = await parish('cleanup')
    const operator = await parish('operator')
    await pool.query(
      `INSERT INTO ochr_push_subscriptions (organization_id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, 'k', 'a')`,
      [org.id, org.userId, `https://push.invalid/${org.id}`])

    // Fail the push-capability step of every revocation attempt.
    const connect = pool.connect.bind(pool)
    vi.spyOn(pool, 'connect').mockImplementation(async (...cb) => {
      // pool.query() uses the callback form internally; leave it alone.
      if (cb.length) return connect(...cb)
      const client = await connect()
      const query = client.query.bind(client)
      client.query = (sql, ...rest) => {
        if (typeof sql === 'string' && sql.startsWith('DELETE FROM ochr_push_subscriptions') && rest[0]?.[0] === org.id) {
          return Promise.reject(new Error('synthetic revocation failure'))
        }
        return query(sql, ...rest)
      }
      const release = client.release.bind(client)
      client.release = (...a) => { client.query = query; return release(...a) }
      return client
    })
    const res = await request(server).post('/api/organization/hold').set(auth(org.token)).send({ confirm: org.name, acknowledge_export_warning: true })
    vi.restoreAllMocks()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ held: true, revocation_complete: false, organization_deleted: false })
    // Access is refused anyway: the hold is committed.
    expect((await request(server).get('/api/organization').set(auth(org.token))).status).not.toBe(200)
    const audit = await waitFor(async () => (await pool.query(
      "SELECT summary, metadata FROM ochr_audit_log WHERE organization_id = $1 AND action = 'hold'", [org.id])).rows[0], 'hold audit row')
    expect(audit.metadata).toMatchObject({ cleanup_complete: false })
    expect(audit.summary).toMatch(/incomplete/)
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM ochr_push_subscriptions WHERE organization_id = $1', [org.id])).rows[0].n).toBe(1)

    const prior = process.env.SUPER_ADMIN_USER_IDS
    process.env.SUPER_ADMIN_USER_IDS = String(operator.userId ?? operator.id) // F-01: by id only
    try {
      const notHeld = await request(server).post(`/api/admin/maintenance/organizations/${operator.id}/hold-revocation`).set(auth(operator.token))
      expect(notHeld.status).toBe(409)
      const missing = await request(server).post('/api/admin/maintenance/organizations/2147483000/hold-revocation').set(auth(operator.token))
      expect(missing.status).toBe(404)
      // A parish admin who is not the operator cannot run it.
      const other = await parish('notoperator')
      expect((await request(server).post(`/api/admin/maintenance/organizations/${org.id}/hold-revocation`).set(auth(other.token))).status).not.toBe(200)
      const repaired = await request(server).post(`/api/admin/maintenance/organizations/${org.id}/hold-revocation`).set(auth(operator.token))
      expect(repaired.status).toBe(200)
      expect(repaired.body).toEqual({ held: true, revocation_complete: true })
      // The completion is a new audit row; the incomplete one is not rewritten.
      const { rows: trail } = await pool.query(
        "SELECT metadata FROM ochr_audit_log WHERE organization_id = $1 AND action = 'hold' ORDER BY id", [org.id])
      expect(trail.map(r => r.metadata)).toEqual([
        expect.objectContaining({ cleanup_complete: false }),
        { already: true, cleanup_complete: true, via: 'operator' },
      ])
    } finally {
      if (prior === undefined) delete process.env.SUPER_ADMIN_USER_IDS; else process.env.SUPER_ADMIN_USER_IDS = prior
    }
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM ochr_push_subscriptions WHERE organization_id = $1', [org.id])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM ochr_users WHERE organization_id = $1 AND deactivated_at IS NULL', [org.id])).rows[0].n).toBe(0)
  })
})

describe('public surfaces of a held parish', () => {
  it('a published form is no longer served or accepted', async () => {
    const org = await parish('form')
    const form = await request(server).post('/api/forms').set(auth(org.token)).send({
      title: `Held Form ${RUN_ID}`, is_public: true, status: 'open',
      fields: [{ id: 'name', type: 'short_text', label: 'Name', required: true }],
    })
    expect(form.status).toBe(201)
    const { rows: [{ slug }] } = await pool.query('SELECT slug FROM ochr_organizations WHERE id = $1', [org.id])
    expect((await request(server).get(`/api/public/forms/${slug}/${form.body.slug}`)).status).toBe(200)
    expect((await hold(org)).status).toBe(200)
    expect((await request(server).get(`/api/public/forms/${slug}/${form.body.slug}`)).status).toBe(404)
    const submit = await request(server).post(`/api/public/forms/${slug}/${form.body.slug}/submit`).send({ answers: { name: 'Synthetic' } })
    expect(submit.status).toBe(404)
  })
})

describe('minimization reaches audit copies of contact details', () => {
  const confirmation = { confirm: 'DEIDENTIFY', acknowledge_history_retained: true }
  it('strips contact keys from audit rows about the member, keeps the name, and strips late rows too', async () => {
    const org = await parish('auditcopy'), other = await parish('auditother')
    const make = async o => {
      const r = await request(server).post('/api/clients').set(auth(o.token)).send({ name: 'Synthetic Person', email: `copy_${o.id}@example.com`, phone: '5550100', notes: 'Synthetic note' })
      expect(r.status).toBe(201); return r.body.id
    }
    const id = await make(org)
    const otherId = await make(other)
    const rowsFor = (o, cid) => pool.query("SELECT metadata FROM ochr_audit_log WHERE organization_id = $1 AND entity_type = 'client' AND entity_id = $2", [o.id, String(cid)])
    await waitFor(async () => (await rowsFor(org, id)).rows.some(r => r.metadata?.email), 'create audit row with email')
    await waitFor(async () => (await rowsFor(other, otherId)).rows.some(r => r.metadata?.email), 'other tenant audit row')

    const res = await request(server).post(`/api/clients/${id}/deidentify`).set(auth(org.token)).send(confirmation)
    expect(res.status).toBe(200)
    expect(res.body.audit_contact_copies_minimized).toBeGreaterThanOrEqual(1)
    expect(res.body.vault_snapshots_retained).toBe(0)
    expect(res.body.other_audit_copies).toBe('not_measured')
    for (const { metadata } of (await rowsFor(org, id)).rows) {
      for (const key of ['email', 'phone', 'notes', 'avatar', 'birth_date']) expect(metadata ?? {}).not.toHaveProperty(key)
    }
    expect((await rowsFor(org, id)).rows.some(r => r.metadata?.name === 'Synthetic Person')).toBe(true)
    // Another parish's member with the same numeric shape is untouched.
    expect((await rowsFor(other, otherId)).rows.some(r => r.metadata?.email)).toBe(true)

    // A late or rewritten audit row about the member, zero-padded id included.
    const { rows: [late] } = await pool.query(
      `INSERT INTO ochr_audit_log (organization_id, action, entity_type, entity_id, summary, metadata)
       VALUES ($1, 'update', 'client', $2, 'late', $3::jsonb) RETURNING metadata`,
      [org.id, `00${id}`, JSON.stringify({ name: 'Synthetic Person', email: 'late@example.com', phone: '1' })])
    expect(late.metadata).toEqual({ name: 'Synthetic Person' })
  })
})

describe('tables outside the hold guard are named, not assumed', () => {
  // These ochr_ tables carry no organization_id, so migration 114 attaches no
  // generic hold guard to them. Parish-side ones (payroll shifts by staff,
  // notification prefs by user) are reached only through authenticated
  // routes, which refuse a held parish's sessions. Diocese-side ones
  // (diocese_org_id / parish_org_id) are written by the chancery, which keeps
  // access to a held parish's diocesan record — a documented limitation.
  // Reset tokens have their own guard. A new table must be added here
  // deliberately, with a decision about its guard.
  const UNGUARDED = [
    'ochr_assessment_lines', 'ochr_assessments', 'ochr_diocese_affiliations', 'ochr_diocese_regions',
    'ochr_email_suppressions', 'ochr_liturgical_calendar', 'ochr_notification_prefs', 'ochr_organizations',
    'ochr_parish_care_briefs', 'ochr_parish_followups', 'ochr_parish_timeline', 'ochr_parish_transitions',
    'ochr_password_reset_tokens', 'ochr_payroll_shifts',
    // Stage 7 platform-wide AI stop (one row, operator-controlled), not tenant data
    'ochr_platform_ai_switch', 'ochr_platform_ai_switch_events',
    'ochr_release_log', 'ochr_report_review_notes',
    'ochr_schema_migrations',
  ]
  it('records the exact set of ochr_ base tables without organization_id', async () => {
    const { rows } = await pool.query(
      `SELECT t.table_name FROM information_schema.tables t
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND t.table_name LIKE 'ochr\\_%'
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                           WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'organization_id')
        ORDER BY 1`)
    expect(rows.map(r => r.table_name)).toEqual(UNGUARDED)
  })
})
