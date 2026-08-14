// Swap-request nudge (NV.3 / Sprint 2). A daily cron calls
// nudgePendingSwaps(): any swap request that's been pending for a few
// days and hasn't been nudged yet gets ONE reminder to the target
// member. reminded_at is stamped so it's not re-sent. Goes through
// notify() — in-app + Web Push now, email when a transport is wired.
//
// Runs across all orgs (cron context).

import pool from '../db.js'
import { notify } from '../notifications/transport.js'
import { monitor } from '../monitoring/index.js'

const NUDGE_AFTER_DAYS = 2

export async function nudgePendingSwaps() {
  let nudged = 0

  const { rows } = await pool.query(
    `SELECT r.id, r.organization_id,
            e.title AS event_title,
            to_char(e.date, 'FMDay, FMMon FMDD')  AS event_date,
            to_char(e.start_time, 'FMHH12:MI AM') AS event_time,
            rc.name AS requester_name,
            tc.name AS target_name,
            tc.email AS target_email
       FROM ochr_swap_requests r
       JOIN ochr_calendar_events e ON e.id  = r.calendar_event_id
       JOIN ochr_clients rc        ON rc.id = r.requester_client_id
       JOIN ochr_clients tc        ON tc.id = r.target_client_id
      WHERE r.status = 'pending'
        AND r.reminded_at IS NULL
        AND r.created_at < NOW() - ($1 || ' days')::interval
      LIMIT 500`,
    [String(NUDGE_AFTER_DAYS)]
  )

  for (const r of rows) {
    // Stamp first so a notify failure doesn't cause a re-nudge loop.
    await pool.query('UPDATE ochr_swap_requests SET reminded_at = NOW() WHERE id = $1', [r.id])
    if (!r.target_email) continue
    try {
      await notify({
        organizationId:    r.organization_id,
        recipient:         r.target_email,
        notification_type: 'swap_pending_reminder',
        vars: {
          target_name:    r.target_name,
          requester_name: r.requester_name,
          event_title:    r.event_title,
          event_date:     r.event_date,
          event_time:     r.event_time,
        },
      })
      nudged++
    } catch (err) {
      monitor.error('swap.nudge', err, { swapRequestId: r.id })
    }
  }

  return { nudged }
}
