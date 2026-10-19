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
// RATES (087). A rate can be flat (`rate_bps`) or a marginal ladder
// (`bands`), because real diocesan formulas are usually a ladder: Maine
// charges 5% on the first $10,000 and 15% above it, and the churchwide
// assessment exempts the first $200,000 then charges 15% — which is the
// same mechanism with a zero on the bottom rung. Every line keeps the
// slice-by-slice working, so a parish adding the bands up by hand arrives
// at the number on the invoice.
//
// BASE YEAR (087). The base need not come from the assessment's own year.
// Maine assesses on the parochial report "submitted two years prior", so
// `base_year` is stored per assessment and defaults to `fiscal_year`.
//
// The base is arithmetic, not entry (GIV-08 M4): approved frozen
// assessable_base across submissions that CLOSE within the BASE year,
// minus APPLIED credits. totals_json stays the archival gross; OPEN
// adjustments do not move the bill. A submission is assessed in the
// calendar year its period_end falls in. Anchoring on the end date
// (not full containment) means a report period that straddles a year
// boundary, or a parish on a non-calendar fiscal year, lands in exactly
// one assessment year instead of being silently dropped from both.
// Bases recompute freely while the year is a draft; publishing freezes
// the lines as the authoritative bill. Payments are recorded manually
// (real invoicing waits on the billing provider).

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'
import { computeBases } from '../finance/assessmentBases.js'

const router = Router()

const YEAR_RE = /^\d{4}$/
const money = v => (Math.round(Number(v) * 100) / 100).toFixed(2)
const assessedFor = (base, bps) => money((Number(base) * bps) / 10000)

// A marginal ladder, and its working.
//
// Each slice is rounded to cents and the slices are summed — rather than
// summing exactly and rounding once — so the breakdown a parish is shown
// adds up to the amount it is billed. Rounding the total separately
// produces an invoice that is a penny away from its own explanation, and
// the phone call that follows costs more than the penny.
export function assessedForBands(base, bands) {
  const total = Number(base) || 0
  let floor = 0, sum = 0
  const breakdown = []
  for (const band of bands) {
    const ceiling = band.upto === null || band.upto === undefined ? Infinity : Number(band.upto)
    if (total <= floor) break
    const slice = Math.min(total, ceiling) - floor
    if (slice > 0) {
      const amount = Number(money((slice * band.rate_bps) / 10000))
      sum += amount
      breakdown.push({
        from: money(floor),
        to: ceiling === Infinity ? null : money(ceiling),
        amount_in_band: money(slice),
        rate_bps: band.rate_bps,
        assessed: money(amount),
      })
    }
    floor = ceiling
    if (floor === Infinity) break
  }
  return { assessed: money(sum), breakdown }
}

// Bands in, or a clear sentence about why not.
//
// The top rung must be open. A ladder that stops leaves income above the
// last rung silently unassessed — a bill quietly too small, which nobody
// notices until an auditor does.
export function validateBands(raw) {
  if (raw === undefined || raw === null) return { bands: null }
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'bands must be a non-empty list' }
  if (raw.length > 8) return { error: 'An assessment can have at most 8 bands' }
  const bands = []
  let previous = 0
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] ?? {}
    const bps = Number(b.rate_bps)
    if (!Number.isInteger(bps) || bps < 0 || bps > 3000) {
      return { error: `Band ${i + 1}: rate_bps must be an integer between 0 and 3000 (0–30%)` }
    }
    const last = i === raw.length - 1
    const upto = b.upto === null || b.upto === undefined ? null : Number(b.upto)
    if (last) {
      if (upto !== null) return { error: 'The last band must have no upper limit, so income above it is still assessed' }
    } else {
      if (!Number.isFinite(upto) || upto <= previous) {
        return { error: `Band ${i + 1}: each upper limit must be a number larger than the one before it` }
      }
      previous = upto
    }
    bands.push({ upto, rate_bps: bps })
  }
  return { bands }
}

// One place that answers "what does this parish owe", whichever shape the
// diocese's formula takes. A per-line override is always flat: an
// override is a negotiated rate for one parish, not a second ladder.
function assessFor(base, { bands, rate_bps }) {
  if (Array.isArray(bands) && bands.length) return assessedForBands(base, bands)
  return { assessed: assessedFor(base, rate_bps), breakdown: null }
}

async function loadAssessment(id, dioceseOrgId) {
  const { rows } = await pool.query(
    `SELECT id, fiscal_year, rate_bps, basis, status, notes, created_at,
            bands, COALESCE(base_year, fiscal_year) AS base_year
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
            l.assessed, l.paid, l.status, l.note, l.breakdown
       FROM ochr_assessment_lines l
       JOIN ochr_organizations p ON p.id = l.parish_org_id
      WHERE l.assessment_id = $1
      ORDER BY p.name`,
    [id]
  )
  const num = v => Number(v) || 0
  return {
    ...a,
    // M4: line.base is payable (approved frozen gross − APPLIED credits).
    // totals_json on the source submissions remains the archival gross.
    payable_rule: 'approved_frozen_gross_minus_applied_credits',
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
              a.bands, COALESCE(a.base_year, a.fiscal_year) AS base_year,
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

// POST /api/diocese/assessments
//   { fiscal_year, rate_bps | bands, base_year?, notes? }
router.post('/', async (req, res) => {
  const year = String(req.body?.fiscal_year ?? '')
  if (!YEAR_RE.test(year)) return res.status(400).json({ error: 'fiscal_year must be a four-digit year' })

  const v = validateBands(req.body?.bands)
  if (v.error) return res.status(400).json({ error: v.error })
  const bands = v.bands

  // A flat rate is still required when there are no bands, and is kept
  // alongside them when there are: it is what a per-parish override
  // resets to, and what the year is described as when somebody asks for
  // one number.
  const bps = bands ? Number(req.body?.rate_bps ?? bands[bands.length - 1].rate_bps) : Number(req.body?.rate_bps)
  if (!Number.isInteger(bps) || bps < 0 || bps > 3000) {
    return res.status(400).json({ error: 'rate_bps must be an integer between 0 and 3000 (0–30%)' })
  }

  // The year the base is drawn from. Defaults to the assessment's own
  // year, which is what every assessment meant before this existed.
  const baseYear = req.body?.base_year != null ? String(req.body.base_year) : year
  if (!YEAR_RE.test(baseYear)) return res.status(400).json({ error: 'base_year must be a four-digit year' })

  const notes = req.body?.notes != null ? String(req.body.notes).trim() || null : null

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO ochr_assessments (diocese_org_id, fiscal_year, rate_bps, notes, bands, base_year)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.organizationId, year, bps, notes, bands ? JSON.stringify(bands) : null, baseYear]
    )
    const id = rows[0].id
    for (const b of await computeBases(req.organizationId, baseYear)) {
      const { assessed, breakdown } = assessFor(b.base, { bands, rate_bps: bps })
      await client.query(
        `INSERT INTO ochr_assessment_lines (assessment_id, parish_org_id, base, rate_bps, assessed, breakdown)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, b.parish_org_id, b.base, bps, assessed, breakdown ? JSON.stringify(breakdown) : null]
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
      `SELECT fiscal_year, rate_bps, status, bands,
              COALESCE(base_year, fiscal_year) AS base_year
         FROM ochr_assessments
        WHERE id = $1 AND diocese_org_id = $2 FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!a.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    if (a[0].status !== 'draft') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only a draft assessment can be recomputed' }) }

    const bases = await computeBases(req.organizationId, a[0].base_year)
    for (const b of bases) {
      // A line that carries a per-parish override keeps it: the DO UPDATE
      // re-derives at the LINE's own rate, not the year's. A line with no
      // override follows the year's ladder, so `breakdown` is recomputed
      // from the new base and stays true to the number beside it.
      const fresh = assessFor(b.base, { bands: a[0].bands, rate_bps: a[0].rate_bps })
      await client.query(
        `INSERT INTO ochr_assessment_lines (assessment_id, parish_org_id, base, rate_bps, assessed, breakdown)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (assessment_id, parish_org_id) DO UPDATE SET
           base = EXCLUDED.base,
           assessed = CASE
             WHEN ochr_assessment_lines.rate_bps IS DISTINCT FROM $4
               THEN ROUND(EXCLUDED.base * ochr_assessment_lines.rate_bps / 10000.0, 2)
             ELSE EXCLUDED.assessed END,
           breakdown = CASE
             WHEN ochr_assessment_lines.rate_bps IS DISTINCT FROM $4
               THEN NULL
             ELSE EXCLUDED.breakdown END,
           updated_at = NOW()`,
        [id, b.parish_org_id, b.base, a[0].rate_bps, fresh.assessed,
         fresh.breakdown ? JSON.stringify(fresh.breakdown) : null]
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

// PUBLISH A BILL THAT IS STILL TRUE (4 Sep).
//
// Publishing freezes the lines as the authoritative bill, and the lines
// are whatever the last draft computation left. An approval that landed
// after the draft — or during the publish — was silently missing from the
// bill, and once published there was no way back: recompute is draft-only,
// the line PATCH does not take a base, and a second assessment for the
// year is a 409. Reproduced: H1 approved, draft at 10,000; H2 approved;
// publish → 200 with the bill still at 10,000 against an approved truth
// of 30,000.
//
// So before the status flips, the bases are recomputed and compared to
// the stored lines. Any difference is a 409 naming the parishes, and
// nothing is frozen. This deliberately does NOT recompute on publish:
// the chancery is about to freeze what is on its screen, and quietly
// replacing those numbers on the way to the freeze would be the same
// defect wearing a different face. Recompute is a click away and shows
// its result first.
//
// "Different" means "recompute would change it": a parish with a base and
// no line, a line whose base moved, or a line whose parish no longer
// qualifies and that recompute would drop (untouched: no payment, not
// waived). A line recompute would keep — paid or waived — is not a
// reason to refuse, or recompute-then-publish could never succeed.
function staleLines(lines, bases) {
  const num = v => Number(v) || 0
  const byParish = new Map(bases.map(b => [b.parish_org_id, num(b.base)]))
  const changed = []
  for (const l of lines) {
    if (byParish.has(l.parish_org_id)) {
      if (num(l.base) !== byParish.get(l.parish_org_id)) {
        changed.push({ parish_org_id: l.parish_org_id, parish_name: l.parish_name, was: money(l.base), now: money(byParish.get(l.parish_org_id)) })
      }
      byParish.delete(l.parish_org_id)
    } else if (num(l.paid) === 0 && l.status !== 'waived') {
      changed.push({ parish_org_id: l.parish_org_id, parish_name: l.parish_name, was: money(l.base), now: null })
    }
  }
  for (const [parish_org_id, base] of byParish) {
    changed.push({ parish_org_id, parish_name: null, was: null, now: money(base) })
  }
  return changed
}

// PATCH /api/diocese/assessments/:id — { status?, notes? }
// Lifecycle: draft → published → closed (forward only).
const NEXT_STATUS = { published: 'draft', closed: 'published' }
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const nextStatus = req.body?.status
  if (nextStatus != null && !(nextStatus in NEXT_STATUS)) {
    return res.status(400).json({ error: "status must be 'published' or 'closed'" })
  }
  const client = await pool.connect()
  const refuse = async (status, body) => { await client.query('ROLLBACK'); return res.status(status).json(body) }
  try {
    // FOR UPDATE, as recompute does: a recompute and a publish must not
    // interleave, or the check below could pass against lines that are
    // being rewritten underneath it.
    await client.query('BEGIN')
    const { rows: found } = await client.query(
      `SELECT id, status, COALESCE(base_year, fiscal_year) AS base_year
         FROM ochr_assessments WHERE id = $1 AND diocese_org_id = $2 FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!found.length) return refuse(404, { error: 'Not found' })
    const a = found[0]

    const sets = ['updated_at = NOW()']
    const params = []
    if (nextStatus) {
      if (a.status !== NEXT_STATUS[nextStatus]) {
        return refuse(400, { error: `Cannot move from '${a.status}' to '${nextStatus}'` })
      }
      if (nextStatus === 'published') {
        const { rows: lines } = await client.query(
          `SELECT l.parish_org_id, p.name AS parish_name, l.base, l.paid, l.status
             FROM ochr_assessment_lines l
             JOIN ochr_organizations p ON p.id = l.parish_org_id
            WHERE l.assessment_id = $1`,
          [id]
        )
        const changed = staleLines(lines, await computeBases(req.organizationId, a.base_year, client))
        if (changed.length) {
          return refuse(409, {
            error: 'Approved periods changed since this bill was computed. Recompute before publishing.',
            code: 'assessment_stale',
            changed,
          })
        }
      }
      params.push(nextStatus); sets.push(`status = $${params.length}`)
    }
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'notes')) {
      params.push(req.body.notes != null ? String(req.body.notes).trim() || null : null)
      sets.push(`notes = $${params.length}`)
    }
    params.push(id, req.organizationId)
    await client.query(
      `UPDATE ochr_assessments SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND diocese_org_id = $${params.length}`,
      params
    )
    await client.query('COMMIT')
    res.json(await detail(id, req.organizationId))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('assessments.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update the assessment' })
  } finally {
    client.release()
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
      // An override is one negotiated flat rate for one parish, not a
      // second ladder. Leaving the old breakdown would explain the bill
      // with arithmetic that no longer produces it.
      sets.push('breakdown = NULL')
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
