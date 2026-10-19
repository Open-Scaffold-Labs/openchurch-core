// Schedule serving reminders (RM.1).
//
// When members are assigned to a Schedule event (ochr_calendar_events),
// each gets an `assignment_reminder` queued ahead of the event by the
// org's configurable lead time (ochr_organizations.reminder_lead_hours,
// RM.3, default 24h). The reminder flows through the normal drainer →
// notify() path, so it lands in the in-app log + Web Push today and
// starts emailing the moment an email transport is wired — no caller
// changes.
//
// Sync is delete-then-insert keyed on (source_type='calendar_event',
// source_id=eventId), so it's safe to call after ANY roster change
// (create, edit, rotation auto-fill) without piling up duplicates.
// Past-due reminders are never queued: a reminder time already behind
// `now` is simply skipped.

import pool from '../db.js'
import { scheduleNotification } from './scheduler.js'
import { notify } from './transport.js'
import { monitor } from '../monitoring/index.js'

// One-line liturgical note for serving notifications (LIT.2). A named
// feast leads; otherwise the season. Returns "" when neither is set so
// the template renders identically to pre-LIT.2 for plain events. The
// leading newline is baked in (rather than living in the template) so
// the empty case doesn't leave a stray blank line between the intro
// sentence and the location line.
export function liturgicalLine(feast, season) {
  if (feast)  return `\nThis falls on ${feast}${season ? ` (${season})` : ''}.`
  if (season) return `\nLiturgical season: ${season}.`
  return ''
}

// Remove any pending reminders previously queued for these event ids.
// Only 'pending' rows are touched — already-sent reminders stay as
// history. Accepts one id or an array.
export async function cancelEventReminders(organizationId, eventIds) {
  const ids = Array.isArray(eventIds) ? eventIds : [eventIds]
  if (!ids.length) return
  try {
    await pool.query(
      `DELETE FROM ochr_scheduled_notifications
        WHERE organization_id = $1
          AND source_type = 'calendar_event'
          AND source_id = ANY($2::int[])
          AND status = 'pending'`,
      [organizationId, ids]
    )
  } catch (err) {
    monitor.error('reminders.cancel', err, { organizationId, ids })
  }
}

// Re-sync one event's reminders: clear its pending rows, then queue a
// fresh `assignment_reminder` for every assigned member who has an
// email, the org's reminder_lead_hours before the event — but only if that moment
// is still in the future.
export async function syncEventReminders(organizationId, eventId) {
  try {
    await cancelEventReminders(organizationId, eventId)

    const { rows: evs } = await pool.query(
      `SELECT e.id, e.title, e.assigned_to, e.feast_name, e.liturgical_season,
              to_char(e.date, 'FMDay, FMMonth FMDD') AS date_label,
              to_char(e.start_time, 'FMHH12:MI AM')  AS time_label,
              (e.date + e.start_time - (o.reminder_lead_hours || ' hours')::interval) AS remind_at
         FROM ochr_calendar_events e
         JOIN ochr_organizations o ON o.id = e.organization_id
        WHERE e.id = $1 AND e.organization_id = $2 AND o.held_at IS NULL`,
      [eventId, organizationId]
    )
    const ev = evs[0]
    if (!ev) return

    const remindAt = ev.remind_at ? new Date(ev.remind_at) : null
    if (!remindAt || remindAt.getTime() <= Date.now()) return

    const assigned = Array.isArray(ev.assigned_to) ? ev.assigned_to : []
    if (!assigned.length) return

    const { rows: members } = await pool.query(
      `SELECT id, name, email FROM ochr_clients
        WHERE id = ANY($1::int[]) AND organization_id = $2
          AND reminders_opt_out IS NOT TRUE`,
      [assigned, organizationId]
    )

    for (const m of members) {
      if (!m.email) continue // can't remind a member with no email on file
      await scheduleNotification({
        organizationId,
        recipient:         m.email,
        notification_type: 'assignment_reminder',
        vars: {
          recipient_name:      m.name,
          event_title:         ev.title,
          event_date:          ev.date_label,
          event_time:          ev.time_label,
          event_location_line: '',
          liturgical_line:     liturgicalLine(ev.feast_name, ev.liturgical_season),
        },
        sendAt:     remindAt,
        sourceType: 'calendar_event',
        sourceId:   ev.id,
      })
    }
  } catch (err) {
    monitor.error('reminders.sync', err, { organizationId, eventId })
  }
}

// Re-sync every occurrence of a recurring series (by parent id). Used
// after a series create or a "following" batch edit.
export async function syncSeriesReminders(organizationId, parentId) {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1 AND organization_id = $2`,
      [parentId, organizationId]
    )
    for (const r of rows) {
      await syncEventReminders(organizationId, r.id)
    }
  } catch (err) {
    monitor.error('reminders.syncSeries', err, { organizationId, parentId })
  }
}

// Cancel every occurrence of a series — call BEFORE the events are
// deleted so the id list still resolves.
export async function cancelSeriesReminders(organizationId, parentId) {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1 AND organization_id = $2`,
      [parentId, organizationId]
    )
    await cancelEventReminders(organizationId, rows.map(r => r.id))
  } catch (err) {
    monitor.error('reminders.cancelSeries', err, { organizationId, parentId })
  }
}

// Immediate "you've been added" notice (RM.3b) for the given members on
// an event. Goes through notify() — in-app log + Web Push now, email
// when a transport is wired — so a member knows the moment they're
// scheduled, not only the lead-time reminder. Skips members with no
// email or who opted out of serving reminders. notify() calls are
// awaited so the dispatch is observable (e.g. by tests) before the
// caller responds.
export async function notifyAssignmentAdded(organizationId, eventId, memberIds) {
  const ids = (Array.isArray(memberIds) ? memberIds : []).filter(n => Number.isInteger(n))
  if (!ids.length) return
  try {
    const { rows: evs } = await pool.query(
      `SELECT title, feast_name, liturgical_season,
              to_char(date, 'FMDay, FMMonth FMDD') AS date_label,
              to_char(start_time, 'FMHH12:MI AM')  AS time_label
         FROM ochr_calendar_events
        WHERE id = $1 AND organization_id = $2`,
      [eventId, organizationId]
    )
    const ev = evs[0]
    if (!ev) return

    const { rows: members } = await pool.query(
      `SELECT id, name, email FROM ochr_clients
        WHERE id = ANY($1::int[]) AND organization_id = $2
          AND reminders_opt_out IS NOT TRUE`,
      [ids, organizationId]
    )

    for (const m of members) {
      if (!m.email) continue
      try {
        await notify({
          organizationId,
          recipient:         m.email,
          notification_type: 'event_assignment_added',
          vars: {
            recipient_name:      m.name,
            event_title:         ev.title,
            event_date:          ev.date_label,
            event_time:          ev.time_label,
            event_location_line: '',
            liturgical_line:     liturgicalLine(ev.feast_name, ev.liturgical_season),
          },
        })
      } catch (err) {
        monitor.error('notify.calendar_assignment_added', err, { organizationId, memberId: m.id ?? null })
      }
    }
  } catch (err) {
    monitor.error('reminders.notifyAdded', err, { organizationId, eventId })
  }
}
