// Year-end giving statements (Sprint Y). Admin-only — gift histories
// are sensitive; only admins (the bookkeeper / treasurer) get to
// query them.
//
// Two endpoints power the admin UI:
//
//   GET /api/giving-statements/preview?year=YYYY
//     → list every donor who gave in <year> with their total + count.
//       The 'donor key' groups by donor_email when present, else by
//       donor_name. The response carries both so the UI can show
//       "John Doe · 3 gifts · $1,250" and link to the per-donor
//       breakdown.
//
//   GET /api/giving-statements/donor?key=...&year=YYYY[&by=email|name]
//     → one donor's line items + computed total for the year. Used
//       by the print-friendly statement page (Y.3). `by` defaults to
//       'email' when the key contains '@' and 'name' otherwise.
//
// Both endpoints scope strictly to req.organizationId. There is no
// public-facing donor-self-serve here — that would require a
// separate auth flow + magic-link or token system.

import { Router } from 'express'
import pool from '../db.js'

const router = Router()

// Conservative year window. Donations earlier than 2010 are
// unlikely in this product; we reject to surface typos like
// year=202 quickly.
const MIN_YEAR = 2010

function parseYear(raw) {
  const n = Number(raw)
  if (!Number.isInteger(n)) return null
  const thisYear = new Date().getFullYear()
  if (n < MIN_YEAR || n > thisYear + 1) return null
  return n
}

// GET /api/giving-statements/preview?year=YYYY
// Returns: { year, donors: [{ donor_key, by, donor_name, donor_email,
//            total, gift_count }, ...], total_donors, total_amount }
//
// Donors are listed in descending total order so the high-impact
// givers are visible first — the bookkeeper usually starts the
// statement run from the top of that list.
router.get('/preview', async (req, res) => {
  const year = parseYear(req.query.year)
  if (year === null) {
    return res.status(400).json({ error: 'Invalid year' })
  }

  try {
    // Group by email when present (most reliable identity), else by
    // a 'name:<donor_name>' fallback. The UNION ALL keeps both
    // branches readable + indexable rather than packing into one
    // CASE WHEN expression that would foil the partial index.
    const { rows } = await pool.query(
      `
      WITH email_grouped AS (
        SELECT
          'email' AS by,
          donor_email AS donor_key,
          MIN(donor_name) AS donor_name,
          donor_email,
          SUM(amount)::numeric(12,2) AS total,
          COUNT(*)::int AS gift_count
        FROM ochr_donations
        WHERE organization_id = $1
          AND EXTRACT(YEAR FROM date)::int = $2
          AND donor_email IS NOT NULL
        GROUP BY donor_email
      ),
      name_grouped AS (
        SELECT
          'name' AS by,
          donor_name AS donor_key,
          donor_name,
          NULL::text AS donor_email,
          SUM(amount)::numeric(12,2) AS total,
          COUNT(*)::int AS gift_count
        FROM ochr_donations
        WHERE organization_id = $1
          AND EXTRACT(YEAR FROM date)::int = $2
          AND donor_email IS NULL
        GROUP BY donor_name
      )
      SELECT * FROM email_grouped
      UNION ALL
      SELECT * FROM name_grouped
      ORDER BY total DESC, donor_name ASC
      `,
      [req.organizationId, year]
    )

    const total_amount = rows.reduce((sum, r) => sum + Number(r.total), 0)

    res.set('Cache-Control', 'private, max-age=60')
    res.json({
      year,
      donors: rows,
      total_donors: rows.length,
      total_amount: Number(total_amount.toFixed(2)),
    })
  } catch (err) {
    console.error('giving-statements.preview failed:', err)
    res.status(500).json({ error: 'Failed to load giving statements' })
  }
})

// GET /api/giving-statements/donor?key=...&year=YYYY[&by=email|name]
// Returns: { year, donor: {name, email, address}, lines: [...],
//            total, gift_count }
router.get('/donor', async (req, res) => {
  const year = parseYear(req.query.year)
  if (year === null) return res.status(400).json({ error: 'Invalid year' })

  const key = String(req.query.key || '').trim()
  if (!key) return res.status(400).json({ error: 'donor key required' })

  // Default 'by' heuristic — email when the key looks like one,
  // otherwise name. Client can override explicitly via ?by=name to
  // disambiguate edge cases (e.g. a donor named like an email).
  const by = req.query.by === 'name' || req.query.by === 'email'
    ? req.query.by
    : (key.includes('@') ? 'email' : 'name')

  try {
    const filter = by === 'email'
      ? 'donor_email = $3'
      : 'donor_name  = $3 AND donor_email IS NULL'

    const { rows } = await pool.query(
      `SELECT id, donor_name, donor_email, donor_address,
              amount, category, method, date, notes
         FROM ochr_donations
        WHERE organization_id = $1
          AND EXTRACT(YEAR FROM date)::int = $2
          AND ${filter}
        ORDER BY date ASC, id ASC`,
      [req.organizationId, year, key]
    )

    if (rows.length === 0) {
      // 404 rather than empty so the print page can render a clean
      // 'no gifts on file for <donor> in <year>' state instead of an
      // empty statement.
      return res.status(404).json({ error: 'No donations found for this donor + year' })
    }

    // Pull the org's letterhead fields alongside the donor data so
    // the print view (Y.3) renders from a single fetch. Fields may
    // be NULL on orgs that haven't filled in Settings → Org details
    // yet; the client handles the placeholder state.
    const orgQ = await pool.query(
      `SELECT name, address, tax_id, signatory_name, signatory_title, statement_letterhead
         FROM ochr_organizations
        WHERE id = $1`,
      [req.organizationId]
    )
    const org = orgQ.rows[0] ?? {}

    // Prefer the first row's contact block; if a donor's address
    // varies across rows (rare — they moved mid-year), the most
    // recent row's address is the safer mailing target.
    const latest = rows[rows.length - 1]
    const donor = {
      name:    latest.donor_name,
      email:   latest.donor_email,
      address: latest.donor_address,
    }
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0)

    res.set('Cache-Control', 'private, max-age=60')
    res.json({
      year,
      by,
      key,
      donor,
      organization: {
        name:                 org.name ?? null,
        address:              org.address ?? null,
        tax_id:               org.tax_id ?? null,
        signatory_name:       org.signatory_name ?? null,
        signatory_title:      org.signatory_title ?? null,
        statement_letterhead: org.statement_letterhead ?? null,
      },
      lines: rows,
      total: Number(total.toFixed(2)),
      gift_count: rows.length,
    })
  } catch (err) {
    console.error('giving-statements.donor failed:', err)
    res.status(500).json({ error: 'Failed to load donor statement' })
  }
})

export default router
