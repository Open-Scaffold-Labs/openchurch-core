// Finance routes (FIN.1) — chart of accounts, mappings, and the parish
// ledger. Sprint A of the OpenDiocese blueprint, parish-side.
//
//   GET  /api/finance/coa               → effective chart of accounts
//   GET  /api/finance/mappings          → this org's category → account mappings
//   PUT  /api/finance/mappings          → replace/upsert mappings (admin/staff)
//   GET  /api/finance/ledger?start&end  → ledger rows (paginated)
//   POST /api/finance/ledger            → manual entry
//   POST /api/finance/ledger/import     → trial-balance CSV import
//   GET  /api/finance/summary?start&end → totals by rollup group + assessable base
//   GET  /api/finance/diocese           → this parish's view of its diocese
//
// The "effective" chart of accounts is the standard template
// (organization_id NULL) with this org's same-code rows shadowing it —
// see migration 057. The ledger is the ochr_parish_ledger projection:
// donations + payroll derive through mappings at read time; only manual
// and imported rows live in ochr_ledger_entries.
//
// All queries scope on organization_id. Writes are staff/admin via the
// mount-level writeGate; viewers read.

import { Router } from 'express'
import crypto from 'node:crypto'
import pool from '../db.js'
import { parsePagination } from '../utils/params.js'
import { parseCSVToObjects } from '../utils/csv.js'
import { monitor } from '../monitoring/index.js'
import { computePeriodTotals } from '../finance/periodTotals.js'
import { EFFECTIVE_COA } from '../finance/effectiveCoa.js'

const router = Router()

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const CODE_RE  = /^\d{4}$/


async function effectiveCodes(orgId) {
  const { rows } = await pool.query(
    `SELECT code FROM (${EFFECTIVE_COA}) c WHERE c.active`, [orgId]
  )
  return new Set(rows.map(r => r.code))
}

// GET /api/finance/coa
router.get('/coa', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM (${EFFECTIVE_COA}) c ORDER BY c.sort_order, c.code`,
      [req.organizationId]
    )
    res.json({ accounts: rows })
  } catch (err) {
    monitor.error('finance.coa', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the chart of accounts' })
  }
})

// GET /api/finance/mappings
router.get('/mappings', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, source_type, source_key, account_code
         FROM ochr_coa_mappings
        WHERE organization_id = $1
        ORDER BY source_type, source_key`,
      [req.organizationId]
    )
    // Surface the org's distinct donation categories so the mappings UI
    // can offer every category that actually appears in the book.
    const { rows: cats } = await pool.query(
      `SELECT DISTINCT COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category
         FROM ochr_donations WHERE organization_id = $1 ORDER BY 1 LIMIT 100`,
      [req.organizationId]
    )
    res.json({ mappings: rows, donation_categories: cats.map(c => c.category) })
  } catch (err) {
    monitor.error('finance.mappings.get', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load mappings' })
  }
})

// PUT /api/finance/mappings — upsert a batch of mappings. Body:
// { mappings: [{ source_type, source_key, account_code }] }
// An empty/blank account_code removes the mapping (falls back to default).
router.put('/mappings', async (req, res) => {
  const list = Array.isArray(req.body?.mappings) ? req.body.mappings : null
  if (!list) return res.status(400).json({ error: 'mappings array is required' })
  if (list.length > 200) return res.status(400).json({ error: 'Too many mappings in one request (max 200)' })

  try {
    const codes = await effectiveCodes(req.organizationId)
    for (const m of list) {
      const type = m?.source_type
      const key  = typeof m?.source_key === 'string' ? m.source_key.trim() : ''
      const code = typeof m?.account_code === 'string' ? m.account_code.trim() : ''
      if (!['donation_category', 'payroll'].includes(type) || !key) {
        return res.status(400).json({ error: 'Each mapping needs a valid source_type and source_key' })
      }
      if (code && !codes.has(code)) {
        return res.status(400).json({ error: `Unknown account code ${code}` })
      }
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const m of list) {
        const key  = m.source_key.trim()
        const code = (m.account_code ?? '').trim()
        if (!code) {
          await client.query(
            `DELETE FROM ochr_coa_mappings
              WHERE organization_id = $1 AND source_type = $2 AND source_key = $3`,
            [req.organizationId, m.source_type, key]
          )
        } else {
          await client.query(
            `INSERT INTO ochr_coa_mappings (organization_id, source_type, source_key, account_code)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (organization_id, source_type, source_key)
             DO UPDATE SET account_code = EXCLUDED.account_code`,
            [req.organizationId, m.source_type, key, code]
          )
        }
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

    res.json({ ok: true, count: list.length })
  } catch (err) {
    monitor.error('finance.mappings.put', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save mappings' })
  }
})

// GET /api/finance/ledger?start&end&account&source
router.get('/ledger', async (req, res) => {
  const { limit, offset } = parsePagination(req.query)
  const start = ISO_DATE.test(req.query.start ?? '') ? req.query.start : null
  const end   = ISO_DATE.test(req.query.end ?? '')   ? req.query.end   : null

  try {
    const where = ['l.organization_id = $1']
    const params = [req.organizationId]
    if (start) { params.push(start); where.push(`l.entry_date >= $${params.length}`) }
    if (end)   { params.push(end);   where.push(`l.entry_date <= $${params.length}`) }
    if (CODE_RE.test(req.query.account ?? '')) {
      params.push(req.query.account); where.push(`l.account_code = $${params.length}`)
    }
    if (['manual', 'import', 'donation', 'payroll'].includes(req.query.source)) {
      params.push(req.query.source); where.push(`l.source_type = $${params.length}`)
    }
    params.push(limit, offset)

    const { rows } = await pool.query(
      `SELECT to_char(l.entry_date, 'YYYY-MM-DD') AS entry_date,
              l.account_code, c.name AS account_name, c.acct_type,
              l.amount, l.source_type, l.source_id, l.memo
         FROM ochr_parish_ledger l
         LEFT JOIN (${EFFECTIVE_COA}) c ON c.code = l.account_code
        WHERE ${where.join(' AND ')}
        ORDER BY l.entry_date DESC, l.source_type, l.source_id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    res.json({ entries: rows })
  } catch (err) {
    monitor.error('finance.ledger.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the ledger' })
  }
})

// POST /api/finance/ledger — manual entry
router.post('/ledger', async (req, res) => {
  const entryDate = ISO_DATE.test(req.body?.entry_date ?? '') ? req.body.entry_date : null
  const code = typeof req.body?.account_code === 'string' ? req.body.account_code.trim() : ''
  const memo = req.body?.memo != null ? String(req.body.memo).trim() || null : null
  const amount = Number(req.body?.amount)

  if (!entryDate) return res.status(400).json({ error: 'entry_date (YYYY-MM-DD) is required' })
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'Amount must be a non-zero number' })
  if (Math.abs(amount) > 99_999_999) return res.status(400).json({ error: 'Amount is out of range' })

  try {
    const codes = await effectiveCodes(req.organizationId)
    if (!codes.has(code)) return res.status(400).json({ error: `Unknown account code ${code || '(blank)'}` })

    const { rows } = await pool.query(
      `INSERT INTO ochr_ledger_entries (organization_id, entry_date, account_code, amount, memo, source_type, created_by)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6)
       RETURNING id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, account_code, amount, memo, source_type`,
      [req.organizationId, entryDate, code, amount, memo, req.user?.id ?? null]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('finance.ledger.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save the entry' })
  }
})

// POST /api/finance/ledger/import — trial-balance CSV.
// Body: { csv, as_of } — columns: account_code, amount, memo (optional).
// The pragmatic wedge: a parish that keeps its books in QuickBooks can be
// consolidated on one period upload. Amounts are period totals dated as_of.
const IMPORT_COLUMNS = ['account_code', 'amount', 'memo']
router.post('/ledger/import', async (req, res) => {
  const { csv, as_of } = req.body ?? {}
  if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'No CSV content provided' })
  if (!ISO_DATE.test(as_of ?? '')) return res.status(400).json({ error: 'as_of (YYYY-MM-DD) is required — the period-end date these balances describe' })

  try {
    const { headers, rows } = parseCSVToObjects(csv)
    if (!headers.length) return res.status(400).json({ error: 'CSV appears to be empty' })
    for (const required of ['account_code', 'amount']) {
      if (!headers.includes(required)) {
        return res.status(400).json({ error: `CSV must include a "${required}" column. Expected columns: ${IMPORT_COLUMNS.join(', ')}.` })
      }
    }
    const unknown = headers.filter(h => !IMPORT_COLUMNS.includes(h))
    if (unknown.length) return res.status(400).json({ error: `Unknown column(s): ${unknown.join(', ')}. Allowed: ${IMPORT_COLUMNS.join(', ')}.` })
    if (!rows.length) return res.status(400).json({ error: 'CSV has a header row but no data rows' })
    if (rows.length > 500) return res.status(400).json({ error: 'Imports are capped at 500 rows per file' })

    const codes = await effectiveCodes(req.organizationId)
    const batch = crypto.randomUUID()
    const results = { imported: 0, errors: [], batch }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const line = i + 2
      const code = (row.account_code ?? '').trim()
      const amount = Number(row.amount)
      if (!codes.has(code)) { results.errors.push({ line, error: `Unknown account code "${code}"` }); continue }
      if (!Number.isFinite(amount) || amount === 0) { results.errors.push({ line, error: `Invalid amount "${row.amount}"` }); continue }
      if (Math.abs(amount) > 99_999_999) { results.errors.push({ line, error: 'Amount out of range' }); continue }

      try {
        await pool.query(
          `INSERT INTO ochr_ledger_entries (organization_id, entry_date, account_code, amount, memo, source_type, import_batch, created_by)
           VALUES ($1, $2, $3, $4, $5, 'import', $6, $7)`,
          [req.organizationId, as_of, code, amount, (row.memo ?? '').trim() || null, batch, req.user?.id ?? null]
        )
        results.imported++
      } catch {
        results.errors.push({ line, error: 'Row failed to save' })
      }
    }

    res.status(results.imported > 0 ? 201 : 400).json(results)
  } catch (err) {
    monitor.error('finance.ledger.import', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Import failed — nothing may have been saved. Please retry.' })
  }
})

// GET /api/finance/summary?start&end — totals by rollup group, plus the
// assessable revenue base. Computed by the SAME function that freezes a
// submission's totals_json (finance/periodTotals.js), so the live view
// and the submitted report can never disagree.
router.get('/summary', async (req, res) => {
  const start = ISO_DATE.test(req.query.start ?? '') ? req.query.start : '1900-01-01'
  const end   = ISO_DATE.test(req.query.end ?? '')   ? req.query.end   : '2999-12-31'
  try {
    const t = await computePeriodTotals(req.organizationId, start, end)
    res.json({ start, end, ...t })
  } catch (err) {
    monitor.error('finance.summary', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to build the summary' })
  }
})

// ── Period submissions (DIO.2) — the parish side ─────────────
// Submitting freezes this period's totals for the diocese. Requires an
// ACTIVE affiliation; a 'returned' submission is resubmitted in place.

// GET /api/finance/submissions
router.get('/submissions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, to_char(s.period_start, 'YYYY-MM-DD') AS period_start,
              to_char(s.period_end, 'YYYY-MM-DD') AS period_end,
              s.status, s.review_note, s.submitted_at, s.reviewed_at,
              s.totals_json->'totals' AS totals,
              d.name AS diocese_name
         FROM ochr_report_submissions s
         JOIN ochr_organizations d ON d.id = s.diocese_org_id
        WHERE s.organization_id = $1
        ORDER BY s.period_end DESC
        LIMIT 60`,
      [req.organizationId]
    )
    res.json({ submissions: rows })
  } catch (err) {
    monitor.error('finance.submissions.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load submissions' })
  }
})

// POST /api/finance/submissions — body: { period_start, period_end }
router.post('/submissions', async (req, res) => {
  const start = ISO_DATE.test(req.body?.period_start ?? '') ? req.body.period_start : null
  const end   = ISO_DATE.test(req.body?.period_end ?? '')   ? req.body.period_end   : null
  if (!start || !end) return res.status(400).json({ error: 'period_start and period_end (YYYY-MM-DD) are required' })
  if (end < start) return res.status(400).json({ error: 'period_end must be on or after period_start' })

  try {
    const { rows: aff } = await pool.query(
      `SELECT diocese_org_id FROM ochr_diocese_affiliations
        WHERE parish_org_id = $1 AND status = 'active'`,
      [req.organizationId]
    )
    if (!aff.length) return res.status(400).json({ error: 'This parish has no active diocese affiliation' })
    const dioceseId = aff[0].diocese_org_id

    const totals = await computePeriodTotals(req.organizationId, start, end)

    // New period → insert. Returned period → resubmit in place with
    // freshly-computed totals. Submitted/approved period → 409: the
    // frozen report is authoritative until the chancery returns it.
    const { rows } = await pool.query(
      `INSERT INTO ochr_report_submissions
         (organization_id, diocese_org_id, period_start, period_end, totals_json, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, diocese_org_id, period_start, period_end)
       DO UPDATE SET
         totals_json = EXCLUDED.totals_json,
         status = 'submitted',
         submitted_by = EXCLUDED.submitted_by,
         submitted_at = NOW(),
         reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
       WHERE ochr_report_submissions.status = 'returned'
       RETURNING id, status`,
      [req.organizationId, dioceseId, start, end, JSON.stringify(totals), req.user?.id ?? null]
    )
    if (!rows.length) {
      return res.status(409).json({ error: 'That period is already submitted or approved. The chancery must return it before you can resubmit.' })
    }
    res.status(201).json({ id: rows[0].id, status: rows[0].status, totals: totals.totals })
  } catch (err) {
    monitor.error('finance.submissions.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to submit the period' })
  }
})

// GET /api/finance/diocese — what the parish can see of its own diocese
// (DIO.5). The return path. Everything above this line flows UP; a parish
// had no way to see what came back down: not its assessment, not what the
// chancery was still waiting for, not why a submission was returned.
//
// Read-only, and deliberately narrow:
//   · Only a PUBLISHED (or closed) assessment is visible. A chancery
//     drafting next year's rate is not making a promise to anyone, and a
//     parish seeing a draft rate would treat it as one.
//   · Only this parish's own assessment line. Never another parish's, and
//     never the diocese-wide totals.
//   · An unaffiliated parish gets {affiliated: false} and nothing else,
//     rather than a 404 — the panel should render "no diocese", not break.
router.get('/diocese', async (req, res) => {
  const orgId = req.organizationId
  try {
    const { rows: aff } = await pool.query(
      `SELECT a.diocese_org_id, a.status, a.grant_level, a.accepted_at, o.name AS diocese_name
         FROM ochr_diocese_affiliations a
         JOIN ochr_organizations o ON o.id = a.diocese_org_id
        WHERE a.parish_org_id = $1 AND a.status = 'active'
        LIMIT 1`,
      [orgId]
    )
    if (!aff.length) return res.json({ affiliated: false })
    const dioceseId = aff[0].diocese_org_id

    const [assessment, submissions, returned] = await Promise.all([
      pool.query(
        `SELECT s.fiscal_year, s.basis, s.notes AS diocese_note, s.status AS assessment_status,
                l.base, l.rate_bps, l.assessed, l.paid, l.status, l.note
           FROM ochr_assessment_lines l
           JOIN ochr_assessments s ON s.id = l.assessment_id
          WHERE l.parish_org_id = $1
            AND s.diocese_org_id = $2
            AND s.status IN ('published', 'closed')
          ORDER BY s.fiscal_year DESC
          LIMIT 1`,
        [orgId, dioceseId]
      ),
      pool.query(
        `SELECT status, count(*)::int AS n
           FROM ochr_report_submissions
          WHERE organization_id = $1 AND diocese_org_id = $2
          GROUP BY status`,
        [orgId, dioceseId]
      ),
      pool.query(
        `SELECT period_start, period_end, review_note, reviewed_at
           FROM ochr_report_submissions
          WHERE organization_id = $1 AND diocese_org_id = $2 AND status = 'returned'
          ORDER BY reviewed_at DESC NULLS LAST
          LIMIT 1`,
        [orgId, dioceseId]
      ),
    ])

    const counts = { submitted: 0, approved: 0, returned: 0 }
    for (const r of submissions.rows) counts[r.status] = r.n

    res.json({
      affiliated: true,
      diocese: {
        name: aff[0].diocese_name,
        grant_level: aff[0].grant_level,
        since: aff[0].accepted_at,
      },
      // What the chancery is still waiting on is the actionable number
      // here, so it is named rather than left to be derived.
      submissions: { ...counts, awaiting_review: counts.submitted },
      assessment: assessment.rows[0] ?? null,
      last_returned: returned.rows[0] ?? null,
    })
  } catch (err) {
    monitor.error('finance.diocese', err, { orgId })
    res.status(500).json({ error: 'Failed to load diocese summary' })
  }
})

export default router
