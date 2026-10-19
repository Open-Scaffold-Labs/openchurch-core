// Pledges (Sprint D). Admin-only — pledge data + donor matching is
// sensitive enough that only the bookkeeper/treasurer should see it.
//
// Endpoints:
//   GET    /api/pledges            → list every pledge with fulfillment
//   GET    /api/pledges/:id        → one pledge + matched line items
//   POST   /api/pledges            → create
//   PATCH  /api/pledges/:id        → update
//   DELETE /api/pledges/:id        → 204 on success, 404 cross-tenant
//
// Fulfillment math, computed on every list/get:
//   matched_total = SUM(donations.amount) WHERE donor matches
//                   AND date BETWEEN start_date AND COALESCE(end_date, NOW())
//   period_total  = amount × frequency_multiplier(start..end window)
//   fulfillment   = clamp(matched_total / period_total, 0..1)
//
// Why not store fulfillment: donations land continuously, and a
// stored value would drift the moment a new donation posts. Always-
// compute is the only honest answer.

import { Router } from 'express'
import pool from '../db.js'
import { normalizeDonorEmail } from '../finance/donorIdentity.js'
import { requireIntParam } from '../utils/params.js'
import { civilDateInTimeZone } from '../utils/timezone.js'
import { inclusiveCivilDays, isoDatePrefix } from '../utils/civilDay.js'

const router = Router()

const VALID_FREQUENCIES = new Set(['weekly', 'monthly', 'yearly', 'one_time'])
const VALID_STATUSES    = new Set(['active', 'completed', 'cancelled'])

// A DATE is a civil day. "Today" for an open pledge is the current
// civil date in the organization's timezone, not the UTC day and not
// the process-local midnight. A missing or invalid zone falls back to
// UTC inside civilDateInTimeZone. The day count is date-only arithmetic.
//
// If the org's civil today is still before the start, the total is 0,
// open or closed — not the full amount. Once the pledge has begun, an
// open window caps at today and a closed window uses its stored end
// date, and that end day is included.
function expectedPeriodTotal({ amount, frequency, start_date, end_date }, now = new Date(), timeZone) {
  const start = isoDatePrefix(start_date)
  const today = civilDateInTimeZone(now, timeZone)
  if (!start || !today || today < start) return 0
  const end = end_date ? isoDatePrefix(end_date) : today
  if (!end || end < start) return 0
  const days = inclusiveCivilDays(start, end)
  if (!Number.isFinite(days) || days < 1) return 0

  const n = Number(amount)
  if (frequency === 'one_time') return n
  if (frequency === 'weekly')   return n * (days / 7)
  if (frequency === 'monthly')  return n * (days / 30.4375) // avg days/month
  if (frequency === 'yearly')   return n * (days / 365.25)
  return n
}

// Resolve the matching donor key for a pledge. Prefers the member's
// current email (so admins can re-canonicalize an email on the member
// record and the pledge keeps tracking); falls back to the pledge's
// stored donor_email when no member is linked.
async function donorKeyForPledge(pledge, orgId) {
  if (pledge.member_id) {
    // Org-scoped on purpose: an unscoped lookup here would resolve a
    // member row belonging to another tenant and use its email as this
    // pledge's donor key. orgId is passed EXPLICITLY rather than read
    // off the row — the list and Insights queries select specific
    // columns, and trusting `pledge.organization_id` to be present
    // silently zeroed fulfillment for every member-linked pledge when
    // it wasn't (fixed 2026-07-31).
    const { rows } = await pool.query(
      'SELECT email FROM ochr_clients WHERE id = $1 AND organization_id = $2 LIMIT 1',
      [pledge.member_id, orgId]
    )
    const email = rows[0]?.email
    if (email) return { by: 'email', key: email }
    // Member exists but has no email — fall through to donor_email
    // if the pledge has one stored, else by name (less reliable).
  }
  if (pledge.donor_email) return { by: 'email', key: pledge.donor_email }
  return null
}

// Fulfillment for a list of pledges, in TWO queries regardless of length.
//
// The comment here used to say this "avoids the N+1 trap where listing 50
// pledges would otherwise fire 50 SUM queries", and then did exactly
// that: one donor lookup per pledge, and one SUM per pledge in a serial
// loop. Both call sites are unbounded — the list has no LIMIT and
// Insights passes every active pledge — so a parish with 300 pledges
// paid about 600 round trips on every dashboard load, queued behind a
// five-connection pool.
//
// Now: one query resolves every member email, and one aggregates every
// pledge's giving against a VALUES list. The arithmetic is unchanged, and
// so is the donor-key precedence — a linked member's CURRENT email wins
// over the pledge's stored donor_email, so re-canonicalising an address
// on the member record keeps the pledge tracking.
//
// Measured 2026-08-22 on a seeded parish of 300 pledges / 13,400 gifts:
//
//     old (N+1)          198.1 ms    600 round trips
//     new (2 queries)     12.8 ms      2 round trips
//
// Both produce identical per-pledge totals AND gift counts across all 300
// (checked row by row, not just in aggregate). The 15x is the floor, not
// the ceiling: that measurement is over a local socket where a round trip
// is nearly free. Against Supavisor those 600 trips are serial network
// latency queued behind a five-connection pool — the round-trip count is
// the number that actually travels to production, so treat it, not the
// milliseconds, as the durable result.
async function attachFulfillment(orgId, pledges, now = new Date()) {
  if (!pledges.length) return pledges

  const { rows: orgRows } = await pool.query(
    'SELECT timezone FROM ochr_organizations WHERE id = $1',
    [orgId],
  )
  const timeZone = orgRows[0]?.timezone

  // One lookup for every member-linked pledge. The org scope here is
  // defence in depth, not the load-bearing guard, and the falsification
  // says so: removing `AND organization_id = $2` leaves the whole suite
  // green, because ochr_pledges_member_id_org_fk (migration 061) makes a
  // cross-tenant member_id unstorable in the first place — see the test
  // "the DB rejects a cross-tenant pledge member_id below the route layer".
  // Keep the scope (it costs nothing and survives an FK being dropped),
  // but do not mistake it for the thing that makes this safe.
  const memberIds = [...new Set(pledges.map(p => p.member_id).filter(Boolean))]
  const emailByMember = new Map()
  if (memberIds.length) {
    const { rows } = await pool.query(
      `SELECT id, email FROM ochr_clients
        WHERE id = ANY($1::int[]) AND organization_id = $2`,
      [memberIds, orgId])
    for (const r of rows) if (r.email) emailByMember.set(r.id, r.email)
  }

  const donorKey = p => {
    if (p.member_id && emailByMember.has(p.member_id)) return emailByMember.get(p.member_id)
    // Member exists but has no email — fall through to the pledge's own
    // donor_email, exactly as before.
    return p.donor_email || null
  }

  // One aggregate for all of them. LEFT JOIN so a pledge with no
  // matching gifts still comes back with a row, and COUNT(d.id) rather
  // than COUNT(*) — with a left join, COUNT(*) counts the empty match as
  // one gift and every unfulfilled pledge would report gift_count 1.
  const withDonor = pledges.filter(p => donorKey(p))
  const totals = new Map()
  if (withDonor.length) {
    const { rows } = await pool.query(
      `WITH wanted(pledge_id, donor_email, start_date, end_date) AS (
         SELECT * FROM unnest($2::int[], $3::text[], $4::date[], $5::date[])
       )
       SELECT w.pledge_id,
              COALESCE(SUM(d.live_amount), 0)::numeric(12,2) AS total,
              COUNT(d.id)::int AS n
         FROM wanted w
         LEFT JOIN ochr_donation_live d
                ON d.organization_id = $1
               -- Case-insensitive donor identity, as with members (F5): a
               -- pledge stored under one casing must still be credited the
               -- gifts recorded under another, or fulfilment is understated.
               AND lower(d.donor_email) = lower(w.donor_email)
               AND d.date           >= w.start_date
               AND (w.end_date IS NULL OR d.date <= w.end_date)
        GROUP BY w.pledge_id`,
      [
        orgId,
        withDonor.map(p => p.id),
        withDonor.map(p => donorKey(p)),
        withDonor.map(p => p.start_date),
        withDonor.map(p => p.end_date ?? null),
      ])
    for (const r of rows) totals.set(r.pledge_id, { total: Number(r.total), n: r.n })
  }

  const out = []
  for (const pledge of pledges) {
    const got = totals.get(pledge.id) ?? { total: 0, n: 0 }
    const matched_total = got.total
    const gift_count = got.n
    const period_total = expectedPeriodTotal(pledge, now, timeZone)
    const fulfillment  = period_total > 0
      ? Math.min(1, matched_total / period_total)
      : 0
    out.push({
      ...pledge,
      matched_total: Number(matched_total.toFixed(2)),
      period_total:  Number(period_total.toFixed(2)),
      fulfillment,   // 0..1
      gift_count,
    })
  }
  return out
}

// GET /api/pledges?status=active|completed|cancelled
router.get('/', async (req, res) => {
  try {
    const status = req.query.status
    const params = [req.organizationId]
    let where = 'p.organization_id = $1'
    if (status) {
      if (!VALID_STATUSES.has(status)) {
        return res.status(400).json({ error: 'Invalid status' })
      }
      params.push(status)
      where += ` AND p.status = $${params.length}`
    }
    const { rows } = await pool.query(
      `SELECT p.id, p.member_id, p.donor_email, p.amount, p.frequency,
              p.start_date, p.end_date, p.notes, p.status,
              p.created_at, p.updated_at,
              c.name  AS member_name,
              c.email AS member_email
         FROM ochr_pledges p
    LEFT JOIN ochr_clients c
           ON c.id = p.member_id
          AND c.organization_id = p.organization_id
        WHERE ${where}
     ORDER BY p.created_at DESC`,
      params
    )
    const withFulfillment = await attachFulfillment(req.organizationId, rows)
    res.set('Cache-Control', 'private, max-age=60')
    res.json({ pledges: withFulfillment })
  } catch (err) {
    console.error('pledges.list failed:', err)
    res.status(500).json({ error: 'Failed to load pledges' })
  }
})

// GET /api/pledges/:id  → single pledge + matched line items
router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `SELECT p.*, c.name AS member_name, c.email AS member_email
         FROM ochr_pledges p
    LEFT JOIN ochr_clients c
           ON c.id = p.member_id
          AND c.organization_id = p.organization_id
        WHERE p.id = $1 AND p.organization_id = $2`,
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Pledge not found' })
    const pledge = rows[0]
    const [enriched] = await attachFulfillment(req.organizationId, [pledge])

    // Line items: the donations that matched this pledge's window.
    const donor = await donorKeyForPledge(pledge, req.organizationId)
    let lines = []
    if (donor) {
      const { rows: dRows } = await pool.query(
        `SELECT id, amount, refunded_total, live_amount, category, method, date, notes
           FROM ochr_donation_live
          WHERE organization_id = $1
            AND lower(donor_email) = lower($2)
            AND date >= $3
            AND ($4::date IS NULL OR date <= $4)
       ORDER BY date DESC, id DESC`,
        [req.organizationId, donor.key, pledge.start_date, pledge.end_date]
      )
      lines = dRows
    }

    res.set('Cache-Control', 'private, max-age=60')
    res.json({ ...enriched, lines })
  } catch (err) {
    console.error('pledges.get failed:', err)
    res.status(500).json({ error: 'Failed to load pledge' })
  }
})

// POST /api/pledges
router.post('/', async (req, res) => {
  try {
    const { member_id, donor_email, amount, frequency, start_date, end_date, notes, status } = req.body

    // Either member_id or donor_email must be present — the CHECK
    // constraint enforces this at the SQL layer too, but a clean
    // 400 here is friendlier than a Postgres constraint error.
    const pledgeEmail = normalizeDonorEmail(donor_email)
    if (!member_id && !pledgeEmail) {
      return res.status(400).json({ error: 'A member or donor email is required' })
    }
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' })
    }
    if (!VALID_FREQUENCIES.has(frequency)) {
      return res.status(400).json({ error: 'Invalid frequency' })
    }
    if (status && !VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }

    // Sanity: if a member_id is provided, it must belong to the
    // caller's org. Prevents a malicious POST from pledging on
    // another org's member.
    let scopedMemberId = null
    if (member_id) {
      const m = await pool.query(
        'SELECT id FROM ochr_clients WHERE id = $1 AND organization_id = $2',
        [member_id, req.organizationId]
      )
      if (!m.rows.length) return res.status(400).json({ error: 'Member not found' })
      scopedMemberId = m.rows[0].id
    }

    const { rows } = await pool.query(
      `INSERT INTO ochr_pledges
         (organization_id, member_id, donor_email, amount, frequency, start_date, end_date, notes, status)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,CURRENT_DATE),$7,$8,COALESCE($9,'active'))
       RETURNING *`,
      [
        req.organizationId, scopedMemberId, pledgeEmail,
        Number(amount), frequency, start_date || null, end_date || null,
        notes || null, status || null,
      ]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error('pledges.create failed:', err)
    res.status(500).json({ error: 'Failed to create pledge' })
  }
})

// PATCH /api/pledges/:id
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const allowed = ['member_id', 'donor_email', 'amount', 'frequency', 'start_date', 'end_date', 'notes', 'status']
  const sets   = []
  const params = []
  for (const k of allowed) {
    if (!(k in req.body)) continue
    let v = req.body[k]

    // member_id must belong to the caller's org — the same guard POST has
    // applied since Sprint D. Its absence here was a live tenant-isolation
    // hole: member_id sat in the raw allowlist, so an admin in org A could
    // PATCH their own pledge with any ochr_clients.id (sequential SERIALs,
    // so org B's members are enumerable by walking the integer) and the
    // pledge read paths would join that foreign member's name and email
    // straight back into org A's response. Migration 061 now forbids the
    // reference at the DB level too; this check keeps the API answering a
    // clean 400 instead of surfacing a constraint error.
    if (k === 'member_id') {
      if (v === null || v === '') {
        v = null
      } else {
        const n = Number(v)
        if (!Number.isInteger(n) || n <= 0) {
          return res.status(400).json({ error: 'Invalid member_id' })
        }
        try {
          const m = await pool.query(
            'SELECT id FROM ochr_clients WHERE id = $1 AND organization_id = $2',
            [n, req.organizationId]
          )
          if (!m.rows.length) return res.status(400).json({ error: 'Member not found' })
          v = m.rows[0].id
        } catch (err) {
          console.error('pledges.update member lookup failed:', err)
          return res.status(500).json({ error: 'Failed to update pledge' })
        }
      }
      params.push(v)
      sets.push(`${k} = $${params.length}`)
      continue
    }

    if (k === 'frequency' && v && !VALID_FREQUENCIES.has(v)) {
      return res.status(400).json({ error: 'Invalid frequency' })
    }
    if (k === 'status' && v && !VALID_STATUSES.has(v)) {
      return res.status(400).json({ error: 'Invalid status' })
    }
    if (k === 'amount' && v != null) {
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: 'Amount must be a positive number' })
      }
      v = n
    }
    if (typeof v === 'string') v = v.trim() || null
    params.push(v)
    sets.push(`${k} = $${params.length}`)
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' })

  // Bump updated_at on every PATCH.
  sets.push('updated_at = NOW()')
  params.push(id, req.organizationId)

  try {
    const { rows } = await pool.query(
      `UPDATE ochr_pledges SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND organization_id = $${params.length}
        RETURNING *`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Pledge not found' })
    res.json(rows[0])
  } catch (err) {
    // 23514 — the 015 CHECK (member_id IS NOT NULL OR donor_email IS NOT NULL).
    // Reachable by clearing member_id on a pledge that has no donor_email.
    // 23503 — the 061 composite tenant FK. Unreachable through the guard
    // above, but a constraint violation is a client error, not a 500.
    if (err.code === '23514') {
      return res.status(400).json({ error: 'A member or donor email is required' })
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Member not found' })
    }
    console.error('pledges.update failed:', err)
    res.status(500).json({ error: 'Failed to update pledge' })
  }
})

// DELETE /api/pledges/:id
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await pool.query(
      'DELETE FROM ochr_pledges WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    // 404 (not 204) when no row matched — see the tenant-isolation
    // pattern from the Quality pass. Otherwise admins on the wrong
    // org could enumerate pledge ids by checking for 204 vs 404.
    if (result.rowCount === 0) return res.status(404).json({ error: 'Pledge not found' })
    res.status(204).end()
  } catch (err) {
    console.error('pledges.delete failed:', err)
    res.status(500).json({ error: 'Failed to delete pledge' })
  }
})

// Exported for the Insights endpoint to reuse the fulfillment math.
export { attachFulfillment, expectedPeriodTotal }
export default router
