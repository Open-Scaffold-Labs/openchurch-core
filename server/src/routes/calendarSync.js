import { Router } from 'express'
import pool from '../db.js'
import crypto from 'crypto'
import ical from 'ical-generator'
import { requireIntParam } from '../utils/params.js'
import { apiBase } from '../utils/publicUrl.js'
import { memberByEmail } from '../directory/memberIdentity.js'

// Two sub-routers:
// - publicRouter : the ICS subscription URL. Authenticated by the opaque
//   token in the URL (capability URL). No JWT possible because calendar
//   apps can't send Authorization headers.
// - authRouter   : staff-facing endpoint to generate/fetch a member's
//   subscription URL. Requires a signed-in admin.
// How far back a subscribed calendar reaches.
//
// The feed used to return every event a member had ever been assigned
// to, from the parish's first day forward, on every poll — and a
// calendar app polls a subscription every 15–60 minutes forever, whether
// or not anybody is looking. A parish five years in was re-sending five
// years of Sundays several times an hour, per subscriber.
//
// Ninety days is the window a calendar client renders backwards in any
// useful way, and it keeps the feed a fixed size rather than one that
// grows with the parish's age. Forward is deliberately unbounded: future
// events are the entire point of subscribing, and there are never many —
// the recurrence builder caps a series at 26 weeks.
const FEED_LOOKBACK_DAYS = 90

const publicRouter = Router()
const authRouter   = Router()

async function generateCalendarToken(clientId) {
  const token = crypto.randomBytes(24).toString('hex')
  await pool.query(`UPDATE ochr_clients SET calendar_token = $1 WHERE id = $2
       -- tenancy: the member id was org-verified earlier in this handler before the token is rotated.`, [token, clientId])
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
      `SELECT * FROM ochr_clients WHERE calendar_token = $1
       -- tenancy: the token IS the capability for the public ICS feed — there is no session to take an org from. calendar_token is unique and every downstream query in this handler is scoped to the org this row returns.`,
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
          AND e.date >= CURRENT_DATE - $3::int
        ORDER BY e.date`,
      [client.id, orgId, FEED_LOOKBACK_DAYS]
    )

    // Schedule page entries — JSONB containment matches when assigned_to
    // contains this member's id.
    //
    // The comment here used to say "cast both sides to jsonb so the index
    // can apply", and there was no index. The obvious fix was to add a
    // GIN one. MEASURED AT 120,000 EVENTS, THAT IS THE WRONG FIX:
    //
    //   unbounded, no GIN      80.71ms   1,847 buffers
    //   unbounded, with GIN     5.00ms     448 buffers
    //   bounded,   with GIN     4.80ms     448 buffers
    //   bounded,   no GIN       1.84ms      71 buffers   ← this
    //
    // The date window is what makes this cheap. With it, the org+date
    // btree is far more selective than a containment bitmap over 800
    // members, and adding the GIN index makes the planner choose the
    // worse arm — nearly three times slower and six times the buffers.
    // So there is no index here on purpose, and the purpose is written
    // down so nobody adds one back from first principles.
    //
    // The other containment query (swap.js) is already date-bounded and
    // LIMITed, so it sits in the same regime.
    const { rows: scheduleEvents } = await pool.query(
      `SELECT title, date, start_time, end_time, type
         FROM ochr_calendar_events
        WHERE organization_id = $1
          AND assigned_to @> to_jsonb(ARRAY[$2::int])
          AND date >= CURRENT_DATE - $3::int
        ORDER BY date, start_time`,
      [orgId, client.id, FEED_LOOKBACK_DAYS]
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
// returns a calendar link uses the same shape.
//
// The base comes from utils/publicUrl.js rather than being read inline,
// because the value has to be ABSOLUTE and the inline version could not
// tell. A calendar app given `/api/calendar-sync/abc.ics` has nothing to
// resolve it against — it does not error in a way anyone sees, it just
// never syncs, and the member reports months later that their roster
// "stopped working". Same defect the List-Unsubscribe header had, from
// the same env var: vitest sets BASE_URL="/", and the old
// `process.env.BASE_URL || fallback` accepted it happily because "/" is
// truthy.
function buildIcsUrl(base, token) {
  return `${base}/api/calendar-sync/${token}.ics`
}

// Guard for every route whose response payload IS a URL.
//
// Deliberately checked BEFORE the handler does its work, not after. The
// rotate endpoints invalidate the old token as their first act, so
// discovering afterwards that the new URL cannot be built would leave the
// member with a dead subscription and nothing to replace it with.
//
// A 500 rather than a link to localhost: a subscription URL that resolves
// to the operator's own machine is not a degraded answer, it is a wrong
// one, and it fails quietly inside the member's calendar app where nobody
// is looking.
function requireApiBase(res) {
  const base = apiBase()
  if (!base) {
    console.error('calendar-sync: BASE_URL is not an absolute http(s) URL; refusing to emit a relative subscription link')
    res.status(500).json({
      code: 'base_url_unconfigured',
      error: 'Calendar links are unavailable because the server URL is not configured.',
    })
    return null
  }
  return base
}

// GET /api/calendar-sync/link/:clientId  — get or create calendar URL for a member
authRouter.get('/link/:clientId', async (req, res) => {
  const clientId = requireIntParam(req, res, 'clientId'); if (clientId === null) return
  const base = requireApiBase(res); if (base === null) return
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

    res.json({ url: buildIcsUrl(base, calendar_token), token: calendar_token })
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
  const base = requireApiBase(res); if (base === null) return
  try {
    const member = await memberByEmail(req.organizationId, req.user.email,
      ['id', 'name', 'calendar_token'])
    const rows = member ? [member] : []
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

    res.json({ url: buildIcsUrl(base, calendar_token), token: calendar_token })
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
  const base = requireApiBase(res); if (base === null) return
  try {
    const { rows } = await pool.query(
      'SELECT id FROM ochr_clients WHERE id = $1 AND organization_id = $2',
      [clientId, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Member not found' })

    const token = await generateCalendarToken(clientId)
    res.json({ url: buildIcsUrl(base, token), token })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to rotate calendar token' })
  }
})

// POST /api/calendar-sync/my-rotate  — self-serve rotation.
// Same shape as /rotate/:clientId but the target client is resolved
// from the authed user's email, matching /my-link.
authRouter.post('/my-rotate', async (req, res) => {
  const base = requireApiBase(res); if (base === null) return
  try {
    const member = await memberByEmail(req.organizationId, req.user.email)
    const rows = member ? [member] : []
    if (!rows.length) {
      return res.status(404).json({
        code: 'no_member_match',
        error: 'No church member entry found for your email.',
      })
    }

    const token = await generateCalendarToken(rows[0].id)
    res.json({ url: buildIcsUrl(base, token), token })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to rotate calendar token' })
  }
})

export { publicRouter, authRouter }
