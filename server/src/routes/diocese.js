// Diocese routes (DIO.1) — the umbrella org's side of affiliation.
// Mounted with requireOrgType('diocese'): a parish token gets 403 on
// every path here, reads included.
//
//   GET   /api/diocese/parishes        → affiliation roster
//   POST  /api/diocese/parishes/invite → invite a parish by its admin's email
//   PATCH /api/diocese/parishes/:id    → suspend / reactivate / end
//   GET   /api/diocese/coa             → the diocese's chart of accounts
//   PUT   /api/diocese/coa             → customize it; affiliated parishes inherit
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
import { financialObservations } from '../finance/observations.js'
import { overlapsRange, findOverlappingSubmission, overlapMessage } from '../finance/fiscalPeriod.js'

const router = Router()

const ROSTER_SELECT = `
  SELECT a.id, a.status, a.grant_level, a.invited_email,
         a.accepted_at, a.created_at, a.region_id,
         p.id AS parish_org_id, p.name AS parish_name, p.slug AS parish_slug
    FROM ochr_diocese_affiliations a
    JOIN ochr_organizations p ON p.id = a.parish_org_id
`

// GET /api/diocese/parishes
router.get('/parishes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      // DISTINCT ON (parish_org_id): the CURRENT affiliation per parish,
      // not every one there has ever been.
      //
      // Migration 094 lets a parish that left be invited back, which means
      // a (diocese, parish) pair can now hold an 'ended' row AND a new live
      // one. Without this the roster would list that parish twice — once as
      // ended, once as invited — and a chancery reading "St. Anne · ended"
      // next to "St. Anne · invited" has to work out which is now true.
      //
      // The inner ordering picks live over ended, then most recent; the
      // outer restores the display order the page expects.
      `SELECT * FROM (
         SELECT DISTINCT ON (a.parish_org_id) a.id, a.status, a.grant_level,
                a.invited_email, a.accepted_at, a.created_at, a.region_id,
                p.id AS parish_org_id, p.name AS parish_name, p.slug AS parish_slug
           FROM ochr_diocese_affiliations a
           JOIN ochr_organizations p ON p.id = a.parish_org_id
          WHERE a.diocese_org_id = $1
          ORDER BY a.parish_org_id,
                   (a.status IN ('invited','active','suspended')) DESC,
                   a.created_at DESC
       ) current
       ORDER BY (status = 'active') DESC, parish_name ASC
       LIMIT 500`,
      [req.organizationId]
    )
    res.json({ parishes: rows })
  } catch (err) {
    monitor.error('diocese.parishes.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the parish roster' })
  }
})

// POST /api/diocese/parishes/cohort (PILOT.3) — bring in a small cohort,
// with a look before you leap.
//
// WHY THIS IS INVITATIONS AND NOT AN IMPORT.
//
// The obvious reading of "import a parish cohort" is a CSV that creates
// parish records. That would contradict the thing the whole product is
// built on: a diocese cannot create a parish's account or enrol it without
// consent. Parishes sign up themselves and ACCEPT — what they share is a
// covenant they enter and can end from their own settings.
//
// So a cohort is a validated batch of INVITATIONS. It reads as a missing
// feature until you notice it is the constraint doing its job.
//
// Two phases, because the point is not to save typing — it is to let
// somebody see what is about to happen before it happens. `dry_run` costs
// one round trip and turns a batch of surprises into a list you can read.
router.post('/parishes/cohort', async (req, res) => {
  const raw = Array.isArray(req.body?.emails) ? req.body.emails
    : typeof req.body?.emails === 'string' ? req.body.emails.split(/[\s,;]+/)
    : null
  if (!raw) return res.status(400).json({ error: 'Send a list of parish admin emails' })

  const dryRun = req.body?.dry_run !== false   // safe by default
  const cleaned = raw.map(e => String(e).trim().toLowerCase()).filter(Boolean)
  if (!cleaned.length) return res.status(400).json({ error: 'That list is empty' })
  if (cleaned.length > 50) {
    return res.status(400).json({
      error: 'That is more than a pilot cohort. Fifty at a time is the limit — a first cohort of four to eight is what the runbook suggests.',
    })
  }

  try {
    const seen = new Set()
    const rows = []
    for (const email of cleaned) {
      // A list pasted from a spreadsheet routinely repeats a line. Saying
      // so is kinder than silently collapsing it.
      if (seen.has(email)) { rows.push({ email, state: 'duplicate', note: 'Listed more than once' }); continue }
      seen.add(email)

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        rows.push({ email, state: 'invalid', note: 'That does not look like an email address' })
        continue
      }

      const { rows: users } = await pool.query(
        `SELECT u.id, u.role, u.organization_id, o.org_type, o.name AS org_name
           FROM ochr_users u JOIN ochr_organizations o ON o.id = u.organization_id
          WHERE u.email = $1`, [email])
      const t = users[0]

      // Own-address first. It reveals nothing the caller does not already
      // know, and checking it after the generic miss made this branch
      // unreachable — a chancery pasting its own address got told no parish
      // administrator existed, which is true and useless.
      if (t && t.organization_id === req.organizationId) {
        rows.push({ email, state: 'invalid', note: 'That address belongs to this diocese' })
        continue
      }
      // Then ONE message for every kind of miss, exactly as the single
      // invite does — otherwise a diocese can probe which addresses exist
      // and what they are.
      if (!t || t.role !== 'admin' || t.org_type !== 'parish') {
        rows.push({ email, state: 'not_found',
          note: 'No parish administrator with that address. They may need to sign up first.' })
        continue
      }

      const { rows: aff } = await pool.query(
        `SELECT status, diocese_org_id FROM ochr_diocese_affiliations
          WHERE parish_org_id = $1 AND status IN ('invited', 'active', 'suspended')`,
        [t.organization_id])
      if (aff.length) {
        const ours = aff[0].diocese_org_id === req.organizationId
        rows.push({
          email, parish_name: t.org_name,
          state: ours ? (aff[0].status === 'invited' ? 'already_invited' : 'already_affiliated') : 'spoken_for',
          // Never name the other diocese. That a parish is affiliated
          // elsewhere is that parish's business.
          note: ours
            ? (aff[0].status === 'invited' ? 'Already invited — still waiting on them' : 'Already with this diocese')
            : 'Already affiliated elsewhere. That is theirs to change, not ours.',
        })
        continue
      }

      rows.push({ email, parish_name: t.org_name, state: 'ready', note: 'Will be invited' })
    }

    const willInvite = rows.filter(r => r.state === 'ready')

    if (dryRun) {
      return res.json({
        preview: true, rows,
        summary: { total: rows.length, ready: willInvite.length,
                   skipped: rows.length - willInvite.length },
      })
    }

    // Commit. Each row is its own statement so one failure cannot cost the
    // rest — a cohort that half-lands and says which half is better than a
    // cohort that rolls back and says nothing.
    const invited = []
    for (const r of willInvite) {
      const { rows: u } = await pool.query(
        `SELECT organization_id FROM ochr_users WHERE email = $1`, [r.email])
      try {
        await pool.query(
          `INSERT INTO ochr_diocese_affiliations (diocese_org_id, parish_org_id, invited_email)
           VALUES ($1, $2, $3)`,
          [req.organizationId, u[0].organization_id, r.email])
        invited.push({ ...r, state: 'invited' })
      } catch (err) {
        // 23505: somebody invited them between the preview and the commit.
        // "Invited by someone else a moment ago" was asserted for EVERY
        // 23505, including the one raised when this diocese re-invited a
        // parish that had left it — blaming a diocese that had done
        // nothing. Say which rule fired, or say nothing about who.
        const dupe = err?.code === '23505'
        const own  = err?.constraint === 'uq_affiliation_one_live_pair'
        invited.push({ ...r, state: dupe ? 'already_invited' : 'failed',
                       note: !dupe ? 'Could not invite'
                             : own ? 'You already have a live invitation or affiliation with this parish'
                                   : 'This parish already has a live affiliation or invitation' })
      }
    }
    res.status(201).json({
      preview: false,
      rows: rows.map(r => invited.find(i => i.email === r.email) ?? r),
      summary: { total: rows.length, invited: invited.filter(i => i.state === 'invited').length,
                 skipped: rows.length - invited.length },
    })
  } catch (err) {
    monitor.error('diocese.cohort', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Could not work through that list' })
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
    // 23505 — a unique violation, but WHICH one changes what the reader
    // should do, and the old single sentence covered a case that no longer
    // exists. Since migration 094 the only way to collide is a LIVE
    // affiliation: this diocese's own, or another diocese's. An 'ended' row
    // no longer blocks anything, which is the point of that migration.
    if (err?.code === '23505') {
      const own = err?.constraint === 'uq_affiliation_one_live_pair'
      return res.status(409).json({
        error: own
          ? 'You already have a live invitation or affiliation with that parish'
          : 'That parish is already affiliated with a diocese, or has an invitation pending',
      })
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
    // Approving is what admits a period to the roll-up and the bill, so
    // this is the last gate before two overlapping periods are both
    // counted (1 Sep). The parish-side POST refuses an overlap at submit
    // time; this catches what that cannot — two overlapping rows that were
    // both 'submitted' before the guard existed, or landed in a race. The
    // second one may still be RETURNED: that is the way to resolve it.
    if (next === 'approved') {
      const { rows: mine } = await pool.query(
        `SELECT organization_id,
                to_char(period_start, 'YYYY-MM-DD') AS period_start,
                to_char(period_end, 'YYYY-MM-DD')   AS period_end
           FROM ochr_report_submissions
          WHERE id = $1 AND diocese_org_id = $2 AND status = 'submitted'`,
        [id, req.organizationId]
      )
      if (mine.length) {
        const overlap = await findOverlappingSubmission(pool, {
          organizationId: mine[0].organization_id, dioceseOrgId: req.organizationId,
          periodStart: mine[0].period_start, periodEnd: mine[0].period_end,
          statuses: ['approved'], excludeId: id,
        })
        if (overlap) {
          return res.status(409).json({
            error: overlapMessage(overlap, 'return this one, or return the approved period and approve this one instead.'),
            code: 'period_overlap',
            overlaps: { id: overlap.id, period_start: overlap.period_start, period_end: overlap.period_end, status: overlap.status },
          })
        }
      }
    }

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
    // 23P01 — the 097 exclusion constraint caught an overlap the
    // check-then-write above raced past. Two concurrent requests both read
    // "no overlap" on separate pooled connections and both wrote; the
    // database refused the second. That is the guard working, so it must
    // read as the same 409 the application check produces, not as "we broke".
    if (err?.code === '23P01') {
      return res.status(409).json({
        error: "This period overlaps another of this parish's live periods. A parish's periods must not overlap.",
        code: 'period_overlap',
      })
    }
    monitor.error('diocese.submissions.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to review the submission' })
  }
})

// GET /api/diocese/financials?start&end — THE roll-up. Reads only
// APPROVED submissions whose period OVERLAPS the range — which is what this
// comment always said and, until 27 Aug, not what the SQL did. It used
// containment, so a July–June parish read $0.00 here while being billed
// $2,420.57 for the same year. The predicate is now named and shared; see
// ../finance/fiscalPeriod.js for why a browse overlaps and an assessment
// partitions. Shape: rollup_group ×
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
          AND ${overlapsRange('$2', '$3')}
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
          AND ${overlapsRange('$3', '$4')}
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

// GET /api/diocese/observations — financial observations (DIO.4). Simple, explainable
// rules over approved submissions; each flag names its rule and numbers.
router.get('/observations', async (req, res) => {
  try {
    res.json({ parishes: await financialObservations(req.organizationId) })
  } catch (err) {
    monitor.error('diocese.observations', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load financial observations' })
  }
})

// ---------------------------------------------------------------------
// Chart of accounts (DIO.5) — the thing that trickles DOWN.
//
// Until now the diocese could only read what parishes sent up. It could
// not say what the accounts MEAN. That made the assessment only as
// trustworthy as each parish's own setup: untick `assessable` locally and
// the chancery never sees it.
//
// A diocese is an organization, and CoA rows are already keyed on
// organization_id, so the diocese's rows live in the same table with no
// migration. The parish-side resolver (finance.js EFFECTIVE_COA) reads
// them as layer 1: structure from the diocese, wording from the parish.

const COA_COLS = ['name', 'acct_type', 'rollup_group', 'assessable', 'sort_order', 'active']
const ACCT_TYPES = new Set(['asset', 'liability', 'net_asset', 'revenue', 'expense'])

// The diocese's own effective CoA: the standard template with the
// diocese's same-code rows shadowing it. Two layers here, not three —
// a diocese has no diocese.
const DIOCESE_COA = `
  SELECT DISTINCT ON (code)
         code, name, acct_type, rollup_group, assessable, sort_order, active,
         (organization_id IS NOT NULL) AS customized
    FROM ochr_coa_accounts
   WHERE organization_id IS NULL OR organization_id = $1
   ORDER BY code, organization_id NULLS LAST
`

// GET /api/diocese/coa
router.get('/coa', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM (${DIOCESE_COA}) c ORDER BY c.sort_order, c.code`,
      [req.organizationId]
    )
    res.json({ accounts: rows })
  } catch (err) {
    monitor.error('diocese.coa.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load chart of accounts' })
  }
})

// PUT /api/diocese/coa  { accounts: [{ code, name?, acct_type?, ... }] }
//
// Upsert, not replace. A diocese customizing three accounts should not
// have to resend the other ninety, and a truncating PUT would make an
// interrupted save catastrophic rather than annoying.
router.put('/coa', async (req, res) => {
  const list = req.body?.accounts
  if (!Array.isArray(list) || list.length === 0) {
    return res.status(400).json({ error: 'accounts must be a non-empty array' })
  }
  if (list.length > 500) {
    return res.status(400).json({ error: 'Too many accounts in one request (max 500)' })
  }

  const orgId = req.organizationId
  const client = await pool.connect()
  try {
    // Resolve each row against what the diocese effectively has today, so
    // a partial patch ({code, assessable}) keeps the template's name and
    // type instead of nulling them.
    const { rows: current } = await client.query(
      `SELECT * FROM (${DIOCESE_COA}) c`, [orgId]
    )
    const byCode = new Map(current.map(r => [r.code, r]))

    const resolved = []
    for (const raw of list) {
      const code = String(raw?.code ?? '').trim()
      if (!/^\d{4}$/.test(code)) {
        return res.status(400).json({ error: `Invalid account code: ${JSON.stringify(raw?.code)}` })
      }
      const base = byCode.get(code)
      const merged = {}
      for (const col of COA_COLS) {
        merged[col] = raw[col] !== undefined ? raw[col] : base?.[col]
      }
      // A brand-new code the template does not carry needs the full shape.
      if (merged.name == null || merged.acct_type == null || merged.rollup_group == null) {
        return res.status(400).json({ error: `New account ${code} needs name, acct_type and rollup_group` })
      }
      if (!ACCT_TYPES.has(merged.acct_type)) {
        return res.status(400).json({ error: `Invalid acct_type for ${code}: ${merged.acct_type}` })
      }
      resolved.push({
        code,
        name: String(merged.name).trim().slice(0, 200),
        acct_type: merged.acct_type,
        rollup_group: String(merged.rollup_group).trim().slice(0, 100),
        assessable: Boolean(merged.assessable),
        sort_order: Number.isInteger(merged.sort_order) ? merged.sort_order : 0,
        active: merged.active === undefined ? true : Boolean(merged.active),
      })
    }

    await client.query('BEGIN')
    for (const a of resolved) {
      await client.query(
        `INSERT INTO ochr_coa_accounts
           (organization_id, code, name, acct_type, rollup_group, assessable, sort_order, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id, code) WHERE organization_id IS NOT NULL
         DO UPDATE SET name = EXCLUDED.name, acct_type = EXCLUDED.acct_type,
                       rollup_group = EXCLUDED.rollup_group, assessable = EXCLUDED.assessable,
                       sort_order = EXCLUDED.sort_order, active = EXCLUDED.active`,
        [orgId, a.code, a.name, a.acct_type, a.rollup_group, a.assessable, a.sort_order, a.active]
      )
    }
    await client.query('COMMIT')

    const { rows } = await client.query(
      `SELECT * FROM (${DIOCESE_COA}) c ORDER BY c.sort_order, c.code`, [orgId]
    )
    res.json({ accounts: rows, updated: resolved.length })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('diocese.coa.put', err, { orgId })
    res.status(500).json({ error: 'Failed to save chart of accounts' })
  } finally {
    client.release()
  }
})

export default router
