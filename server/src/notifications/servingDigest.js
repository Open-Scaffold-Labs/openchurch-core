// Weekly serving digest (NV.2 / Sprint 2). A cron calls
// sendWeeklyServingDigests() once a week; each member with at least one
// Schedule assignment in the next 7 days gets a single summary email
// (one digest instead of a reminder per event). Goes through notify() —
// in-app + Web Push today, email when a transport is wired. Members who
// opted out of serving reminders, or have no email, are skipped.
//
// Runs across all orgs (cron context).

import pool from '../db.js'
import { notify } from './transport.js'
import { monitor } from '../monitoring/index.js'

export async function sendWeeklyServingDigests() {
  let recipients = 0, sent = 0

  // Every assignment in the next 7 days, with the event's display bits.
  const { rows: events } = await pool.query(
    `SELECT id, organization_id, title, assigned_to,
            to_char(date, 'FMDay, FMMon FMDD')  AS date_label,
            to_char(start_time, 'FMHH12:MI AM') AS time_label
       FROM ochr_calendar_events
      WHERE date >= CURRENT_DATE
        AND date <  CURRENT_DATE + INTERVAL '7 days'
        AND jsonb_array_length(assigned_to) > 0
      ORDER BY organization_id, date ASC, start_time ASC`
  )

  // Group the assignments by (org, member).
  const byMember = new Map() // key `${org}:${clientId}` → { orgId, clientId, lines[] }
  for (const ev of events) {
    const assigned = Array.isArray(ev.assigned_to) ? ev.assigned_to : []
    for (const cid of assigned) {
      const key = `${ev.organization_id}:${cid}`
      if (!byMember.has(key)) byMember.set(key, { orgId: ev.organization_id, clientId: cid, lines: [] })
      byMember.get(key).lines.push(`• ${ev.title} — ${ev.date_label} at ${ev.time_label}`)
    }
  }
  if (byMember.size === 0) return { recipients: 0, sent: 0 }

  // Resolve member names/emails, skipping opted-out + no-email members.
  const clientIds = [...new Set([...byMember.values()].map(m => m.clientId))]
  const { rows: members } = await pool.query(
    `SELECT id, organization_id, name, email FROM ochr_clients
      WHERE id = ANY($1::int[]) AND reminders_opt_out IS NOT TRUE AND email IS NOT NULL AND email <> ''`,
    [clientIds]
  )
  const memberById = new Map(members.map(m => [`${m.organization_id}:${m.id}`, m]))

  for (const [key, agg] of byMember) {
    const m = memberById.get(key)
    if (!m) continue
    recipients++
    try {
      await notify({
        organizationId:    agg.orgId,
        recipient:         m.email,
        notification_type: 'weekly_serving_digest',
        vars: {
          recipient_name: m.name,
          events_list:    agg.lines.join('\n'),
        },
      })
      sent++
    } catch (err) {
      monitor.error('digest.serving', err, { orgId: agg.orgId, clientId: agg.clientId })
    }
  }

  return { recipients, sent }
}
