import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam, parsePagination } from '../utils/params.js'
import { parseCSVToObjects } from '../utils/csv.js'
import { resolveLiturgicalContext } from './liturgical.js'
import { notify } from '../notifications/transport.js'
import { scheduleNotification } from '../notifications/scheduler.js'
import { liturgicalLine } from '../notifications/calendarReminders.js'
import { zonedDateTimeToUtc } from '../utils/timezone.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// Columns the events CSV importer accepts. assigned_members and
// language are app-managed defaults — we don't expose them via CSV
// for v1 to keep the template lean.
const IMPORT_COLUMNS = [
  'title',
  'service_division',
  'date',
  'time',
  'location',
  'liturgical_season',
  'liturgical_color',
  'feast_name',
]

// Sanity-check date and time strings without pulling in a parser. We
// just want "is this in the right shape" — Postgres will reject
// truly malformed values when we INSERT.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/

// Helper — normalize incoming member_ids to a unique array of integers.
function normalizeMemberIds(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const v of raw) {
    const n = parseInt(v, 10)
    if (Number.isFinite(n) && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

// Helper — replace the set of members assigned to an event.
// Returns the set of member_ids that were NOT previously assigned (i.e. new
// assignees who should be notified). Caller has already verified that the
// event + every member_id belong to orgId.
async function setEventMembers(client, eventId, memberIds, orgId) {
  const { rows: prevRows } = await client.query(
    'SELECT member_id FROM ochr_event_members WHERE event_id = $1',
    [eventId]
  )
  const previous = new Set(prevRows.map(r => r.member_id))
  const added = memberIds.filter(id => !previous.has(id))

  await client.query('DELETE FROM ochr_event_members WHERE event_id = $1', [eventId])
  if (memberIds.length === 0) return added
  // $1 = event_id, $2 = organization_id (constant), then member_id per row.
  // The org stamp satisfies the composite tenant FKs (migration 044); the
  // event + members were already scoped to orgId by the caller.
  const values = memberIds.map((_, i) => `($1, $2, $${i + 3})`).join(', ')
  await client.query(
    `INSERT INTO ochr_event_members (event_id, organization_id, member_id) VALUES ${values} ON CONFLICT DO NOTHING`,
    [eventId, orgId, ...memberIds]
  )
  return added
}

// Helper — drop any member_ids that don't belong to orgId. Called before
// touching event_members so an admin can't stealth-assign someone else's
// members by guessing ids.
async function filterMemberIdsToOrg(db, memberIds, orgId) {
  if (!memberIds.length) return []
  const { rows } = await db.query(
    'SELECT id FROM ochr_clients WHERE id = ANY($1::int[]) AND organization_id = $2',
    [memberIds, orgId]
  )
  return rows.map(r => r.id)
}

// Helper — create a notification row per newly-assigned member for this event.
// Runs *after* the event-save transaction commits so a notification failure
// never rolls the event back. Every notification belongs to the same org.
async function notifyEventAssignments(db, event, memberIds, organizationId) {
  if (!memberIds || memberIds.length === 0) return
  const { rows: valid } = await db.query(
    'SELECT id FROM ochr_clients WHERE id = ANY($1::int[]) AND organization_id = $2',
    [memberIds, organizationId]
  )
  if (valid.length === 0) return
  const when = event.date
    ? ` on ${new Date(event.date).toLocaleDateString()}${event.time ? ` at ${event.time}` : ''}`
    : ''
  const message = `You have been assigned to the event: "${event.title}"${when}`
  const params = []
  const placeholders = valid.map((row, i) => {
    const base = i * 5
    params.push(organizationId, row.id, event.id, event.title, message)
    return `('event', $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`
  })
  await db.query(
    `INSERT INTO ochr_notifications (type, organization_id, member_id, event_id, event_title, message)
     VALUES ${placeholders.join(', ')}`,
    params
  )
}

// Helper — dispatch email-track notifications for newly-assigned
// members. Mirrors notifyEventAssignments (which writes to the
// in-app inbox table) but goes through the vendor-neutral notify()
// transport so the same logic flips to a real email provider once
// the team lead picks one.
//
// For each newly-added member we:
//   1. Fire `event_assignment_added` immediately so they know they
//      were added.
//   2. If the event has a date in the future (>= 24h away), enqueue
//      an `assignment_reminder` for 24h before the event starts.
//      Closer than that and the immediate add notification suffices.
//
// Errors are swallowed (logged, never thrown) so a notification path
// hiccup never blocks the event-create response. Same fire-and-forget
// posture as notifyEventAssignments.
async function dispatchEventNotifications(db, event, memberIds, organizationId) {
  if (!memberIds || memberIds.length === 0) return

  const { rows: members } = await db.query(
    `SELECT id, name, email FROM ochr_clients
      WHERE id = ANY($1::int[]) AND organization_id = $2`,
    [memberIds, organizationId]
  )
  if (members.length === 0) return

  // The parish's timezone (040) — "24h before the 10:00 service" must
  // mean 10:00 where the parish worships, not UTC on Vercel (H4).
  const { rows: orgRows } = await db.query(
    `SELECT timezone FROM ochr_organizations WHERE id = $1`,
    [organizationId]
  )
  const orgTz = orgRows[0]?.timezone || 'UTC'

  const startsAt = (() => {
    if (!event.date) return null
    const datePart = event.date.toISOString
      ? event.date.toISOString().slice(0, 10)
      : String(event.date).slice(0, 10)
    // Postgres TIME columns come back as 'HH:MM:SS' strings, but
    // callers can also pass plain 'HH:MM'. Normalize to HH:MM.
    const rawTime  = event.time ? String(event.time) : '00:00'
    const hhmm     = rawTime.slice(0, 5)
    return zonedDateTimeToUtc(datePart, hhmm, orgTz)
  })()

  const dateLabel = startsAt
    ? startsAt.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
    : 'TBD'
  const timeLabel = event.time || 'TBD'
  const locationLine = event.location ? `Location: ${event.location}.` : ''

  const baseVars = {
    event_title:         event.title,
    event_date:          dateLabel,
    event_time:          timeLabel,
    event_location_line: locationLine,
    // LIT.2 — surface the liturgical day in both the immediate notice
    // and the scheduled reminder. /api/events stamps feast_name +
    // liturgical_season at create/update (auto-mapped from the date),
    // so the row passed in already has them.
    liturgical_line:     liturgicalLine(event.feast_name, event.liturgical_season),
  }

  const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000
  const reminderAt = startsAt ? new Date(startsAt.getTime() - REMINDER_LEAD_MS) : null
  const reminderInFuture = reminderAt && reminderAt.getTime() > Date.now()

  for (const m of members) {
    const vars = { ...baseVars, recipient_name: m.name }

    // Immediate "you've been added" notification.
    notify({
      organizationId,
      recipient:         m.email ?? null,
      notification_type: 'event_assignment_added',
      vars,
    }).catch(err => monitor.error('notify.event_assignment_added', err, { recipient: m.email }))

    // Pre-event reminder, only when the event is far enough away.
    if (reminderInFuture) {
      scheduleNotification({
        organizationId,
        recipient:         m.email ?? null,
        notification_type: 'assignment_reminder',
        vars,
        sendAt:            reminderAt,
      }).catch(err => monitor.error('notify.schedule_assignment_reminder', err, { recipient: m.email }))
    }
  }
}

// Helper — attach assigned members to a list of events (same-org only).
async function attachMembers(events, organizationId) {
  if (!events.length) return events
  const ids = events.map(e => e.id)
  const { rows } = await pool.query(
    `SELECT em.event_id, c.id, c.name, c.role
       FROM ochr_event_members em
       JOIN ochr_clients c ON c.id = em.member_id
      WHERE em.event_id = ANY($1::int[]) AND c.organization_id = $2
      ORDER BY c.name ASC`,
    [ids, organizationId]
  )
  const byEvent = new Map()
  for (const r of rows) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, [])
    byEvent.get(r.event_id).push({ id: r.id, name: r.name, role: r.role })
  }
  for (const e of events) {
    e.assigned_members = byEvent.get(e.id) ?? []
  }
  return events
}

// GET /api/events?search=
router.get('/', async (req, res) => {
  try {
    const { search } = req.query
    const orgId = req.organizationId
    // Optional paging with a hard safety ceiling (see parsePagination) so
    // this list can never stream an unbounded event log. Response stays a
    // bare array — clients/tests depend on that shape.
    const { limit, offset } = parsePagination(req.query)
    const { rows } = search
      ? await pool.query(
          `SELECT * FROM ochr_events
           WHERE organization_id = $1
             AND (title ILIKE $2 OR service_division ILIKE $2 OR location ILIKE $2)
           ORDER BY date ASC, time ASC
           LIMIT $3 OFFSET $4`,
          [orgId, `%${search}%`, limit, offset]
        )
      : await pool.query(
          'SELECT * FROM ochr_events WHERE organization_id = $1 ORDER BY date ASC, time ASC LIMIT $2 OFFSET $3',
          [orgId, limit, offset]
        )
    await attachMembers(rows, orgId)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load events' })
  }
})

// GET /api/events/:id — single event with members
router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      'SELECT * FROM ochr_events WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    await attachMembers(rows, req.organizationId)
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load event' })
  }
})

// GET /api/events/:id/tasks — auto-linked tasks (same assigned member as event)
router.get('/:id/tasks', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    // Verify the event belongs to the caller's org before revealing anything
    // that joins across it.
    const { rows: ev } = await pool.query(
      'SELECT 1 FROM ochr_events WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!ev.length) return res.status(404).json({ error: 'Not found' })

    const { rows } = await pool.query(
      `SELECT t.*, c.name AS assigned_member_name
         FROM ochr_tasks t
         JOIN ochr_event_members em ON em.member_id = t.assigned_member_id
         LEFT JOIN ochr_clients c   ON c.id          = t.assigned_member_id
        WHERE em.event_id = $1
          AND t.organization_id = $2
        ORDER BY
          CASE t.status WHEN 'PENDING' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
          CASE t.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
          t.due_date NULLS LAST,
          t.created_at`,
      [id, req.organizationId]
    )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load linked tasks' })
  }
})

// POST /api/events
router.post('/', async (req, res) => {
  const client = await pool.connect()
  let created, newlyAdded
  try {
    const { title, service_division, date, time, location, liturgical_season, liturgical_color, feast_name, member_ids, is_public } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
    // is_public defaults FALSE — every event is private until the
    // admin explicitly opts in via the modal toggle (Sprint P).
    const isPublic = is_public === true
    const rawIds = normalizeMemberIds(member_ids)
    const ids = await filterMemberIdsToOrg(client, rawIds, req.organizationId)

    // Auto-map liturgical context when the caller omitted any of the
    // three fields and a date is present. Explicit body values always
    // win — admins can still pin a non-default color for one-offs.
    let resolvedSeason = liturgical_season
    let resolvedColor  = liturgical_color
    let resolvedFeast  = feast_name
    if (date && (!liturgical_season || !liturgical_color || feast_name === undefined)) {
      const ctx = await resolveLiturgicalContext(date, req.organizationId)
      if (!resolvedSeason) resolvedSeason = ctx.season
      if (!resolvedColor)  resolvedColor  = ctx.color
      if (resolvedFeast === undefined) resolvedFeast = ctx.feast_name
    }

    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO ochr_events (organization_id, title, service_division, date, time, location, liturgical_season, liturgical_color, feast_name, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.organizationId, title, service_division, date || null, time || null, location, resolvedSeason || null, resolvedColor || null, resolvedFeast || null, isPublic]
    )
    created = rows[0]
    newlyAdded = await setEventMembers(client, created.id, ids, req.organizationId)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    console.error(err)
    return res.status(500).json({ error: 'Failed to create event' })
  }
  client.release()

  try {
    await notifyEventAssignments(pool, created, newlyAdded, req.organizationId)
  } catch (err) {
    console.error('notifyEventAssignments failed (event created OK):', err)
  }

  try {
    await dispatchEventNotifications(pool, created, newlyAdded, req.organizationId)
  } catch (err) {
    console.error('dispatchEventNotifications failed (event created OK):', err)
  }

  try { await attachMembers([created], req.organizationId) } catch { /* response still valid without members */ }
  res.status(201).json(created)
})

// POST /api/events/import
// Bulk-imports events from a CSV body. Strict schema (see
// IMPORT_COLUMNS). Title is required; everything else optional.
//
// No duplicate detection — events don't have a natural unique key
// (two services on the same day at different locations are real),
// so we trust the admin's file. They can hand-clean dupes if any
// slip through.
router.post('/import', async (req, res) => {
  try {
    const { csv } = req.body ?? {}
    if (typeof csv !== 'string' || !csv.trim()) {
      return res.status(400).json({ error: 'No CSV content provided' })
    }

    const { headers, rows } = parseCSVToObjects(csv)
    if (!headers.length) {
      return res.status(400).json({ error: 'CSV appears to be empty' })
    }
    if (!headers.includes('title')) {
      return res.status(400).json({
        error: `CSV must include a "title" column. Expected columns: ${IMPORT_COLUMNS.join(', ')}.`
      })
    }
    const unknown = headers.filter(h => !IMPORT_COLUMNS.includes(h))
    if (unknown.length) {
      return res.status(400).json({
        error: `Unknown column(s): ${unknown.join(', ')}. Allowed: ${IMPORT_COLUMNS.join(', ')}.`
      })
    }
    if (!rows.length) {
      return res.status(400).json({ error: 'CSV has a header row but no data rows' })
    }

    const results = { imported: 0, errors: [] }

    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i]
      const line = i + 2 // +1 header row, +1 for 1-indexed line numbers

      const title = (row.title || '').trim()
      if (!title) {
        results.errors.push({ line, message: 'Missing title' })
        continue
      }
      // Lightweight shape checks — DB will catch real format errors.
      if (row.date && !DATE_RE.test(row.date.trim())) {
        results.errors.push({ line, message: `Invalid date "${row.date}" — expected YYYY-MM-DD` })
        continue
      }
      if (row.time && !TIME_RE.test(row.time.trim())) {
        results.errors.push({ line, message: `Invalid time "${row.time}" — expected HH:MM` })
        continue
      }

      try {
        await pool.query(
          `INSERT INTO ochr_events
            (organization_id, title, service_division, date, time, location,
             liturgical_season, liturgical_color, feast_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            req.organizationId,
            title,
            row.service_division ? row.service_division.trim() : null,
            row.date  ? row.date.trim()  : null,
            row.time  ? row.time.trim()  : null,
            row.location ? row.location.trim() : null,
            row.liturgical_season ? row.liturgical_season.trim() : null,
            row.liturgical_color  ? row.liturgical_color.trim()  : null,
            row.feast_name ? row.feast_name.trim() : null,
          ]
        )
        results.imported++
      } catch (err) {
        console.error(`events import: line ${line} insert failed:`, err)
        results.errors.push({ line, message: 'Database rejected the row' })
      }
    }

    res.json(results)
  } catch (err) {
    console.error('events import failed:', err)
    res.status(500).json({ error: 'Failed to import events' })
  }
})

// PATCH /api/events/:id
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const client = await pool.connect()
  let updated, newlyAdded = []
  try {
    const { title, service_division, date, time, location, liturgical_season, liturgical_color, feast_name, member_ids, is_public } = req.body

    if (title !== undefined && !String(title).trim()) {
      client.release()
      return res.status(400).json({ error: 'Title is required' })
    }

    // Partial-update semantics (audit H1): only columns present in the
    // body are written. The old query wrote every column unconditionally,
    // so a one-field PATCH (e.g. { is_public: true }) silently nulled
    // title/date/time/location. The allowlist is hardcoded — nothing
    // from the request reaches the SQL text.
    const PATCHABLE = ['title', 'service_division', 'date', 'time', 'location', 'liturgical_season', 'liturgical_color', 'feast_name']
    const sets = []
    const vals = []
    for (const col of PATCHABLE) {
      if (req.body[col] !== undefined) {
        vals.push(req.body[col] === '' ? null : req.body[col])
        sets.push(`${col} = $${vals.length}`)
      }
    }
    if (is_public !== undefined) {
      vals.push(is_public === true)
      sets.push(`is_public = $${vals.length}`)
    }

    await client.query('BEGIN')
    let rows
    if (sets.length) {
      ;({ rows } = await client.query(
        `UPDATE ochr_events SET ${sets.join(', ')}
          WHERE id = $${vals.length + 1} AND organization_id = $${vals.length + 2} RETURNING *`,
        [...vals, id, req.organizationId]
      ))
    } else {
      // Roster-only PATCH (member_ids with no column changes) — fetch
      // the row for the response without touching it.
      ;({ rows } = await client.query(
        `SELECT * FROM ochr_events WHERE id = $1 AND organization_id = $2`,
        [id, req.organizationId]
      ))
    }
    if (!rows.length) {
      await client.query('ROLLBACK')
      client.release()
      return res.status(404).json({ error: 'Not found' })
    }

    if (Array.isArray(member_ids)) {
      const scoped = await filterMemberIdsToOrg(client, normalizeMemberIds(member_ids), req.organizationId)
      newlyAdded = await setEventMembers(client, rows[0].id, scoped, req.organizationId)
    }
    await client.query('COMMIT')
    updated = rows[0]
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    console.error(err)
    return res.status(500).json({ error: 'Failed to update event' })
  }
  client.release()

  if (newlyAdded.length) {
    try {
      await notifyEventAssignments(pool, updated, newlyAdded, req.organizationId)
    } catch (err) {
      console.error('notifyEventAssignments failed (event updated OK):', err)
    }
    try {
      await dispatchEventNotifications(pool, updated, newlyAdded, req.organizationId)
    } catch (err) {
      console.error('dispatchEventNotifications failed (event updated OK):', err)
    }
  }

  try { await attachMembers([updated], req.organizationId) } catch { /* response still valid */ }
  res.json(updated)
})

// DELETE /api/events/:id
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await pool.query(
      'DELETE FROM ochr_events WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete event' })
  }
})

export default router
