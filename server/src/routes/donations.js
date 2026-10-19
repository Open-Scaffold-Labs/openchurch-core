import { Router } from 'express'
import pool from '../db.js'
import { normalizeDonorEmail } from '../finance/donorIdentity.js'
import {
  findPendingRefund,
  insertPendingRefund,
  lockGift,
  parseRefundAmount,
  postRefundFact,
  postedRefundTotal,
  refreshGiftRefundStamps,
  refundIdempotencyKey,
  reservedRefundTotal,
} from '../finance/donationRefunds.js'
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
].join(', ')

// ── Donations ─────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { start, end } = req.query
    const where  = ['organization_id = $1']
    const params = [req.organizationId]
    if (start) { params.push(start); where.push(`date >= $${params.length}`) }
    if (end)   { params.push(end);   where.push(`date <= $${params.length}`) }
    // Optional paging with a hard safety ceiling (see parsePagination) so
    // this ledger can never stream unbounded. Response stays a bare array —
    // clients/tests depend on that shape.
    const { limit, offset } = parsePagination(req.query)
    params.push(limit, offset)
    const { rows } = await pool.query(`
      SELECT ${DONATION_PUBLIC_COLUMNS} FROM ochr_donations
      WHERE ${where.join(' AND ')}
      ORDER BY date DESC, created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params)
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
async function refuseDeletingChargedGift(req, id) {
  const { rows } = await pool.query(
    `SELECT payment_ref, payment_status FROM ochr_donations
      WHERE id = $1 AND organization_id = $2`,
    [id, req.organizationId]
  )
  const gift = rows[0]
  if (!gift || gift.payment_ref == null) return
  if (gift.payment_status === 'refunded') {
    throw new VaultError('charged_gift',
      'This gift was charged through the payment provider and already refunded; the record stays as the trace of the refund.')
  }
  throw new VaultError('charged_gift',
    'This gift was charged through the payment provider, so its record stays. Refund it instead of deleting it.')
}
router.delete('/:id', protectedDelete('donation', {
  failure: 'Failed to delete donation', before: refuseDeletingChargedGift,
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
router.post('/:id/refund', async (req, res) => {
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
        [id, req.organizationId, posted.amount, posted.id]
      )
      adjusted = ins.rows[0] ?? null
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
router.post('/recurring/:id/cancel', async (req, res) => {
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

router.get('/cash-counts', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ${CASH_SESSION_PUBLIC_COLUMNS} FROM ochr_cash_count_sessions
      WHERE organization_id = $1
      ORDER BY service_date DESC, created_at DESC
    `, [req.organizationId])
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

    const { rows } = await pool.query(
      `INSERT INTO ochr_cash_count_sessions
         (organization_id, service_name, service_date, category, counted_by, verified_by, denominations, total, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${CASH_SESSION_PUBLIC_COLUMNS}`,
      [
        req.organizationId,
        service_name.trim(),
        service_date || new Date().toISOString().slice(0, 10),
        category || 'offering',
        counted_by.trim(),
        verified_by?.trim() || null,
        JSON.stringify(denominations || {}),
        total,
        notes?.trim() || null,
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

    const counters = [s.counted_by, s.verified_by].filter(Boolean).join(' & ')
    const donorLabel = `${s.service_name} (Cash Collection)`

    const { rows: dRows } = await client.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, amount, category, method, date, notes)
       VALUES ($1, $2, $3, $4, 'cash', $5, $6)
       RETURNING ${DONATION_PUBLIC_COLUMNS}`,
      [req.organizationId, donorLabel, s.total, s.category, s.service_date, `Counted by: ${counters}`]
    )

    // Claim guarded on status so even a bypassed lock cannot double-post.
    const { rows } = await client.query(
      `UPDATE ochr_cash_count_sessions SET status='confirmed', donation_id=$1
       WHERE id = $2 AND organization_id = $3 AND status <> 'confirmed'
       RETURNING ${CASH_SESSION_PUBLIC_COLUMNS}`,
      [dRows[0].id, id, req.organizationId]
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

router.delete('/cash-counts/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await pool.query(
      'DELETE FROM ochr_cash_count_sessions WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete cash count' })
  }
})

export default router
