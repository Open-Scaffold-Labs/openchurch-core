// SP-266 / SP-267 / SP-269 / SP-270 — Mass stipend follow-up.
// SP-268 Release deferred (José 2026-10-28 3:44 PM PT).
// José 2026-10-28 1:37 PM PT (money OK). Real Postgres on 553xx. Synthetic tenants only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import {
  PAYMENT_METHODS,
  RECEIVED_DATE_REQUIRED,
  stipendEffectiveDate,
} from '../src/finance/stipends.js'
import { orgTodayIso } from '../src/utils/sheetWeek.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATION = join(HERE, '../src/migrations/139-mass-stipend-followup.js')
const PW = 'sp266-pw'
let server, A, B, staff
let ipSeq = 1
const nextIp = () => `10.139.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const cleanup = []
const today = () => new Date().toISOString().slice(0, 10)

async function signup(tag) {
  const email = `sp266_${tag}_${RUN_ID}@example.com`
  const r = await createOrg(server, {
    organizationName: `SP266 ${tag} ${RUN_ID}`, name: `Admin ${tag}`,
    email, password: PW,
  }, nextIp())
  expect(r.status).toBe(201)
  cleanup.push(r.body.user.organization.id)
  return { id: r.body.user.organization.id, userId: r.body.user.id, token: r.body.token }
}
async function addUser(org, role, name, tag) {
  const email = `sp266_${tag}_${RUN_ID}@example.com`
  const c = await request(server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', nextIp())
    .send({ name, email, password: PW, role })
  expect(c.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PW })
  expect(l.status).toBe(200)
  return { id: l.body.user.id, token: l.body.token }
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  A = await signup('a')
  B = await signup('b')
  staff = await addUser(A, 'staff', 'Staff One', 's1')
}, 90_000)

afterAll(async () => {
  for (const id of cleanup) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

async function makeIntention(token, body) {
  return request(server).post('/api/mass-intentions').set(auth(token))
    .send({ intention: `† SP266 ${RUN_ID} ${Math.random().toString(36).slice(2, 6)}`, requested_by: 'Synthetic', ...body })
}

describe('139 migration', () => {
  it('is tip, transactional, and idempotent column adds', async () => {
    const { EXPECTED_MIGRATION, MIGRATION_NAMES } = await import('../src/migrations/names.js')
    expect(EXPECTED_MIGRATION).toBe('144-online-giving-clearing')
    expect(MIGRATION_NAMES).toContain('139-mass-stipend-followup')
    expect(MIGRATION_NAMES.at(-1)).toBe('144-online-giving-clearing')
    const src = readFileSync(MIGRATION, 'utf8')
    expect(src).toMatch(/BEGIN ISOLATION LEVEL REPEATABLE READ/)
    expect(src).toMatch(/SET LOCAL lock_timeout/)
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS received_date/)
    expect(src).toMatch(/payment_method/)
    const { up } = await import('../src/migrations/139-mass-stipend-followup.js')
    await up(); await up()
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ochr_mass_intentions'
          AND column_name IN ('received_date', 'payment_method')
        ORDER BY column_name`)
    expect(cols.rows.map(r => r.column_name)).toEqual(['payment_method', 'received_date'])
  })
})

describe('SP-266 received date books cash-in day', () => {
  it('books effective_date on received_date, not Mass date', async () => {
    const made = await makeIntention(A.token, {
      stipend: '10.00',
      mass_date: '2026-11-01',
      received_date: '2026-10-28',
      payment_method: 'cash',
    })
    expect(made.status).toBe(201)
    expect(made.body.received_date).toBe('2026-10-28')
    expect(made.body.payment_method).toBe('cash')
    const facts = await pool.query(
      `SELECT kind, amount::text AS amount, effective_date::text AS d
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(facts.rows).toEqual([
      expect.objectContaining({ kind: 'recorded', amount: '10.00', d: '2026-10-28' }),
    ])
  })

  it('omitted received_date defaults to today; explicit empty refuses', async () => {
    const omit = await makeIntention(A.token, { stipend: '5.00', mass_date: '2026-11-02' })
    expect(omit.status).toBe(201)
    expect(omit.body.received_date).toBe(today())
    expect(omit.body.payment_method).toBe('cash')
    const facts = await pool.query(
      `SELECT effective_date::text AS d FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, omit.body.id])
    expect(facts.rows[0].d).toBe(today())

    const empty = await makeIntention(A.token, {
      stipend: '5.00', mass_date: '2026-11-03', received_date: '', payment_method: 'cash',
    })
    expect(empty.status).toBe(RECEIVED_DATE_REQUIRED.status)
    expect(empty.body.code).toBe(RECEIVED_DATE_REQUIRED.body.code)
  })

  it('refuses invalid payment method; accepts listed methods', async () => {
    const bad = await makeIntention(A.token, {
      stipend: '3.00', mass_date: '2026-11-04', received_date: '2026-10-28', payment_method: 'venmo',
    })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('payment_method_invalid')
    for (const m of PAYMENT_METHODS) {
      const ok = await makeIntention(A.token, {
        stipend: '1.00', mass_date: '2026-11-05', received_date: '2026-10-27', payment_method: m,
      })
      expect(ok.status).toBe(201)
      expect(ok.body.payment_method).toBe(m)
    }
  })

  it('stipendEffectiveDate prefers received over Mass', () => {
    expect(stipendEffectiveDate({ receivedDate: '2026-10-28', massDate: '2026-11-01' })).toBe('2026-10-28')
    expect(stipendEffectiveDate({ massDate: '2026-11-01', today: '2026-10-01' })).toBe('2026-11-01')
    expect(stipendEffectiveDate({ today: '2026-10-01' })).toBe('2026-10-01')
  })

  // N449-1 red/green: evening America/Los_Angeles must not slip to the next UTC day.
  it('stipendEffectiveDate uses orgTodayIso for evening America/Los_Angeles', () => {
    // 2026-10-28 17:30 PDT = 2026-10-29 00:30 UTC — UTC day is already the 29th.
    const eveningLa = new Date('2026-10-28T17:30:00-07:00')
    expect(eveningLa.toISOString().slice(0, 10)).toBe('2026-10-29')
    expect(orgTodayIso(eveningLa, 'America/Los_Angeles')).toBe('2026-10-28')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(eveningLa)
      expect(stipendEffectiveDate({ timeZone: 'America/Los_Angeles' })).toBe('2026-10-28')
      expect(stipendEffectiveDate({})).toBe('2026-10-29') // no zone → usableTimeZone → UTC
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SP-268 Release deferred (José 2026-10-28 3:44 PM PT)', () => {
  it('POST /release is not mounted; fulfilled stipend stays held in 2330', async () => {
    const made = await makeIntention(A.token, {
      stipend: '12.00', mass_date: '2026-10-01', received_date: '2026-09-28', payment_method: 'check',
    })
    expect(made.status).toBe(201)
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET status = 'fulfilled',
              fulfilled_mass_date = '2026-10-01',
              fulfilled_mass_title = 'Test Mass',
              fulfilled_mass_time = '10:00:00',
              entered_history = true
        WHERE id = $1 AND organization_id = $2`,
      [made.body.id, A.id])
    const gone = await request(server).post(`/api/mass-intentions/${made.body.id}/release`)
      .set(auth(A.token)).send({ reason: 'Remit to celebrant' })
    // Express falls through to the generic 404 (or method-not-allowed) — not a stipend clear.
    expect([404, 405]).toContain(gone.status)
    const open = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END), 0)::text AS open
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(open.rows[0].open).toBe('12.00')
  })

  // N449-3 / Ledger: voiding fulfilled + open 2330 would clear liability with
  // pastor_applied and no remittance counter-account — Release by another door.
  it('refuses void of fulfilled intention with open 2330 (N449-3)', async () => {
    const made = await makeIntention(A.token, {
      stipend: '15.00', mass_date: '2026-10-02', received_date: '2026-09-29', payment_method: 'cash',
    })
    expect(made.status).toBe(201)
    const other = await makeIntention(A.token, {
      stipend: null, mass_date: '2026-11-20',
    })
    expect(other.status).toBe(201)
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET status = 'fulfilled',
              fulfilled_mass_date = '2026-10-02',
              fulfilled_mass_title = 'Test Mass',
              fulfilled_mass_time = '09:00:00',
              entered_history = true
        WHERE id = $1 AND organization_id = $2`,
      [made.body.id, A.id])
    const attempts = [
      { kind: 'pastor_applied', reason: 'Remit to celebrant' },
      { kind: 'refunded', reason: 'Cash returned' },
      { kind: 'transferred', reason: 'Move held stipend', transfer_to_intention_id: other.body.id },
    ]
    for (const disposition of attempts) {
      const refused = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
        .set(auth(A.token)).send({ reason: 'Erroneous fulfilled entry', disposition })
      expect(refused.status).toBe(409)
      expect(refused.body.code).toBe('void_fulfilled_held')
      expect(refused.body.error).toMatch(/fulfilled Mass intention with a held stipend cannot be voided yet/i)
    }
    const still = await pool.query(
      `SELECT voided_at, status,
              (SELECT COALESCE(SUM(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END), 0)::text
                 FROM ochr_mass_stipend_facts
                WHERE organization_id = $2 AND mass_intention_id = $1) AS open
         FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2`,
      [made.body.id, A.id])
    expect(still.rows[0].voided_at).toBeNull()
    expect(still.rows[0].status).toBe('fulfilled')
    expect(still.rows[0].open).toBe('15.00')
  })

  it('still voids an open intention with disposition (control)', async () => {
    const made = await makeIntention(A.token, {
      stipend: '7.00', mass_date: '2026-11-10', received_date: '2026-10-28', payment_method: 'check',
    })
    expect(made.status).toBe(201)
    const voided = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token)).send({
        reason: 'Duplicate before Mass',
        disposition: { kind: 'refunded', reason: 'Cash returned at the office' },
      })
    expect(voided.status).toBe(200)
    const row = await pool.query(
      `SELECT voided_at FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2`,
      [made.body.id, A.id])
    expect(row.rows[0].voided_at).not.toBeNull()
  })
})

describe('SP-267 void disposition keeps history', () => {
  it('void with refund clears liability and leaves the row (no delete)', async () => {
    const made = await makeIntention(A.token, {
      stipend: '9.00', mass_date: '2026-10-05', received_date: '2026-10-04', payment_method: 'cash',
    })
    expect(made.status).toBe(201)
    const refused = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token)).send({ reason: 'Duplicate walk-in' })
    expect(refused.status).toBe(400)
    expect(refused.body.code).toBe('stipend_disposition_required')

    const voided = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token)).send({
        reason: 'Duplicate walk-in',
        disposition: { kind: 'refunded', reason: 'Cash returned at the office' },
      })
    expect(voided.status).toBe(200)
    const row = await pool.query(
      `SELECT voided_at, void_reason, status, stipend::text AS stipend
         FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2`,
      [made.body.id, A.id])
    expect(row.rows[0].voided_at).not.toBeNull()
    expect(row.rows[0].void_reason).toBe('Duplicate walk-in')
    expect(row.rows[0].status).toBe('cancelled')
    expect(row.rows[0].stipend).toBe('9.00')
    const open = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END), 0)::text AS open
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(open.rows[0].open).toBe('0.00')
  })
})

describe('SP-269 / finance source label + Staff RBAC', () => {
  it('finance source key remains mass_stipend and Staff stay out of Finance', async () => {
    const made = await makeIntention(A.token, {
      stipend: '2.00', mass_date: '2026-10-06', received_date: '2026-10-06', payment_method: 'card',
    })
    expect(made.status).toBe(201)
    const line = await pool.query(
      `SELECT source_type FROM ochr_parish_ledger
        WHERE organization_id = $1 AND source_type = 'mass_stipend'
        LIMIT 1`, [A.id])
    expect(line.rows[0]?.source_type).toBe('mass_stipend')
    const staffFin = await request(server).get('/api/finance/summary')
      .set(auth(staff.token)).query({ period: '2026-10' })
    expect(staffFin.status).toBe(403)
  })
})


describe('N449 org-local today (evening America/Los_Angeles)', () => {
  // Instant where UTC has already rolled to the 29th while LA is still the 28th.
  const EVENING_LA = new Date('2026-10-28T17:30:00-07:00')
  const LA_DAY = '2026-10-28'
  const UTC_DAY = '2026-10-29'
  const MASS_DAY = '2026-11-15'

  async function laOrg() {
    const email = `sp266_la_${RUN_ID}_${Math.random().toString(36).slice(2, 6)}@example.com`
    const r = await createOrg(server, {
      organizationName: `SP266 LA ${RUN_ID} ${Math.random().toString(36).slice(2, 5)}`,
      name: 'Admin LA',
      email,
      password: PW,
      timezone: 'America/Los_Angeles',
    }, nextIp())
    expect(r.status).toBe(201)
    const orgId = r.body.user.organization.id
    cleanup.push(orgId)
    const tz = await pool.query('SELECT timezone FROM ochr_organizations WHERE id = $1', [orgId])
    expect(tz.rows[0].timezone).toBe('America/Los_Angeles')
    return { id: orgId, userId: r.body.user.id, token: r.body.token }
  }

  it('omitted received_date defaults to parish civil day, not UTC', async () => {
    const org = await laOrg()
    expect(EVENING_LA.toISOString().slice(0, 10)).toBe(UTC_DAY)
    expect(orgTodayIso(EVENING_LA, 'America/Los_Angeles')).toBe(LA_DAY)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(EVENING_LA)
      const made = await makeIntention(org.token, {
        stipend: '8.00',
        mass_date: MASS_DAY,
        // received_date omitted on purpose
      })
      expect(made.status, JSON.stringify(made.body)).toBe(201)
      expect(made.body.received_date).toBe(LA_DAY)
      expect(made.body.received_date).not.toBe(UTC_DAY)
      const facts = await pool.query(
        `SELECT effective_date::text AS d FROM ochr_mass_stipend_facts
          WHERE organization_id = $1 AND mass_intention_id = $2 AND kind = 'recorded'`,
        [org.id, made.body.id])
      expect(facts.rows[0].d).toBe(LA_DAY)
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('disposition-only clearing uses action day, not Mass day (N449-2)', async () => {
    const org = await laOrg()
    // Book while wall-clock is normal; liability recorded on received_date.
    const made = await makeIntention(org.token, {
      stipend: '11.00',
      mass_date: MASS_DAY,
      received_date: '2026-10-20',
      payment_method: 'cash',
    })
    expect(made.status).toBe(201)
    // Legacy-style void without disposition (row cancelled; liability still open).
    // D449-4: /disposition recovers "was fulfilled" from the void correction.
    // A real void always wrote one; missing correction fails closed. Seed the
    // correction with before.status=open so this regression stays a non-fulfilled case.
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET status = 'cancelled', voided_at = '2026-10-20T15:00:00Z',
              void_reason = 'legacy hold', voided_by = $1
        WHERE id = $2 AND organization_id = $3`,
      [org.userId, made.body.id, org.id])
    await pool.query(
      `INSERT INTO ochr_mass_intention_corrections
         (organization_id, mass_intention_id, actor_user_id, kind, reason, before, after)
       VALUES ($1, $2, $3, 'void', $4, $5, $6)`,
      [org.id, made.body.id, org.userId, 'legacy hold',
       JSON.stringify({ status: 'open', voided: false }),
       JSON.stringify({ status: 'cancelled', voided: true, disposition: null })])

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(EVENING_LA)
      const disp = await request(server).post(`/api/mass-intentions/${made.body.id}/disposition`)
        .set(auth(org.token))
        .send({ disposition: { kind: 'refunded', reason: 'Cash returned (N449 evening LA)' } })
      expect(disp.status, JSON.stringify(disp.body)).toBe(200)
      expect(disp.body.open_liability).toBe('0.00')
      const clears = await pool.query(
        `SELECT kind, effective_date::text AS d FROM ochr_mass_stipend_facts
          WHERE organization_id = $1 AND mass_intention_id = $2
            AND kind IN ('refunded', 'transferred', 'pastor_applied')
          ORDER BY id`,
        [org.id, made.body.id])
      expect(clears.rows.length).toBeGreaterThan(0)
      for (const row of clears.rows) {
        expect(row.d, JSON.stringify(row)).toBe(LA_DAY)
        expect(row.d).not.toBe(MASS_DAY)
        expect(row.d).not.toBe(UTC_DAY)
      }
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)
})
