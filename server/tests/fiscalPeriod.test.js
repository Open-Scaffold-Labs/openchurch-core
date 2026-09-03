// Fiscal-period semantics: a browse OVERLAPS, an assignment PARTITIONS.
//
// THE DEFECT THESE PROTECT, reproduced on 27 Aug before anything changed:
// a July–June parish read $0.00 on the chancery's default screen while
// being billed $2,420.57 for the same year, from the same approved
// submission. GET /api/diocese/financials documented itself as matching
// periods that OVERLAP the range and implemented CONTAINMENT, so for any
// parish whose fiscal year is not the calendar year the chancery's default
// view said "filed nothing".
//
// WHAT WOULD MAKE THESE FAIL: changing overlapsRange() back to containment
// (`period_start >= start AND period_end <= end`), or changing endsInYear()
// to overlap. Both mutations were performed and both turned these red.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import 'dotenv/config'
import jwt from 'jsonwebtoken'

import pool from '../src/db.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { overlapsRange, endsInYear } from '../src/finance/fiscalPeriod.js'

let server, dioceseId, parishId, token

const BASE = '2420.57'

async function addSubmission(period_start, period_end, base = BASE, status = 'approved') {
  const { rows } = await pool.query(
    `INSERT INTO ochr_report_submissions
       (organization_id, diocese_org_id, period_start, period_end, status, totals_json)
     VALUES ($1,$2,$3,$4,$5, jsonb_build_object('totals', jsonb_build_object(
       'assessable_base', $6::text, 'revenue', $6::text)))
     RETURNING id`,
    [parishId, dioceseId, period_start, period_end, status, base])
  return rows[0].id
}

const clearSubmissions = () =>
  pool.query('DELETE FROM ochr_report_submissions WHERE diocese_org_id = $1', [dioceseId])

// The assessment engine's own question, asked exactly as computeBases asks it.
async function billedForYear(year) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM((s.totals_json->'totals'->>'assessable_base')::NUMERIC), 0) AS base
       FROM ochr_report_submissions s
       JOIN ochr_diocese_affiliations a
         ON a.parish_org_id = s.organization_id AND a.diocese_org_id = s.diocese_org_id
        AND a.status IN ('active','suspended')
      WHERE s.diocese_org_id = $1 AND s.status = 'approved'
        AND ${endsInYear('$2')}`,
    [dioceseId, String(year)])
  return Number(rows[0].base)
}

async function rollup(start, end) {
  const res = await request(server)
    .get(`/api/diocese/financials?start=${start}&end=${end}`)
    .set('Authorization', `Bearer ${token}`)
  expect(res.status).toBe(200)
  return { count: res.body.submission_count ?? 0,
           base: Number(res.body.totals?.assessable_base ?? 0) }
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()

  const d = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type)
     VALUES ($1,$2,'diocese') RETURNING id`,
    [`FP Diocese ${RUN_ID}`, `fp-dio-${RUN_ID}`])
  dioceseId = d.rows[0].id
  const p = await pool.query(
    `INSERT INTO ochr_organizations (name, slug, org_type)
     VALUES ($1,$2,'parish') RETURNING id`,
    [`FP Parish ${RUN_ID}`, `fp-par-${RUN_ID}`])
  parishId = p.rows[0].id
  await pool.query(
    `INSERT INTO ochr_diocese_affiliations (diocese_org_id, parish_org_id, status, grant_level)
     VALUES ($1,$2,'active','detail')`, [dioceseId, parishId])
  const u = await pool.query(
    `INSERT INTO ochr_users (organization_id, name, email, password_hash, role)
     VALUES ($1,'FP Admin',$2,'x','admin') RETURNING id, token_version`,
    [dioceseId, `fp_${RUN_ID}@example.com`])
  token = jwt.sign(
    { userId: u.rows[0].id, organizationId: dioceseId, role: 'admin', tv: u.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' })
}, 60_000)

afterAll(async () => {
  await pool.query('DELETE FROM ochr_report_submissions WHERE diocese_org_id = $1', [dioceseId])
  await pool.query('DELETE FROM ochr_diocese_affiliations WHERE diocese_org_id = $1', [dioceseId])
  await pool.query('DELETE FROM ochr_users WHERE organization_id = $1', [dioceseId])
  await pool.query('DELETE FROM ochr_organizations WHERE id = ANY($1)', [[dioceseId, parishId]])
  await closeServer(server)
  await pool.end()
})

describe('fiscal period — the two surfaces must agree that a parish HAS data', () => {
  it('B. July–June parish: the roll-up and the bill agree (the reproduced defect)', async () => {
    await clearSubmissions()
    await addSubmission('2026-07-01', '2027-06-30')
    const view = await rollup('2027-01-01', '2027-12-31')   // the chancery default
    const bill = await billedForYear(2027)
    expect(bill).toBe(2420.57)
    expect(view.count).toBe(1)          // was 0 — containment excluded it
    expect(view.base).toBe(2420.57)     // was 0.00 while the bill said 2420.57
  }, 30_000)

  it('A. calendar-year parish: unchanged by the correction', async () => {
    await clearSubmissions()
    await addSubmission('2027-01-01', '2027-12-31')
    expect((await rollup('2027-01-01', '2027-12-31')).base).toBe(2420.57)
    expect(await billedForYear(2027)).toBe(2420.57)
  }, 30_000)
})

describe('fiscal period — boundaries', () => {
  it('C. a period ending exactly on the range start is included', async () => {
    await clearSubmissions()
    await addSubmission('2026-01-01', '2027-01-01')
    expect((await rollup('2027-01-01', '2027-12-31')).count).toBe(1)
  }, 30_000)

  it('D. a period starting exactly on the range end is included', async () => {
    await clearSubmissions()
    await addSubmission('2027-12-31', '2028-06-30')
    expect((await rollup('2027-01-01', '2027-12-31')).count).toBe(1)
  }, 30_000)

  it('E. one day outside either boundary is excluded', async () => {
    await clearSubmissions()
    await addSubmission('2025-01-01', '2026-12-31')   // ends the day before
    await addSubmission('2028-01-01', '2028-12-31')   // starts the day after
    expect((await rollup('2027-01-01', '2027-12-31')).count).toBe(0)
  }, 30_000)

  it('F. an empty period reports zero, not an error', async () => {
    await clearSubmissions()
    const view = await rollup('2027-01-01', '2027-12-31')
    expect(view.count).toBe(0)
    expect(view.base).toBe(0)
  }, 30_000)

  it('G. two periods spanning the boundary: both browse, each bills once', async () => {
    await clearSubmissions()
    await addSubmission('2026-07-01', '2027-06-30')   // closes in 2027
    await addSubmission('2027-07-01', '2028-06-30')   // closes in 2028
    // The browse shows both — both touch calendar 2027.
    expect((await rollup('2027-01-01', '2027-12-31')).count).toBe(2)
    // The bill is a PARTITION: each period lands in exactly one year.
    expect(await billedForYear(2027)).toBe(2420.57)
    expect(await billedForYear(2028)).toBe(2420.57)
    // and neither year double-counts.
    expect(await billedForYear(2026)).toBe(0)
  }, 30_000)

  it('only APPROVED submissions reach either surface', async () => {
    await clearSubmissions()
    await addSubmission('2026-07-01', '2027-06-30', BASE, 'submitted')
    expect((await rollup('2027-01-01', '2027-12-31')).count).toBe(0)
    expect(await billedForYear(2027)).toBe(0)
  }, 30_000)
})

describe('fiscal period — the predicates themselves', () => {
  it('overlapsRange is symmetric interval intersection', () => {
    expect(overlapsRange('$1', '$2')).toBe('s.period_start <= $2 AND s.period_end >= $1')
  })
  it('endsInYear anchors on the closing date only', () => {
    expect(endsInYear('$1')).toMatch(/period_end\s*>=/)
    expect(endsInYear('$1')).toMatch(/period_end\s*<=/)
    expect(endsInYear('$1')).not.toMatch(/period_start/)
  })
})
