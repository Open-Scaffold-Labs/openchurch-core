// Finance routes (FIN.1) — chart of accounts, mappings, and the parish
// ledger. Sprint A of the OpenDiocese blueprint, parish-side.
//
//   GET  /api/finance/coa               → effective chart of accounts
//   GET  /api/finance/mappings          → this org's category → account mappings
//   PUT  /api/finance/mappings          → append a mapping effective today (admin/staff)
//   GET  /api/finance/ledger?start&end  → ledger rows (paginated)
//   POST /api/finance/ledger            → manual entry
//   POST /api/finance/ledger/import     → balanced trial-balance CSV import
//   GET  /api/finance/summary?start&end → totals by rollup group + assessable base
//   POST /api/finance/parallel-check    → old-system TB vs live totals (read-only)
//   POST /api/finance/cutover/scoreboard → five-line weekly scoreboard (read-only)
//   POST /api/finance/cutover/export    → scoreboard + trial balance CSV
//   GET|POST /api/finance/cutover/signoffs → append-only accountant sign-off
//   GET  /api/finance/cutover/template → Day-1 CSV, every active account at 0.00
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
import { computePeriodTotals, unmappedDonationLines } from '../finance/periodTotals.js'
import { parseOldTrialBalance, compareAccounts, buildScoreboard, scoreboardCsv, templateCsv } from '../finance/cutover.js'
import { acquireSignoffLocks } from '../finance/locks.js'
import { giftAssessableAtFreeze } from '../finance/giftAssessableFreeze.js'
import { EFFECTIVE_COA } from '../finance/effectiveCoa.js'
import { findOverlappingSubmission, overlapMessage, overlapRemedy } from '../finance/fiscalPeriod.js'
import { PERIOD_ADJUSTMENT_LIST_COLS, PERIOD_ADJUSTMENT_LIST_JOINS } from '../finance/periodAdjustmentRollup.js'
import {
  DEPOSIT_ADJUSTMENTS_PENDING, periodHasPendingDepositAdjustments,
  lockSubmissionsForDepositCheck, isDepositLockBusy, DEPOSIT_LOCK_BUSY,
} from '../finance/depositAdjustmentGuard.js'
import { periodHasOpenStipendDispositions, OPEN_STIPEND_DISPOSITIONS_PENDING } from '../finance/stipends.js'
import { applyMappingList, lockParishBooks, MappingRejected } from '../finance/mappingWrite.js'
import {
  dollarsToCents, centsToDollarString, naturalCentsFromSides, sidesFromNatural,
  trialBalanceSides, isOpeningBalanceEquityName, trialBalanceIdempotencyKey,
} from '../finance/trialBalance.js'

const router = Router()

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const CODE_RE  = /^\d{4}$/


async function effectiveCodes(orgId) {
  const { rows } = await pool.query(
    `SELECT code FROM (${EFFECTIVE_COA}) c WHERE c.active`, [orgId]
  )
  return new Set(rows.map(r => r.code))
}

async function chartByCode(orgId) {
  const { rows } = await pool.query(
    `SELECT code, name, acct_type, assessable FROM (${EFFECTIVE_COA}) c WHERE c.active`,
    [orgId]
  )
  return new Map(rows.map(r => [r.code, r]))
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
      `SELECT id, source_type, source_key, account_code, set_by,
              CASE WHEN effective_from = '-infinity'::date THEN '-infinity'
                   ELSE to_char(effective_from, 'YYYY-MM-DD') END AS effective_from
         FROM ochr_coa_mappings
        WHERE organization_id = $1 AND superseded_on IS NULL
        -- Byte order, so 'Plate' and 'plate' list the same way on every
        -- database collation (en_US sorts them the other way round).
        ORDER BY source_type COLLATE "C", source_key COLLATE "C"`,
      [req.organizationId]
    )
    // Surface the org's distinct donation categories so the mappings UI
    // can offer every category that actually appears in the book.
    const { rows: cats } = await pool.query(
      `SELECT DISTINCT COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category
         FROM ochr_donations WHERE organization_id = $1 ORDER BY 1 LIMIT 100`,
      [req.organizationId]
    )
    // …and the funds, which are the STRONGER signal about a gift and the
    // one the ledger now prefers (migration 086). A fund is a real record
    // with a real id; a category is a string somebody typed. Sent with
    // how many gifts each fund carries, so the screen can say what is
    // actually at stake in mapping it.
    const { rows: funds } = await pool.query(
      `SELECT f.id, f.name, f.active, f.net_asset_class, f.restriction_nature,
              COUNT(d.id)::int AS gift_count,
              COALESCE(SUM(d.live_amount), 0)::NUMERIC(12,2) AS gift_total
         FROM ochr_funds f
         LEFT JOIN ochr_donation_live d
                ON d.fund_id = f.id AND d.organization_id = f.organization_id
        WHERE f.organization_id = $1
        GROUP BY f.id, f.name, f.active, f.net_asset_class, f.restriction_nature,
                 f.sort_order
        ORDER BY f.sort_order, f.name`,
      [req.organizationId]
    )
    const { rows: [cut] } = await pool.query(
      `SELECT to_char(cutover_on, 'YYYY-MM-DD') AS c FROM ochr_books_cutover`)
    const lines = cut
      ? await unmappedDonationLines(req.organizationId, cut.c, '2999-12-31')
      : []
    res.json({
      mappings: rows,
      donation_categories: cats.map(c => c.category),
      funds,
      mapping_prompt: lines.length
        ? { since: cut.c, lines, total: lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2) }
        : null,
    })
  } catch (err) {
    monitor.error('finance.mappings.get', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load mappings' })
  }
})

// PUT /api/finance/mappings — append mappings effective on a date.
// Body: { mappings: [{ source_type, source_key, account_code }], effective_from? }
// A blank account_code closes the open row. Nothing already posted is rewritten.
router.put('/mappings', async (req, res) => {
  const list = Array.isArray(req.body?.mappings) ? req.body.mappings : null
  if (!list) return res.status(400).json({ error: 'mappings array is required' })
  if (list.length > 200) return res.status(400).json({ error: 'Too many mappings in one request (max 200)' })

  try {
    const requested = req.body?.effective_from
    if (requested != null && requested !== '' && (typeof requested !== 'string' || !ISO_DATE.test(requested))) {
      return res.status(400).json({ error: 'effective_from must be YYYY-MM-DD' })
    }

    const byCode = await chartByCode(req.organizationId)
    for (const m of list) {
      const type = m?.source_type
      const key  = typeof m?.source_key === 'string' ? m.source_key.trim() : ''
      const code = typeof m?.account_code === 'string' ? m.account_code.trim() : ''
      if (!['donation_category', 'payroll', 'fund'].includes(type) || !key) {
        return res.status(400).json({ error: 'Each mapping needs a valid source_type and source_key' })
      }
      if (code && !byCode.has(code)) {
        return res.status(400).json({ error: `Unknown account code ${code}` })
      }
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await applyMappingList(client, req.organizationId, list, requested || null, byCode)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (err instanceof MappingRejected) {
        return res.status(err.status).json({ error: err.message, code: err.code })
      }
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

// POST /api/finance/ledger/import — trial-balance CSV, all or nothing.
// Body: { csv, as_of }. Columns: account_code plus either amount (natural
// sign) or debit and credit. A file that does not balance, names Opening
// Balance Equity with a balance, or lands in a submitted period is refused
// and nothing is written.
const IMPORT_COLUMNS = ['account_code', 'amount', 'memo', 'debit', 'credit']
router.post('/ledger/import', async (req, res) => {
  const { csv, as_of } = req.body ?? {}
  if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'No CSV content provided' })
  if (!ISO_DATE.test(as_of ?? '')) return res.status(400).json({ error: 'as_of (YYYY-MM-DD) is required — the period-end date these balances describe' })

  try {
    const { headers, rows } = parseCSVToObjects(csv)
    if (!headers.length) return res.status(400).json({ error: 'CSV appears to be empty' })
    const useSides = headers.includes('debit') || headers.includes('credit')
    if (useSides && (!headers.includes('debit') || !headers.includes('credit'))) {
      return res.status(400).json({ error: 'Debit and credit columns are used together.' })
    }
    if (!headers.includes('account_code') || (!useSides && !headers.includes('amount'))) {
      return res.status(400).json({ error: `CSV must include account_code and either amount or debit and credit. Allowed: ${IMPORT_COLUMNS.join(', ')}.` })
    }
    const unknown = headers.filter(h => !IMPORT_COLUMNS.includes(h))
    if (unknown.length) return res.status(400).json({ error: `Unknown column(s): ${unknown.join(', ')}. Allowed: ${IMPORT_COLUMNS.join(', ')}.` })
    if (!rows.length) return res.status(400).json({ error: 'CSV has a header row but no data rows' })
    if (rows.length > 500) return res.status(400).json({ error: 'Imports are capped at 500 rows per file' })

    const byCode = await chartByCode(req.organizationId)
    const errors = []
    const parsed = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const line = i + 2
      const code = (row.account_code ?? '').trim()
      const account = byCode.get(code)
      if (!account) { errors.push({ line, error: `Unknown account code "${code}"` }); continue }
      let natural = null
      let debitCents = 0
      let creditCents = 0
      if (useSides) {
        const debitRaw = (row.debit ?? '').trim()
        const creditRaw = (row.credit ?? '').trim()
        if ((row.amount ?? '').trim()) {
          errors.push({ line, error: 'A row uses amount or debit and credit, not both.' })
          continue
        }
        if ((debitRaw === '') === (creditRaw === '')) {
          errors.push({ line, error: 'A row is a debit or a credit, not both and not neither.' })
          continue
        }
        const cents = dollarsToCents(debitRaw || creditRaw)
        if (cents == null || cents <= 0) {
          errors.push({ line, error: `Invalid amount "${debitRaw || creditRaw}"` })
          continue
        }
        debitCents = debitRaw ? cents : 0
        creditCents = creditRaw ? cents : 0
        natural = naturalCentsFromSides(account.acct_type, debitCents, creditCents)
      } else {
        const cents = dollarsToCents(row.amount)
        if (cents == null || cents === 0) {
          errors.push({ line, error: `Invalid amount "${row.amount}"` })
          continue
        }
        natural = cents
        const sides = sidesFromNatural(account.acct_type, cents)
        debitCents = sides.debitCents
        creditCents = sides.creditCents
      }
      if (isOpeningBalanceEquityName(account.name) && natural !== 0) {
        errors.push({ line, code: 'opening_balance_equity', error: 'Opening Balance Equity must be zero. Nothing was saved.' })
        continue
      }
      parsed.push({
        code, natural, debitCents, creditCents,
        memo: (row.memo ?? '').trim() || null,
      })
    }
    if (errors.length) {
      const code = errors.find(e => e.code)?.code
      return res.status(400).json({ imported: 0, errors, ...(code ? { code } : {}) })
    }
    const totals = trialBalanceSides(parsed)
    if (!totals.balanced) {
      return res.status(400).json({
        imported: 0,
        code: 'trial_balance_unbalanced',
        debit_cents: totals.debitCents,
        credit_cents: totals.creditCents,
        errors: [{ line: null, error: 'Debits and credits are not equal. Nothing was saved.' }],
      })
    }

    const idempotencyKey = trialBalanceIdempotencyKey(as_of, parsed)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await lockParishBooks(client, req.organizationId)
      const { rows: closed } = await client.query(
        `SELECT id FROM ochr_report_submissions
          WHERE organization_id = $1
            AND status IN ('submitted', 'approved')
            AND period_start <= $2::date AND period_end >= $2::date
          FOR UPDATE`,
        [req.organizationId, as_of])
      if (closed.length) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          imported: 0,
          code: 'period_submitted',
          error: 'That date is inside a period already sent to the diocese. Nothing was saved.',
        })
      }
      const { rows: inserted } = await client.query(
        `INSERT INTO ochr_ledger_imports (organization_id, idempotency_key, as_of, row_count)
         VALUES ($1, $2, $3::date, $4)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [req.organizationId, idempotencyKey, as_of, parsed.length])
      if (!inserted.length) {
        const { rows: [existing] } = await client.query(
          `SELECT id, row_count FROM ochr_ledger_imports
            WHERE organization_id = $1 AND idempotency_key = $2`,
          [req.organizationId, idempotencyKey])
        await client.query('COMMIT')
        return res.status(200).json({
          imported: existing.row_count, errors: [], batch: String(existing.id), idempotent: true,
        })
      }
      const batch = crypto.randomUUID()
      for (const line of parsed) {
        await client.query(
          `INSERT INTO ochr_ledger_entries
             (organization_id, entry_date, account_code, amount, memo, source_type, import_batch, import_id, created_by)
           VALUES ($1, $2, $3, $4, $5, 'import', $6, $7, $8)`,
          [req.organizationId, as_of, line.code, centsToDollarString(line.natural), line.memo,
            batch, inserted[0].id, req.user?.id ?? null])
      }
      await client.query('COMMIT')
      res.status(201).json({ imported: parsed.length, errors: [], batch })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (err?.code === '23505') {
        return res.status(409).json({
          imported: 0, code: 'import_conflict',
          error: 'Another import is saving this file. Nothing new was saved.',
        })
      }
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    monitor.error('finance.ledger.import', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Import failed. Nothing was saved. Please retry.' })
  }
})

// POST /api/finance/parallel-check — side-by-side proof (Landscape #5).
// Body: { csv, start, end } — columns: account_code, amount (old system's
// period totals). Compares them to the SAME live totals /summary shows and
// returns per-account variance in integer cents. READ-ONLY: nothing from
// the old system is written to the ledger. zero_variance is true only when
// every account matches AND every row was read; a skipped row is never a
// silent match.
router.post('/parallel-check', async (req, res) => {
  const { csv, start, end } = req.body ?? {}
  if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'No CSV content provided' })
  if (!ISO_DATE.test(start ?? '') || !ISO_DATE.test(end ?? '')) return res.status(400).json({ error: 'start and end (YYYY-MM-DD) are required' })
  if (start > end) return res.status(400).json({ error: 'start must be on or before end' })
  try {
    const parsed = parseOldTrialBalance(csv)
    if (parsed.headerError) return res.status(400).json({ error: parsed.headerError })
    const { old, errors } = parsed
    const accounts = (await compareAccounts(req.organizationId, old, start, end))
      // eslint-disable-next-line no-unused-vars
      .map(({ in_old_file, ...a }) => a)
    // R413-1: a skipped row means the old side is incomplete, so there is no
    // honest total. null, never an apparent $0.00; per-account lines stay
    // as partial detail.
    const complete = errors.length === 0 && accounts.every(a => a.openchurch_cents !== null)
    const totalVariance = complete ? accounts.reduce((s, a) => s + a.variance_cents, 0) : null
    const zero = complete && accounts.every(a => a.variance_cents === 0)
    res.json({ start, end, basis: 'live', complete, zero_variance: zero, total_variance_cents: totalVariance,
      mismatched: accounts.filter(a => a.variance_cents !== 0).length, accounts, errors })
  } catch (err) {
    monitor.error('finance.parallelCheck', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Could not run the check. Nothing was saved. Please retry.' })
  }
})

// ── Cutover scoreboard (finance/cutover.js) ─────────────────────────────
// Five weekly lines — cash, receivables, deposits, payables, trial balance —
// old system vs OpenChurch as of a date. Read-only except the append-only
// accountant sign-off, which is refused unless the scoreboard recomputed
// server-side is cutover_ready. Staff/admin only (writeGate covers POST;
// the GET checks the role itself).
const STAFF_ROLES = new Set(['admin', 'staff'])
function cutoverInput(req, res) {
  const { csv, as_of } = req.body ?? {}
  if (typeof csv !== 'string' || !csv.trim()) { res.status(400).json({ error: 'No CSV content provided' }); return null }
  if (!ISO_DATE.test(as_of ?? '')) { res.status(400).json({ error: 'as_of (YYYY-MM-DD) is required' }); return null }
  return { csv, as_of }
}

router.post('/cutover/scoreboard', async (req, res) => {
  const input = cutoverInput(req, res); if (!input) return
  try {
    const sb = await buildScoreboard(req.organizationId, input.csv, input.as_of)
    if (sb.headerError) return res.status(400).json({ error: sb.headerError })
    res.json(sb)
  } catch (err) {
    monitor.error('finance.cutover.scoreboard', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Could not build the scoreboard. Nothing was saved. Please retry.' })
  }
})

router.post('/cutover/export', async (req, res) => {
  const input = cutoverInput(req, res); if (!input) return
  try {
    const sb = await buildScoreboard(req.organizationId, input.csv, input.as_of)
    if (sb.headerError) return res.status(400).json({ error: sb.headerError })
    const { rows: [org] } = await pool.query('SELECT name FROM ochr_organizations WHERE id = $1', [req.organizationId])
    res.set('Content-Type', 'text/csv; charset=utf-8')
    res.set('Content-Disposition', `attachment; filename="cutover-scoreboard-${input.as_of}.csv"`)
    res.set('Cache-Control', 'no-store')
    res.send(scoreboardCsv(sb, { orgName: org?.name ?? '' }))
  } catch (err) {
    monitor.error('finance.cutover.export', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Could not build the export. Please retry.' })
  }
})

router.get('/cutover/signoffs', async (req, res) => {
  if (!STAFF_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Staff or admin only' })
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.as_of, s.accountant_name, s.signed_on, s.created_at, u.name AS recorded_by_name
         FROM ochr_cutover_signoffs s
         LEFT JOIN ochr_users u ON u.id = s.recorded_by AND u.organization_id = s.organization_id
        WHERE s.organization_id = $1 ORDER BY s.created_at DESC, s.id DESC LIMIT 100`,
      [req.organizationId])
    res.json({ signoffs: rows })
  } catch (err) {
    monitor.error('finance.cutover.signoffs', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Could not read sign-offs. Please retry.' })
  }
})

// R414-1: the readiness recompute and the INSERT run in ONE transaction
// holding, all-or-nothing and in sorted order, EXCLUSIVE (finance, org) and
// SHARED (chart, template) + (chart, diocese) — see finance/locks.js. Every
// write to a table the scoreboard reads (finance data, the parish's own,
// diocesan and template COA rows, its diocese affiliation) takes the
// opposite mode via a row trigger (migration 129), so it either commits
// before the recompute (and is seen) or waits until the sign-off commits.
// Lock acquisition is bounded (2 s → 503 cutover_busy); lock_timeout and
// statement_timeout bound everything else. The row records the snapshot.
router.post('/cutover/signoffs', async (req, res) => {
  const input = cutoverInput(req, res); if (!input) return
  // Atlas P1-2: an attestation always names who recorded it.
  if (!Number.isInteger(req.user?.id)) return res.status(401).json({ error: 'A signed-in staff user is required to record a sign-off' })
  const name = typeof req.body?.accountant_name === 'string' ? req.body.accountant_name.trim() : ''
  const signedOn = req.body?.signed_on
  if (!name || name.length > 200) return res.status(400).json({ error: "The accountant's name is required" })
  if (!ISO_DATE.test(signedOn ?? '')) return res.status(400).json({ error: 'signed_on (YYYY-MM-DD) is required' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '2s'`)
    await client.query(`SET LOCAL statement_timeout = '30s'`)
    const locks = await acquireSignoffLocks(client, req.organizationId)
    if (!locks.ok) {
      await client.query('ROLLBACK')
      return res.status(503).json({ code: 'cutover_busy', error: 'The books are being updated right now. Please retry the sign-off in a moment.' })
    }
    const { rows: [snap] } = await client.query(`SELECT clock_timestamp() AS at, pg_current_snapshot()::text AS marker`)
    const sb = await buildScoreboard(req.organizationId, input.csv, input.as_of, client)
    if (sb.headerError) { await client.query('ROLLBACK'); return res.status(400).json({ error: sb.headerError }) }
    if (!sb.cutover_ready) {
      await client.query('ROLLBACK')
      return res.status(409).json({ code: 'cutover_not_ready', error: 'Every line must match to $0.00 with a complete file before a sign-off can be recorded.', lines: sb.lines })
    }
    const { rows: [row] } = await client.query(
      `INSERT INTO ochr_cutover_signoffs (organization_id, as_of, accountant_name, signed_on, scoreboard, recorded_by, snapshot_at, snapshot_marker)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, as_of, accountant_name, signed_on, created_at, snapshot_at, snapshot_marker`,
      [req.organizationId, input.as_of, name, signedOn,
        JSON.stringify({ lines: sb.lines, accounts: sb.accounts, snapshot: { at: snap.at, marker: snap.marker, diocese_org_id: locks.dioceseOrgId } }),
        req.user.id, snap.at, snap.marker])
    await client.query('COMMIT')
    res.status(201).json(row)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('finance.cutover.signoff', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'The sign-off was not recorded. Please retry.' })
  } finally { client.release() }
})

// GET /api/finance/cutover/template — every active chart account at 0.00.
router.get('/cutover/template', async (req, res) => {
  if (!STAFF_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Staff or admin only' })
  try {
    res.set('Content-Type', 'text/csv; charset=utf-8')
    res.set('Content-Disposition', 'attachment; filename="old-system-trial-balance-template.csv"')
    res.set('Cache-Control', 'no-store')
    res.send(await templateCsv(req.organizationId))
  } catch (err) {
    monitor.error('finance.cutover.template', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Could not build the template. Please retry.' })
  }
})

// GET /api/finance/summary?start&end — LIVE totals by rollup group, plus
// the assessable revenue base. Computed by the SAME function that freezes
// a submission's totals_json (finance/periodTotals.js). After a later
// refund those two numbers can disagree: this response is the live books,
// not the approved snapshot. `basis: 'live'` says so; do not read it as
// an approved period.
router.get('/summary', async (req, res) => {
  const start = ISO_DATE.test(req.query.start ?? '') ? req.query.start : '1900-01-01'
  const end   = ISO_DATE.test(req.query.end ?? '')   ? req.query.end   : '2999-12-31'
  try {
    const t = await computePeriodTotals(req.organizationId, start, end)
    const lines = await unmappedDonationLines(req.organizationId, start, end)
    res.json({
      start, end, basis: 'live', ...t,
      mapping_prompt: lines.length
        ? { lines, total: lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2) }
        : null,
    })
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
              -- Frozen totals are archival (099). OPEN is the unresolved
              -- condition; APPLIED credits (106) are the payable net.
              -- Shipping totals without these lets every renderer imply
              -- the figures already net later refunds. They do not.
              ${PERIOD_ADJUSTMENT_LIST_COLS},
              d.name AS diocese_name
         FROM ochr_report_submissions s
         JOIN ochr_organizations d ON d.id = s.diocese_org_id
         ${PERIOD_ADJUSTMENT_LIST_JOINS}
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
//
// ONE TRANSACTION, ONE SNAPSHOT (4 Sep). The totals used to be computed by
// an autocommit SELECT and the row written by a second statement, and a
// gift committed in the gap between them was inside the period, outside
// the frozen totals, and EARLIER than the row's own submitted_at. The
// frozen report then said, in its own timestamp, that the gift should have
// been in it. Reproduced deterministically: revenue 1000.00 frozen at
// 01:05:35.377Z, a 777.00 gift dated in-period committed at .368Z.
//
// So the affiliation read, the overlap check, the totals and the write now
// run on one client at REPEATABLE READ. The isolation level is what makes
// the promise structural rather than probable: the totals SELECT sees the
// transaction's snapshot, and submitted_at = NOW() is the transaction's
// start time, so the row's timestamp and its figures describe the same
// instant — everything committed before it is in, everything after is
// out, by construction. Not SERIALIZABLE, because nothing here needs the
// write-skew guarantee and the retry burden that comes with it.
router.post('/submissions', async (req, res) => {
  const start = ISO_DATE.test(req.body?.period_start ?? '') ? req.body.period_start : null
  const end   = ISO_DATE.test(req.body?.period_end ?? '')   ? req.body.period_end   : null
  if (!start || !end) return res.status(400).json({ error: 'period_start and period_end (YYYY-MM-DD) are required' })
  if (end < start) return res.status(400).json({ error: 'period_end must be on or after period_start' })

  const client = await pool.connect()
  // Every early exit below has already decided the answer; the transaction
  // has nothing to keep and must not hold the connection open.
  const refuse = async (status, body) => { await client.query('ROLLBACK'); return res.status(status).json(body) }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await lockParishBooks(client, req.organizationId)

    const { rows: aff } = await client.query(
      `SELECT diocese_org_id FROM ochr_diocese_affiliations
        WHERE parish_org_id = $1 AND status = 'active'`,
      [req.organizationId]
    )
    if (!aff.length) return refuse(400, { error: 'This parish has no active diocese affiliation' })
    const dioceseId = aff[0].diocese_org_id

    // A parish's live periods must not overlap (1 Sep). The UNIQUE below
    // only catches the IDENTICAL period; FY + H2 + Q1 of one year all
    // passed it, all got approved, and the assessment summed them — see
    // findOverlappingSubmission for the reproduction. Refused here, with
    // the other period named and a remedy that exists for its status —
    // see overlapRemedy. Which period is the right one is not this
    // route's decision.
    const overlap = await findOverlappingSubmission(client, {
      organizationId: req.organizationId, dioceseOrgId: dioceseId, periodStart: start, periodEnd: end,
    })
    if (overlap) {
      return refuse(409, {
        error: overlapMessage(overlap, overlapRemedy(overlap, 'parish')),
        code: 'period_overlap',
        overlaps: { id: overlap.id, period_start: overlap.period_start, period_end: overlap.period_end, status: overlap.status },
      })
    }

    // R418-1: a resubmit would freeze totals that still miss deposit
    // adjustments the chancery cannot see. Refuse until they are wired in.
    // R418-2: lock this parish's own row for the period first (same row
    // lock reversal approval takes), then check under it.
    await lockSubmissionsForDepositCheck(client,
      's.organization_id = $1 AND s.diocese_org_id = $2 AND s.period_start = $3::date AND s.period_end = $4::date',
      [req.organizationId, dioceseId, start, end])
    if (await periodHasPendingDepositAdjustments(client, {
      organizationId: req.organizationId, dioceseOrgId: dioceseId, periodStart: start, periodEnd: end,
    })) {
      return refuse(DEPOSIT_ADJUSTMENTS_PENDING.status, DEPOSIT_ADJUSTMENTS_PENDING.body)
    }
    // SP-250 W1: voided paid intentions without a disposition hold submit.
    if (await periodHasOpenStipendDispositions(client, {
      organizationId: req.organizationId, periodStart: start, periodEnd: end,
    })) {
      return refuse(OPEN_STIPEND_DISPOSITIONS_PENDING.status, OPEN_STIPEND_DISPOSITIONS_PENDING.body)
    }

    const totals = await computePeriodTotals(req.organizationId, start, end, client)
    // Held on the gift lines themselves, per category, not on the summed
    // unmapped bucket: a negative or offsetting line on another unknown
    // code must not hide a gift, and an unknown non-donation code is not a
    // gift with no account.
    const categories = await unmappedDonationLines(req.organizationId, start, end, client)
    if (categories.length) {
      return refuse(409, {
        code: 'unmapped_unknown',
        error: 'This period has gifts with no account. Map them before sending it. Nothing was frozen.',
        unmapped_total: categories.reduce((s, l) => s + Number(l.amount), 0).toFixed(2),
        categories,
      })
    }
    // Per-gift assessable facts from THIS snapshot. A later refund
    // stamps assessable_impact from this map — never from live COA.
    totals.gift_assessable = await giftAssessableAtFreeze(
      req.organizationId, start, end, client)

    // New period → insert. Returned period → resubmit in place with
    // freshly-computed totals. Submitted/approved period → 409: the
    // frozen report is authoritative until the chancery returns it.
    const { rows } = await client.query(
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
      return refuse(409, { error: 'That period is already submitted or approved. The chancery must return it before you can resubmit.' })
    }

    // A resubmit replaces the frozen totals with ones computed NOW. The
    // live ledger (104) keeps the gift and subtracts posted refund facts,
    // so a refund that was an open adjustment against the RETURNED version
    // is already in the new net. Keeping the adjustment would count that
    // refund twice: once in the figures, once as an open item the chancery
    // is asked to settle. The invariant the refund route keeps (an open
    // adjustment iff the frozen totals include refunded money) says there is
    // nothing left to record; the same transaction that writes the new
    // totals removes it, so no reader sees fresh totals with a stale item.
    // Resolved ones are history and stay. A brand-new period has none, so
    // this is a no-op on the INSERT branch.
    await client.query(
      `DELETE FROM ochr_period_adjustments
        WHERE submission_id = $1 AND organization_id = $2 AND resolved_at IS NULL`,
      [rows[0].id, req.organizationId]
    )
    await client.query('COMMIT')
    res.status(201).json({ id: rows[0].id, status: rows[0].status, totals: totals.totals })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    // 23P01 — the 097 exclusion constraint caught an overlap the
    // check-then-write above raced past. Two concurrent requests both read
    // "no overlap" on separate pooled connections and both wrote; the
    // database refused the second. That is the guard working, so it must
    // read as the same 409 the application check produces, not as "we broke".
    if (isDepositLockBusy(err)) return res.status(DEPOSIT_LOCK_BUSY.status).json(DEPOSIT_LOCK_BUSY.body)
    if (err?.code === '23P01') {
      return res.status(409).json({
        error: "This period overlaps another of this parish's live periods. A parish's periods must not overlap.",
        code: 'period_overlap',
      })
    }
    // 40001 — REPEATABLE READ refused to update a row (the resubmit's
    // ON CONFLICT target) that another transaction changed after our
    // snapshot: the chancery reviewed this period while the parish was
    // resubmitting it. Nothing was written. Not a fault; a retry sees the
    // new state and gets the right answer.
    if (err?.code === '40001') {
      return res.status(409).json({
        error: 'This period changed while it was being submitted. Please try again.',
        code: 'retry',
      })
    }
    monitor.error('finance.submissions.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to submit the period' })
  } finally {
    client.release()
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
