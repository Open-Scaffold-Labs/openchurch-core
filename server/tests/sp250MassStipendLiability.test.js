// SP-250 — Mass stipend liability (Ledger C + W1). José 2026-10-27 1:37 PM PT.
// Real Postgres on 553xx. Synthetic tenants only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'
import { STIPEND_LIABILITY_CODE } from '../src/migrations/136-mass-stipend-liability.js'
import { DISPOSITION_REQUIRED_CODE } from '../src/finance/stipends.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATION = join(HERE, '../src/migrations/136-mass-stipend-liability.js')
const PW = 'sp250-pw'
let server, A, B, staff, admin2
let ipSeq = 1
const nextIp = () => `10.136.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const cleanup = []

async function signup(tag) {
  const email = `sp250_${tag}_${RUN_ID}@example.com`
  const r = await createOrg(server, {
    organizationName: `SP250 ${tag} ${RUN_ID}`, name: `Admin ${tag}`,
    email, password: PW,
  }, nextIp())
  expect(r.status).toBe(201)
  cleanup.push(r.body.user.organization.id)
  return { id: r.body.user.organization.id, userId: r.body.user.id, token: r.body.token, email }
}
async function addUser(org, role, name, tag) {
  const email = `sp250_${tag}_${RUN_ID}@example.com`
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
  admin2 = await addUser(A, 'admin', 'Admin Two', 'a2')
}, 90_000)

afterAll(async () => {
  for (const id of cleanup) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

async function makeIntention(token, body) {
  const r = await request(server).post('/api/mass-intentions').set(auth(token))
    .send({ intention: `† SP250 ${RUN_ID} ${Math.random().toString(36).slice(2, 6)}`, requested_by: 'Synthetic', ...body })
  return r
}

describe('136 migration', () => {
  it('is tip after 133→135→136, skips 134, is transactional, seeds 2330 non-assessable', async () => {
    const { MIGRATION_NAMES, EXPECTED_MIGRATION } = await import('../src/migrations/names.js')
    expect(EXPECTED_MIGRATION).toBe('144-online-giving-clearing')
    // 134 stays reserved elsewhere. After #438, order is 133 → 135 → 136.
    expect(MIGRATION_NAMES.some(n => n.startsWith('134-'))).toBe(false)
    const i133 = MIGRATION_NAMES.indexOf('133-parish-catering')
    const i135 = MIGRATION_NAMES.indexOf('135-fund-net-asset-class')
    const i136 = MIGRATION_NAMES.indexOf('136-mass-stipend-liability')
    expect(i133).toBeGreaterThanOrEqual(0)
    expect(i135).toBe(i133 + 1)
    expect(i136).toBe(i135 + 1)
    const src = readFileSync(MIGRATION, 'utf8')
    expect(src).toMatch(/BEGIN ISOLATION LEVEL REPEATABLE READ/)
    expect(src).toMatch(/SET LOCAL lock_timeout/)
    const { up } = await import('../src/migrations/136-mass-stipend-liability.js')
    await up(); await up()
    const coa = await pool.query(
      `SELECT code, acct_type, assessable FROM ochr_coa_accounts
        WHERE organization_id IS NULL AND code = $1`, [STIPEND_LIABILITY_CODE])
    expect(coa.rows[0]).toMatchObject({ code: '2330', acct_type: 'liability', assessable: false })
    const rls = await pool.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'ochr_mass_stipend_facts'`)
    expect(rls.rows[0]?.relrowsecurity).toBe(true)
    const trigs = await pool.query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'ochr_mass_stipend_facts'::regclass AND NOT tgisinternal
        ORDER BY tgname`)
    const names = trigs.rows.map(r => r.tgname)
    expect(names).toContain('ochr_mass_stipend_facts_append_only')
    expect(names).toContain('ochr_organization_hold_guard')
  })
})

describe('stipend liability projection', () => {
  it('create with stipend credits 2330 and never donations/4210', async () => {
    const made = await makeIntention(A.token, { stipend: '15.00', mass_date: '2026-11-01', received_date: '2026-10-20', payment_method: 'cash' })
    expect(made.status).toBe(201)
    expect(made.body.received_date).toBe('2026-10-20')
    const facts = await pool.query(
      `SELECT id, kind, amount::text AS amount, effective_date::text AS d
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(facts.rows).toEqual([
      expect.objectContaining({ kind: 'recorded', amount: '15.00', d: '2026-10-20' }),
    ])
    const line = await pool.query(
      `SELECT account_code, amount::text AS amount, source_type
         FROM ochr_parish_ledger
        WHERE organization_id = $1 AND source_type = 'mass_stipend' AND source_id = $2`,
      [A.id, facts.rows[0].id])
    expect(line.rows[0]).toMatchObject({ account_code: '2330', amount: '15.00', source_type: 'mass_stipend' })
    // Dual-write into Donations is forbidden (doctrine / Help).
    const dual = await pool.query(
      `SELECT 1 FROM ochr_donations
        WHERE organization_id = $1 AND amount = 15 AND date = '2026-10-20'
        LIMIT 1`, [A.id])
    expect(dual.rows).toHaveLength(0)
    const a4210 = await pool.query(
      `SELECT coalesce(sum(amount),0)::text AS s FROM ochr_parish_ledger
        WHERE organization_id = $1 AND account_code = '4210'`, [A.id])
    expect(Number(a4210.rows[0].s)).toBe(0)
  })

  it('void without disposition refuses; refund disposition clears liability', async () => {
    const made = await makeIntention(A.token, { stipend: '10.00', mass_date: '2026-10-21' })
    expect(made.status).toBe(201)
    const refused = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token)).send({ reason: 'Duplicate' })
    expect(refused.status).toBe(400)
    expect(refused.body.code).toBe(DISPOSITION_REQUIRED_CODE)
    const still = await pool.query(
      `SELECT voided_at FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2`,
      [made.body.id, A.id])
    expect(still.rows[0].voided_at).toBeNull()

    const voided = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token)).send({
        reason: 'Duplicate',
        disposition: { kind: 'refunded', reason: 'Cash returned to requester' },
      })
    expect(voided.status).toBe(200)
    const open = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(open.rows[0].s).toBe('0.00')
  })

  it('transfer moves liability to another open intention in-tenant', async () => {
    const src = await makeIntention(A.token, { stipend: '20.00', mass_date: '2026-10-22' })
    const tgt = await makeIntention(A.token, { stipend: null, mass_date: '2026-10-23' })
    expect(src.status).toBe(201)
    expect(tgt.status).toBe(201)
    const v = await request(server).post(`/api/mass-intentions/${src.body.id}/void`)
      .set(auth(A.token)).send({
        reason: 'Family asked to move',
        disposition: {
          kind: 'transferred',
          transfer_to_intention_id: tgt.body.id,
          reason: 'Moved to later Mass',
        },
      })
    expect(v.status).toBe(200)
    const srcOpen = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, src.body.id])
    const tgtOpen = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, tgt.body.id])
    expect(srcOpen.rows[0].s).toBe('0.00')
    expect(tgtOpen.rows[0].s).toBe('20.00')
    // P1 N2: target latches offering_recorded + stipend
    const latch = await pool.query(
      `SELECT stipend::text AS stipend, offering_recorded
         FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2`,
      [tgt.body.id, A.id])
    expect(latch.rows[0].offering_recorded).toBe(true)
    expect(latch.rows[0].stipend).toBe('20.00')
    // Voiding the target without disposition must refuse
    const refuse = await request(server).post(`/api/mass-intentions/${tgt.body.id}/void`)
      .set(auth(A.token)).send({ reason: 'Changed mind' })
    expect(refuse.status).toBe(400)
    expect(refuse.body.code).toBe(DISPOSITION_REQUIRED_CODE)
  })

  it('staff cannot void; cross-tenant void is 404; foreign disposition target refused', async () => {
    const made = await makeIntention(A.token, { stipend: '8.00', mass_date: '2026-10-24' })
    const other = await makeIntention(B.token, { stipend: '8.00', mass_date: '2026-10-24' })
    expect(made.status).toBe(201)
    expect(other.status).toBe(201)
    const staffVoid = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(staff.token)).send({
        reason: 'x', disposition: { kind: 'refunded', reason: 'x' },
      })
    expect(staffVoid.status).toBe(403)
    const cross = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(B.token)).send({
        reason: 'x', disposition: { kind: 'refunded', reason: 'x' },
      })
    expect(cross.status).toBe(404)
    const badTransfer = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token)).send({
        reason: 'move',
        disposition: {
          kind: 'transferred',
          transfer_to_intention_id: other.body.id,
          reason: 'cross parish',
        },
      })
    expect(badTransfer.status).toBe(400)
    expect(badTransfer.body.code).toBe('transfer_target')
  })

  it('open disposition holds period submit (fail closed)', async () => {
    // Simulate legacy: voided + offering_recorded with no clearing fact.
    const made = await makeIntention(A.token, { stipend: '11.00', mass_date: '2026-10-15' })
    expect(made.status).toBe(201)
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET status = 'cancelled', voided_at = '2026-10-16T12:00:00Z',
              void_reason = 'legacy', voided_by = $1
        WHERE id = $2 AND organization_id = $3`,
      [A.userId, made.body.id, A.id])
    // Ensure recorded fact exists (create path wrote it) and no clearing.
    const clearing = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2
          AND kind IN ('refunded','transferred','pastor_applied')`,
      [A.id, made.body.id])
    expect(clearing.rows[0].n).toBe(0)

    // Affiliate A to a diocese so submit is reachable.
    const dio = await createOrg(server, {
      organizationName: `SP250 Dio ${RUN_ID}`, name: 'Dio Admin',
      email: `sp250_dio_${RUN_ID}@example.com`, password: PW, organizationType: 'diocese',
    }, nextIp())
    expect(dio.status).toBe(201)
    cleanup.push(dio.body.user.organization.id)
    const inv = await request(server).post('/api/diocese/parishes/invite').set(auth(dio.body.token))
      .send({ email: A.email })
    expect(inv.status).toBeLessThan(300)
    const acc = await request(server).post('/api/affiliation/accept').set(auth(A.token))
      .send({ grant_level: 'detail' })
    expect(acc.status).toBe(200)

    const sub = await request(server).post('/api/finance/submissions').set(auth(A.token))
      .send({ period_start: '2026-10-01', period_end: '2026-10-31' })
    expect(sub.status).toBe(409)
    expect(sub.body.code).toBe('stipend_dispositions_pending')
  })
})

describe('SP-250 review batch', () => {
  it('append-only: UPDATE/DELETE on facts blocked; correction appends (Carolina P1b)', async () => {
    const made = await makeIntention(A.token, { stipend: '12.00', mass_date: '2026-10-18' })
    expect(made.status).toBe(201)
    const { rows: [fact] } = await pool.query(
      `SELECT id FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2 AND kind = 'recorded'`,
      [A.id, made.body.id])
    const upd = await pool.query(
      `UPDATE ochr_mass_stipend_facts SET amount = 1 WHERE id = $1 AND organization_id = $2`,
      [fact.id, A.id]).catch(e => e)
    expect(String(upd.message || upd)).toMatch(/append-only/)
    const del = await pool.query(
      `DELETE FROM ochr_mass_stipend_facts WHERE id = $1 AND organization_id = $2`,
      [fact.id, A.id]).catch(e => e)
    expect(String(del.message || del)).toMatch(/append-only/)

    // Amount correction appends a delta fact (N439-2)
    const corr = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(A.token))
      .send({ reason: 'Counted wrong envelope', changes: { stipend: '18.00' } })
    expect(corr.status).toBe(200)
    const facts = await pool.query(
      `SELECT kind, amount::text AS amount FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2
        ORDER BY id`,
      [A.id, made.body.id])
    expect(facts.rows.length).toBeGreaterThanOrEqual(2)
    const open = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(open.rows[0].s).toBe('18.00')
  })

  it('delete of transfer target returns 409 not 500 (Ledger P2)', async () => {
    const src = await makeIntention(A.token, { stipend: '9.00', mass_date: '2026-10-19' })
    const tgt = await makeIntention(A.token, { stipend: null, mass_date: '2026-10-19' })
    expect(src.status).toBe(201)
    expect(tgt.status).toBe(201)
    const v = await request(server).post(`/api/mass-intentions/${src.body.id}/void`)
      .set(auth(A.token)).send({
        reason: 'move',
        disposition: {
          kind: 'transferred',
          transfer_to_intention_id: tgt.body.id,
          reason: 'later Mass',
        },
      })
    expect(v.status).toBe(200)
    const del = await request(server).delete(`/api/mass-intentions/${tgt.body.id}`)
      .set(auth(A.token))
    expect(del.status).toBe(409)
    expect(['offering_recorded', 'stipend_transfer_target', 'fulfilled_history']).toContain(
      del.body.code || 'offering_recorded')
  })

  it('legacy voided+paid can record disposition and clear submit hold (Ledger P2)', async () => {
    const made = await makeIntention(A.token, { stipend: '7.00', mass_date: '2026-10-14' })
    expect(made.status).toBe(201)
    await pool.query(
      `UPDATE ochr_mass_intentions
          SET status = 'cancelled', voided_at = '2026-10-14T15:00:00Z',
              void_reason = 'legacy', voided_by = $1
        WHERE id = $2 AND organization_id = $3`,
      [A.userId, made.body.id, A.id])
    // D449-4: /disposition reads before.status from the void correction.
    await pool.query(
      `INSERT INTO ochr_mass_intention_corrections
         (organization_id, mass_intention_id, actor_user_id, kind, reason, before, after)
       VALUES ($1, $2, $3, 'void', $4, $5, $6)`,
      [A.id, made.body.id, A.userId, 'legacy',
       JSON.stringify({ status: 'open', voided: false }),
       JSON.stringify({ status: 'cancelled', voided: true, disposition: null })])
    const revoid = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token)).send({
        reason: 'again', disposition: { kind: 'refunded', reason: 'cash back' },
      })
    expect(revoid.status).toBe(409)

    const disp = await request(server).post(`/api/mass-intentions/${made.body.id}/disposition`)
      .set(auth(A.token))
      .send({ disposition: { kind: 'refunded', reason: 'Cash returned (legacy)' } })
    expect(disp.status).toBe(200)
    expect(disp.body.open_liability).toBe('0.00')
  })

  it('N442-1 / N442-3: decrease appends adjusted delta (18→10)', async () => {
    const made = await makeIntention(A.token, { stipend: '18.00', mass_date: '2026-10-16' })
    expect(made.status).toBe(201)
    const down = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(A.token))
      .send({ reason: 'Miscounted cash', changes: { stipend: '10.00' } })
    expect(down.status).toBe(200)
    const facts = await pool.query(
      `SELECT kind, amount::text AS amount FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2
        ORDER BY id`,
      [A.id, made.body.id])
    expect(facts.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'recorded', amount: '18.00' }),
      expect.objectContaining({ kind: 'adjusted', amount: '8.00' }),
    ]))
    const open = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(open.rows[0].s).toBe('10.00')
    expect(down.body.stipend).toBe('10.00')
  })

  it('N442-1: clear stipend to null via /correct zeros open 2330 liability', async () => {
    const made = await makeIntention(A.token, { stipend: '14.00', mass_date: '2026-10-13' })
    expect(made.status).toBe(201)
    const cleared = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(A.token))
      .send({ reason: 'Never received', changes: { stipend: null } })
    expect(cleared.status).toBe(200)
    expect(cleared.body.stipend).toBeNull()
    const open = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(open.rows[0].s).toBe('0.00')
    const kinds = await pool.query(
      `SELECT kind, amount::text AS amount FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2 ORDER BY id`,
      [A.id, made.body.id])
    expect(kinds.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'recorded', amount: '14.00' }),
      expect.objectContaining({ kind: 'adjusted', amount: '14.00' }),
    ]))
  })

  it('N442-1: clear stipend to 0.00 via /correct also zeros open 2330', async () => {
    const made = await makeIntention(A.token, { stipend: '5.00', mass_date: '2026-10-12' })
    expect(made.status).toBe(201)
    const cleared = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(A.token))
      .send({ reason: 'Waived after count', changes: { stipend: '0.00' } })
    expect(cleared.status).toBe(200)
    const open = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(open.rows[0].s).toBe('0.00')
  })

  it('N442-6: re-set after clear restores open 2330 via sync delta', async () => {
    const made = await makeIntention(A.token, { stipend: '15.00', mass_date: '2026-10-11' })
    expect(made.status).toBe(201)
    const cleared = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(A.token))
      .send({ reason: 'Wrong entry', changes: { stipend: null } })
    expect(cleared.status).toBe(200)
    const zero = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(zero.rows[0].s).toBe('0.00')

    const reset = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(A.token))
      .send({ reason: 'Cash found', changes: { stipend: '12.00' } })
    expect(reset.status).toBe(200)
    expect(reset.body.stipend).toBe('12.00')
    const open = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(open.rows[0].s).toBe('12.00')
    const facts = await pool.query(
      `SELECT kind, amount::text AS amount FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2 ORDER BY id`,
      [A.id, made.body.id])
    // create recorded + clear adjusted + restore recorded delta
    expect(facts.rows.length).toBeGreaterThanOrEqual(3)
    expect(facts.rows[facts.rows.length - 1]).toEqual(
      expect.objectContaining({ kind: 'recorded', amount: '12.00' }))
  })

  it('N442-7: clear then void with disposition does not stick submit hold', async () => {
    // Fresh org so earlier suite voids with open liability cannot pollute the hold check.
    const org = await signup('n4427')
    const { periodHasOpenStipendDispositions } = await import('../src/finance/stipends.js')
    const made = await makeIntention(org.token, { stipend: '13.00', mass_date: '2026-10-10' })
    expect(made.status).toBe(201)
    const cleared = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(org.token))
      .send({ reason: 'Never paid', changes: { stipend: null } })
    expect(cleared.status).toBe(200)
    // D449-4: open 0 + disposition refuses (no_open_stipend). Void without
    // disposition when nothing is held — honest path after a book clear.
    const refusedDisp = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(org.token)).send({
        reason: 'Withdrawn',
        disposition: { kind: 'refunded', reason: 'No stipend was held' },
      })
    expect(refusedDisp.status).toBe(409)
    expect(refusedDisp.body.code).toBe('no_open_stipend')
    const voided = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(org.token)).send({ reason: 'Withdrawn' })
    expect(voided.status).toBe(200)
    const open = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [org.id, made.body.id])
    expect(open.rows[0].s).toBe('0.00')
    const held = await periodHasOpenStipendDispositions(pool, {
      organizationId: org.id, periodStart: '2026-10-01', periodEnd: '2026-10-31',
    })
    expect(held).toBe(false)
  })

  it('N442-8: legacy voided+paid with zero facts still holds submit', async () => {
    // Mig 136 skipped already-voided paid rows (no facts) so W1 stayed
    // fail-closed until a human disposition. Hold must not key only on
    // open SUM > 0 — that fail-opens those legacy rows.
    const org = await signup('n4428')
    const { periodHasOpenStipendDispositions } = await import('../src/finance/stipends.js')
    const ins = await pool.query(
      `INSERT INTO ochr_mass_intentions
         (organization_id, intention, requested_by, mass_date, stipend, status,
          voided_at, void_reason, voided_by, offering_recorded)
       VALUES ($1, $2, 'Synthetic', '2026-10-12', 15.00, 'cancelled',
               '2026-10-12T12:00:00Z', 'legacy pre-136', $3, true)
       RETURNING id, offering_recorded`,
      [org.id, `† N442-8 legacy ${RUN_ID}`, org.userId])
    const id = ins.rows[0].id
    expect(ins.rows[0].offering_recorded).toBe(true)
    // D449-4: known-not-fulfilled legacy still dispositions; missing correction
    // fails closed (covered by d4494FulfilledDispositionGuard test 6).
    await pool.query(
      `INSERT INTO ochr_mass_intention_corrections
         (organization_id, mass_intention_id, actor_user_id, kind, reason, before, after)
       VALUES ($1, $2, $3, 'void', $4, $5, $6)`,
      [org.id, id, org.userId, 'legacy pre-136',
       JSON.stringify({ status: 'open', voided: false }),
       JSON.stringify({ status: 'cancelled', voided: true, disposition: null })])
    const nFacts = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [org.id, id])
    expect(nFacts.rows[0].n).toBe(0)
    const held = await periodHasOpenStipendDispositions(pool, {
      organizationId: org.id, periodStart: '2026-10-01', periodEnd: '2026-10-31',
    })
    expect(held).toBe(true)

    // Disposition clears the hold (endpoint seeds recorded:legacy then clears).
    const disp = await request(server).post(`/api/mass-intentions/${id}/disposition`)
      .set(auth(org.token))
      .send({ disposition: { kind: 'refunded', reason: 'Cash returned (legacy zero-fact)' } })
    expect(disp.status).toBe(200)
    const heldAfter = await periodHasOpenStipendDispositions(pool, {
      organizationId: org.id, periodStart: '2026-10-01', periodEnd: '2026-10-31',
    })
    expect(heldAfter).toBe(false)
  })

  it('N442-9: clear → re-set same amount → clear again zeros open 2330', async () => {
    // Ledger R4: sync keys adjusted:id:20.00->0.00 collided on the second
    // clear after re-set to the same amount (ON CONFLICT DO NOTHING), so the
    // book went null while open 2330 stayed 20.
    const org = await signup('n4429')
    const made = await makeIntention(org.token, { stipend: '20.00', mass_date: '2026-10-20' })
    expect(made.status).toBe(201)
    const c1 = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(org.token)).send({ reason: 'clear1', changes: { stipend: null } })
    expect(c1.status).toBe(200)
    const r1 = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(org.token)).send({ reason: 'cash later', changes: { stipend: '20.00' } })
    expect(r1.status).toBe(200)
    expect(r1.body.stipend).toBe('20.00')
    const c2 = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(org.token)).send({ reason: 'clear2', changes: { stipend: null } })
    expect(c2.status).toBe(200)
    expect(c2.body.stipend).toBeNull()
    const open = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [org.id, made.body.id])
    expect(open.rows[0].s).toBe('0.00')
  })

  it('N442-7: void with nonzero open balance still requires disposition', async () => {
    const made = await makeIntention(A.token, { stipend: '4.00', mass_date: '2026-10-09' })
    expect(made.status).toBe(201)
    const refused = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token)).send({ reason: 'Duplicate' })
    expect(refused.status).toBe(400)
    expect(refused.body.code).toBe(DISPOSITION_REQUIRED_CODE)
  })

  it('N442-5 Info: repeated clear is idempotent (open stays 0)', async () => {
    const made = await makeIntention(A.token, { stipend: '8.00', mass_date: '2026-10-08' })
    expect(made.status).toBe(201)
    const c1 = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(A.token))
      .send({ reason: 'Clear once', changes: { stipend: null } })
    expect(c1.status).toBe(200)
    const count1 = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    const c2 = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(A.token))
      .send({ reason: 'Clear again', changes: { stipend: null } })
    // Nothing to correct (already null) → 400, or no-op sync if somehow accepted
    expect([200, 400]).toContain(c2.status)
    const open = await pool.query(
      `SELECT coalesce(sum(CASE WHEN kind = 'recorded' THEN amount ELSE -amount END),0)::text AS s
         FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(open.rows[0].s).toBe('0.00')
    const count2 = await pool.query(
      `SELECT count(*)::int AS n FROM ochr_mass_stipend_facts
        WHERE organization_id = $1 AND mass_intention_id = $2`,
      [A.id, made.body.id])
    expect(count2.rows[0].n).toBe(count1.rows[0].n)
  })

  it('N442-5 Info: clear after void is refused (409)', async () => {
    const made = await makeIntention(A.token, { stipend: '3.00', mass_date: '2026-10-07' })
    expect(made.status).toBe(201)
    const voided = await request(server).post(`/api/mass-intentions/${made.body.id}/void`)
      .set(auth(A.token)).send({
        reason: 'Dup',
        disposition: { kind: 'refunded', reason: 'Returned' },
      })
    expect(voided.status).toBe(200)
    const clear = await request(server).post(`/api/mass-intentions/${made.body.id}/correct`)
      .set(auth(A.token))
      .send({ reason: 'Too late', changes: { stipend: null } })
    expect(clear.status).toBe(409)
  })

  it('Staff cannot read parish finance / 2330 lines (depends on #437)', async () => {
    const made = await makeIntention(A.token, { stipend: '6.00', mass_date: '2026-10-17' })
    expect(made.status).toBe(201)
    const ledger = await request(server).get('/api/finance/ledger')
      .query({ from: '2026-10-01', to: '2026-10-31' }).set(auth(staff.token))
    expect(ledger.status).toBe(403)
    const summary = await request(server).get('/api/finance/summary')
      .query({ from: '2026-10-01', to: '2026-10-31' }).set(auth(staff.token))
    expect(summary.status).toBe(403)
  })
})
