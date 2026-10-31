import { Router } from 'express'
import pool from '../db.js'
import { normalizeDonorEmail } from '../finance/donorIdentity.js'
import {
  AdjustmentError,
  findPendingRefund,
  insertPendingRefund,
  issuedStatementsForGift,
  lockGift,
  parseMarkerAmount,
  parseRefundAmount,
  postRecordedAdjustment,
  postRefundFact,
  postVoidFact,
  postedRefundTotal,
  refreshGiftRefundStamps,
  refundIdempotencyKey,
  reservedRefundTotal,
} from '../finance/donationRefunds.js'
import { requireRole } from '../middleware/auth.js'
import { requireIntParam, parsePagination, parseDays } from '../utils/params.js'
import { civilDateInTimeZone } from '../utils/timezone.js'
import { createRefund } from '../payments/index.js'
import { protectedDelete } from '../vault/deleteRoute.js'
import { VaultError } from '../vault/index.js'

const router = Router()

// Parish civil today for an undated gift. civilDateInTimeZone is the
// helper pledges and care already use, and it matches the checklist,
// kiosk, and packet clocks: ochr_organizations.timezone, with UTC when
// the zone is blank or invalid. The day is computed in JS and bound as
// a date string, so neither the process TZ nor the Postgres session
// TimeZone chooses it.
async function parishCivilToday(orgId, now = new Date()) {
  const { rows } = await pool.query(
    'SELECT timezone FROM ochr_organizations WHERE id = $1',
    [orgId],
  )
  return civilDateInTimeZone(now, rows[0]?.timezone)
}

// Explicit columns rather than SELECT *. search_vec is a tsvector the ledger
// screen never renders — it was riding on every row of every page purely
// because the query said `*`. Listing the columns also means a column added
// to ochr_donations later has to be chosen into the API rather than
// appearing in it by default. Guarded by LEAK.1.
//
// Measured on a 10,400-gift ledger, one 100-row page: 25 kB with SELECT *,
// 15 kB with the allowlist — 41% of every ledger page was the tsvector.
// `date` is a calendar day, not a moment, and it ships as one. node-postgres
// parses a Postgres DATE into a JS Date at the SERVER's local midnight, which
// JSON then serialises as a full ISO timestamp — so the client received
// '2031-04-04T00:00:00.000Z' for a column whose whole meaning is '2031-04-04'.
// Every row of the donation log rendered 'Invalid Date' (13 of 13, measured
// 4 Sep), and a reader west of the server would have been shown the previous
// day even once it parsed. to_char is what the rest of the codebase already
// does with a DATE (bulletins.js, availability.js); this column had been
// missed.
const DONATION_PUBLIC_COLUMNS = [
  'id', 'organization_id', 'donor_name', 'donor_email', 'donor_address',
  'amount', 'category', 'method', "to_char(date, 'YYYY-MM-DD') AS date",
  'notes', 'source', 'fund_id',
  'payment_ref', 'payment_status', 'refunded_at', 'refund_ref', 'created_at',
].join(', ')

// The same discipline for cash-count sessions. This table has no internal
// columns TODAY, so `RETURNING *` leaks nothing today — but "today" is the
// whole problem. ochr_donations also had no internal columns until a
// tsvector was added, and every `RETURNING *` written before that quietly
// started shipping it. An explicit list is what makes a new column a
// decision instead of an accident.
const CASH_SESSION_PUBLIC_COLUMNS = [
  'id', 'organization_id', 'service_name',
  "to_char(service_date, 'YYYY-MM-DD') AS service_date", 'category',
  'counted_by', 'verified_by', 'denominations', 'total', 'status',
  'donation_id', 'notes', 'created_at',
  // 123: who confirmed / voided, and how the count was verified.
  'counted_by_user_id', 'confirmed_by_user_id', 'confirmed_by_name', 'confirmed_at',
  'verification', 'voided_at', 'voided_by_name', 'void_reason', 'void_refund_id',
].join(', ')

// ── Donations ─────────────────────────────────────────────────

// Marker fields ride beside the gift, never inside it. The gift columns
// stay the declared contract; `books` is the derived net and the marker.
const BOOK_COLUMNS = [
  'refunded_total', 'live_amount', 'marker', 'void_reason', 'voided_by_name',
  'voided_at', 'from_cash_count', 'statement_drift',
]
const DONATION_PAGE_COLUMNS = [
  'id', 'organization_id', 'donor_name', 'donor_email', 'donor_address',
  'amount', 'category', 'method', 'date', 'notes', 'source', 'fund_id',
  'payment_ref', 'payment_status', 'refunded_at', 'refund_ref', 'created_at',
].map(c => `page.${c}`).join(', ')

function withBooks(row) {
  const books = {
    marker: row.marker,
    refunded_total: row.refunded_total,
    live_amount: row.live_amount,
    void_reason: row.void_reason,
    voided_by_name: row.voided_by_name,
    voided_at: row.voided_at,
    from_cash_count: row.from_cash_count,
    statement_drift: row.statement_drift,
  }
  const gift = { ...row }
  for (const key of BOOK_COLUMNS) delete gift[key]
  return { ...gift, books }
}

// One read for the log and for the marker response, so both describe the
// gift the same way. Posted reversals come off the live amount; the gift
// amount itself is not rewritten. An issued statement whose frozen line
// no longer matches that live amount is a flag, not a rewrite.
async function queryDonations(db, organizationId, { id = null, start, end, limit, offset }) {
  const where = ['organization_id = $1']
  const params = [organizationId]
  if (id != null) { params.push(id); where.push(`id = $${params.length}`) }
  if (start) { params.push(start); where.push(`date >= $${params.length}`) }
  if (end)   { params.push(end);   where.push(`date <= $${params.length}`) }
  params.push(limit, offset)
  const { rows } = await db.query(`
    SELECT ${DONATION_PAGE_COLUMNS},
           COALESCE(mk.refunded_total, 0)::numeric(12,2) AS refunded_total,
           (page.amount - COALESCE(mk.refunded_total, 0))::numeric(12,2) AS live_amount,
           CASE
             WHEN COALESCE(mk.voided, false) THEN 'voided'
             WHEN COALESCE(mk.refunded_total, 0) = 0 THEN 'none'
             WHEN COALESCE(mk.refunded_total, 0) >= page.amount THEN 'refunded'
             ELSE 'partial'
           END AS marker,
           mk.void_reason,
           mk.voided_by_name,
           mk.voided_at,
           EXISTS (
             SELECT 1 FROM ochr_cash_count_sessions cc
              WHERE cc.donation_id = page.id AND cc.organization_id = page.organization_id
           ) AS from_cash_count,
           EXISTS (
             SELECT 1 FROM ochr_giving_statements s
              WHERE s.organization_id = page.organization_id
                AND s.status = 'issued'
                AND EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements(COALESCE(s.snapshot_json->'lines', '[]'::jsonb)) line
                   WHERE line->>'donation_id' = page.id::text
                     AND (
                       CASE
                         WHEN line->>'live_amount' ~ '^[0-9]+(\\.[0-9]+)?$'
                         THEN (line->>'live_amount')::numeric
                         ELSE NULL
                       END
                     ) IS DISTINCT FROM (page.amount - COALESCE(mk.refunded_total, 0))
                )
           ) AS statement_drift
      FROM (
        SELECT ${DONATION_PUBLIC_COLUMNS}
          FROM ochr_donations
         WHERE ${where.join(' AND ')}
         ORDER BY date DESC, created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}
      ) page
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE status = 'posted'), 0) AS refunded_total,
          BOOL_OR(status = 'posted' AND kind = 'void') AS voided,
          (ARRAY_AGG(reason ORDER BY id DESC) FILTER (WHERE status = 'posted' AND kind = 'void'))[1] AS void_reason,
          (ARRAY_AGG(recorded_by_name ORDER BY id DESC) FILTER (WHERE status = 'posted' AND kind = 'void'))[1] AS voided_by_name,
          MAX(refunded_at) FILTER (WHERE status = 'posted' AND kind = 'void') AS voided_at
        FROM ochr_donation_refunds r
        WHERE r.donation_id = page.id AND r.organization_id = page.organization_id
      ) mk ON true
  `, params)
  return rows.map(withBooks)
}

router.get('/', async (req, res) => {
  try {
    const { start, end } = req.query
    // Optional paging with a hard safety ceiling (see parsePagination) so
    // this ledger can never stream unbounded. Response stays a bare array —
    // clients/tests depend on that shape.
    const { limit, offset } = parsePagination(req.query)
    const rows = await queryDonations(pool, req.organizationId, { start, end, limit, offset })
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load donations' })
  }
})

router.get('/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(live_amount) FILTER (WHERE date >= date_trunc('month', NOW())), 0)::NUMERIC(10,2) AS month_total,
        COALESCE(SUM(live_amount) FILTER (WHERE date >= date_trunc('week',  NOW())), 0)::NUMERIC(10,2) AS week_total,
        COALESCE(MAX(live_amount), 0)::NUMERIC(10,2)                                                   AS largest,
        COUNT(DISTINCT donor_name)                                                                     AS donor_count,
        COUNT(*)                                                                                       AS total_count
      FROM ochr_donation_live
      WHERE organization_id = $1
    `, [req.organizationId])
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load summary' })
  }
})

router.get('/chart', async (req, res) => {
  try {
    const days = parseDays(req.query.days, 30)
    const { rows } = await pool.query(`
      SELECT
        to_char(date, 'MM/DD') AS label,
        date::TEXT             AS date,
        SUM(live_amount)::NUMERIC(10,2) AS total
      FROM ochr_donation_live
      WHERE organization_id = $1 AND date >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY date
      ORDER BY date ASC
    `, [req.organizationId, days])
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load chart data' })
  }
})

// GET /api/donations/by-fund?days=N
// Per-fund giving totals over the last N days (default 365), largest
// first. `category` doubles as the fund name for online gifts and the
// designation for manual entries, so one grouping covers both. Empty
// categories collapse into 'Uncategorized'.
router.get('/by-fund', async (req, res) => {
  try {
    const days = parseDays(req.query.days, 365)
    const { rows } = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category,
        SUM(live_amount)::NUMERIC(10,2) AS total,
        COUNT(*)::int                   AS count
      FROM ochr_donation_live
      WHERE organization_id = $1 AND date >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized')
      ORDER BY total DESC
    `, [req.organizationId, days])
    res.json({ days, funds: rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load fund breakdown' })
  }
})

router.post('/', async (req, res) => {
  try {
    const { donor_name, donor_email, donor_address, amount, category, method, date, notes, fund_id } = req.body
    if (!donor_name?.trim()) return res.status(400).json({ error: 'Donor name is required' })
    if (!amount || isNaN(amount) || Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than $0' })

    // A gift can name the fund it was given to. This route could not do
    // that until now — only the public giving page and the Studio import
    // set fund_id — so a parish recording gifts by hand had funds it
    // could create, designate nothing to, and see no effect from.
    //
    // It matters beyond bookkeeping: migration 086 lets the fund decide
    // which account a gift lands in, and therefore whether the diocese
    // assesses it. A restricted fund with no gifts attached protects
    // nothing.
    //
    // Checked against THIS org even though a composite foreign key would
    // also refuse a stranger's fund — a 400 that says which field is
    // wrong is a better answer than a 500 from a constraint.
    let fundId = null
    if (fund_id !== undefined && fund_id !== null && fund_id !== '') {
      const n = Number(fund_id)
      if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'Invalid fund' })
      const { rowCount } = await pool.query(
        'SELECT 1 FROM ochr_funds WHERE id = $1 AND organization_id = $2', [n, req.organizationId])
      if (!rowCount) return res.status(400).json({ error: 'That fund is not one of this parish\'s funds' })
      fundId = n
    }
    // donor_email + donor_address are optional. Email is the
    // grouping key for year-end giving statements (Sprint Y) — falls
    // back to donor_name when absent, so older walk-in cash gifts
    // still aggregate, just less reliably across spelling variants.
    //
    // An omitted date is the parish's civil today, not the UTC day.
    // Statements read this column, and this route never updates it.
    // UTC-today stores tomorrow for a gift entered late in the evening
    // west of UTC.
    const giftDate = date || await parishCivilToday(req.organizationId)
    const { rows } = await pool.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, donor_email, donor_address, amount, category, method, date, notes, fund_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${DONATION_PUBLIC_COLUMNS}`,
      [req.organizationId, donor_name.trim(),
       normalizeDonorEmail(donor_email), donor_address?.trim() || null,
       amount, category || 'tithe', method || 'cash',
       giftDate, notes, fundId]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create donation' })
  }
})

// Protected by the Continuity Vault — a gift removed in error is
// recoverable, which matters most at the end of a giving year.
//
// A gift the PROVIDER charged is not deletable at all (1 Sep). payment_ref
// is the provider's charge id: money moved, and the row is the only thing
// in this system that says so. Deleting it did not give the money back —
// it removed the record that the money was ever taken, and the refund
// route below then had nothing to refund. After a refund the same row is
// the trace of the refund, so it stays for the same reason. The vault's
// restore does not change this: a restored row is still a charged gift.
// Manual, cash-count and imported rows have no payment_ref and delete as
// before.
// R365-1: runs on the vault's connection AFTER the gift row is locked FOR
// UPDATE, and that lock is held through capture and DELETE. /void,
// /record-refund and /refund lock the same row, so a reversal either
// commits first (and this refuses) or waits and then finds no gift (404).
// A precheck on a separate connection let a marker commit in the gap and
// be cascaded away with the gift.
async function refuseDeletingChargedGift(req, conn, roots) {
  const gift = roots[0]
  if (!gift) return
  const id = gift.id
  // 123: a gift posted by a confirmed cash count is the count's ledger fact.
  // Removing it would erase the money from the books with no reason or
  // trace; an admin voids the count instead, which keeps both and posts a
  // linked reversing entry.
  const { rowCount: fromCount } = await conn.query(
    `SELECT 1 FROM ochr_cash_count_sessions WHERE donation_id = $1 AND organization_id = $2`,
    [id, req.organizationId]
  )
  if (fromCount) {
    throw new VaultError('cash_count_gift',
      'This gift was posted from a confirmed cash count, so its record stays. An admin can void the count instead, with a reason.')
  }
  const { rowCount: marked } = await conn.query(
    `SELECT 1 FROM ochr_donation_refunds
      WHERE donation_id = $1 AND organization_id = $2
        AND status IN ('pending', 'posted')`,
    [id, req.organizationId]
  )
  if (marked) {
    throw new VaultError('marked_gift',
      'This gift has a void or refund on record, so the original stays.')
  }
  if (gift.payment_ref == null) return
  if (gift.payment_status === 'refunded') {
    throw new VaultError('charged_gift',
      'This gift was charged through the payment provider and already refunded; the record stays as the trace of the refund.')
  }
  throw new VaultError('charged_gift',
    'This gift was charged through the payment provider, so its record stays. Refund it instead of deleting it.')
}

router.delete('/:id', protectedDelete('donation', {
  failure: 'Failed to delete donation', underLock: refuseDeletingChargedGift,
}))

// POST /api/donations/:id/refund (GIV.6 / GIV-06 Option A)
// Refund/void a gift the provider charged. Manual entries aren't
// refundable here — they're just deleted.
//
// A refund is a NEW linked financial fact. gift.amount is never rewritten.
// The gift stamps (payment_status / refunded_at / refund_ref) are a derived
// cache of Σ(posted refund rows): full `refunded` only when that sum covers
// the gift. Live books keep the gift and subtract posted refunds.
//
// Refundable iff payment_ref IS NOT NULL and source IN ('online',
// 'recurring') (1 Sep). The charge id is what makes a refund possible.
//
// Amount omitted = remaining balance (so existing full-refund callers keep
// working). An amount that would push Σ(posted+pending) over gift.amount
// is a hard 409 — never a silent clamp.
//
// Provider idempotency is per refund row (`refund-{org}-{donation}-{refundId}`),
// not per gift: two partials of one gift are two movements of money. The
// pending row is committed BEFORE the provider call so a retry after a
// failed stamp UPDATE reuses the same key.
// Admin-only (José, 2026-10-22): same gate as /void and /record-refund.
router.post('/:id/refund', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const asked = parseRefundAmount(req.body?.amount)
  if (asked.kind === 'invalid') {
    return res.status(400).json({ error: 'Amount must be greater than $0' })
  }
  try {
    const peek = await pool.query(
      `SELECT id, source, amount, payment_ref, payment_status
         FROM ochr_donations WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId]
    )
    const gift = peek.rows[0]
    if (!gift) return res.status(404).json({ error: 'Not found' })
    if (!['online', 'recurring'].includes(gift.source) || gift.payment_ref == null) {
      return res.status(400).json({
        error: 'Only gifts charged through the payment provider can be refunded. This one has no provider charge; delete it instead.',
      })
    }

    // Phase 1 — reserve the fact under FOR UPDATE so concurrent partials
    // cannot together exceed gift.amount. The pending row is the name of
    // THIS refund at the provider.
    const reserve = await pool.connect()
    let refundRow
    try {
      await reserve.query('BEGIN')
      const locked = await lockGift(reserve, id, req.organizationId)
      if (!locked) {
        await reserve.query('ROLLBACK')
        return res.status(404).json({ error: 'Not found' })
      }
      const pending = await findPendingRefund(reserve, id, req.organizationId)
      if (pending) {
        if (asked.kind === 'explicit' && Number(asked.amount) !== Number(pending.amount)) {
          await reserve.query('ROLLBACK')
          return res.status(409).json({ error: 'A refund is already in progress for this gift.' })
        }
        refundRow = pending
      } else {
        const reserved = Number(await reservedRefundTotal(reserve, id, req.organizationId))
        const remaining = Number(locked.amount) - reserved
        if (remaining <= 0) {
          await reserve.query('ROLLBACK')
          return res.status(409).json({ error: 'Already refunded' })
        }
        const amount = asked.kind === 'explicit' ? asked.amount : remaining
        if (amount > remaining) {
          await reserve.query('ROLLBACK')
          return res.status(409).json({ error: 'Refund would exceed the remaining gift amount.' })
        }
        refundRow = await insertPendingRefund(reserve, req.organizationId, id, amount)
      }
      await reserve.query('COMMIT')
    } catch (err) {
      await reserve.query('ROLLBACK').catch(() => {})
      if (err?.code === '23514') {
        return res.status(409).json({ error: 'Refund would exceed the remaining gift amount.' })
      }
      throw err
    } finally {
      reserve.release()
    }

    const idempotencyKey = refundIdempotencyKey(req.organizationId, id, refundRow.id)
    let refund
    try {
      refund = await createRefund({
        organizationId: req.organizationId,
        chargeId:       gift.payment_ref,
        amount:         Number(refundRow.amount),
        idempotencyKey,
      })
    } catch {
      return res.status(502).json({ error: 'Refund could not be processed.' })
    }

    // Phase 2 — post the fact, refresh the derived gift stamps, and write
    // the freeze sidecar when this gift sits inside a frozen period.
    // Period adjustments are NOT live books (GIV-07). The amount recorded
    // is THIS refund, not the gift.
    const client = await pool.connect()
    let updated, posted, adjusted = null, postedSum
    try {
      await client.query('BEGIN')
      await lockGift(client, id, req.organizationId)
      posted = await postRefundFact(client, {
        refundId: refundRow.id,
        organizationId: req.organizationId,
        donationId: id,
        refundRef: refund.id,
      })
      if (!posted) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: 'Already refunded' })
      }
      updated = await refreshGiftRefundStamps(client, id, req.organizationId, DONATION_PUBLIC_COLUMNS)
      postedSum = await postedRefundTotal(client, id, req.organizationId)

      // THE INVARIANT: an open adjustment exists for a submission iff that
      // submission's FROZEN totals include money that has since been
      // refunded. Two predicates decide "is this gift in those totals",
      // and neither of them is "the period is approved":
      //
      // STATUS. The totals are frozen at SUBMIT, not at approval — the
      // chancery's approve flips a status and copies nothing. Both
      // 'submitted' and 'approved' hold a frozen result; only 'returned'
      // does not, because a resubmit recomputes it (and clears these —
      // see POST /submissions in routes/finance.js).
      //
      // SNAPSHOT. created_at <= submitted_at is the snapshot boundary.
      // UNIQUE (submission_id, donation_refund_id): the SAME refund is
      // idempotent (ON CONFLICT DO NOTHING); DISTINCT refund facts each
      // get a sidecar row. totals_json is not rewritten.
      //
      // assessable_impact is copied from totals_json.gift_assessable —
      // the freeze stamp — never from live COA or mappings. A gift that
      // was not assessable at freeze stamps 0 so APPLIED cannot shrink
      // the payable base. A missing map, or a gift the map does not
      // name, is UNKNOWN (NULL). UNKNOWN is not 0: settle must refuse
      // before APPLIED can change the payable.
      adjusted = await recordPeriodAdjustment(client, {
        donationId: id, organizationId: req.organizationId, amount: posted.amount, refundId: posted.id,
      })
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

    const liveAmount = Number(gift.amount) - Number(postedSum)
    const body = {
      ...updated,
      refunded_total: postedSum,
      live_amount: liveAmount,
      refund: posted,
    }
    res.json(adjusted
      ? { ...body, period_adjustment: {
          submission_id: Number(adjusted.submission_id),
          amount: adjusted.amount,
          message: 'This gift is inside a reporting period the diocese has been sent. ' +
                   'The frozen totals for that period, and any bill from them, still include it — they are not changed by this refund. ' +
                   'The adjustment has been recorded against that period for the chancery to settle.',
        } }
      : body)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to refund donation' })
  }
})

// POST /api/donations/:id/void
// POST /api/donations/:id/record-refund
//
// A marker on the parish books. Nothing here calls the payment provider
// and nothing rewrites the gift row. The reversing fact is the same shape
// as a cash-count void (ochr_donation_refunds, posted, with who / when /
// reason). Admin only, matching the Help table for donation refunds and
// the cash-count void.
//
// An online gift still gets the marker. The response says the money itself
// has to be returned in the payment provider. An issued giving statement
// that names the gift is flagged and left as it was issued.

const BAD_IDEMPOTENCY_KEY = Symbol('bad-idempotency-key')

function parseIdempotencyKey(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string') return BAD_IDEMPOTENCY_KEY
  const key = raw.trim()
  if (!key || key.length > 120) return BAD_IDEMPOTENCY_KEY
  return key
}

function providerNotice(gift) {
  const online = gift.payment_ref != null || gift.source === 'online' || gift.source === 'recurring'
  if (!online) return null
  return 'This marks the parish books only. Return the money in the payment provider if it has not already been returned there.'
}

async function postMarker(req, res, kind) {
  const id = requireIntParam(req, res); if (id === null) return
  const reason = parseVoidReason(req.body?.reason)
  if (!reason) return res.status(422).json({ error: 'A reason is required.' })
  const idempotencyKey = parseIdempotencyKey(req.body?.idempotency_key)
  if (idempotencyKey === BAD_IDEMPOTENCY_KEY) {
    return res.status(400).json({ error: 'That request could not be told apart from another. Please try again.' })
  }
  let amountCents = null
  if (kind === 'refund') {
    const asked = parseMarkerAmount(req.body?.amount)
    if (asked.kind === 'invalid') return res.status(400).json({ error: 'Amount must be greater than $0' })
    if (asked.kind === 'explicit') amountCents = asked.cents
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const actor = await liveActor(client, req)
    let result
    try {
      result = await postRecordedAdjustment(client, {
        organizationId: req.organizationId,
        donationId: id,
        kind,
        amountCents,
        reason,
        actor,
        idempotencyKey,
      })
    } catch (err) {
      if (err instanceof AdjustmentError) {
        await client.query('ROLLBACK')
        return res.status(err.status).json({ error: err.error })
      }
      throw err
    }

    let adjusted = null
    if (!result.replayed) {
      adjusted = await recordPeriodAdjustment(client, {
        donationId: id,
        organizationId: req.organizationId,
        amount: result.reversal.amount,
        refundId: result.reversal.id,
      })
    }
    const issued = await issuedStatementsForGift(client, req.organizationId, id)
    const [donation] = await queryDonations(client, req.organizationId, {
      id, limit: 1, offset: 0,
    })
    if (!donation) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    await client.query('COMMIT')

    const body = {
      donation,
      reversal: {
        id: result.reversal.id,
        amount: result.reversal.amount,
        kind: result.reversal.kind,
        reason: result.reversal.reason,
        refunded_at: result.reversal.refunded_at,
        recorded_by_name: result.reversal.recorded_by_name,
      },
      replayed: result.replayed,
      provider_notice: providerNotice(donation),
      issued_statements: issued.map(s => ({
        id: s.id,
        statement_no: s.statement_no,
        tax_year: s.tax_year,
      })),
    }
    res.json(adjusted
      ? { ...body, period_adjustment: {
          submission_id: Number(adjusted.submission_id),
          amount: adjusted.amount,
          message: 'This gift is inside a reporting period the diocese has been sent. ' +
                   'The frozen totals for that period are not changed by this. ' +
                   'The adjustment has been recorded against that period for the chancery to settle.',
        } }
      : body)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(err)
    res.status(500).json({
      error: kind === 'void' ? 'Failed to void donation' : 'Failed to record refund',
    })
  } finally {
    client.release()
  }
}

router.post('/:id/void', requireRole('admin'), (req, res) => postMarker(req, res, 'void'))
router.post('/:id/record-refund', requireRole('admin'), (req, res) => postMarker(req, res, 'refund'))

// ── Recurring gifts (GIV.7) ───────────────────────────────────

// GET /api/donations/recurring — active recurring gifts for the org.
router.get('/recurring', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rg.id, rg.donor_name, rg.donor_email, rg.amount, rg.frequency,
              to_char(rg.next_charge_date, 'YYYY-MM-DD') AS next_charge_date,
              rg.last_charged_at, rg.created_at,
              rg.status, rg.failure_count, rg.last_error, rg.last_failed_at,
              f.name AS fund_name
         FROM ochr_recurring_gifts rg
         LEFT JOIN ochr_funds f ON f.id = rg.fund_id
        WHERE rg.organization_id = $1 AND rg.status IN ('active', 'paused')
        ORDER BY
          -- Paused gifts first: they are the ones that need a person.
          CASE WHEN rg.status = 'paused' THEN 0 ELSE 1 END,
          rg.last_failed_at DESC NULLS LAST,
          rg.created_at DESC`,
      [req.organizationId]
    )
    // Split rather than making the screen filter a mixed list. "Needs
    // attention" is a different question from "what is coming in", and a
    // parish should be able to see the first without reading the second.
    res.json({
      recurring: rows.filter(r => r.status === 'active'),
      needs_attention: rows.filter(r => r.status === 'paused'),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load recurring gifts' })
  }
})

// POST /api/donations/recurring/:id/cancel — stop a recurring gift.
// Admin-only (José, 2026-10-23), like void and refund.
router.post('/recurring/:id/cancel', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_recurring_gifts SET status = 'cancelled'
        WHERE id = $1 AND organization_id = $2 AND status IN ('active', 'paused')
        RETURNING id, status`,
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found or already cancelled' })
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to cancel recurring gift' })
  }
})

// ── Cash Count Sessions ───────────────────────────────────────

// SP-092: optional ?from=YYYY-MM-DD&to=YYYY-MM-DD on service_date,
// inclusive, inside this organization only. A malformed or impossible
// date, or from after to, is refused rather than silently ignored.
const BAD_DATE = Symbol('bad cash-count date')
function cashCountDateParam(v) {
  if (v === undefined || v === '') return null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return BAD_DATE
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return BAD_DATE
  return v
}

router.get('/cash-counts', async (req, res) => {
  const from = cashCountDateParam(req.query.from)
  const to = cashCountDateParam(req.query.to)
  if (from === BAD_DATE || to === BAD_DATE) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' })
  if (from && to && from > to) {
    return res.status(400).json({ error: 'The from date is after the to date' })
  }
  try {
    const params = [req.organizationId]
    let range = ''
    if (from) { params.push(from); range += ` AND service_date >= $${params.length}::date` }
    if (to) { params.push(to); range += ` AND service_date <= $${params.length}::date` }
    const { rows } = await pool.query(`
      SELECT ${CASH_SESSION_PUBLIC_COLUMNS} FROM ochr_cash_count_sessions
      WHERE organization_id = $1${range}
      ORDER BY service_date DESC, created_at DESC
    `, params)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load cash counts' })
  }
})

// POST — save a new cash count session (status = 'pending')
router.post('/cash-counts', async (req, res) => {
  try {
    const { service_name, service_date, category, counted_by, verified_by, denominations, total, notes } = req.body
    if (!service_name?.trim()) return res.status(400).json({ error: 'Service name is required' })
    if (!counted_by?.trim())   return res.status(400).json({ error: 'Counter name is required' })
    if (!total || isNaN(total) || Number(total) <= 0) return res.status(400).json({ error: 'Total must be greater than $0' })
    // 123 (José, 21 Oct): verification is a second SIGNED-IN staff member at
    // confirmation, not a typed name. A typed verifier is refused rather
    // than stored and silently ignored.
    if (typeof verified_by === 'string' ? verified_by.trim() : verified_by != null) {
      return res.status(422).json({
        code: 'typed_verifier_retired',
        error: 'A second signed-in staff member verifies a count by confirming it. Leave the verifier blank.',
      })
    }

    const { rows } = await pool.query(
      `INSERT INTO ochr_cash_count_sessions
         (organization_id, service_name, service_date, category, counted_by, verified_by, denominations, total, notes, counted_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${CASH_SESSION_PUBLIC_COLUMNS}`,
      [
        req.organizationId,
        service_name.trim(),
        service_date || new Date().toISOString().slice(0, 10),
        category || 'offering',
        counted_by.trim(),
        null,
        JSON.stringify(denominations || {}),
        total,
        notes?.trim() || null,
        req.user.id,
      ]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to save cash count' })
  }
})

// PATCH — confirm a session: posts it to donations and marks confirmed.
// A REAL transaction this time: SELECT ... FOR UPDATE serializes
// concurrent confirms on the same session, so a double-clicked Confirm
// (or two open tabs) posts the collection to the ledger exactly once —
// the second caller blocks, then sees status='confirmed' and gets 409.
// If anything fails between the donation INSERT and the session UPDATE,
// the whole thing rolls back: no orphaned donation, no half-confirmed
// session.
router.patch('/cash-counts/:id/confirm', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const session = await client.query(
      'SELECT * FROM ochr_cash_count_sessions WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [id, req.organizationId]
    )
    if (!session.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Session not found' })
    }

    const s = session.rows[0]
    if (s.status === 'confirmed') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Already confirmed' })
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const has = k => Object.prototype.hasOwnProperty.call(body, k)
    const { rows: meRows } = await client.query(
      'SELECT id, name FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [req.user.id, req.organizationId]
    )
    if (!meRows.length) {
      await client.query('ROLLBACK')
      return res.status(401).json({ error: 'User no longer exists' })
    }
    const me = meRows[0]
    const donorLabel = `${s.service_name} (Cash Collection)`
    let verification, giftNote

    if (s.counted_by_user_id != null) {
      // 123 (José, 21 Oct): the verifier is a second signed-in staff user in
      // this parish, different from the user who saved the count. A count
      // can still be posted by one person, but only when they say so, and
      // it is labelled 'Single count, not verified' everywhere it shows.
      if (has('verified_by')) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          code: 'typed_verifier_retired',
          error: 'A second signed-in staff member verifies a count by confirming it; typed verifier names are no longer accepted.',
        })
      }
      if (has('single_count') && typeof body.single_count !== 'boolean') {
        await client.query('ROLLBACK')
        return res.status(422).json({ error: 'single_count must be a boolean' })
      }
      if (Number(s.counted_by_user_id) === Number(me.id)) {
        if (body.single_count !== true) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            code: 'verifier_required',
            error: 'A second signed-in staff member must confirm this count. To post it without one, confirm it as a single count (not verified).',
          })
        }
        verification = 'single'
        giftNote = `Single count, not verified. Counted by: ${s.counted_by}`
      } else {
        verification = 'two_person'
        giftNote = `Counted by: ${s.counted_by}; verified by ${me.name} (second signed-in staff member)`
      }
    } else {
      // Counts saved before 123 have no signed-in counter. They keep the
      // #357 typed-name rule (two different recorded names) and are
      // labelled as typed names, never as signed-in verification.
      // R357-2: an explicit verified_by must be a nonblank string — it
      // never falls back. Only an omitted key keeps the saved name.
      if (has('verified_by')) {
        const v = body.verified_by
        if (typeof v !== 'string' || !v.trim()) {
          await client.query('ROLLBACK')
          return res.status(422).json({ error: 'A second person must verify this count before it is confirmed' })
        }
        s.verified_by = v.trim().slice(0, 200)
      }
      const norm = v => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase()
      if (!norm(s.verified_by)) {
        await client.query('ROLLBACK')
        return res.status(422).json({ error: 'A second person must verify this count before it is confirmed' })
      }
      if (norm(s.verified_by) === norm(s.counted_by)) {
        await client.query('ROLLBACK')
        return res.status(422).json({ error: 'The verifier must be a different person from the counter' })
      }
      verification = 'typed_names'
      giftNote = `Counted by: ${s.counted_by} & ${s.verified_by}`
    }

    const { rows: dRows } = await client.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, method, date, notes)
       VALUES ($1, $2, $3, $4, 'cash', $5, $6)
       RETURNING ${DONATION_PUBLIC_COLUMNS}`,
      [req.organizationId, donorLabel, s.total, s.category, s.service_date, giftNote]
    )

    // Claim guarded on status so even a bypassed lock cannot double-post.
    const { rows } = await client.query(
      `UPDATE ochr_cash_count_sessions
          SET status='confirmed', donation_id=$1, verified_by=$4,
              confirmed_by_user_id=$5, confirmed_by_name=$6, confirmed_at=NOW(), verification=$7
       WHERE id = $2 AND organization_id = $3 AND status <> 'confirmed'
       RETURNING ${CASH_SESSION_PUBLIC_COLUMNS}`,
      [dRows[0].id, id, req.organizationId, s.verified_by, me.id, me.name, verification]
    )
    if (!rows.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Already confirmed' })
    }

    await client.query('COMMIT')
    res.json({ session: rows[0], donation: dRows[0] })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(err)
    res.status(500).json({ error: 'Failed to confirm cash count' })
  } finally {
    client.release()
  }
})

// POST /cash-counts/:id/void — reasoned reversal of a CONFIRMED count
// (José, 21 Oct). Admin-only, matching "Donation refunds" in the Help role
// table: reversing posted money is the same authority as refunding it.
//
// Nothing is deleted or rewritten. The count and its posted gift stay as
// they are; a linked reversing fact (ochr_donation_refunds, kind='void',
// with the reason) nets the gift to zero in ochr_donation_live and the
// parish ledger, and a period adjustment is recorded when the gift sits in
// a period already sent to the diocese.
//
// Lock order matches confirm: the session row, then the gift row (the 104
// cap trigger re-locks the gift in the same order). A second void — a
// retry, a double-click, or a concurrent request — finds voided_at set
// under the lock and returns the existing void with already_voided: true;
// it never posts a second reversal. uq_donation_refunds_one_void and the
// cap trigger refuse one at the database even if this lock were bypassed.
// The #358 void, as one step inside a caller's transaction. The caller has
// already locked the session row (FOR UPDATE). Lock order stays session →
// gift (the 104 cap trigger re-locks the gift in the same order). Returns
// { fail: { status, body } } or { session, reversal, adjusted }.
// Any pending staff request on the count is closed in the same transaction:
// 'approved' when it is the one being approved, otherwise 'superseded'.
async function postCountVoidLocked(client, { organizationId, s, actor, reason, approvingRequestId = null }) {
  if (s.status !== 'confirmed') {
    return { fail: { status: 409, body: { error: 'Only a confirmed count can be voided. A pending count can be deleted.' } } }
  }
  const gone = { fail: { status: 409, body: { error: 'The gift this count posted is no longer in the ledger, so there is nothing to reverse.' } } }
  if (s.donation_id == null) return gone
  const gift = await lockGift(client, s.donation_id, organizationId)
  if (!gift) return gone
  const remaining = Number(gift.amount) - Number(await reservedRefundTotal(client, gift.id, organizationId))
  if (remaining <= 0) {
    return { fail: { status: 409, body: { error: 'This gift is already fully reversed.' } } }
  }
  const reversal = await postVoidFact(client, {
    organizationId, donationId: gift.id, amount: remaining, reason, actor,
  })
  const adjusted = await recordPeriodAdjustment(client, {
    donationId: gift.id, organizationId, amount: reversal.amount, refundId: reversal.id,
  })
  const { rows } = await client.query(
    `UPDATE ochr_cash_count_sessions
        SET voided_at = NOW(), voided_by_user_id = $3, voided_by_name = $4,
            void_reason = $5, void_refund_id = $6
      WHERE id = $1 AND organization_id = $2 AND voided_at IS NULL
      RETURNING ${CASH_SESSION_PUBLIC_COLUMNS}`,
    [s.id, organizationId, actor?.id ?? null, actor?.name ?? null, reason, reversal.id]
  )
  if (!rows.length) {
    return { fail: { status: 409, body: { error: 'This count was voided by another request.' } } }
  }
  await client.query(
    `UPDATE ochr_cash_count_void_requests
        SET status = CASE WHEN id = $3 THEN 'approved' ELSE 'superseded' END,
            decided_by_user_id = $4, decided_by_name = $5, decided_at = NOW(),
            void_refund_id = CASE WHEN id = $3 THEN $6::BIGINT ELSE void_refund_id END
      WHERE organization_id = $1 AND cash_count_id = $2 AND status = 'pending'`,
    [organizationId, s.id, approvingRequestId, actor?.id ?? null, actor?.name ?? null, reversal.id]
  )
  return { session: rows[0], reversal, adjusted }
}

function voidResponse(result) {
  const { session, reversal, adjusted } = result
  return {
    session,
    reversal,
    ...(adjusted ? { period_adjustment: {
      submission_id: Number(adjusted.submission_id),
      amount: adjusted.amount,
      message: 'This gift is inside a reporting period the diocese has been sent. ' +
               'The frozen totals for that period are not changed by this void; ' +
               'the adjustment has been recorded against that period for the chancery to settle.',
    } } : {}),
  }
}

async function liveActor(client, req) {
  const { rows } = await client.query(
    'SELECT id, name, role FROM ochr_users WHERE id = $1 AND organization_id = $2',
    [req.user.id, req.organizationId]
  )
  return rows[0] ?? null
}

function parseVoidReason(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  return raw.trim().slice(0, 500)
}

router.post('/cash-counts/:id/void', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const reason = parseVoidReason(req.body?.reason)
  if (!reason) return res.status(422).json({ error: 'A reason is required to void a confirmed count' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: sRows } = await client.query(
      'SELECT * FROM ochr_cash_count_sessions WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [id, req.organizationId]
    )
    const s = sRows[0]
    if (!s) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Session not found' })
    }
    if (s.voided_at) {
      const { rows } = await client.query(
        `SELECT ${CASH_SESSION_PUBLIC_COLUMNS} FROM ochr_cash_count_sessions WHERE id = $1 AND organization_id = $2`,
        [id, req.organizationId]
      )
      await client.query('ROLLBACK')
      return res.json({ session: rows[0], already_voided: true })
    }
    const actor = await liveActor(client, req)
    const result = await postCountVoidLocked(client, { organizationId: req.organizationId, s, actor, reason })
    if (result.fail) {
      await client.query('ROLLBACK')
      return res.status(result.fail.status).json(result.fail.body)
    }
    await client.query('COMMIT')
    res.json(voidResponse(result))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(err)
    res.status(500).json({ error: 'Failed to void cash count' })
  } finally {
    client.release()
  }
})

// ── Void requests (José, 21 Oct 7:38 PM PT) ───────────────────
// Staff (or an admin) ask for a confirmed count to be voided, with a
// reason. No money moves. Every OTHER admin of this parish gets an in-app
// notification in the existing bell (ochr_notifications, addressed with
// recipient_user_id — migration 124). An admin who is not the requester
// approves (the #358 void posts in the same transaction, recording the
// approver and the request's original reason) or rejects (who, when,
// optional note). Admins can still void directly; that closes any pending
// request as 'superseded'.
//
// Lock order everywhere: session row, then request row, then gift row.
// One pending request per count: the session lock serializes creators and
// uq_ccvr_one_pending refuses a second at the database.
const VOID_REQUEST_COLUMNS = [
  'id', 'cash_count_id', 'reason', 'status', 'requested_by_user_id', 'requested_by_name',
  'requested_at', 'decided_by_user_id', 'decided_by_name', 'decided_at', 'decision_note', 'void_refund_id',
].join(', ')

router.post('/cash-counts/:id/void-requests', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const reason = parseVoidReason(req.body?.reason)
  if (!reason) return res.status(422).json({ error: 'A reason is required to request a void' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: sRows } = await client.query(
      'SELECT * FROM ochr_cash_count_sessions WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [id, req.organizationId]
    )
    const s = sRows[0]
    if (!s) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Session not found' })
    }
    if (s.status !== 'confirmed') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Only a confirmed count can be voided. A pending count can be deleted.' })
    }
    if (s.voided_at) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'This count is already voided.' })
    }
    const { rows: open } = await client.query(
      `SELECT ${VOID_REQUEST_COLUMNS} FROM ochr_cash_count_void_requests
        WHERE organization_id = $1 AND cash_count_id = $2 AND status = 'pending'`,
      [req.organizationId, id]
    )
    if (open.length) {
      await client.query('ROLLBACK')
      return res.json({ request: open[0], already_requested: true })
    }
    const actor = await liveActor(client, req)
    const { rows } = await client.query(
      `INSERT INTO ochr_cash_count_void_requests
         (organization_id, cash_count_id, reason, requested_by_user_id, requested_by_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${VOID_REQUEST_COLUMNS}`,
      [req.organizationId, id, reason, actor?.id ?? null, actor?.name ?? null]
    )
    // One addressed bell row per admin who can approve it (not the requester).
    const { rowCount: notified } = await client.query(
      `INSERT INTO ochr_notifications (organization_id, type, recipient_user_id, message)
       SELECT $1, 'cash_count_void_request', u.id, $3
         FROM ochr_users u
        WHERE u.organization_id = $1 AND u.role = 'admin' AND u.id IS DISTINCT FROM $2`,
      [req.organizationId, actor?.id ?? null,
       `${actor?.name || 'A staff member'} asked to void the "${s.service_name}" cash count. Reason: ${reason}`]
    )
    await client.query('COMMIT')
    res.status(201).json({ request: rows[0], admins_notified: notified })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(err)
    res.status(500).json({ error: 'Failed to request void' })
  } finally {
    client.release()
  }
})

router.get('/cash-counts/void-requests', async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending'
    if (!['pending', 'approved', 'rejected', 'superseded', 'all'].includes(status)) {
      return res.status(400).json({ error: 'Unknown status' })
    }
    const { rows } = await pool.query(
      `SELECT ${VOID_REQUEST_COLUMNS} FROM ochr_cash_count_void_requests
        WHERE organization_id = $1 AND ($2 = 'all' OR status = $2)
        ORDER BY requested_at DESC LIMIT 200`,
      [req.organizationId, status]
    )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load void requests' })
  }
})

// Shared decision scaffold: locks session then request, re-checks state.
async function decideVoidRequest(req, res, decide) {
  const rid = requireIntParam(req, res); if (rid === null) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: peek } = await client.query(
      'SELECT cash_count_id FROM ochr_cash_count_void_requests WHERE id = $1 AND organization_id = $2',
      [rid, req.organizationId]
    )
    if (!peek.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Request not found' })
    }
    const { rows: sRows } = await client.query(
      'SELECT * FROM ochr_cash_count_sessions WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [peek[0].cash_count_id, req.organizationId]
    )
    const { rows: rRows } = await client.query(
      `SELECT * FROM ochr_cash_count_void_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [rid, req.organizationId]
    )
    const r = rRows[0]
    if (r.status !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: `This request is already ${r.status}.`, status: r.status })
    }
    const actor = await liveActor(client, req)
    const out = await decide(client, { s: sRows[0], r, actor })
    if (out.fail) {
      await client.query('ROLLBACK')
      return res.status(out.fail.status).json(out.fail.body)
    }
    await client.query('COMMIT')
    res.json(out.body)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(err)
    res.status(500).json({ error: 'Failed to decide void request' })
  } finally {
    client.release()
  }
}

router.post('/cash-counts/void-requests/:id/approve', requireRole('admin'), (req, res) =>
  decideVoidRequest(req, res, async (client, { s, r, actor }) => {
    if (r.requested_by_user_id != null && Number(r.requested_by_user_id) === Number(actor?.id)) {
      return { fail: { status: 403, body: { code: 'own_request', error: 'Another admin must approve a void you requested.' } } }
    }
    const result = await postCountVoidLocked(client, {
      organizationId: req.organizationId, s, actor, reason: r.reason, approvingRequestId: r.id,
    })
    if (result.fail) return result
    const { rows } = await client.query(
      `SELECT ${VOID_REQUEST_COLUMNS} FROM ochr_cash_count_void_requests WHERE id = $1`, [r.id])
    return { body: { request: rows[0], ...voidResponse(result) } }
  }))

router.post('/cash-counts/void-requests/:id/reject', requireRole('admin'), (req, res) =>
  decideVoidRequest(req, res, async (client, { r, actor }) => {
    const raw = req.body?.note
    if (raw != null && typeof raw !== 'string') {
      return { fail: { status: 422, body: { error: 'note must be text' } } }
    }
    const note = raw?.trim() ? raw.trim().slice(0, 500) : null
    const { rows } = await client.query(
      `UPDATE ochr_cash_count_void_requests
          SET status = 'rejected', decided_by_user_id = $3, decided_by_name = $4,
              decided_at = NOW(), decision_note = $5
        WHERE id = $1 AND organization_id = $2 AND status = 'pending'
        RETURNING ${VOID_REQUEST_COLUMNS}`,
      [r.id, req.organizationId, actor?.id ?? null, actor?.name ?? null, note]
    )
    return { body: { request: rows[0] } }
  }))

router.delete('/cash-counts/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    // SP-091: a confirmed count is already posted to the ledger; deleting
    // it would erase the count behind that donation. Only pending deletes.
    const result = await pool.query(
      `DELETE FROM ochr_cash_count_sessions
       WHERE id = $1 AND organization_id = $2 AND status <> 'confirmed'`,
      [id, req.organizationId]
    )
    if (result.rowCount === 0) {
      const { rows } = await pool.query(
        'SELECT status FROM ochr_cash_count_sessions WHERE id = $1 AND organization_id = $2',
        [id, req.organizationId]
      )
      if (rows.length) return res.status(409).json({ error: 'A confirmed count is posted to the ledger and cannot be deleted' })
      return res.status(404).json({ error: 'Not found' })
    }
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete cash count' })
  }
})

// The freeze sidecar for one posted reversing fact (refund or cash-count
// void): an open adjustment for every submitted/approved period whose frozen
// totals include this gift. See the INVARIANT note in the refund route.
// UNIQUE (submission_id, donation_refund_id) keeps it idempotent.
async function recordPeriodAdjustment(client, { donationId, organizationId, amount, refundId }) {
  const ins = await client.query(
        `INSERT INTO ochr_period_adjustments
           (organization_id, diocese_org_id, submission_id, donation_id,
            donation_refund_id, kind, amount, assessable_impact)
         SELECT s.organization_id, s.diocese_org_id, s.id, d.id, $4, 'refund',
                $3::NUMERIC(12,2),
                CASE
                  WHEN jsonb_typeof(
                         s.totals_json->'gift_assessable'
                         ->d.id::text
                         ->'assessable'
                       ) = 'boolean'
                    AND (s.totals_json->'gift_assessable'
                         ->d.id::text
                         ->>'assessable')::boolean
                  THEN $3::NUMERIC(12,2)
                  WHEN jsonb_typeof(
                         s.totals_json->'gift_assessable'
                         ->d.id::text
                         ->'assessable'
                       ) = 'boolean'
                  THEN 0::NUMERIC(12,2)
                  ELSE NULL
                END
           FROM ochr_report_submissions s
           JOIN ochr_donations d
             ON d.id = $1 AND d.organization_id = s.organization_id
          WHERE s.organization_id = $2
            AND s.status IN ('submitted', 'approved')
            AND d.date BETWEEN s.period_start AND s.period_end
            AND d.created_at <= s.submitted_at
         ON CONFLICT DO NOTHING
         RETURNING id, submission_id, amount, assessable_impact`,
        [donationId, organizationId, amount, refundId]
      )
  return ins.rows[0] ?? null
}

export default router
