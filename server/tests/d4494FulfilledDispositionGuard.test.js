// D449-4 — fulfilled intentions must not take a disposition (Ledger 2026-10-29).
// Rule: a disposition is only for an intention whose Mass was NOT said.
// "Was fulfilled" after void = latest void correction before.status === 'fulfilled'.
// No migration. Existing rows untouched. Real Postgres on 553xx. Synthetic tenants only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const DISPOSITION_FULFILLED_CODE = 'disposition_fulfilled'
const REFUSE_DISPOSITION_FULFILLED =
  'This Mass was already offered, so its stipend can\'t be refunded, transferred, or applied elsewhere. Nothing was changed.'
const VOID_FULFILLED_HELD_CODE = 'void_fulfilled_held'

const PW = 'd4494-pw'
let server, A
let ipSeq = 1
const nextIp = () => `10.149.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const cleanup = []

async function signup(tag) {
  const email = `d4494_${tag}_${RUN_ID}@example.com`
  const r = await createOrg(server, {
    organizationName: `D4494 ${tag} ${RUN_ID}`, name: `Admin ${tag}`,
    email, password: PW,
  }, nextIp())
  expect(r.status).toBe(201)
  cleanup.push(r.body.user.organization.id)
  return { id: r.body.user.organization.id, userId: r.body.user.id, token: r.body.token }
}

async function makeIntention(token, body) {
  return request(server).post('/api/mass-intentions').set(auth(token))
    .send({
      intention: `† D4494 ${RUN_ID} ${Math.random().toString(36).slice(2, 6)}`,
      requested_by: 'Synthetic',
      ...body,
    })
}

async function markFulfilled(orgId, id, massDate = '2026-10-02') {
  await pool.query(
    `UPDATE ochr_mass_intentions
        SET status = 'fulfilled',
            fulfilled_mass_date = $3,
            fulfilled_mass_title = 'Test Mass',
            fulfilled_mass_time = '09:00:00',
            entered_history = true
      WHERE id = $1 AND organization_id = $2`,
    [id, orgId, massDate])
}

/** Bring open 2330 to 0 by appending an adjusted fact (append-only; no DELETE). */
async function clearOpenLiability(orgId, id) {
  const open = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END), 0)::numeric AS open
       FROM ochr_mass_stipend_facts
      WHERE organization_id = $1 AND mass_intention_id = $2`,
    [orgId, id])
  const amt = Number(open.rows[0].open)
  if (!(amt > 0)) return
  const n = await pool.query(
    `SELECT count(*)::int AS n FROM ochr_mass_stipend_facts
      WHERE organization_id = $1 AND mass_intention_id = $2`,
    [orgId, id])
  const seq = n.rows[0].n
  await pool.query(
    `INSERT INTO ochr_mass_stipend_facts
       (organization_id, mass_intention_id, kind, amount, effective_date,
        reason, idempotency_key)
     VALUES ($1, $2, 'adjusted', $3, '2026-10-01'::date,
             'D449-4 test clear open liability', $4)`,
    [orgId, id, amt.toFixed(2),
     `adjusted:d4494:${id}:${seq}:${amt.toFixed(2)}->0.00`])
}

async function countCorrections(orgId, id) {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM ochr_mass_intention_corrections
      WHERE organization_id = $1 AND mass_intention_id = $2`,
    [orgId, id])
  return r.rows[0].n
}

async function countLegacySeeds(orgId, id) {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM ochr_mass_stipend_facts
      WHERE organization_id = $1 AND mass_intention_id = $2
        AND idempotency_key = $3`,
    [orgId, id, `recorded:legacy:${id}`])
  return r.rows[0].n
}

async function countClearingFacts(orgId, id) {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM ochr_mass_stipend_facts
      WHERE organization_id = $1 AND mass_intention_id = $2
        AND kind IN ('refunded', 'transferred', 'pastor_applied')`,
    [orgId, id])
  return r.rows[0].n
}

async function rowState(orgId, id) {
  const r = await pool.query(
    `SELECT status, voided_at, offering_recorded, stipend::text AS stipend
       FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2`,
    [id, orgId])
  return r.rows[0]
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  A = await signup('a')
}, 90_000)

afterAll(async () => {
  for (const id of cleanup) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

describe('D449-4 fulfilled disposition guard', () => {
  // 1. fulfilled, open 0, void with pastor_applied → 409; nothing changed
  it('1: refuses void+disposition on fulfilled open-0 (disposition_fulfilled)', async () => {
    const made = await makeIntention(A.token, {
      stipend: '10.00', mass_date: '2026-10-02',
      received_date: '2026-09-28', payment_method: 'cash',
    })
    expect(made.status).toBe(201)
    await clearOpenLiability(A.id, made.body.id)
    await markFulfilled(A.id, made.body.id)
    const beforeCorr = await countCorrections(A.id, made.body.id)
    const beforeClearing = await countClearingFacts(A.id, made.body.id)

    const refused = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token))
      .send({
        reason: 'Erroneous fulfilled entry',
        disposition: { kind: 'pastor_applied', reason: 'Remit to celebrant' },
      })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe(DISPOSITION_FULFILLED_CODE)
    expect(refused.body.error).toBe(REFUSE_DISPOSITION_FULFILLED)

    const row = await rowState(A.id, made.body.id)
    expect(row.status).toBe('fulfilled')
    expect(row.voided_at).toBeNull()
    expect(await countCorrections(A.id, made.body.id)).toBe(beforeCorr)
    expect(await countClearingFacts(A.id, made.body.id)).toBe(beforeClearing)
  })

  // 2. fulfilled → void (no disposition) → 200; then /disposition → 409; no legacy seed
  it('2: void without disposition allowed; later /disposition refuses; no legacy seed', async () => {
    const made = await makeIntention(A.token, {
      stipend: '12.00', mass_date: '2026-10-03',
      received_date: '2026-09-29', payment_method: 'cash',
    })
    expect(made.status).toBe(201)
    await clearOpenLiability(A.id, made.body.id)
    await markFulfilled(A.id, made.body.id)

    const voided = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token))
      .send({ reason: 'Duplicate fulfilled entry' })
    expect(voided.status, JSON.stringify(voided.body)).toBe(200)
    const afterVoid = await rowState(A.id, made.body.id)
    expect(afterVoid.status).toBe('cancelled')
    expect(afterVoid.voided_at).not.toBeNull()
    expect(afterVoid.offering_recorded).toBe(true)

    const disp = await request(server).post(`/api/mass-intentions/${made.body.id}/disposition`)
      .set(auth(A.token))
      .send({ disposition: { kind: 'pastor_applied', reason: 'Remit to celebrant' } })
    expect(disp.status).toBe(409)
    expect(disp.body.code).toBe(DISPOSITION_FULFILLED_CODE)
    expect(await countLegacySeeds(A.id, made.body.id)).toBe(0)
  })

  // 3. fulfilled, offering_recorded, no fact, voided → /disposition → 409, no seed
  it('3: voided-was-fulfilled with offering_recorded and no fact refuses before seed', async () => {
    // Create unpaid (no stipend fact), then latch offering_recorded + stipend via
    // SQL so the legacy seed path would otherwise fire on /disposition.
    const made = await makeIntention(A.token, {
      stipend: null, mass_date: '2026-10-04',
    })
    expect(made.status).toBe(201)

    await pool.query(
      `UPDATE ochr_mass_intentions
          SET stipend = 14.00, offering_recorded = true,
              status = 'cancelled', voided_at = '2026-10-05T15:00:00Z',
              void_reason = 'synthetic fulfilled void', voided_by = $1,
              fulfilled_mass_date = '2026-10-04',
              fulfilled_mass_title = 'Test Mass',
              fulfilled_mass_time = '09:00:00',
              entered_history = true
        WHERE id = $2 AND organization_id = $3`,
      [A.userId, made.body.id, A.id])
    await pool.query(
      `INSERT INTO ochr_mass_intention_corrections
         (organization_id, mass_intention_id, actor_user_id, kind, reason, before, after)
       VALUES ($1, $2, $3, 'void', $4, $5, $6)`,
      [A.id, made.body.id, A.userId, 'synthetic fulfilled void',
       JSON.stringify({ status: 'fulfilled', voided: false }),
       JSON.stringify({ status: 'cancelled', voided: true, disposition: null })])

    const row = await rowState(A.id, made.body.id)
    expect(row.offering_recorded).toBe(true)
    expect(row.stipend).toBe('14.00')

    const disp = await request(server).post(`/api/mass-intentions/${made.body.id}/disposition`)
      .set(auth(A.token))
      .send({ disposition: { kind: 'refunded', reason: 'Cash returned' } })
    expect(disp.status).toBe(409)
    expect(disp.body.code).toBe(DISPOSITION_FULFILLED_CODE)
    expect(await countLegacySeeds(A.id, made.body.id)).toBe(0)
  })

  // 4. scheduled/open voided legacy paid row → /disposition still 200 (regression)
  it('4: legacy voided open/scheduled paid row still accepts /disposition', async () => {
    const made = await makeIntention(A.token, {
      stipend: '11.00', mass_date: '2026-11-15',
      received_date: '2026-10-20', payment_method: 'cash',
    })
    expect(made.status).toBe(201)
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET status = 'cancelled', voided_at = '2026-10-20T15:00:00Z',
              void_reason = 'legacy hold', voided_by = $1
        WHERE id = $2 AND organization_id = $3`,
      [A.userId, made.body.id, A.id])
    await pool.query(
      `INSERT INTO ochr_mass_intention_corrections
         (organization_id, mass_intention_id, actor_user_id, kind, reason, before, after)
       VALUES ($1, $2, $3, 'void', $4, $5, $6)`,
      [A.id, made.body.id, A.userId, 'legacy hold',
       JSON.stringify({ status: 'open', voided: false }),
       JSON.stringify({ status: 'cancelled', voided: true, disposition: null })])

    const disp = await request(server).post(`/api/mass-intentions/${made.body.id}/disposition`)
      .set(auth(A.token))
      .send({ disposition: { kind: 'refunded', reason: 'Cash returned (legacy)' } })
    expect(disp.status, JSON.stringify(disp.body)).toBe(200)
    expect(disp.body.open_liability).toBe('0.00')
  })

  // 5. N449-3 void_fulfilled_held unchanged
  it('5: N449-3 void_fulfilled_held still refuses fulfilled + open 2330', async () => {
    const made = await makeIntention(A.token, {
      stipend: '15.00', mass_date: '2026-10-02',
      received_date: '2026-09-29', payment_method: 'cash',
    })
    expect(made.status).toBe(201)
    await markFulfilled(A.id, made.body.id)

    const refused = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token))
      .send({
        reason: 'Erroneous fulfilled entry',
        disposition: { kind: 'pastor_applied', reason: 'Remit to celebrant' },
      })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe(VOID_FULFILLED_HELD_CODE)
    const row = await rowState(A.id, made.body.id)
    expect(row.status).toBe('fulfilled')
    expect(row.voided_at).toBeNull()
  })

  // 6. Void correction missing → 409 fail closed
  it('6: missing void correction fails closed with disposition_fulfilled', async () => {
    const made = await makeIntention(A.token, {
      stipend: '9.00', mass_date: '2026-11-01',
      received_date: '2026-10-15', payment_method: 'cash',
    })
    expect(made.status).toBe(201)
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET status = 'cancelled', voided_at = '2026-10-16T15:00:00Z',
              void_reason = 'very old void', voided_by = $1
        WHERE id = $2 AND organization_id = $3`,
      [A.userId, made.body.id, A.id])
    await pool.query(
      `DELETE FROM ochr_mass_intention_corrections
        WHERE organization_id = $1 AND mass_intention_id = $2 AND kind = 'void'`,
      [A.id, made.body.id])

    const disp = await request(server).post(`/api/mass-intentions/${made.body.id}/disposition`)
      .set(auth(A.token))
      .send({ disposition: { kind: 'refunded', reason: 'Cash returned' } })
    expect(disp.status).toBe(409)
    expect(disp.body.code).toBe(DISPOSITION_FULFILLED_CODE)
    expect(await countLegacySeeds(A.id, made.body.id)).toBe(0)
  })
})
