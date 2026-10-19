// Mass intention routes (MI.1 / MI.4). Tenant-scoped book of requested Mass
// intentions.
//
//   GET    /api/mass-intentions              → the book (paginated, ?status=, ?q=)
//   GET    /api/mass-intentions/weekly       → sacristy manifest window
//   GET    /api/mass-intentions/nearest-outside → closest listing date outside a window
//                                               + tenant undated-waiting signal
//   GET    /api/mass-intentions/awaiting     → unassigned, offerable on a date
//   GET    /api/mass-intentions/:id          → one entry
//   POST   /api/mass-intentions              → add a request
//   POST   /api/mass-intentions/:id/assign   → offer at a scheduled Mass (MI.4)
//   POST   /api/mass-intentions/:id/unassign → release from a Mass (MI.4)
//   PATCH  /api/mass-intentions/:id          → edit allowlisted fields
//   DELETE /api/mass-intentions/:id          → remove
//
// All queries scope on organization_id. Writes are staff/admin (writeGate at
// the mount); viewers read. A linked requester (requested_by_client_id) is
// validated against the caller's org before write.
//
// Assigning to a Mass is one trusted fact: the event's date becomes
// mass_date, and an open intention becomes scheduled. The book, weekly
// sheet, Sunday Packet, and calendar tiles all read that same row.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam, parsePagination } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'
import {
  canonicalIsoDate,
  finiteSpanDays,
  orgTodayIso,
  readWeeklyDate,
  resolveWeeklyWindow,
  usableTimeZone,
} from '../utils/sheetWeek.js'

const router = Router()

export const MI_STATUSES = new Set(['open', 'scheduled', 'fulfilled', 'cancelled'])

// Fulfill is a ceremony that promises a Mass. New writes must not mint
// NULL stamps and call them history. Parish English — never "snapshot".
export const REFUSE_FULFILL_WITHOUT_MASS =
  'This intention is not offered at a Mass yet — nothing was lost.'

// A date-only PATCH must not park the book on a different day from the
// linked Mass. Unassign (calendar_event_id: null) or name the Mass.
// The row is left as it was. Fulfilled stamps are not written here.
export const REFUSE_DATE_DISAGREES =
  'That date is not the assigned Mass. Nothing was changed. Clear the assignment, or choose the Mass for that date.'

export const REFUSE_NOT_A_MASS =
  "That isn't a Mass. Nothing was changed."
// Distinct from the date-conflict 409, so the book can say which refusal it was.
export const NOT_A_MASS_CODE = 'not_a_mass'
// Only this code is the date-conflict sentence. Other 409s stay generic.
export const DATE_CONFLICT_CODE = 'date_conflict'
// A recorded fulfilment is not a link that can be moved. Re-link is
// refused while any fulfilled_mass_* column is set. Correction is a
// later, audited act — this path does not clear or rewrite the stamp.
export const STAMPED_HISTORY_CODE = 'stamped_history'
export const STAMP_CONFLICT_CODE = 'stamp_conflict'
export const PREVIOUSLY_RECORDED_FULFILMENT = 'previously recorded fulfilment'

export const REFUSE_STAMPED_HISTORY =
  'This intention was already recorded at a Mass. The link was not changed. Nothing was lost.'

export const REFUSE_STAMP_CONFLICT =
  'This intention was already recorded at a Mass whose day, name, or time has changed. Nothing was changed.'

// New links are refused only for a type known not to be a Mass.
// Kept in step with client/src/utils/massEvent.js.
//
// The Schedule form writes three types:
//   service — default pill. A Mass.
//   event   — Event pill, and what POST stores when type is omitted,
//             null, or blank. Also the column default. Accepted,
//             because a real Mass may be stored this way.
//   meeting — the only clearly non-liturgical type that form writes.
//             Refused in any case, including surrounding spaces.
//
// Also accepted: mass, liturgy, a blank type, SQL NULL, and any other
// word. Production's mix of stored types is UNKNOWN, so an allowlist
// would strand a Mass we have not seen.
export const NON_MASS_EVENT_TYPES = new Set(['meeting'])

export function isMassEvent(event) {
  if (!event) return false
  if (event.type == null) return true
  const type = String(event.type).trim().toLowerCase()
  if (type === '') return true
  return !NON_MASS_EVENT_TYPES.has(type)
}

// Stored calendar day: bare YYYY-MM-DD, or UTC-midnight JSON of a DATE.
// A shifted instant is not a day, so it cannot match the Mass.
export function intentionCalendarDay(value) {
  if (value == null || value === '') return ''
  const s = String(value).trim()
  const bare = /^(\d{4}-\d{2}-\d{2})$/.exec(s)
  if (bare) return bare[1]
  const utcMidnight = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z$/.exec(s)
  return utcMidnight ? utcMidnight[1] : ''
}

// An explicit mass_date that is not the linked Mass's civil day.
// A missing mass_date is not a conflict — the Mass's day is used.
// Null and blank are present, and they are not that day.
export function explicitDayConflicts(body, massDay) {
  if (body == null || !Object.prototype.hasOwnProperty.call(body, 'mass_date')) return false
  return intentionCalendarDay(body.mass_date) !== massDay
}

export function dateConflictBody() {
  return { error: REFUSE_DATE_DISAGREES, code: DATE_CONFLICT_CODE }
}

// Any one of the three columns is a recorded fulfilment. All-null is
// the legacy unknown row, which this guard does not treat as history.
export function hasFulfilmentStamp(row) {
  if (!row) return false
  return row.fulfilled_mass_date != null
    || row.fulfilled_mass_title != null
    || row.fulfilled_mass_time != null
}

function clockFace(value) {
  if (value == null || value === '') return null
  const s = String(value).trim()
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s)
  if (!m) return s
  return `${m[1]}:${m[2]}:${m[3] || '00'}`
}

// The live linked Mass equals the stamp only when date, title, and
// time all match. A rename, a retime, or a moved day is not the same
// recording. Compared as civil text, never as a JS Date.
export function stampMatchesLive(stamp, event) {
  if (!stamp || !event) return false
  const stampDate = stamp.fulfilled_mass_date == null
    ? null
    : (intentionCalendarDay(stamp.fulfilled_mass_date) || null)
  const liveDate = event.date == null
    ? null
    : (intentionCalendarDay(event.date) || null)
  if (stampDate !== liveDate) return false
  const stampTitle = stamp.fulfilled_mass_title == null ? null : String(stamp.fulfilled_mass_title)
  const liveTitle = event.title == null ? null : String(event.title)
  if (stampTitle !== liveTitle) return false
  return clockFace(stamp.fulfilled_mass_time) === clockFace(event.start_time)
}

// Book rows that are no longer fulfilled, but still carry a stamp.
// The words are the label. Never the plain word "fulfilled".
export function fulfilmentLabelSql(alias) {
  return `CASE
            WHEN ${alias}.status IS DISTINCT FROM 'fulfilled'
             AND (${alias}.fulfilled_mass_date IS NOT NULL
               OR ${alias}.fulfilled_mass_title IS NOT NULL
               OR ${alias}.fulfilled_mass_time IS NOT NULL)
            THEN '${PREVIOUSLY_RECORDED_FULFILMENT}'
            ELSE NULL
          END`
}

// Offering on the book. NUMERIC(10,2): null means no stipend. A missing
// field and JSON null stay null. Empty string is not "no stipend", and
// Number() must not turn whitespace, true, [], or "1e2" into money.
// Never store a bad offering as 0 or as null. Whole cents only — a
// longer fraction would be rounded by the column.
const STIPEND_MAX_CENTS = 9999999999 // 99999999.99
const STIPEND_TEXT = /^\d+(?:\.\d{1,2})?$/
export const STIPEND_REFUSED = 'That offering is not a real amount. Nothing was saved.'

function centsFromNumber(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || Object.is(n, -0) || n < 0) return null
  const scaled = n * 100
  const cents = Math.round(scaled)
  if (Math.abs(scaled - cents) > 1e-6) return null
  if (!Number.isSafeInteger(cents) || cents > STIPEND_MAX_CENTS) return null
  return cents
}

function centsFromText(s) {
  if (typeof s !== 'string' || !STIPEND_TEXT.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  if (whole.length > 8) return null
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2))
  if (!Number.isSafeInteger(cents) || cents > STIPEND_MAX_CENTS) return null
  return cents
}

function formatCents(cents) {
  const whole = Math.trunc(cents / 100)
  const frac = cents % 100
  return `${whole}.${String(frac).padStart(2, '0')}`
}

// { ok: true, value: null | 'x.xx' } or { ok: false }.
// null / undefined → no stipend. Anything else must be a real amount.
export function readStipend(v) {
  if (v === null || v === undefined) return { ok: true, value: null }
  const cents = typeof v === 'number' ? centsFromNumber(v) : centsFromText(v)
  if (cents === null) return { ok: false }
  return { ok: true, value: formatCents(cents) }
}

// Columns a PATCH may touch, and how to read each from the body. Closed
// allowlist so organization_id / unknown columns can never be set.
// R285-F1: columns compared before/after a PATCH so the audit row can name
// what changed. Only field NAMES leave this module (plus numeric stipend);
// intention / requester / note text never does.
const CHANGE_COLS = 'intention, requested_by, note, stipend, requested_by_client_id'
export const MI_CHANGE_FIELDS = ['intention', 'note', 'requested_by', 'requested_by_client_id', 'stipend', 'mass_date', 'status', 'calendar_event_id']
const changeKey = v => (v == null ? null : String(v))
// R285-4: the audit's projected state comes from the SAME committed
// RETURNING row as changed[] (not the post-COMMIT loadFull re-read, which a
// concurrent writer can change first). Typed ids/status only, no text.
const snapInt = v => (v == null ? null : (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null))
// R4-L1: every mass_intention write (create, PATCH, assign, unassign)
// publishes the row IT saved (RETURNING, or the locked row on a no-op) as
// the audit snapshot. Typed ids/status only, no text.
export function massIntentionSnapshot(row) {
  return {
    id: snapInt(row?.id),
    requested_by_client_id: snapInt(row?.requested_by_client_id),
    calendar_event_id: snapInt(row?.calendar_event_id),
    status: typeof row?.status === 'string' ? row.status : null,
  }
}
const SNAP_COLS = 'id, requested_by_client_id, calendar_event_id, status'
export function massIntentionChange(before, after) {
  const changed = MI_CHANGE_FIELDS.filter(f => changeKey(before?.[f]) !== changeKey(after?.[f]))
  return {
    changed,
    stipend_before: before?.stipend ?? null,
    stipend_after: after?.stipend ?? null,
    snapshot: massIntentionSnapshot(after),
  }
}

const EDITABLE = {
  intention:    v => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
  requested_by: v => (v == null ? null : String(v).trim() || null),
  mass_date:    v => (v === null || v === '' ? null : String(v)),
  note:         v => (v == null ? null : String(v).trim() || null),
  status:       v => (MI_STATUSES.has(v) ? v : undefined),
  stipend:      v => {
    const read = readStipend(v)
    return read.ok ? read.value : undefined
  },
}

// A requester member id is a positive integer or its decimal string. Anything
// else (true, '', 1.5, '1e2', ' 7') reads as NaN so the caller refuses it;
// Number(true) === 1 must never select member 1.
// ochr_clients.id is SERIAL (int4), so the domain is 1..2147483647. Anything
// outside it is refused BEFORE a query, with the same not-found answer, so an
// oversized value never reaches Postgres as a range error (R285-1). Strings
// must be canonical decimal (no sign, no leading zero, no spaces, no exponent);
// at most 10 digits, so no float rounding is possible before the bound check.
export const MEMBER_ID_MAX = 2147483647
export function readMemberId(v) {
  let n = NaN
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && /^[1-9][0-9]{0,9}$/.test(v)) n = Number(v)
  return Number.isSafeInteger(n) && n >= 1 && n <= MEMBER_ID_MAX ? n : NaN
}

async function clientInOrg(clientId, orgId, client = pool) {
  const { rows } = await client.query(
    'SELECT 1 FROM ochr_clients WHERE id = $1 AND organization_id = $2',
    [clientId, orgId]
  )
  return rows.length > 0
}

async function eventInOrg(eventId, orgId, client = pool) {
  const { rows } = await client.query(
    `SELECT id,
            to_char(date, 'YYYY-MM-DD') AS date,
            title,
            to_char(start_time, 'HH24:MI:SS') AS start_time,
            type
       FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2`,
    [eventId, orgId]
  )
  return rows[0] || null
}

function sameEventId(a, b) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return Number(a) === Number(b)
}

function upsertSet(sets, params, col, val) {
  const prefix = `${col} = `
  const i = sets.findIndex(s => s.startsWith(prefix))
  if (i >= 0) params[i] = val
  else {
    params.push(val)
    sets.push(`${col} = $${params.length}`)
  }
}

async function loadFull(id, orgId, client = pool) {
  const { rows } = await client.query(
    `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE s.id = $1 AND s.organization_id = $2`,
    [id, orgId]
  )
  return rows[0] || null
}

// The Mass is the authority for date and "is this offered".
// Open → scheduled on link; scheduled → open on release. Fulfilled and
// cancelled stay put — those are historical facts, not scheduling state.
function statusOnLink(current) {
  return current === 'open' ? 'scheduled' : current
}
function statusOnRelease(current) {
  return current === 'scheduled' ? 'open' : current
}

// Fulfilled presentation is the stamp only. NULL stays unknown — never
// COALESCE to the live calendar or to the working mass_date. Open and
// scheduled keep the live JOIN. JSON keys stay mass_date / mass_title /
// mass_time so clients do not grow a second pair.
const SELECT_COLS = `s.id, s.intention, s.requested_by, s.requested_by_client_id,
                     CASE WHEN s.status = 'fulfilled'
                          THEN to_char(s.fulfilled_mass_date, 'YYYY-MM-DD')
                          ELSE to_char(s.mass_date, 'YYYY-MM-DD')
                     END AS mass_date,
                     s.calendar_event_id, s.stipend, s.status, s.note,
                     s.created_at, s.updated_at, c.name AS requester_name,
                     CASE WHEN s.status = 'fulfilled'
                          THEN s.fulfilled_mass_title
                          ELSE e.title
                     END AS mass_title,
                     CASE WHEN s.status = 'fulfilled'
                          THEN to_char(s.fulfilled_mass_time, 'HH24:MI')
                          ELSE to_char(e.start_time, 'HH24:MI')
                     END AS mass_time,
                     ${fulfilmentLabelSql('s')} AS fulfilment_label`

const FROM_JOIN = `FROM ochr_mass_intentions s
                   LEFT JOIN ochr_clients c
                     ON c.id = s.requested_by_client_id AND c.organization_id = s.organization_id
                   LEFT JOIN ochr_calendar_events e
                     ON e.id = s.calendar_event_id AND e.organization_id = s.organization_id`

// SP-064: "past scheduled — fulfilment not recorded". A row still marked
// scheduled whose stored Mass day (s.mass_date, the canonical day for every
// non-fulfilled row) is strictly before TODAY on the parish's own clock.
// Read-only: the passage of time never marks anything fulfilled, and this is
// not a claim that the Mass was or was not celebrated. Unknown dates, today,
// the future, open, cancelled and fulfilled rows never match.
const pastScheduledSql = todayParam =>
  `(s.status = 'scheduled' AND s.mass_date IS NOT NULL AND s.mass_date < ${todayParam}::date)`

// GET /api/mass-intentions?status=&q=&view=past_scheduled  (the book)
router.get('/', async (req, res) => {
  const { limit, offset } = parsePagination(req.query)
  const statusFilter = typeof req.query.status === 'string' && MI_STATUSES.has(req.query.status)
    ? req.query.status : null
  const pastOnly = req.query.view === 'past_scheduled'

  try {
    // Parish clock (JWT organization only — never the host's or browser's
    // zone), the same helpers the weekly sheet uses.
    const orgTz = await pool.query(`SELECT timezone FROM ochr_organizations WHERE id = $1`, [req.organizationId])
    const todayIso = orgTodayIso(new Date(), usableTimeZone(orgTz.rows[0]?.timezone))

    const where = ['s.organization_id = $1']
    const params = [req.organizationId, todayIso]
    const pastExpr = pastScheduledSql('$2')
    if (statusFilter) { params.push(statusFilter); where.push(`s.status = $${params.length}`) }
    // Filtered in SQL before LIMIT/OFFSET, so every page is from the whole
    // tenant-scoped set, not from rows the client already downloaded.
    if (pastOnly) where.push(pastExpr)

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q) {
      const escaped = q.replace(/[\\%_]/g, ch => `\\${ch}`)
      params.push(`%${escaped}%`)
      const p = `$${params.length}`
      where.push(`(s.intention ILIKE ${p} OR s.requested_by ILIKE ${p} OR c.name ILIKE ${p})`)
    }
    params.push(limit, offset)

    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS}, ${pastExpr} AS past_scheduled ${FROM_JOIN}
        WHERE ${where.join(' AND ')}
        ORDER BY CASE WHEN s.status = 'fulfilled' THEN s.fulfilled_mass_date ELSE s.mass_date END
                 ASC NULLS FIRST, s.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    res.json({ intentions: rows })
  } catch (err) {
    monitor.error('massIntentions.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load Mass intentions' })
  }
})

// GET /api/mass-intentions/weekly?start=YYYY-MM-DD&end=YYYY-MM-DD (MI.2)
// The sacristy manifest: intentions for a date range, from the
// read-optimized ochr_sacristy_weekly_manifest view. Filter on week_date
// (listing window), not mass_date — fulfilled rows with NULL stamps still
// belong in the working week's sheet with unknown chrome. With neither
// date, the window is the parish's vigil week (Saturday through Friday
// of the coming Sunday) in ochr_organizations.timezone. One omitted side
// stays a literal 7 days around the date that was sent. Capped at 31
// days. Defined BEFORE '/:id' so the literal path isn't swallowed.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WEEKLY_ROW_CAP = 500
router.get('/weekly', async (req, res) => {
  const startRead = readWeeklyDate(req.query.start)
  const endRead = readWeeklyDate(req.query.end)
  // Impossible calendar days (2026-02-31, 2026-13-01) used to fall through
  // into SQL and come back as 500 plus an error log. They are a bad request.
  if (startRead.invalid || endRead.invalid) {
    return res.status(400).json({ error: 'start and end must be real calendar dates' })
  }
  const startQ = startRead.date
  const endQ = endRead.date

  try {
    // Parish clock. Needed before the default window, and again for the
    // generation stamp. JWT organization only — never the host's zone.
    // An invalid stored zone is echoed as UTC, the column default.
    const orgTz = await pool.query(
      `SELECT timezone FROM ochr_organizations WHERE id = $1`,
      [req.organizationId]
    )
    const timezone = usableTimeZone(orgTz.rows[0]?.timezone)
    const todayIso = orgTodayIso(new Date(), timezone)
    const { start, end } = resolveWeeklyWindow(startQ, endQ, todayIso)

    if (!canonicalIsoDate(start) || !canonicalIsoDate(end)) {
      return res.status(400).json({ error: 'start and end must be real calendar dates' })
    }
    if (end < start) return res.status(400).json({ error: 'end must be on or after start' })
    const spanDays = finiteSpanDays(start, end)
    if (spanDays == null || spanDays > 31) {
      return res.status(400).json({ error: spanDays == null
        ? 'start and end must be real calendar dates'
        : 'Range is capped at 31 days' })
    }

    // One snapshot for the page and the count. Two autocommit statements
    // can disagree by a row if a write commits between them, and the stamp
    // would then name a total the page does not show. REPEATABLE READ
    // freezes that snapshot; READ ONLY keeps the lock cheap.
    const db = await pool.connect()
    let manifest
    let total
    // A failed ROLLBACK leaves the session unusable. release(err) destroys
    // that client instead of returning it to the pool. Only this route.
    let destroyClient = null
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      manifest = await db.query(
        `SELECT id, to_char(mass_date, 'YYYY-MM-DD') AS mass_date, mass_title,
                to_char(mass_time, 'HH24:MI') AS mass_time, formatted_intention,
                requested_by, requester_name, stipend, status, note,
                calendar_event_id, fulfilment_label
           FROM ochr_sacristy_weekly_manifest
          WHERE organization_id = $1 AND week_date BETWEEN $2 AND $3
          ORDER BY week_date ASC, mass_date ASC NULLS LAST, mass_time ASC NULLS LAST, id ASC
          LIMIT ${WEEKLY_ROW_CAP}`,
        [req.organizationId, start, end]
      )
      total = await db.query(
        `SELECT COUNT(*)::int AS n
           FROM ochr_sacristy_weekly_manifest
          WHERE organization_id = $1 AND week_date BETWEEN $2 AND $3`,
        [req.organizationId, start, end]
      )
      await db.query('COMMIT')
    } catch (err) {
      try {
        await db.query('ROLLBACK')
      } catch (rollbackErr) {
        destroyClient = rollbackErr
      }
      throw err
    } finally {
      db.release(destroyClient)
    }
    const intentionTotal = Number(total.rows[0]?.n)
    const shown = manifest.rows.length
    const truncated = Number.isFinite(intentionTotal) && intentionTotal > shown
    res.json({
      start,
      end,
      timezone,
      generated_at: new Date().toISOString(),
      intention_total: Number.isFinite(intentionTotal) ? intentionTotal : shown,
      truncated,
      intentions: manifest.rows,
    })
  } catch (err) {
    monitor.error('massIntentions.weekly', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load the weekly manifest' })
  }
})

// GET /api/mass-intentions/nearest-outside?start=&end=
// Empty-week honesty: closest week_date on the sacristy view that is
// outside [start, end], plus a tenant-scoped count of open/scheduled
// intentions with no listing date. The view drops NULL week_date, so
// undated waiting is read from the book — never invented as a fulfilled
// stamp, and never listed on the weekly sheet. Same listing date as
// weekly (fulfilled stamp, else working mass_date). Defined before '/:id'.
router.get('/nearest-outside', async (req, res) => {
  const start = typeof req.query.start === 'string' && ISO_DATE.test(req.query.start) ? req.query.start : null
  const end   = typeof req.query.end   === 'string' && ISO_DATE.test(req.query.end)   ? req.query.end   : null
  if (!start || !end) return res.status(400).json({ error: 'start and end dates are required' })
  if (end < start) return res.status(400).json({ error: 'end must be on or after start' })
  const spanDays = (Date.parse(end) - Date.parse(start)) / 86400000
  if (spanDays > 31) return res.status(400).json({ error: 'Range is capped at 31 days' })

  try {
    const [nearest, undated] = await Promise.all([
      pool.query(
        `SELECT to_char(week_date, 'YYYY-MM-DD') AS date
           FROM ochr_sacristy_weekly_manifest
          WHERE organization_id = $1
            AND week_date NOT BETWEEN $2::date AND $3::date
          ORDER BY abs(week_date - $2::date) ASC, week_date ASC
          LIMIT 1`,
        [req.organizationId, start, end]
      ),
      // Listing date for open/scheduled is mass_date (same CASE as week_date
      // on the view). Fulfilled rows are not waiting; cancelled are not in
      // the book. Tenant scope is JWT organization_id only.
      pool.query(
        `SELECT COUNT(*)::int AS n
           FROM ochr_mass_intentions
          WHERE organization_id = $1
            AND status IN ('open', 'scheduled')
            AND mass_date IS NULL`,
        [req.organizationId]
      ),
    ])
    const undatedCount = Number(undated.rows[0]?.n ?? 0)
    res.json({
      start,
      end,
      date: nearest.rows[0]?.date ?? null,
      undated_waiting: undatedCount > 0,
      undated_waiting_count: undatedCount,
    })
  } catch (err) {
    monitor.error('massIntentions.nearestOutside', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to check the rest of the book' })
  }
})

// GET /api/mass-intentions/awaiting?date=YYYY-MM-DD (MI.4)
// Intentions that can be offered at a Mass on this date: not cancelled,
// not fulfilled, not already pinned to a Mass, and either undated or
// dated this day. A row that already carries a fulfilment stamp is not
// waiting: deleting the Mass sets calendar_event_id null, and a row
// released before that was refused can still be unlinked. Offering it
// again is refused. Defined before '/:id' so the literal isn't swallowed.
router.get('/awaiting', async (req, res) => {
  const date = typeof req.query.date === 'string' && ISO_DATE.test(req.query.date) ? req.query.date : null
  if (!date) return res.status(400).json({ error: 'A date is required' })

  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN}
        WHERE s.organization_id = $1
          AND s.status IN ('open', 'scheduled')
          AND s.calendar_event_id IS NULL
          AND s.fulfilled_mass_date IS NULL
          AND s.fulfilled_mass_title IS NULL
          AND s.fulfilled_mass_time IS NULL
          AND (s.mass_date IS NULL OR s.mass_date = $2::date)
        ORDER BY s.mass_date ASC NULLS LAST, s.created_at DESC
        LIMIT 100`,
      [req.organizationId, date]
    )
    res.json({ date, intentions: rows })
  } catch (err) {
    monitor.error('massIntentions.awaiting', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load waiting intentions' })
  }
})

// GET /api/mass-intentions/:id
router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE s.id = $1 AND s.organization_id = $2`,
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('massIntentions.get', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load Mass intention' })
  }
})

// POST /api/mass-intentions
router.post('/', async (req, res) => {
  const intention = typeof req.body?.intention === 'string' ? req.body.intention.trim() : ''
  if (!intention) return res.status(400).json({ error: 'An intention is required' })

  const requestedBy = req.body?.requested_by != null ? String(req.body.requested_by).trim() || null : null
  let massDate = req.body?.mass_date ? String(req.body.mass_date) : null
  const note = req.body?.note != null ? String(req.body.note).trim() || null : null
  let status = MI_STATUSES.has(req.body?.status) ? req.body.status : 'open'
  const clientId = req.body?.requested_by_client_id != null ? readMemberId(req.body.requested_by_client_id) : null
  const eventId = req.body?.calendar_event_id != null && req.body.calendar_event_id !== ''
    ? Number(req.body.calendar_event_id) : null

  let stipend = null
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'stipend')) {
    const read = readStipend(req.body.stipend)
    if (!read.ok) return res.status(400).json({ error: STIPEND_REFUSED })
    stipend = read.value
  }

  try {
    // SP-052: any non-null requester id must be a member of THIS parish.
    // Malformed, nonexistent and other-parish ids get one identical answer
    // (same as PATCH) and nothing is written. Previously a malformed id was
    // silently dropped and the row saved unlinked.
    let resolvedClientId = null
    if (clientId != null) {
      if (!(Number.isInteger(clientId) && clientId > 0) || !(await clientInOrg(clientId, req.organizationId))) {
        return res.status(404).json({ error: 'Member not found in your church' })
      }
      resolvedClientId = clientId
    }

    let resolvedEventId = null
    let stampDate = null
    let stampTitle = null
    let stampTime = null
    if (eventId != null) {
      if (!Number.isInteger(eventId) || eventId <= 0) {
        return res.status(404).json({ error: 'Mass not found on your calendar' })
      }
      const ev = await eventInOrg(eventId, req.organizationId)
      if (!ev) return res.status(404).json({ error: 'Mass not found on your calendar' })
      if (!isMassEvent(ev)) return res.status(409).json({ error: REFUSE_NOT_A_MASS, code: NOT_A_MASS_CODE })
      // Same comparison as PATCH. An explicit day that is not this Mass's
      // civil day writes nothing (no row, and audit records 2xx only).
      // A missing mass_date is derived from the Mass below.
      if (explicitDayConflicts(req.body, ev.date)) {
        return res.status(409).json(dateConflictBody())
      }
      resolvedEventId = ev.id
      // The Mass owns the date. An open request offered at a Mass is scheduled.
      massDate = ev.date
      status = statusOnLink(status)
      if (status === 'fulfilled') {
        stampDate = ev.date
        stampTitle = ev.title
        stampTime = ev.start_time
      }
    }

    if (status === 'fulfilled' && resolvedEventId == null) {
      return res.status(409).json({ error: REFUSE_FULFILL_WITHOUT_MASS })
    }

    const { rows } = await pool.query(
      `INSERT INTO ochr_mass_intentions
         (organization_id, intention, requested_by, requested_by_client_id, mass_date, stipend, status, note, calendar_event_id,
          fulfilled_mass_date, fulfilled_mass_title, fulfilled_mass_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${SNAP_COLS}`,
      [req.organizationId, intention, requestedBy, resolvedClientId, massDate, stipend, status, note, resolvedEventId,
       stampDate, stampTitle, stampTime]
    )
    const { rows: full } = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE s.id = $1 AND s.organization_id = $2`,
      [rows[0].id, req.organizationId]
    )
    res.locals.massIntentionSnapshot = massIntentionSnapshot(rows[0])
    res.status(201).json(full[0])
  } catch (err) {
    monitor.error('massIntentions.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save Mass intention' })
  }
})

// PATCH /api/mass-intentions/:id
// Fulfilled stamps are write-once at the transition to fulfilled, from
// the org-scoped calendar row in this same transaction. Calendar edits
// and a later PATCH of mass_date must not rewrite them. There is no
// correction semantic in this change — do not send fulfilled_mass_*.
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const locked = await client.query(
      `SELECT id, status, calendar_event_id,
              to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date,
              fulfilled_mass_title,
              to_char(fulfilled_mass_time, 'HH24:MI:SS') AS fulfilled_mass_time,
              ${CHANGE_COLS}
         FROM ochr_mass_intentions
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!locked.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    const current = locked.rows[0]

    const sets = []
    const params = []
    for (const [col, read] of Object.entries(EDITABLE)) {
      if (Object.prototype.hasOwnProperty.call(req.body ?? {}, col)) {
        const val = read(req.body[col])
        if (val === undefined) {
          await client.query('ROLLBACK')
          const error = col === 'stipend' ? STIPEND_REFUSED : `Invalid value for ${col}`
          return res.status(400).json({ error })
        }
        params.push(val); sets.push(`${col} = $${params.length}`)
      }
    }

    let nextEventId = current.calendar_event_id
    // Invalid status already returned 400 above. A missing status keeps
    // the row where it is, so "stays fulfilled" can see the next status.
    const askedStatus = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'status')
      && MI_STATUSES.has(req.body.status)
      ? req.body.status
      : current.status
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'calendar_event_id')) {
      const eid = req.body.calendar_event_id != null && req.body.calendar_event_id !== ''
        ? Number(req.body.calendar_event_id) : null
      // A new calendar_event_id on a stamped row would leave the stamp
      // naming one Mass and the link naming another. Same id is not a re-link.
      if (hasFulfilmentStamp(current) && !sameEventId(current.calendar_event_id, eid)) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: REFUSE_STAMPED_HISTORY, code: STAMPED_HISTORY_CODE })
      }
      if (eid == null) {
        params.push(null); sets.push(`calendar_event_id = $${params.length}`)
        nextEventId = null
        if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'status')) {
          upsertSet(sets, params, 'status', statusOnRelease(current.status))
        }
      } else {
        const ev = Number.isInteger(eid) && eid > 0
          ? await eventInOrg(eid, req.organizationId, client)
          : null
        if (!ev) {
          await client.query('ROLLBACK')
          return res.status(404).json({ error: 'Mass not found on your calendar' })
        }
        // A new link has to be a Mass. An intention already linked to a
        // meeting stays linked: a PATCH that does not change the event
        // must not rewrite that historical row.
        const sameLink = sameEventId(current.calendar_event_id, ev.id)
        if (!sameLink && !isMassEvent(ev)) {
          await client.query('ROLLBACK')
          return res.status(409).json({ error: REFUSE_NOT_A_MASS, code: NOT_A_MASS_CODE })
        }
        // The same Mass, with a submitted day that is not that Mass's day,
        // must not be stored. A different Mass still adopts its own day.
        // Null and blank are not that day. The exception is a row that
        // stays fulfilled: the book sends the frozen stamp (or a blank
        // older stamp) with the same Mass, and that stamp is never
        // rewritten. Reopening is not that exception. Roll back before
        // UPDATE so no audit row is written (audit records 2xx only).
        // Skip the same-Mass date check only while the row stays fulfilled.
        // A fulfilled row that is being reopened is a live link again.
        const rowStaysFulfilled = current.status === 'fulfilled' && askedStatus === 'fulfilled'
        if (sameLink && !rowStaysFulfilled && explicitDayConflicts(req.body, ev.date)) {
          await client.query('ROLLBACK')
          return res.status(409).json(dateConflictBody())
        }
        params.push(ev.id); sets.push(`calendar_event_id = $${params.length}`)
        nextEventId = ev.id
        // Fulfilled stamps stay. A same-link meeting keeps its stored day
        // rather than adopting a later calendar move. A row that stays
        // fulfilled keeps its stored day too (the stamp is the book).
        // Leaving fulfilled, or any other live link, stores the Mass's day.
        if (sameLink && (rowStaysFulfilled || !isMassEvent(ev))) {
          upsertSet(sets, params, 'mass_date', current.mass_date)
        } else {
          upsertSet(sets, params, 'mass_date', ev.date)
        }
        upsertSet(sets, params, 'status', statusOnLink(askedStatus))
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'requested_by_client_id')) {
      const cid = req.body.requested_by_client_id != null ? readMemberId(req.body.requested_by_client_id) : null
      if (cid == null) {
        params.push(null); sets.push(`requested_by_client_id = $${params.length}`)
      } else if (Number.isInteger(cid) && cid > 0 && (await clientInOrg(cid, req.organizationId, client))) {
        params.push(cid); sets.push(`requested_by_client_id = $${params.length}`)
      } else {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Member not found in your church' })
      }
    }

    // A linked row that leaves fulfilled is live again. The client omits
    // an unchanged Mass, so this path has no calendar_event_id. Store the
    // Mass's current day and apply statusOnLink (open becomes scheduled).
    // A historical meeting link keeps its stored day.
    const touchedEvent = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'calendar_event_id')
    const rowStaysFulfilled = current.status === 'fulfilled' && askedStatus === 'fulfilled'
    if (!touchedEvent && !rowStaysFulfilled && current.status === 'fulfilled' && nextEventId != null) {
      const linked = await eventInOrg(nextEventId, req.organizationId, client)
      if (linked && isMassEvent(linked)) {
        upsertSet(sets, params, 'mass_date', linked.date)
      }
      upsertSet(sets, params, 'status', statusOnLink(askedStatus))
    }

    const statusInSets = sets.find(s => s.startsWith('status = '))
    const nextStatus = statusInSets
      ? params[sets.indexOf(statusInSets)]
      : current.status

    // mass_date without calendar_event_id, while a Mass is still linked.
    // A different org-local day must not be stored. Naming the Mass adopts
    // its date above. calendar_event_id: null unassigns and may set a date.
    // Return before UPDATE so fulfilled stamps are not rewritten.
    const massDateAlone = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'mass_date')
      && !Object.prototype.hasOwnProperty.call(req.body ?? {}, 'calendar_event_id')
    if (massDateAlone && nextEventId != null) {
      const linked = await eventInOrg(nextEventId, req.organizationId, client)
      if (linked && explicitDayConflicts(req.body, linked.date)) {
        await client.query('ROLLBACK')
        return res.status(409).json(dateConflictBody())
      }
    }

    // Stamp only on the transition to fulfilled. A row that already
    // carries a stamp is fulfilled again only when the live linked Mass
    // still equals that stamp. Otherwise refuse — never rewrite the bytes.
    if (nextStatus === 'fulfilled' && current.status !== 'fulfilled') {
      const ev = nextEventId != null
        ? await eventInOrg(nextEventId, req.organizationId, client)
        : null
      if (!ev) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: REFUSE_FULFILL_WITHOUT_MASS })
      }
      if (hasFulfilmentStamp(current)) {
        if (!stampMatchesLive(current, ev)) {
          await client.query('ROLLBACK')
          return res.status(409).json({ error: REFUSE_STAMP_CONFLICT, code: STAMP_CONFLICT_CODE })
        }
      } else {
        upsertSet(sets, params, 'fulfilled_mass_date', ev.date)
        upsertSet(sets, params, 'fulfilled_mass_title', ev.title)
        upsertSet(sets, params, 'fulfilled_mass_time', ev.start_time)
      }
    }

    if (sets.length === 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'No editable fields provided' })
    }
    sets.push(`updated_at = NOW()`)

    params.push(id, req.organizationId)
    const { rows } = await client.query(
      `UPDATE ochr_mass_intentions SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND organization_id = $${params.length}
        RETURNING id, status, calendar_event_id,
                  to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
                  ${CHANGE_COLS}`,
      params
    )
    if (!rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    await client.query('COMMIT')
    // R285-F1/F2: audit records WHICH fields really changed (stored before
    // vs stored after, same transaction), never their text.
    res.locals.massIntentionChange = massIntentionChange(current, rows[0])
    res.locals.massIntentionSnapshot = res.locals.massIntentionChange.snapshot
    res.json(await loadFull(id, req.organizationId))
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    monitor.error('massIntentions.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update Mass intention' })
  } finally {
    client.release()
  }
})

// POST /api/mass-intentions/:id/assign  (MI.4)
// Offer this intention at a scheduled Mass. The Mass owns the date.
// Concurrent assigns serialize on the intention row. Same Mass twice is
// idempotent. expected_calendar_event_id (null = was unassigned) rejects
// a stale drawer so two secretaries cannot silently overwrite each other.
router.post('/:id/assign', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const eid = req.body?.calendar_event_id != null && req.body.calendar_event_id !== ''
    ? Number(req.body.calendar_event_id) : null
  if (!Number.isInteger(eid) || eid <= 0) {
    return res.status(400).json({ error: 'A Mass on the calendar is required' })
  }

  const hasExpected = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'expected_calendar_event_id')
  const expectedRaw = req.body?.expected_calendar_event_id
  const expectedId = expectedRaw == null || expectedRaw === '' ? null : Number(expectedRaw)
  if (hasExpected && expectedId != null && (!Number.isInteger(expectedId) || expectedId <= 0)) {
    return res.status(400).json({ error: 'That assignment looks out of date. Nothing was lost — please look again.' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const locked = await client.query(
      `SELECT id, status, calendar_event_id, requested_by_client_id,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date,
              fulfilled_mass_title,
              to_char(fulfilled_mass_time, 'HH24:MI:SS') AS fulfilled_mass_time
         FROM ochr_mass_intentions
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!locked.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    const row = locked.rows[0]
    if (hasFulfilmentStamp(row) && !sameEventId(row.calendar_event_id, eid)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_STAMPED_HISTORY, code: STAMPED_HISTORY_CODE })
    }
    if (row.status === 'cancelled') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'This intention was cancelled and cannot be offered.' })
    }
    if (row.status === 'fulfilled') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'A fulfilled intention stays with the Mass that offered it.' })
    }

    const ev = await eventInOrg(eid, req.organizationId, client)
    if (!ev) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Mass not found on your calendar' })
    }
    if (!isMassEvent(ev)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_NOT_A_MASS, code: NOT_A_MASS_CODE })
    }

    if (sameEventId(row.calendar_event_id, ev.id)) {
      await client.query('COMMIT')
      res.locals.massIntentionSnapshot = massIntentionSnapshot(row)
      return res.json(await loadFull(id, req.organizationId))
    }

    if (hasExpected && !sameEventId(row.calendar_event_id, expectedId)) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: 'This intention was just assigned elsewhere. Nothing was lost — please look again.',
      })
    }

    const assigned = await client.query(
      `UPDATE ochr_mass_intentions
          SET calendar_event_id = $1,
              mass_date = $2::date,
              status = $3,
              updated_at = NOW()
        WHERE id = $4 AND organization_id = $5
        RETURNING ${SNAP_COLS}`,
      [ev.id, ev.date, statusOnLink(row.status), id, req.organizationId]
    )
    await client.query('COMMIT')
    res.locals.massIntentionSnapshot = massIntentionSnapshot(assigned.rows[0])
    res.json(await loadFull(id, req.organizationId))
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    monitor.error('massIntentions.assign', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to assign Mass intention' })
  } finally {
    client.release()
  }
})

// POST /api/mass-intentions/:id/unassign  (MI.4)
// Release from a Mass. Keeps mass_date so the week still shows it as
// dated-but-unassigned. Scheduled returns to open.
router.post('/:id/unassign', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return

  const hasExpected = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'expected_calendar_event_id')
  const expectedRaw = req.body?.expected_calendar_event_id
  const expectedId = expectedRaw == null || expectedRaw === '' ? null : Number(expectedRaw)
  if (hasExpected && expectedId != null && (!Number.isInteger(expectedId) || expectedId <= 0)) {
    return res.status(400).json({ error: 'That assignment looks out of date. Nothing was lost — please look again.' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const locked = await client.query(
      `SELECT id, status, calendar_event_id, requested_by_client_id,
              to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date,
              fulfilled_mass_title,
              to_char(fulfilled_mass_time, 'HH24:MI:SS') AS fulfilled_mass_time
         FROM ochr_mass_intentions
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!locked.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    const row = locked.rows[0]
    // Same refusal as PATCH calendar_event_id null. A recorded fulfilment
    // is not a link that can be dropped. A legacy fulfilled row with no
    // stamp still uses the fulfilled sentence below.
    if (hasFulfilmentStamp(row)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_STAMPED_HISTORY, code: STAMPED_HISTORY_CODE })
    }
    if (row.status === 'fulfilled') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'A fulfilled intention stays with the Mass that offered it.' })
    }
    if (row.calendar_event_id == null) {
      await client.query('COMMIT')
      res.locals.massIntentionSnapshot = massIntentionSnapshot(row)
      return res.json(await loadFull(id, req.organizationId))
    }
    if (hasExpected && !sameEventId(row.calendar_event_id, expectedId)) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: 'This intention was just assigned elsewhere. Nothing was lost — please look again.',
      })
    }

    const released = await client.query(
      `UPDATE ochr_mass_intentions
          SET calendar_event_id = NULL,
              status = $1,
              updated_at = NOW()
        WHERE id = $2 AND organization_id = $3
        RETURNING ${SNAP_COLS}`,
      [statusOnRelease(row.status), id, req.organizationId]
    )
    await client.query('COMMIT')
    res.locals.massIntentionSnapshot = massIntentionSnapshot(released.rows[0])
    res.json(await loadFull(id, req.organizationId))
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    monitor.error('massIntentions.unassign', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to release Mass intention' })
  } finally {
    client.release()
  }
})

// DELETE /api/mass-intentions/:id
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('massIntentions.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete Mass intention' })
  }
})

export default router
