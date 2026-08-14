import { Router } from 'express'
import pool from '../db.js'
import crypto from 'crypto'
import ical from 'ical-generator'
import { requireIntParam } from '../utils/params.js'

// Two sub-routers:
// - publicRouter : the ICS subscription URL. Authenticated by the opaque
//   token in the URL (capability URL). No JWT possible because calendar
//   apps can't send Authorization headers.
// - authRouter   : staff-facing endpoint to generate/fetch a member's
//   subscription URL. Requires a signed-in admin.
const publicRouter = Router()
const authRouter   = Router()

async function generateCalendarToken(clientId) {
  const token = crypto.randomBytes(24).toString('hex')
  await pool.query('UPDATE ochr_clients SET calendar_token = $1 WHERE id = $2', [token, clientId])
  return token
}

function toDateOnly(d) {
  if (!d) return null
  return d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
}

function generateICS(client, tasks, events, scheduleEvents) {
  const calendar = ical({ name: `${client.name} – OpenChurch` })

  // Tasks → all-day entries on their due date
  for (const task of tasks) {
    if (!task.due_date) continue
    const date = new Date(task.due_date)
    calendar.createEvent({
      start: date,
      end: date,
      allDay: true,
      summary: task.title,
      description: task.description || '',
    })
  }

  // Events page entries (ochr_events) — already filtered to ones this
  // member is on the roster for via ochr_event_members.
  for (const event of events) {
    if (!event.date) continue
    const datePart = toDateOnly(event.date)
    // Postgres TIME columns come back as 'HH:MM:SS'; callers can
    // also send 'HH:MM'. Normalize to HH:MM before appending :00 so
    // the constructor never sees 'HH:MM:SS:00'.
    const rawTime  = event.time ? String(event.time) : '00:00'
    const hhmm     = rawTime.slice(0, 5)
    const start = new Date(`${datePart}T${hhmm}:00`)
    const end   = new Date(start.getTime() + 60 * 60 * 1000)
    calendar.createEvent({
      start,
      end,
      summary: event.title,
      location: event.location || '',
      description: event.service_division || '',
    })
  }

  // Schedule page entries (ochr_calendar_events) — already filtered to
  // ones where this member is in the assigned_to JSONB array.
  for (const ev of scheduleEvents) {
    if (!ev.date || !ev.start_time || !ev.end_time) continue
    const datePart = toDateOnly(ev.date)
    const start = new Date(`${datePart}T${ev.start_time}`)
    const end   = new Date(`${datePart}T${ev.end_time}`)
    calendar.createEvent({
      start,
      end,
      summary: ev.title,
      description: ev.type ? `Type: ${ev.type}` : '',
    })
  }

  return calendar.toString()
}

// GET /api/calendar-sync/:token.ics  — public ICS feed
// The token is the capability — anyone holding it gets that member's feed.
// Every query here is scoped to the client's organization so we never
// leak cross-tenant events even if tokens collide (shouldn't, but belt-and-suspenders).
publicRouter.get('/:token.ics', async (req, res) => {
  try {
    const { token } = req.params
    const { rows: clientRows } = await pool.query(
      'SELECT * FROM ochr_clients WHERE calendar_token = $1',
      [token]
    )
    if (!clientRows.length) return res.status(404).send('Calendar not found')

    const client = clientRows[0]
    const orgId  = client.organization_id

    const { rows: tasks } = await pool.query(
      `SELECT title, description, due_date
         FROM ochr_tasks
        WHERE assigned_member_id = $1 AND organization_id = $2 AND due_date IS NOT NULL`,
      [client.id, orgId]
    )

    // Events page entries — only the ones this member is assigned to via
    // ochr_event_members. The previous query returned every event in the
    // org, which meant subscribers were getting the whole church's
    // calendar dumped on them.
    const { rows: events } = await pool.query(
      `SELECT e.title, e.date, e.time, e.location, e.service_division
         FROM ochr_events e
         JOIN ochr_event_members em ON em.event_id = e.id
        WHERE em.member_id = $1 AND e.organization_id = $2
        ORDER BY e.date`,
      [client.id, orgId]
    )

    // Schedule page entries — JSONB containment matches when assigned_to
    // contains this member's id. Cast both sides to jsonb so the index
    // can apply.
    const { rows: scheduleEvents } = await pool.query(
      `SELECT title, date, start_time, end_time, type
         FROM ochr_calendar_events
        WHERE organization_id = $1
          AND assigned_to @> to_jsonb(ARRAY[$2::int])
        ORDER BY date, start_time`,
      [orgId, client.id]
    )

    const icsContent = generateICS(client, tasks, events, scheduleEvents)

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${client.name.replace(/\s+/g, '_')}_calendar.ics"`)
    res.send(icsContent)
  } catch (err) {
    console.error(err)
    res.status(500).send('Failed to generate calendar')
  }
})

// Build the public ICS URL for a token. Centralized so any route that
// returns a calendar link uses the same shape (and the same fallback).
function buildIcsUrl(token) {
  const baseUrl = process.env.BASE_URL || `http://localhost:3034`
  return `${baseUrl}/api/calendar-sync/${token}.ics`
}

// GET /api/calendar-sync/link/:clientId  — get or create calendar URL for a member
authRouter.get('/link/:clientId', async (req, res) => {
  const clientId = requireIntParam(req, res, 'clientId'); if (clientId === null) return
  try {
    const { rows } = await pool.query(
      'SELECT id, name, calendar_token FROM ochr_clients WHERE id = $1 AND organization_id = $2',
      [clientId, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Member not found' })

    let { calendar_token } = rows[0]
    if (!calendar_token) {
      calendar_token = await generateCalendarToken(clientId)
    }

    res.json({ url: buildIcsUrl(calendar_token), token: calendar_token })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to generate calendar link' })
  }
})

// GET /api/calendar-sync/my-link  — self-serve variant of /link/:clientId.
// Matches the authed user's email to a member row in the same org so a
// staff member can grab their own feed without an admin handing it over.
// 404s with a clear code when the user isn't on the member roster (the
// UI uses the code to silently hide the card instead of surfacing an
// error toast for a non-error condition).
authRouter.get('/my-link', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, calendar_token
         FROM ochr_clients
        WHERE LOWER(email) = LOWER($1) AND organization_id = $2
        LIMIT 1`,
      [req.user.email, req.organizationId]
    )
    if (!rows.length) {
      return res.status(404).json({
        code: 'no_member_match',
        error: 'No church member entry found for your email. Ask an admin to add you to the member roster.',
      })
    }

    const client = rows[0]
    let { calendar_token } = client
    if (!calendar_token) {
      calendar_token = await generateCalendarToken(client.id)
    }

    res.json({ url: buildIcsUrl(calendar_token), token: calendar_token })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to generate calendar link' })
  }
})

// POST /api/calendar-sync/rotate/:clientId  — admin/staff rotation.
// Generates a fresh token, immediately invalidating any existing
// subscription. Use when a member's link is exposed or shared with the
// wrong person.
authRouter.post('/rotate/:clientId', async (req, res) => {
  const clientId = requireIntParam(req, res, 'clientId'); if (clientId === null) return
  try {
    const { rows } = await pool.query(
      'SELECT id FROM ochr_clients WHERE id = $1 AND organization_id = $2',
      [clientId, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Member not found' })

    const token = await generateCalendarToken(clientId)
    res.json({ url: buildIcsUrl(token), token })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to rotate calendar token' })
  }
})

// POST /api/calendar-sync/my-rotate  — self-serve rotation.
// Same shape as /rotate/:clientId but the target client is resolved
// from the authed user's email, matching /my-link.
authRouter.post('/my-rotate', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM ochr_clients
        WHERE LOWER(email) = LOWER($1) AND organization_id = $2
        LIMIT 1`,
      [req.user.email, req.organizationId]
    )
    if (!rows.length) {
      return res.status(404).json({
        code: 'no_member_match',
        error: 'No church member entry found for your email.',
      })
    }

    const token = await generateCalendarToken(rows[0].id)
    res.json({ url: buildIcsUrl(token), token })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to rotate calendar token' })
  }
})

export { publicRouter, authRouter }
