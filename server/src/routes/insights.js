// Tenant analytics — admin-only growth + activity dashboard data.
// Single endpoint that bundles every chart the /insights client page
// needs so the page renders from one fetch. Per-tenant scoped via
// req.organizationId on every query.
//
// Why one endpoint instead of /summary + /timeseries/* split:
// - The dashboard renders the whole thing at once; splitting would
//   force 4-6 round-trips for no UX benefit.
// - The four queries here are cheap (small per-tenant tables, all
//   filtered by organization_id which is indexed).
// - Easier to cache + invalidate as a single resource.

import { Router } from 'express'
import pool from '../db.js'
import { attachFulfillment } from './pledges.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const MONTHS_BACK = 12          // window for the growth + donations trends
const CATEGORY_WINDOW_DAYS = 365 // window for the category breakdown — last 12 months

// GET /api/insights
// Returns:
//   {
//     summary: { member_count, ytd_donations, ai_this_month, ai_last_month, staff_active },
//     members_joined:  [{ month: '2025-12', count: 7 }, ...]   // last 12 months
//     donations_monthly: [{ month: '2025-12', total: 4521.50 }, ...]
//     donations_by_category: [{ category: 'tithe', total: ... }, ...]
//   }
//
// Months are zero-filled — if the org had no joins in May, the row
// shows up with count 0 so the line chart doesn't pinch.
router.get('/', async (req, res) => {
  try {
    const orgId = req.organizationId
    const now   = new Date()
    const yearStart = new Date(now.getFullYear(), 0, 1).toISOString()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()

    const [
      memberCount, ytdDonations, aiThisMonth, aiLastMonth, staffActive,
      membersJoined, donationsMonthly, donationsCategories,
      attendanceSummary, attendanceMonthly,
    ] = await Promise.all([
      // ── Summary cards ────────────────────────────────────────
      pool.query(
        `SELECT COUNT(*)::int AS n FROM ochr_clients
          WHERE organization_id = $1 AND name NOT LIKE '[Sample]%'`,
        [orgId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS total
           FROM ochr_donations
          WHERE organization_id = $1 AND date >= $2
            AND payment_status IS DISTINCT FROM 'refunded'`,
        [orgId, yearStart]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM ochr_ai_usage
          WHERE organization_id = $1 AND created_at >= $2`,
        [orgId, monthStart]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM ochr_ai_usage
          WHERE organization_id = $1
            AND created_at >= $2 AND created_at < $3`,
        [orgId, lastMonthStart, monthStart]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM ochr_payroll_staff
          WHERE organization_id = $1 AND status = 'active'
            AND name NOT LIKE '[Sample]%'`,
        [orgId]
      ),

      // ── Time series ──────────────────────────────────────────
      // generate_series builds the month grid; LEFT JOIN keeps zero
      // months in the result so the line chart doesn't have gaps.
      pool.query(
        `
        WITH months AS (
          SELECT date_trunc('month', generate_series(
            (date_trunc('month', NOW()) - INTERVAL '${MONTHS_BACK - 1} months'),
            date_trunc('month', NOW()),
            INTERVAL '1 month'
          ))::date AS m
        )
        SELECT TO_CHAR(months.m, 'YYYY-MM') AS month,
               COUNT(c.id)::int AS count
          FROM months
     LEFT JOIN ochr_clients c
            ON date_trunc('month', c.created_at)::date = months.m
           AND c.organization_id = $1
           AND c.name NOT LIKE '[Sample]%'
      GROUP BY months.m
      ORDER BY months.m ASC
        `,
        [orgId]
      ),
      pool.query(
        `
        WITH months AS (
          SELECT date_trunc('month', generate_series(
            (date_trunc('month', NOW()) - INTERVAL '${MONTHS_BACK - 1} months'),
            date_trunc('month', NOW()),
            INTERVAL '1 month'
          ))::date AS m
        )
        SELECT TO_CHAR(months.m, 'YYYY-MM') AS month,
               COALESCE(SUM(d.amount),0)::numeric(12,2) AS total
          FROM months
     LEFT JOIN ochr_donations d
            ON date_trunc('month', d.date)::date = months.m
           AND d.organization_id = $1
           AND d.payment_status IS DISTINCT FROM 'refunded'
      GROUP BY months.m
      ORDER BY months.m ASC
        `,
        [orgId]
      ),

      // ── Category breakdown ──────────────────────────────────
      // Trailing 365-day window — long enough to capture the full
      // liturgical year (so seasonal categories like 'special
      // offering' don't get truncated). Skip the [Sample]-tagged
      // donations so admin-meaningful totals dominate.
      pool.query(
        `SELECT COALESCE(NULLIF(category, ''), 'uncategorized') AS category,
                COALESCE(SUM(amount),0)::numeric(12,2) AS total,
                COUNT(*)::int AS count
           FROM ochr_donations
          WHERE organization_id = $1
            AND date >= NOW() - ($2 || ' days')::interval
            AND (notes IS NULL OR notes NOT LIKE '[Sample]%')
            AND payment_status IS DISTINCT FROM 'refunded'
       GROUP BY 1
       ORDER BY total DESC`,
        [orgId, CATEGORY_WINDOW_DAYS]
      ),

      // ── Attendance summary (Sprint T / T.3) ─────────────────
      // Average % attendance per event that has at least one mark.
      // Events with no marks at all are excluded — they'd zero-pull
      // the average and don't reflect reality (the pastor just
      // didn't take attendance that week).
      pool.query(
        `WITH per_event AS (
           SELECT a.event_id,
                  COUNT(*) FILTER (WHERE status = 'present')::float
                    / NULLIF(COUNT(*)::float, 0) AS pct
             FROM ochr_attendance a
             JOIN ochr_events e ON e.id = a.event_id
            WHERE e.organization_id = $1
              AND e.date >= NOW() - INTERVAL '${MONTHS_BACK} months'
            GROUP BY a.event_id
         )
         SELECT
           COUNT(*)::int                                AS tracked_events,
           COALESCE(AVG(pct), 0)::numeric(5,4)          AS avg_attendance_rate
         FROM per_event`,
        [orgId]
      ),

      // 12-month attendance trend — average % per month across all
      // tracked events. Zero-filled via generate_series so the chart
      // doesn't pinch at empty months.
      pool.query(
        `
        WITH months AS (
          SELECT date_trunc('month', generate_series(
            (date_trunc('month', NOW()) - INTERVAL '${MONTHS_BACK - 1} months'),
            date_trunc('month', NOW()),
            INTERVAL '1 month'
          ))::date AS m
        ),
        per_event AS (
          SELECT date_trunc('month', e.date)::date AS month_start,
                 COUNT(*) FILTER (WHERE a.status = 'present')::float
                   / NULLIF(COUNT(*)::float, 0) AS pct
            FROM ochr_attendance a
            JOIN ochr_events e ON e.id = a.event_id
           WHERE e.organization_id = $1
             AND e.date IS NOT NULL
           GROUP BY a.event_id, date_trunc('month', e.date)
        )
        SELECT TO_CHAR(months.m, 'YYYY-MM')                       AS month,
               COALESCE(AVG(pe.pct), 0)::numeric(5,4)             AS avg_rate,
               COUNT(pe.pct)::int                                 AS events
          FROM months
     LEFT JOIN per_event pe ON pe.month_start = months.m
      GROUP BY months.m
      ORDER BY months.m ASC
        `,
        [orgId]
      ),
    ])

    const attRow = attendanceSummary.rows[0] ?? { tracked_events: 0, avg_attendance_rate: 0 }

    // Pledge summary (Sprint D / D.3). Sum the per-pledge fulfillment
    // computed by attachFulfillment so the math stays in one place —
    // pledges.js owns expectedPeriodTotal / donor-key resolution and
    // Insights consumes the result.
    const activePledgesQ = await pool.query(
      `SELECT id, member_id, donor_email, amount, frequency,
              start_date, end_date, notes, status
         FROM ochr_pledges
        WHERE organization_id = $1 AND status = 'active'`,
      [orgId]
    )
    const enrichedPledges = await attachFulfillment(orgId, activePledgesQ.rows)
    const pledgeSummary = {
      active_count:    enrichedPledges.length,
      total_pledged:   Number(enrichedPledges.reduce((s, p) => s + p.period_total,  0).toFixed(2)),
      total_received:  Number(enrichedPledges.reduce((s, p) => s + p.matched_total, 0).toFixed(2)),
    }
    pledgeSummary.fulfillment = pledgeSummary.total_pledged > 0
      ? Math.min(1, pledgeSummary.total_received / pledgeSummary.total_pledged)
      : null

    res.set('Cache-Control', 'private, max-age=60')
    res.json({
      summary: {
        member_count:        memberCount.rows[0].n,
        ytd_donations:       Number(ytdDonations.rows[0].total),
        ai_this_month:       aiThisMonth.rows[0].n,
        ai_last_month:       aiLastMonth.rows[0].n,
        staff_active:        staffActive.rows[0].n,
        // Sprint T / T.3 — attendance summary. avg_attendance_rate
        // is a fraction 0..1; the client renders as a percentage.
        // null when no events have been marked yet (vs 0, which
        // would imply 'attendance was zero' rather than 'nobody has
        // taken attendance yet').
        avg_attendance_rate: attRow.tracked_events > 0 ? Number(attRow.avg_attendance_rate) : null,
        tracked_events:      attRow.tracked_events,
        // Sprint D / D.3 — pledge fulfillment cut. Null when no
        // active pledges; otherwise the matched/expected ratio
        // across all active pledges in the current windows.
        pledge_fulfillment:  pledgeSummary.fulfillment,
        pledges_active:      pledgeSummary.active_count,
        pledges_pledged:     pledgeSummary.total_pledged,
        pledges_received:    pledgeSummary.total_received,
      },
      members_joined:        membersJoined.rows,
      donations_monthly:     donationsMonthly.rows.map(r => ({ month: r.month, total: Number(r.total) })),
      donations_by_category: donationsCategories.rows.map(r => ({ ...r, total: Number(r.total) })),
      attendance_monthly:    attendanceMonthly.rows.map(r => ({
        month:    r.month,
        avg_rate: Number(r.avg_rate),
        events:   r.events,
      })),
    })
  } catch (err) {
    console.error('insights failed:', err)
    res.status(500).json({ error: 'Failed to load insights' })
  }
})

// GET /api/insights/lapsed?weeks=N — the pastoral-care list (INS.4):
// members who HAVE been seen before (attendance or check-in) but not in
// the last N weeks (default 3). Members with no history at all are
// excluded — a brand-new member is an onboarding story, not a lapse.
// This is a care instrument, not a surveillance one: it exists so
// someone notices Mrs. Rivera has been missing and calls her.
router.get('/lapsed', async (req, res) => {
  const weeks = Math.min(26, Math.max(1, Number.parseInt(req.query.weeks, 10) || 3))
  try {
    const { rows } = await pool.query(
      `WITH last_seen AS (
         SELECT c.id, c.name, c.email, c.phone,
                GREATEST(
                  COALESCE((SELECT MAX(a.marked_at) FROM ochr_attendance a
                             WHERE a.member_id = c.id AND a.organization_id = c.organization_id
                               AND a.status = 'present'), 'epoch'::timestamptz),
                  COALESCE((SELECT MAX(k.checked_in_at) FROM ochr_checkins k
                             WHERE k.client_id = c.id AND k.organization_id = c.organization_id), 'epoch'::timestamptz)
                ) AS seen_at
           FROM ochr_clients c
          WHERE c.organization_id = $1
       )
       SELECT id, name, email, phone,
              to_char(seen_at, 'YYYY-MM-DD') AS last_seen,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - seen_at)) / 604800)::INT AS weeks_absent
         FROM last_seen
        WHERE seen_at > 'epoch'::timestamptz
          AND seen_at < NOW() - ($2 || ' weeks')::interval
        ORDER BY seen_at DESC
        LIMIT 200`,
      [req.organizationId, weeks]
    )
    res.json({ weeks, members: rows })
  } catch (err) {
    monitor.error('insights.lapsed', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the pastoral-care list' })
  }
})

export default router
