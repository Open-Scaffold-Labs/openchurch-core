// Assessment routes (DIO.4) — mounted at /api/diocese/assessments with
// requireOrgType('diocese'), so everything here is chancery-only.
//
//   GET    /                → assessment years (with line rollups)
//   POST   /                → create a draft year { fiscal_year, rate_bps }
//   GET    /:id             → detail with per-parish lines
//   POST   /:id/recompute   → refresh draft bases from approved submissions
//   PATCH  /:id             → publish / close / edit notes (draft rate too)
//   PATCH  /:id/lines/:lineId → per-parish override, payment, waive
//
// The base is arithmetic, not entry: SUM of assessable_base across the
// parish's APPROVED submissions that CLOSE within the assessment year —
// a submission is assessed in the calendar year its period_end falls in.
// Anchoring on the end date (not full containment) means a report period
// that straddles a year boundary, or a parish on a non-calendar fiscal
// year, lands in exactly one assessment year instead of being silently
// dropped from both. Bases recompute freely while the year is a draft;
// publishing freezes the lines as the authoritative bill. Payments are
// recorded manually (real invoicing waits on the billing provider).

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const YEAR_RE = /^\d{4}$/
const money = v => (Math.round(Number(v) * 100) / 100).toFixed(2)
const assessedFor = (base, bps) => money((Number(base) * bps) / 10000)

// Per-parish assessable base for a calendar year, from approved
// submissions of ACTIVE/SUSPENDED affiliations. A submission is anchored
// to the year its period_end falls in (the year it closes), so every
// approved period is counted in exactly one assessment year — a period
// spanning a year boundary is no longer dropped from both.
async function computeBases(dioceseOrgId, year) {
  const { rows } = await pool.query(
    `SELECT s.organization_id AS parish_org_id,
            SUM((s.totals_json->'totals'->>'assessable_base')::NUMERIC)::NUMERIC(12,2) AS base
       FROM ochr_report_submissions s
       JOIN ochr_diocese_affiliations a
         ON a.parish_org_id = s.organization_id
        AND a.diocese_org_id = s.diocese_org_id
        AND a.status IN ('active', 'suspended')
      WHERE s.diocese_org_id = $1 AND s.status = 'approved'
        AND s.period_end >= ($2 || '-01-01')::date
        AND s.period_end <= ($2 || '-12-31')::date
      GROUP BY s.organization_id`,
    [dioceseOrgId, year]
  )
  return rows
}

async function loadAssessment(id, dioceseOrgId) {
  const { rows } = await pool.query(
    `SELECT id, fiscal_year, rate_bps, basis, status, notes, created_at
       FROM ochr_assessments WHERE id = $1 AND diocese_org_id = $2`,
    [id, dioceseOrgId]
  )
  return rows[0] ?? null
}

async function detail(id, dioceseOrgId) {
  const a = await loadAssessment(id, dioceseOrgId)
  if (!a) return null
  const { rows: lines } = await pool.query(
    `SELECT l.id, l.parish_org_id, p.name AS parish_name, l.base, l.rate_bps,
            l.assessed, l.paid, l.status, l.note
       FROM ochr_assessment_lines l
       JOIN ochr_organizations p ON p.id = l.parish_org_id
      WHERE l.assessment_id = $1
      ORDER BY p.name`,
    [id]
  )
  const num = v => Number(v) || 0
  return {
    ...a,
    lines,
    totals: {
      base: money(lines.reduce((s, l) => s + num(l.base), 0)),
      assessed: money(lines.filter(l => l.status !== 'waived').reduce((s, l) => s + num(l.assessed), 0)),
      paid: money(lines.reduce((s, l) => s + num(l.paid), 0)),
    },
  }
}

// GET /api/diocese/assessments
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.fiscal_year, a.rate_bps, a.status, a.notes,
              COUNT(l.id)::INT AS parish_count,
              COALESCE(SUM(l.assessed) FILTER (WHERE l.status <> 'waived'), 0)::NUMERIC(12,2) AS total_assessed,
              COALESCE(SUM(l.paid), 0)::NUMERIC(12,2) AS total_paid
         FROM ochr_assessments a
         LEFT JOIN ochr_assessment_lines l ON l.assessment_id = a.id
        WHERE a.diocese_org_id = $1
        GROUP BY a.id
        ORDER BY a.fiscal_year DESC`,
      [req.organizationId]
    )
    res.json({ assessments: rows })
  } catch (err) {
    monitor.error('assessments.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load assessments' })
  }
})

// POST /api/diocese/assessments — { fiscal_year, rate_bps, notes? }
router.post('/', async (req, res) => {
  const year = String(req.body?.fiscal_year ?? '')
  const bps = Number(req.body?.rate_bps)
  if (!YEAR_RE.test(year)) return res.status(400).json({ error: 'fiscal_year must be a four-digit year' })
  if (!Number.isInteger(bps) || bps < 0 || bps > 3000) {
    return res.status(400).json({ error: 'rate_bps must be an integer between 0 and 3000 (0–30%)' })
  }
  const notes = req.body?.notes != null ? String(req.body.notes).trim() || null : null

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO ochr_assessments (diocese_org_id, fiscal_year, rate_bps, notes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.organizationId, year, bps, notes]
    )
    const id = rows[0].id
    for (const b of await computeBases(req.organizationId, year)) {
      await client.query(
        `INSERT INTO ochr_assessment_lines (assessment_id, parish_org_id, base, rate_bps, assessed)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, b.parish_org_id, b.base, bps, assessedFor(b.base, bps)]
      )
    }
    await client.query('COMMIT')
    res.status(201).json(await detail(id, req.organizationId))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err?.code === '23505') {
      return res.status(409).json({ error: `An assessment for ${year} already exists` })
    }
    monitor.error('assessments.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to create the assessment' })
  } finally {
    client.release()
  }
})

// GET /api/diocese/assessments/:id
router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const d = await detail(id, req.organizationId)
    if (!d) return res.status(404).json({ error: 'Not found' })
    res.json(d)
  } catch (err) {
    monitor.error('assessments.get', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load the assessment' })
  }
})

// POST /api/diocese/assessments/:id/recompute — draft only. Re-pulls
// bases (new approvals since creation) and re-derives assessed amounts
// at each line's CURRENT rate, preserving per-parish overrides.
router.post('/:id/recompute', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: a } = await client.query(
      `SELECT fiscal_year, rate_bps, status FROM ochr_assessments
        WHERE id = $1 AND diocese_org_id = $2 FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!a.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    if (a[0].status !== 'draft') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only a draft assessment can be recomputed' }) }

    const bases = await computeBases(req.organizationId, a[0].fiscal_year)
    for (const b of bases) {
      await client.query(
        `INSERT INTO ochr_assessment_lines (assessment_id, parish_org_id, base, rate_bps, assessed)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (assessment_id, parish_org_id) DO UPDATE SET
           base = EXCLUDED.base,
           assessed = ROUND(EXCLUDED.base * ochr_assessment_lines.rate_bps / 10000.0, 2),
           updated_at = NOW()`,
        [id, b.parish_org_id, b.base, a[0].rate_bps, assessedFor(b.base, a[0].rate_bps)]
      )
    }

    // Drop lines for parishes that no longer qualify (affiliation lapsed or
    // their approvals were withdrawn). A draft recompute rebuilds from
    // source, so a stale base must not keep inflating the bill. Only remove
    // untouched lines — never one carrying a recorded payment or an explicit
    // waiver — so we can't silently destroy money or a chancery's decision.
    const keep = bases.map(b => b.parish_org_id)
    await client.query(
      `DELETE FROM ochr_assessment_lines
        WHERE assessment_id = $1
          AND paid = 0 AND status <> 'waived'
          AND parish_org_id <> ALL($2::int[])`,
      [id, keep]
    )
    await client.query('COMMIT')
    res.json(await detail(id, req.organizationId))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('assessments.recompute', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to recompute' })
  } finally {
    client.release()
  }
})

// PATCH /api/diocese/assessments/:id — { status?, notes? }
// Lifecycle: draft → published → closed (forward only).
const NEXT_STATUS = { published: 'draft', closed: 'published' }
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const nextStatus = req.body?.status
  if (nextStatus != null && !(nextStatus in NEXT_STATUS)) {
    return res.status(400).json({ error: "status must be 'published' or 'closed'" })
  }
  try {
    const a = await loadAssessment(id, req.organizationId)
    if (!a) return res.status(404).json({ error: 'Not found' })

    const sets = ['updated_at = NOW()']
    const params = []
    if (nextStatus) {
      if (a.status !== NEXT_STATUS[nextStatus]) {
        return res.status(400).json({ error: `Cannot move from '${a.status}' to '${nextStatus}'` })
      }
      params.push(nextStatus); sets.push(`status = $${params.length}`)
    }
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'notes')) {
      params.push(req.body.notes != null ? String(req.body.notes).trim() || null : null)
      sets.push(`notes = $${params.length}`)
    }
    params.push(id, req.organizationId)
    await pool.query(
      `UPDATE ochr_assessments SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND diocese_org_id = $${params.length}`,
      params
    )
    res.json(await detail(id, req.organizationId))
  } catch (err) {
    monitor.error('assessments.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update the assessment' })
  }
})

// PATCH /api/diocese/assessments/:id/lines/:lineId
//   { rate_bps }        → hardship override (draft or published), re-derives assessed
//   { record_payment }  → adds to paid; status auto-advances partial → paid
//   { status: 'waived' | 'pending' } → waive / unwaive
//   { note }            → annotate (why the override / waiver)
const has = (body, key) => Object.prototype.hasOwnProperty.call(body ?? {}, key)
// Payment status from the money: fully-paid > 0 → paid, some → partial, none → pending.
const deriveStatus = (paid, assessed) =>
  paid >= assessed && assessed > 0 ? 'paid' : paid > 0 ? 'partial' : 'pending'

router.patch('/:id/lines/:lineId', async (req, res) => {
  const id = Number(req.params.id), lineId = Number(req.params.lineId)
  if (!Number.isInteger(id) || !Number.isInteger(lineId)) return res.status(400).json({ error: 'Invalid id' })

  // Validate the body up front, before we take a row lock.
  let overrideBps = null
  if (has(req.body, 'rate_bps')) {
    overrideBps = Number(req.body.rate_bps)
    if (!Number.isInteger(overrideBps) || overrideBps < 0 || overrideBps > 3000) {
      return res.status(400).json({ error: 'rate_bps must be an integer between 0 and 3000' })
    }
  }
  let paymentAmt = null
  if (has(req.body, 'record_payment')) {
    paymentAmt = Number(req.body.record_payment)
    if (!Number.isFinite(paymentAmt) || paymentAmt <= 0) {
      return res.status(400).json({ error: 'record_payment must be a positive amount' })
    }
  }
  if (has(req.body, 'status') && !['waived', 'pending'].includes(req.body.status)) {
    return res.status(400).json({ error: "Line status can only be set to 'waived' or 'pending'" })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lock the line and confirm — in one shot — that it belongs to an
    // assessment this diocese owns and isn't closed. FOR UPDATE serializes
    // concurrent payments/overrides so a read-modify-write can't lose a
    // write (two payments both landing, not one clobbering the other).
    const { rows } = await client.query(
      `SELECT l.base, l.assessed, l.paid, l.status, a.status AS assessment_status
         FROM ochr_assessment_lines l
         JOIN ochr_assessments a ON a.id = l.assessment_id
        WHERE l.id = $1 AND l.assessment_id = $2 AND a.diocese_org_id = $3
        FOR UPDATE OF l`,
      [lineId, id, req.organizationId]
    )
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    const line = rows[0]
    if (line.assessment_status === 'closed') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'This assessment year is closed' })
    }

    const sets = ['updated_at = NOW()']
    const params = []

    if (overrideBps !== null) {
      params.push(overrideBps); sets.push(`rate_bps = $${params.length}`)
      params.push(assessedFor(line.base, overrideBps)); sets.push(`assessed = $${params.length}`)
    }

    let newPaid = Number(line.paid)
    if (paymentAmt !== null) {
      newPaid = Number(money(newPaid + paymentAmt))
      params.push(money(newPaid)); sets.push(`paid = $${params.length}`)
    }

    // The bill this line is measured against, after any rate override here.
    const assessed = overrideBps !== null ? Number(assessedFor(line.base, overrideBps)) : Number(line.assessed)

    // Status resolution:
    //   explicit 'waived'  → waived.
    //   explicit 'pending' → unwaive/reset: DERIVE from recorded payments,
    //     never a blind 'pending' — a line with money on it comes back as
    //     partial/paid, not falsely unpaid.
    //   payment / rate change with no explicit status → auto-advance, but a
    //     line already waived stays waived until it's explicitly unwaived.
    let nextStatus = null
    if (has(req.body, 'status') && req.body.status === 'waived') {
      nextStatus = 'waived'
    } else if (has(req.body, 'status') && req.body.status === 'pending') {
      nextStatus = deriveStatus(newPaid, assessed)
    } else if (paymentAmt !== null || overrideBps !== null) {
      nextStatus = line.status === 'waived' ? 'waived' : deriveStatus(newPaid, assessed)
    }
    if (nextStatus) { params.push(nextStatus); sets.push(`status = $${params.length}`) }

    if (has(req.body, 'note')) {
      params.push(req.body.note != null ? String(req.body.note).trim() || null : null)
      sets.push(`note = $${params.length}`)
    }

    params.push(lineId)
    await client.query(
      `UPDATE ochr_assessment_lines SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    )
    await client.query('COMMIT')
    res.json(await detail(id, req.organizationId))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('assessments.lines.patch', err, { orgId: req.organizationId, id, lineId })
    res.status(500).json({ error: 'Failed to update the line' })
  } finally {
    client.release()
  }
})

export default router
