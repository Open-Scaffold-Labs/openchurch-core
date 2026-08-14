import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam, parsePagination, parseDays } from '../utils/params.js'
import { createRefund } from '../payments/index.js'

const router = Router()

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
      SELECT * FROM ochr_donations
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
        COALESCE(SUM(amount) FILTER (WHERE date >= date_trunc('month', NOW())), 0)::NUMERIC(10,2) AS month_total,
        COALESCE(SUM(amount) FILTER (WHERE date >= date_trunc('week',  NOW())), 0)::NUMERIC(10,2) AS week_total,
        COALESCE(MAX(amount), 0)::NUMERIC(10,2)                                                   AS largest,
        COUNT(DISTINCT donor_name)                                                                AS donor_count,
        COUNT(*)                                                                                  AS total_count
      FROM ochr_donations
      WHERE organization_id = $1
        AND payment_status IS DISTINCT FROM 'refunded'
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
        SUM(amount)::NUMERIC(10,2) AS total
      FROM ochr_donations
      WHERE organization_id = $1 AND date >= NOW() - ($2 || ' days')::INTERVAL
        AND payment_status IS DISTINCT FROM 'refunded'
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
        SUM(amount)::NUMERIC(10,2) AS total,
        COUNT(*)::int              AS count
      FROM ochr_donations
      WHERE organization_id = $1 AND date >= NOW() - ($2 || ' days')::INTERVAL
        AND payment_status IS DISTINCT FROM 'refunded'
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
    const { donor_name, donor_email, donor_address, amount, category, method, date, notes } = req.body
    if (!donor_name?.trim()) return res.status(400).json({ error: 'Donor name is required' })
    if (!amount || isNaN(amount) || Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than $0' })
    // donor_email + donor_address are optional. Email is the
    // grouping key for year-end giving statements (Sprint Y) — falls
    // back to donor_name when absent, so older walk-in cash gifts
    // still aggregate, just less reliably across spelling variants.
    const { rows } = await pool.query(
      `INSERT INTO ochr_donations (organization_id, donor_name, donor_email, donor_address, amount, category, method, date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.organizationId, donor_name.trim(),
       donor_email?.trim() || null, donor_address?.trim() || null,
       amount, category || 'tithe', method || 'cash',
       // Last-resort fallback only. The client form prefills the donor's LOCAL
       // day (todayLocalISO), so `date` is normally set; the server has no
       // caller timezone, so UTC-today is the only defensible default here.
       date || new Date().toISOString().slice(0, 10), notes]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create donation' })
  }
})

router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await pool.query(
      'DELETE FROM ochr_donations WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete donation' })
  }
})

// POST /api/donations/:id/refund (GIV.6)
// Refund/void an online gift. Manual entries aren't refundable here —
// they're just deleted. Runs the refund through the payments stub, then
// stamps the row (payment_status='refunded' + refunded_at/refund_ref) so
// it drops out of giving stats and shows as refunded.
router.post('/:id/refund', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `SELECT id, source, amount, payment_ref, payment_status
         FROM ochr_donations WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId]
    )
    const gift = rows[0]
    if (!gift) return res.status(404).json({ error: 'Not found' })
    if (gift.source !== 'online') {
      return res.status(400).json({ error: 'Only online gifts can be refunded; delete manual entries instead.' })
    }
    if (gift.payment_status === 'refunded') {
      return res.status(409).json({ error: 'Already refunded' })
    }

    let refund
    try {
      refund = await createRefund({
        organizationId: req.organizationId,
        chargeId:       gift.payment_ref,
        amount:         Number(gift.amount),
      })
    } catch {
      return res.status(502).json({ error: 'Refund could not be processed.' })
    }

    const { rows: updated } = await pool.query(
      `UPDATE ochr_donations
          SET payment_status = 'refunded', refunded_at = NOW(), refund_ref = $1
        WHERE id = $2 AND organization_id = $3
        RETURNING *`,
      [refund.id, id, req.organizationId]
    )
    res.json(updated[0])
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
              rg.next_charge_date, rg.last_charged_at, rg.created_at,
              f.name AS fund_name
         FROM ochr_recurring_gifts rg
         LEFT JOIN ochr_funds f ON f.id = rg.fund_id
        WHERE rg.organization_id = $1 AND rg.status = 'active'
        ORDER BY rg.created_at DESC`,
      [req.organizationId]
    )
    res.json({ recurring: rows })
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
        WHERE id = $1 AND organization_id = $2 AND status = 'active'
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
      SELECT * FROM ochr_cash_count_sessions
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
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
       VALUES ($1, $2, $3, $4, 'cash', $5, $6) RETURNING *`,
      [req.organizationId, donorLabel, s.total, s.category, s.service_date, `Counted by: ${counters}`]
    )

    // Claim guarded on status so even a bypassed lock cannot double-post.
    const { rows } = await client.query(
      `UPDATE ochr_cash_count_sessions SET status='confirmed', donation_id=$1
       WHERE id = $2 AND organization_id = $3 AND status <> 'confirmed' RETURNING *`,
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
