import { Router } from 'express'
import pool from '../db.js'

const router = Router()

// Sample rows are identifiable by a '[Sample]' prefix in their title/name
// — kept as a shared constant so the status query and the clear query
// stay in lockstep if we ever change the marker.
const SAMPLE_PREFIX = '[Sample]%'

// GET /api/onboarding/status
// Returns whether the caller's org still has any sample rows left, and
// per-kind counts. The client uses `hasSamples` to decide whether to
// render the "Clear sample data" banner on the Dashboard.
//
// Match conventions per table:
//   members / events / tasks / staff / schedule  → name|title LIKE '[Sample]%'
//   donations                                    → notes LIKE '[Sample]%'
//     (donor_name stays clean — putting "[Sample]" in front of every
//     donor name is uglier than tagging the notes column)
router.get('/status', async (req, res) => {
  try {
    const orgId = req.organizationId

    // Single trip — gather sample counts + real-data signals + team
    // size + letterhead state. The Dashboard's checklist card (Sprint O)
    // read all of these in one call; that card is gone — it filled a bar
    // to doneCount/totalCount, which is the pressure the First Parish
    // Setup sprint removed. What survives here is `hasSamples`, which is
    // still the "clear the sample rows" banner's signal and is a fact
    // rather than a score. Each query is independent so Promise.all
    // parallelizes them.
    //
    // 'Real' here means NOT (name/title LIKE '[Sample]%'). Donations
    // use the notes column for sample marking — see the seed file.
    const [
      sMembers, sEvents, sTasks, sDonations, sStaff, sSchedule,
      rMembers, rEvents,
      teamSize, org,
    ] = await Promise.all([
      // Sample counts (existing behavior)
      pool.query(`SELECT COUNT(*)::int AS n FROM ochr_clients WHERE organization_id = $1 AND name  LIKE $2`, [orgId, SAMPLE_PREFIX]),
      pool.query(`SELECT COUNT(*)::int AS n FROM ochr_events WHERE organization_id = $1 AND title LIKE $2`, [orgId, SAMPLE_PREFIX]),
      pool.query(`SELECT COUNT(*)::int AS n FROM ochr_tasks WHERE organization_id = $1 AND title LIKE $2`, [orgId, SAMPLE_PREFIX]),
      pool.query(`SELECT COUNT(*)::int AS n FROM ochr_donations WHERE organization_id = $1 AND notes LIKE $2`, [orgId, SAMPLE_PREFIX]),
      pool.query(`SELECT COUNT(*)::int AS n FROM ochr_payroll_staff WHERE organization_id = $1 AND name LIKE $2`, [orgId, SAMPLE_PREFIX]),
      pool.query(`SELECT COUNT(*)::int AS n FROM ochr_calendar_events WHERE organization_id = $1 AND title LIKE $2`, [orgId, SAMPLE_PREFIX]),

      // Real-data signals — checklist 'done' state per item
      pool.query(`SELECT COUNT(*)::int AS n FROM ochr_clients WHERE organization_id = $1 AND name  NOT LIKE $2`, [orgId, SAMPLE_PREFIX]),
      pool.query(`SELECT COUNT(*)::int AS n FROM ochr_events  WHERE organization_id = $1 AND title NOT LIKE $2`, [orgId, SAMPLE_PREFIX]),

      // Team size + org letterhead readiness
      pool.query(`SELECT COUNT(*)::int AS n FROM ochr_users WHERE organization_id = $1`, [orgId]),
      pool.query(`SELECT tax_id, signatory_name, page_published FROM ochr_organizations WHERE id = $1`, [orgId]),
    ])

    const counts = {
      members:   sMembers.rows[0].n,
      events:    sEvents.rows[0].n,
      tasks:     sTasks.rows[0].n,
      donations: sDonations.rows[0].n,
      staff:     sStaff.rows[0].n,
      schedule:  sSchedule.rows[0].n,
    }
    const realCounts = {
      members: rMembers.rows[0].n,
      events:  rEvents.rows[0].n,
    }
    const orgRow = org.rows[0] ?? {}

    res.json({
      hasSamples: Object.values(counts).reduce((a, b) => a + b, 0) > 0,
      counts,
      // Sprint O additions — onboarding checklist signals. Each is a
      // boolean the client uses to render the 'done' state of a row.
      realCounts,
      has_real_members:  realCounts.members > 0,
      has_real_events:   realCounts.events  > 0,
      has_letterhead:    Boolean(orgRow.tax_id && orgRow.signatory_name),
      has_team_invited:  teamSize.rows[0].n > 1,
      // Anchor 5 / A5.3 — checklist signal for the public church page.
      has_published_page: Boolean(orgRow.page_published),
    })
  } catch (err) {
    console.error('onboarding status failed:', err)
    res.status(500).json({ error: 'Failed to load onboarding status' })
  }
})

// POST /api/onboarding/clear-samples
// Deletes every [Sample]-prefixed row in the caller's org across the
// three seeded tables. Safe to call when there are no samples (no-op),
// so the client can fire-and-forget without checking status first.
//
// FK cascades on ochr_event_members / ochr_tasks.assigned_member_id
// handle any references that may have been created between signup and
// the clear request (e.g. an admin assigned a real member to a sample
// event before clearing).
router.post('/clear-samples', async (req, res) => {
  try {
    const orgId = req.organizationId
    // ochr_event_members rows cascade via FK from ochr_events;
    // ochr_payroll_shifts cascade from ochr_payroll_staff. The
    // recurrence_parent_id self-FK on ochr_calendar_events is also
    // ON DELETE CASCADE, but we delete by title match so every row
    // in the series matches independently.
    const [members, events, tasks, donations, staff, schedule] = await Promise.all([
      pool.query(
        `DELETE FROM ochr_clients WHERE organization_id = $1 AND name LIKE $2`,
        [orgId, SAMPLE_PREFIX]
      ),
      pool.query(
        `DELETE FROM ochr_events WHERE organization_id = $1 AND title LIKE $2`,
        [orgId, SAMPLE_PREFIX]
      ),
      pool.query(
        `DELETE FROM ochr_tasks WHERE organization_id = $1 AND title LIKE $2`,
        [orgId, SAMPLE_PREFIX]
      ),
      // A CHARGED GIFT IS NOT SAMPLE DATA, WHATEVER ITS NOTES SAY.
      //
      // Every other line here matches a column the seed writes and nobody
      // else does. This one does not: ochr_donations.notes is where the
      // PUBLIC give page stores the donor's own message
      // (publicEvents.js:374 — `message || null`, and the Stripe webhook
      // does the same with session metadata). So the predicate is a text
      // match on donor-controlled text, and a gift whose message happened to
      // begin "[Sample]" was hard-deleted here — with a real payment_ref,
      // past the refuseDeletingChargedGift guard that owns DELETE
      // /api/donations/:id, and without a vault capture, so not recoverable
      // either.
      //
      // payment_ref IS NULL is the whole fix: the sample seed never sets one
      // (onboarding/sampleSeed.js:384 has no payment column), and a gift that
      // has one is a record of money that moved. Refund it or keep it.
      pool.query(
        `DELETE FROM ochr_donations
          WHERE organization_id = $1 AND notes LIKE $2 AND payment_ref IS NULL`,
        [orgId, SAMPLE_PREFIX]
      ),
      pool.query(
        `DELETE FROM ochr_payroll_staff WHERE organization_id = $1 AND name LIKE $2`,
        [orgId, SAMPLE_PREFIX]
      ),
      pool.query(
        `DELETE FROM ochr_calendar_events WHERE organization_id = $1 AND title LIKE $2`,
        [orgId, SAMPLE_PREFIX]
      ),
    ])
    res.json({
      cleared: {
        members:   members.rowCount,
        events:    events.rowCount,
        tasks:     tasks.rowCount,
        donations: donations.rowCount,
        staff:     staff.rowCount,
        schedule:  schedule.rowCount,
      },
    })
  } catch (err) {
    console.error('clear samples failed:', err)
    res.status(500).json({ error: 'Failed to clear sample data' })
  }
})

export default router
