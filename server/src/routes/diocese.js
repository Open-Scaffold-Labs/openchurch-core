// Diocese routes (DIO.1) — the umbrella org's side of affiliation.
// Mounted with requireOrgType('diocese'): a parish token gets 403 on
// every path here, reads included.
//
//   GET   /api/diocese/parishes        → affiliation roster
//   POST  /api/diocese/parishes/invite → invite a parish by its admin's email
//   PATCH /api/diocese/parishes/:id    → suspend / reactivate / end
//
// Invariants:
//   • Every query joins through the caller's diocese_org_id — a diocese
//     can only ever see affiliations it owns.
//   • The diocese can never set an affiliation to 'active'. Activation
//     is the parish's move (acceptance with an explicit grant level).
//   • One live diocese per parish, enforced by a partial unique index —
//     a second diocese's invite gets a clean 409, not a race.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'
import { computeDistress } from '../finance/distress.js'

const router = Router()

const ROSTER_SELECT = `
  SELECT a.id, a.status, a.grant_level, a.invited_email,
         a.accepted_at, a.created_at,
         p.id AS parish_org_id, p.name AS parish_name, p.slug AS parish_slug
    FROM ochr_diocese_affiliations a
    JOIN ochr_organizations p ON p.id = a.parish_org_id
`

// GET /api/diocese/parishes
router.get('/parishes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${ROSTER_SELECT}
        WHERE a.diocese_org_id = $1
        ORDER BY (a.status = 'active') DESC, p.name ASC
        LIMIT 500`,
      [req.organizationId]
    )
    res.json({ parishes: rows })
  } catch (err) {
    monitor.error('diocese.parishes.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the parish roster' })
  }
})

// POST /api/diocese/parishes/invite — body: { email }
// The email must belong to an ADMIN of a parish org: affiliation is an
// org-level covenant, so the invite targets someone empowered to accept it.
router.post('/parishes/invite', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email) return res.status(400).json({ error: 'A parish admin email is required' })

  try {
    const { rows: users } = await pool.query(
      `SELECT u.id, u.role, u.organization_id, o.org_type, o.name AS org_name
         FROM ochr_users u
         JOIN ochr_organizations o ON o.id = u.organization_id
        WHERE u.email = $1`,
      [email]
    )
    // One generic miss message — don't let a diocese probe which emails
    // exist, or what role/type they hold (same shape as forgot-password).
    const target = users[0]
    if (!target || target.role !== 'admin' || target.org_type !== 'parish') {
      return res.status(404).json({ error: 'No parish admin was found with that email' })
    }
    if (target.organization_id === req.organizationId) {
      return res.status(400).json({ error: 'That email belongs to this diocese' })
    }

    const { rows } = await pool.query(
      `INSERT INTO ochr_diocese_affiliations (diocese_org_id, parish_org_id, invited_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [req.organizationId, target.organization_id, email]
    )
    const { rows: full } = await pool.query(
      `${ROSTER_SELECT} WHERE a.id = $1 AND a.diocese_org_id = $2`,
      [rows[0].id, req.organizationId]
    )
    res.status(201).json(full[0])
  } catch (err) {
    // 23505 — unique violation: either this diocese already invited the
    // parish, or the parish already has a live affiliation elsewhere.
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'That parish already has a diocese affiliation or pending invitation' })
    }
    monitor.error('diocese.parishes.invite', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to send the invitation' })
  }
})

// PATCH /api/diocese/parishes/:id — body: { status }
// Diocese-side transitions only: active→suspended, suspended→active
// (reinstate), and anything→ended. Never invited→active.
const DIOCESE_TRANSITIONS = {
  suspended: new Set(['active']),
  active:    new Set(['suspended']),   // reinstate a suspension
  ended:     new Set(['invited', 'active', 'suspended']),
}
router.patch('/parishes/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const next = req.body?.status
  if (!(next in DIOCESE_TRANSITIONS)) {
    return res.status(400).json({ error: "status must be 'active', 'suspended', or 'ended'" })
  }

  try {
    const { rows } = await pool.query(
      `UPDATE ochr_diocese_affiliations a
          SET status = $1, updated_at = NOW()
        WHERE a.id = $2 AND a.diocese_org_id = $3
          AND a.status = ANY($4)
        RETURNING a.id`,
      [next, id, req.organizationId, [...DIOCESE_TRANSITIONS[next]]]
    )
    if (!rows.length) {
      // Distinguish "not yours / doesn't exist" from "yours, but that
      // transition isn't allowed" without leaking other orgs' rows.
      const { rows: mine } = await pool.query(
        'SELECT status FROM ochr_diocese_affiliations WHERE id = $1 AND diocese_org_id = $2',
        [id, req.organizationId]
      )
      if (!mine.length) return res.status(404).json({ error: 'Not found' })
      return res.status(400).json({ error: `Cannot move an affiliation from '${mine[0].status}' to '${next}'` })
    }
    const { rows: full } = await pool.query(
      `${ROSTER_SELECT} WHERE a.id = $1 AND a.diocese_org_id = $2`,
      [id, req.organizationId]
    )
    res.json(full[0])
  } catch (err) {
    monitor.error('diocese.parishes.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update the affiliation' })
  }
})

// ── Submissions review + the roll-up (DIO.2) ─────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// Active-affiliation join used by every read below — the diocese only
// ever sees data for parishes whose affiliation is live, at whatever
// grant level the parish chose.
const ACTIVE_AFF = `
  SELECT parish_org_id, grant_level FROM ochr_diocese_affiliations
   WHERE diocese_org_id = $1 AND status IN ('active', 'suspended')
`

// GET /api/diocese/submissions?status=
// Joined through the live affiliation: when a parish leaves, its
// submissions leave the chancery's view with it. The rows aren't
// deleted — the parish still owns its history — but the covenant is
// what grants the diocese sight, and it lapses with the covenant.
router.get('/submissions', async (req, res) => {
  const statusFilter = ['submitted', 'approved', 'returned'].includes(req.query.status)
    ? req.query.status : null
  try {
    const params = [req.organizationId]
    let where = 's.diocese_org_id = $1'
    if (statusFilter) { params.push(statusFilter); where += ` AND s.status = $${params.length}` }
    const { rows } = await pool.query(
      `SELECT s.id, s.status, s.review_note,
              to_char(s.period_start, 'YYYY-MM-DD') AS period_start,
              to_char(s.period_end, 'YYYY-MM-DD') AS period_end,
              s.submitted_at, s.reviewed_at,
              s.totals_json->'totals' AS totals,
              p.id AS parish_org_id, p.name AS parish_name
         FROM ochr_report_submissions s
         JOIN ochr_organizations p ON p.id = s.organization_id
         JOIN (${ACTIVE_AFF}) aff ON aff.parish_org_id = s.organization_id
        WHERE ${where}
        ORDER BY (s.status = 'submitted') DESC, s.period_end DESC, p.name ASC
        LIMIT 500`,
      params
    )
    res.json({ submissions: rows })
  } catch (err) {
    monitor.error('diocese.submissions.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load submissions' })
  }
})

// PATCH /api/diocese/submissions/:id — body: { status: approved|returned, note? }
router.patch('/submissions/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const next = req.body?.status
  if (!['approved', 'returned'].includes(next)) {
    return res.status(400).json({ error: "status must be 'approved' or 'returned'" })
  }
  const note = req.body?.note != null ? String(req.body.note).trim() || null : null
  if (next === 'returned' && !note) {
    return res.status(400).json({ error: 'Returning a submission requires a note explaining what to fix' })
  }
  try {
    // Review requires a LIVE affiliation (audit follow-up): once a parish
    // leaves, the diocese can no longer act on its in-flight submissions.
    const { rows } = await pool.query(
      `UPDATE ochr_report_submissions s
          SET status = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW()
        WHERE s.id = $4 AND s.diocese_org_id = $5 AND s.status = 'submitted'
          AND EXISTS (
            SELECT 1 FROM ochr_diocese_affiliations a
             WHERE a.diocese_org_id = s.diocese_org_id
               AND a.parish_org_id = s.organization_id
               AND a.status IN ('active', 'suspended')
          )
        RETURNING s.id, s.status`,
      [next, note, req.user?.id ?? null, id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'No reviewable submission found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('diocese.submissions.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to review the submission' })
  }
})

// GET /api/diocese/financials?start&end — THE roll-up. Reads only
// APPROVED submissions whose period overlaps the range: rollup_group ×
// parish matrix plus consolidated totals. Group-level data is what
// every grant level shares; account lines stay behind the per-parish
// drill-down below.
router.get('/financials', async (req, res) => {
  const start = ISO_DATE.test(req.query.start ?? '') ? req.query.start : '1900-01-01'
  const end   = ISO_DATE.test(req.query.end ?? '')   ? req.query.end   : '2999-12-31'
  try {
    const { rows: subs } = await pool.query(
      `SELECT s.organization_id, p.name AS parish_name, s.totals_json,
              to_char(s.period_start, 'YYYY-MM-DD') AS period_start,
              to_char(s.period_end, 'YYYY-MM-DD') AS period_end
         FROM ochr_report_submissions s
         JOIN ochr_organizations p ON p.id = s.organization_id
         JOIN (${ACTIVE_AFF}) aff ON aff.parish_org_id = s.organization_id
        WHERE s.diocese_org_id = $1 AND s.status = 'approved'
          AND s.period_start >= $2 AND s.period_end <= $3
        ORDER BY p.name, s.period_start`,
      [req.organizationId, start, end]
    )

    const num = v => Number(v) || 0
    const parishes = new Map()   // org_id → { name, groups: Map, totals }
    const groupTotals = new Map() // "type|group" → total
    const consolidated = { revenue: 0, expense: 0, assessable_base: 0 }

    for (const s of subs) {
      const t = s.totals_json
      const p = parishes.get(s.organization_id) ?? {
        parish_org_id: s.organization_id, parish_name: s.parish_name,
        groups: new Map(), revenue: 0, expense: 0, assessable_base: 0, periods: 0,
      }
      p.periods += 1
      p.revenue += num(t.totals?.revenue)
      p.expense += num(t.totals?.expense)
      p.assessable_base += num(t.totals?.assessable_base)
      for (const g of t.groups ?? []) {
        const key = `${g.acct_type}|${g.rollup_group}`
        p.groups.set(key, (p.groups.get(key) ?? 0) + num(g.total))
        groupTotals.set(key, (groupTotals.get(key) ?? 0) + num(g.total))
      }
      parishes.set(s.organization_id, p)
      consolidated.revenue += num(t.totals?.revenue)
      consolidated.expense += num(t.totals?.expense)
      consolidated.assessable_base += num(t.totals?.assessable_base)
    }

    res.json({
      start, end,
      submission_count: subs.length,
      groups: [...groupTotals.entries()]
        .map(([key, total]) => {
          const [acct_type, rollup_group] = key.split('|')
          return { acct_type, rollup_group, total: total.toFixed(2) }
        })
        .sort((a, b) => a.acct_type.localeCompare(b.acct_type) || a.rollup_group.localeCompare(b.rollup_group)),
      parishes: [...parishes.values()].map(p => ({
        parish_org_id: p.parish_org_id,
        parish_name: p.parish_name,
        periods: p.periods,
        revenue: p.revenue.toFixed(2),
        expense: p.expense.toFixed(2),
        net: (p.revenue - p.expense).toFixed(2),
        assessable_base: p.assessable_base.toFixed(2),
        groups: [...p.groups.entries()].map(([key, total]) => {
          const [acct_type, rollup_group] = key.split('|')
          return { acct_type, rollup_group, total: total.toFixed(2) }
        }),
      })),
      totals: {
        revenue: consolidated.revenue.toFixed(2),
        expense: consolidated.expense.toFixed(2),
        net: (consolidated.revenue - consolidated.expense).toFixed(2),
        assessable_base: consolidated.assessable_base.toFixed(2),
      },
    })
  } catch (err) {
    monitor.error('diocese.financials', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to build the roll-up' })
  }
})

// GET /api/diocese/parishes/:orgId/financials?start&end — per-parish
// drill-down. Group totals for every live affiliation; ACCOUNT-level
// lines only when the parish granted 'detail'. The grant is the
// parish's choice and it is honored here, not just promised.
router.get('/parishes/:id/financials', async (req, res) => {
  const parishOrgId = requireIntParam(req, res); if (parishOrgId === null) return
  const start = ISO_DATE.test(req.query.start ?? '') ? req.query.start : '1900-01-01'
  const end   = ISO_DATE.test(req.query.end ?? '')   ? req.query.end   : '2999-12-31'
  try {
    const { rows: aff } = await pool.query(
      `SELECT grant_level FROM ochr_diocese_affiliations
        WHERE diocese_org_id = $1 AND parish_org_id = $2 AND status IN ('active', 'suspended')`,
      [req.organizationId, parishOrgId]
    )
    if (!aff.length) return res.status(404).json({ error: 'Not found' })
    const grant = aff[0].grant_level

    const { rows: subs } = await pool.query(
      `SELECT to_char(s.period_start, 'YYYY-MM-DD') AS period_start,
              to_char(s.period_end, 'YYYY-MM-DD') AS period_end,
              s.status, s.totals_json
         FROM ochr_report_submissions s
        WHERE s.diocese_org_id = $1 AND s.organization_id = $2 AND s.status = 'approved'
          AND s.period_start >= $3 AND s.period_end <= $4
        ORDER BY s.period_start`,
      [req.organizationId, parishOrgId, start, end]
    )

    res.json({
      grant_level: grant,
      periods: subs.map(s => ({
        period_start: s.period_start,
        period_end: s.period_end,
        totals: s.totals_json.totals,
        groups: s.totals_json.groups,
        // The grant line: account detail exists in the frozen report but
        // is only released when the parish said 'detail'.
        accounts: grant === 'detail' ? s.totals_json.accounts : undefined,
      })),
    })
  } catch (err) {
    monitor.error('diocese.parishFinancials', err, { orgId: req.organizationId, parishOrgId })
    res.status(500).json({ error: "Failed to load the parish's financials" })
  }
})

// GET /api/diocese/health — distress flags (DIO.4). Simple, explainable
// rules over approved submissions; each flag names its rule and numbers.
router.get('/health', async (req, res) => {
  try {
    res.json({ parishes: await computeDistress(req.organizationId) })
  } catch (err) {
    monitor.error('diocese.health', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to compute parish health' })
  }
})

export default router
