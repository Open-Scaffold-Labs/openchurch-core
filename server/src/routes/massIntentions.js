// Mass intention routes (MI.1 / MI.4). Tenant-scoped book of requested Mass
// intentions.
//
//   GET    /api/mass-intentions              → the book (paginated, ?status=, ?q=,
//                                               ?view=past_scheduled, ?weekend=this_sunday)
//   GET    /api/mass-intentions/weekly       → sacristy manifest window
//   GET    /api/mass-intentions/nearest-outside → closest listing date outside a window
//                                               + tenant undated-waiting signal
//   GET    /api/mass-intentions/awaiting     → unassigned, offerable on a date
//   GET    /api/mass-intentions/:id          → one entry
//   POST   /api/mass-intentions              → add a request
//   POST   /api/mass-intentions/bulk-mark-said          → mark the chosen rows said (D-1)
//   POST   /api/mass-intentions/bulk-mark-said/:batchId/undo
//   POST   /api/mass-intentions/:id/assign   → offer at a scheduled Mass (MI.4)
//   POST   /api/mass-intentions/:id/unassign → release from a Mass (MI.4)
//   PATCH  /api/mass-intentions/:id          → edit allowlisted fields
//   POST   /api/mass-intentions/:id/correct  → admin correction, reason required
//   POST   /api/mass-intentions/:id/void     → admin void, reason required
//   POST   /api/mass-intentions/:id/disposition → disposition on already-voided held stipend
//   (SP-268 Release stipend deferred — fulfilled 2330 stays held until remittance CoA decided)
//   DELETE /api/mass-intentions/:id          → remove (never fulfilled history)
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
import { requireRole } from '../middleware/auth.js'
import { writeMassIntentionAuditInTx } from '../middleware/auditLog.js'
import { bulkMarkSaid, undoBulkMarkSaid, MAY_MARK_SAID } from './massIntentionMarkSaid.js'
import { requireIntParam, parsePagination } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'
import {
  recordStipendIfNeeded,
  syncStipendLiability,
  parseDisposition,
  writeDisposition,
  openStipendLiability,
  DISPOSITION_REQUIRED,
  parseReceivedDate,
  parsePaymentMethod,
  stipendEffectiveDate,
  RECEIVED_DATE_REQUIRED,
  RECEIVED_DATE_INVALID,
  PAYMENT_METHOD_REQUIRED,
} from '../finance/stipends.js'
import {
  canonicalIsoDate,
  finiteSpanDays,
  orgTodayIso,
  orgNowHHMM,
  readWeeklyDate,
  resolveWeeklyWindow,
  thisSundayPair,
  thisSundaySpan,
  usableTimeZone,
} from '../utils/sheetWeek.js'


// N449-1: stipend money paths use the parish civil day, not process UTC.
async function orgCivilToday(db, orgId, instant = new Date()) {
  const { rows } = await db.query(
    `SELECT timezone FROM ochr_organizations WHERE id = $1`, [orgId])
  return orgTodayIso(instant, usableTimeZone(rows[0]?.timezone))
}

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

// Founder decision 8 (2026-10-19): fulfilled history is preserved. An
// ordinary PATCH that would change a stored value on a fulfilled row is
// refused; an administrator corrects it with a reason (POST /:id/correct,
// written to ochr_mass_intention_corrections). Delete is refused for a
// fulfilled, stamped, or voided row; an erroneous or duplicate row is
// voided with a reason instead (POST /:id/void).
export const FULFILLED_LOCKED_CODE = 'fulfilled_locked'
// #285 F6 (José, 2026-10-25): once an intention is fulfilled (or carries a
// fulfilment stamp), its offering amount and its Mass link are locked for
// every path, the admin correction included. A wrong amount or Mass is put
// right by voiding the entry with a reason (the row stays in the book) and
// recording it again — never by rewriting the fulfilled record.
export const FULFILLED_OFFERING_LOCKED_CODE = 'fulfilled_offering_locked'
export const REFUSE_FULFILLED_OFFERING_EDIT =
  'The offering and the Mass are locked once an intention is fulfilled. Nothing was changed. A fulfilled intention with a held stipend cannot be voided yet; remittance accounting is still an open parish decision.'
export const REFUSE_FULFILLED_EDIT =
  'This intention was fulfilled and is kept as recorded. Nothing was changed. An administrator can correct it with a reason.'
export const FULFILLED_HISTORY_CODE = 'fulfilled_history'
export const REFUSE_FULFILLED_DELETE =
  'This intention is part of the parish record and cannot be deleted. Nothing was changed. An administrator can void it with a reason.'
// SP-133 / F4 (José adopted TARS #62 comment 6380227296 item 3, 2026-10-23):
// once an offering amount has been recorded on an intention, no role —
// admin included — may hard-delete it. The admin-only reasoned void keeps
// the row and its trail. "Recorded" means: the stored stipend is not NULL
// (an explicit 0.00 IS a recorded amount; it does not mean paid or waived),
// OR the durable offering_recorded marker (migration 126) is set. Amounts
// cleared before any surviving evidence existed stay UNKNOWN (out of scope). An
// ordinary edit may not clear a recorded amount to NULL; an admin
// correction may, and a corrected row has entered history, so it stays
// protected either way.
export const OFFERING_RECORDED_CODE = 'offering_recorded'
export const REFUSE_OFFERING_DELETE =
  'An offering was recorded for this intention, so it cannot be deleted. Nothing was changed. An administrator can void it with a reason.'
export const OFFERING_CLEAR_CODE = 'offering_clear_refused'
export const REFUSE_OFFERING_CLEAR =
  'A recorded offering cannot be removed with an ordinary edit. Nothing was changed. An administrator can correct it with a reason.'

// R382-1: the proof lives on the row (migration 126 offering_recorded,
// latched by trigger on every write that stores a non-NULL stipend, 0.00
// included, never cleared). Audit retention cannot change this answer.
// Pure: the caller passes the locked row.
export function offeringEverRecorded(row) {
  return !!row && (row.offering_recorded === true || row.stipend != null)
}
export const VOIDED_CODE = 'voided'
export const REFUSE_VOIDED =
  'This intention was voided. Nothing was changed.'
// N449-3 / Ledger: voiding a fulfilled intention that still holds open 2330
// is the deferred SP-268 Release by another door (pastor_applied clears
// liability with no remittance counter-account). Refuse until remittance CoA.
export const VOID_FULFILLED_HELD_CODE = 'void_fulfilled_held'
export const REFUSE_VOID_FULFILLED_HELD =
  'A fulfilled Mass intention with a held stipend cannot be voided yet. The stipend stays held until remittance accounting is decided. Nothing was changed.'
// D449-4 / Ledger: a disposition is only for an intention whose Mass was NOT
// said. Fulfilled + disposition (void with open 0, or /disposition after void)
// refuses. "Was fulfilled" after void comes from the void correction's
// before.status — no new column, no migration. Missing void correction fails
// closed with the same code.
export const DISPOSITION_FULFILLED_CODE = 'disposition_fulfilled'
export const REFUSE_DISPOSITION_FULFILLED =
  'This Mass was already offered, so its stipend can\'t be refunded, transferred, or applied elsewhere. Nothing was changed.'
export const REASON_REQUIRED_CODE = 'reason_required'
export const REFUSE_REASON_REQUIRED = 'A reason is required. Nothing was changed.'
export const ADMIN_ONLY_CODE = 'admin_only'
export const REFUSE_ADMIN_ONLY = 'Only an administrator can correct or void an intention. Nothing was changed.'
export const REASON_MAX = 500

// A reason is real text: trimmed, non-empty, bounded.
export function readReason(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t.length > REASON_MAX) return null
  return t
}

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
const CHANGE_COLS = 'intention, requested_by, note, stipend, requested_by_client_id, payment_method'
export const MI_CHANGE_FIELDS = ['intention', 'note', 'requested_by', 'requested_by_client_id', 'stipend', 'mass_date', 'status', 'calendar_event_id', 'received_date', 'payment_method']
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
  // SP-266/270: cash-in day and method travel with the offering.
  received_date: v => {
    const read = parseReceivedDate(v)
    return read.ok ? read.value : undefined
  },
  payment_method: v => {
    const read = parsePaymentMethod(v)
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
                     to_char(s.received_date, 'YYYY-MM-DD') AS received_date,
                     s.payment_method,
                     (SELECT COALESCE(SUM(CASE WHEN f.kind = 'recorded' THEN f.amount ELSE -f.amount END), 0)::NUMERIC(12,2)
                        FROM ochr_mass_stipend_facts f
                       WHERE f.organization_id = s.organization_id
                         AND f.mass_intention_id = s.id) AS open_stipend_liability,
                     s.created_at, s.updated_at, c.name AS requester_name,
                     CASE WHEN s.status = 'fulfilled'
                          THEN s.fulfilled_mass_title
                          ELSE e.title
                     END AS mass_title,
                     CASE WHEN s.status = 'fulfilled'
                          THEN to_char(s.fulfilled_mass_time, 'HH24:MI')
                          ELSE to_char(e.start_time, 'HH24:MI')
                     END AS mass_time,
                     ${fulfilmentLabelSql('s')} AS fulfilment_label,
                     s.voided_at, s.void_reason, s.entered_history,
                     -- F468-1: after void, status is cancelled; recover whether
                     -- the Mass was already said from the void correction so
                     -- the book can hide Disposition without a new column.
                     (SELECT (c.before->>'status') = 'fulfilled'
                        FROM ochr_mass_intention_corrections c
                       WHERE c.organization_id = s.organization_id
                         AND c.mass_intention_id = s.id
                         AND c.kind = 'void'
                       ORDER BY c.id DESC
                       LIMIT 1) AS was_fulfilled`

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
//
// SP-181 (Saint, 2026-10-25): on Sunday afternoon this morning's Mass must
// be findable too. A row dated TODAY also matches once its linked Mass (the
// same day on the calendar) has a start time at or before the parish's
// current wall-clock time. A today row with no linked Mass or no start time
// still never matches — the time it was offered is unknown.
const pastScheduledSql = (todayParam, nowParam) =>
  `(s.status = 'scheduled' AND s.mass_date IS NOT NULL AND (s.mass_date < ${todayParam}::date`
  + (nowParam
    ? ` OR (s.mass_date = ${todayParam}::date AND e.id IS NOT NULL AND e.date = s.mass_date`
      + ` AND e.start_time IS NOT NULL AND ${nowParam}::time IS NOT NULL AND e.start_time <= ${nowParam}::time)`
    : '')
  + `))`

// D-1. Admin and secretary (staff) only — requireRole, not the page.
// Registered before /:id so "bulk-mark-said" is never read as an intention id.
router.post('/bulk-mark-said', requireRole(...MAY_MARK_SAID), bulkMarkSaid)
router.post('/bulk-mark-said/:batchId/undo', requireRole(...MAY_MARK_SAID), undoBulkMarkSaid)

// Listing day on the book — the same CASE as week_date on the sacristy
// view (migration 110). A recorded fulfilment stamp is the day; otherwise
// the working mass_date. This does not rewrite a stamp, and it does not
// drop cancelled rows (the sheet view does; the book does not).
const listingDateSql = alias =>
  `(CASE WHEN ${alias}.status = 'fulfilled' AND ${alias}.fulfilled_mass_date IS NOT NULL THEN ${alias}.fulfilled_mass_date ELSE ${alias}.mass_date END)`

// GET /api/mass-intentions?status=&q=&view=past_scheduled&weekend=this_sunday
// An accepted weekend is pinned with &saturday=&sunday= (a real Saturday
// and the next day). Those dates are the window; the clock is not read
// again. A missing or unusable pair is unread, not the whole book and
// not whatever weekend the clock has moved to.
router.get('/', async (req, res) => {
  const { limit, offset } = parsePagination(req.query)
  const statusFilter = typeof req.query.status === 'string' && MI_STATUSES.has(req.query.status)
    ? req.query.status : null
  const pastOnly = req.query.view === 'past_scheduled'
  const thisSunday = req.query.weekend === 'this_sunday'
  const anchorRequested = thisSunday && (req.query.saturday != null || req.query.sunday != null)

  try {
    // Parish clock (JWT organization only — never the host's or browser's
    // zone), the same helpers the weekly sheet uses. Past scheduled still
    // compares against this day when a weekend is pinned.
    const orgTz = await pool.query(`SELECT timezone FROM ochr_organizations WHERE id = $1`, [req.organizationId])
    const todayIso = orgTodayIso(new Date(), usableTimeZone(orgTz.rows[0]?.timezone))

    const where = ['s.organization_id = $1']
    const nowHHMM = orgNowHHMM(new Date(), usableTimeZone(orgTz.rows[0]?.timezone))
    const params = [req.organizationId, todayIso, nowHHMM]
    const pastExpr = pastScheduledSql('$2', '$3')
    let sundaySpan = null
    if (thisSunday && anchorRequested) {
      sundaySpan = typeof req.query.saturday === 'string' && typeof req.query.sunday === 'string'
        ? thisSundayPair(req.query.saturday, req.query.sunday)
        : null
    } else if (thisSunday) {
      sundaySpan = thisSundaySpan(todayIso)
    }
    // Unresolvable is not an empty weekend and not the clock's new one.
    if (thisSunday && !sundaySpan) {
      return res.status(400).json({ error: 'Failed to load Mass intentions' })
    }
    if (statusFilter) { params.push(statusFilter); where.push(`s.status = $${params.length}`) }
    // Filtered in SQL before LIMIT/OFFSET, so every page is from the whole
    // tenant-scoped set, not from rows the client already downloaded.
    if (pastOnly) where.push(pastExpr)
    // This Sunday: the vigil Saturday and that Sunday. With no pinned
    // dates, that is the weekly sheet's week from the parish clock.
    if (sundaySpan) {
      params.push(sundaySpan.saturday)
      const satP = `$${params.length}`
      params.push(sundaySpan.sunday)
      const sunP = `$${params.length}`
      where.push(`${listingDateSql('s')} BETWEEN ${satP}::date AND ${sunP}::date`)
    }

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
    const payload = { intentions: rows }
    if (sundaySpan) payload.weekend = { saturday: sundaySpan.saturday, sunday: sundaySpan.sunday }
    res.json(payload)
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
// outside [start, end] (SP-100: measured from the nearer window edge), plus a tenant-scoped count of open/scheduled
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
          ORDER BY CASE WHEN week_date < $2::date THEN $2::date - week_date
                        ELSE week_date - $3::date END ASC,
                   week_date ASC
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

  // SP-266/270: when an offering amount is recorded, require the day the
  // money came in and how it was paid. Defaults are a client concern
  // (today); the server refuses inventing either.
  const receivedRead = parseReceivedDate(
    Object.prototype.hasOwnProperty.call(req.body ?? {}, 'received_date')
      ? req.body.received_date : undefined)
  if (!receivedRead.ok) {
    return res.status(RECEIVED_DATE_INVALID.status).json(RECEIVED_DATE_INVALID.body)
  }
  let receivedDate = receivedRead.value
  const methodRead = parsePaymentMethod(
    Object.prototype.hasOwnProperty.call(req.body ?? {}, 'payment_method')
      ? req.body.payment_method : undefined)
  if (!methodRead.ok) {
    return res.status(400).json({
      code: 'payment_method_invalid',
      error: 'Payment method must be cash, check, card, or other. Nothing was changed.',
    })
  }
  let paymentMethod = methodRead.value
  if (stipend != null && Number(stipend) > 0) {
    // Omitted → default today / cash (API compat + SP-266 books cash-in day,
    // not Mass day). Explicit empty string still refuses.
    const body = req.body ?? {}
    if (!receivedDate) {
      if (Object.prototype.hasOwnProperty.call(body, 'received_date')) {
        return res.status(RECEIVED_DATE_REQUIRED.status).json(RECEIVED_DATE_REQUIRED.body)
      }
      receivedDate = await orgCivilToday(pool, req.organizationId)
    }
    if (!paymentMethod) {
      if (Object.prototype.hasOwnProperty.call(body, 'payment_method')) {
        return res.status(PAYMENT_METHOD_REQUIRED.status).json(PAYMENT_METHOD_REQUIRED.body)
      }
      paymentMethod = 'cash'
    }
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

    // #285 F5: the row and its audit row commit together.
    const client = await pool.connect()
    let rows
    try {
      await client.query('BEGIN')
      ;({ rows } = await client.query(
      `INSERT INTO ochr_mass_intentions
         (organization_id, intention, requested_by, requested_by_client_id, mass_date, stipend, status, note, calendar_event_id,
          fulfilled_mass_date, fulfilled_mass_title, fulfilled_mass_time, received_date, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${SNAP_COLS}`,
      [req.organizationId, intention, requestedBy, resolvedClientId, massDate, stipend, status, note, resolvedEventId,
       stampDate, stampTitle, stampTime, receivedDate, paymentMethod]
      ))
      await writeMassIntentionAuditInTx(client, req, { status: 201, snapshot: massIntentionSnapshot(rows[0]) })
      if (stipend != null && Number(stipend) > 0) {
        const today = await orgCivilToday(client, req.organizationId)
        const eff = stipendEffectiveDate({ receivedDate, massDate, today })
        await recordStipendIfNeeded(client, {
          organizationId: req.organizationId,
          massIntentionId: rows[0].id,
          amount: stipend,
          effectiveDate: eff,
          userId: req.user?.id ?? null,
        })
      }
      await client.query('COMMIT')
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* already closed */ }
      throw err
    } finally {
      client.release()
    }
    res.locals.auditRecorded = true
    const { rows: full } = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE s.id = $1 AND s.organization_id = $2`,
      [rows[0].id, req.organizationId]
    )
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
router.patch('/:id', (req, res) => patchIntention(req, res, null))

// POST /api/mass-intentions/:id/correct  { reason, changes: { ...PATCH body } }
// Admin only. The same edit rules as PATCH apply (the Mass link, dates and
// stamps are never rewritten), except that a fulfilled row may change. The
// correction row records who, the reason, and before/after, in the same
// transaction as the change.
router.post('/:id/correct', (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: REFUSE_ADMIN_ONLY, code: ADMIN_ONLY_CODE })
  }
  const reason = readReason(req.body?.reason)
  if (!reason) return res.status(400).json({ error: REFUSE_REASON_REQUIRED, code: REASON_REQUIRED_CODE })
  const changes = req.body?.changes
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return res.status(400).json({ error: 'No editable fields provided' })
  }
  req.body = changes
  return patchIntention(req, res, { reason })
})

async function patchIntention(req, res, correction) {
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
              to_char(received_date, 'YYYY-MM-DD') AS received_date,
              voided_at, entered_history,
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
    if (current.voided_at != null) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_VOIDED, code: VOIDED_CODE })
    }

    // #285 F6 / R405-1: on a fulfilled or stamped row, any valid change to
    // the offering or the Mass link gets the F6 code first, on the ordinary
    // edit and the admin correction alike, before the older offering-clear
    // and stamped-history guards. Invalid payloads still fall through to
    // their 400. Same row lock; ROLLBACK, so no correction or audit row.
    if (current.status === 'fulfilled' || hasFulfilmentStamp(current)) {
      const body = req.body ?? {}
      let touchesLocked = false
      if (Object.prototype.hasOwnProperty.call(body, 'stipend')) {
        const st = readStipend(body.stipend)
        const cur = current.stipend == null ? null : readStipend(String(current.stipend)).value
        if (st.ok && st.value !== cur) touchesLocked = true
      }
      if (Object.prototype.hasOwnProperty.call(body, 'calendar_event_id')) {
        const raw = body.calendar_event_id
        const eid = raw != null && raw !== '' ? Number(raw) : null
        if ((eid === null || (Number.isInteger(eid) && eid > 0))
            && !sameEventId(current.calendar_event_id, eid)) touchesLocked = true
      }
      if (touchesLocked) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: REFUSE_FULFILLED_OFFERING_EDIT, code: FULFILLED_OFFERING_LOCKED_CODE })
      }
    }

    // SP-133: a recorded offering is not nulled by an ordinary edit (that
    // would re-open hard delete). Admin correction may, with a reason.
    if (!correction && current.stipend != null
        && Object.prototype.hasOwnProperty.call(req.body ?? {}, 'stipend')
        && (req.body.stipend === null || req.body.stipend === undefined)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_OFFERING_CLEAR, code: OFFERING_CLEAR_CODE })
    }

    const sets = []
    const params = []
    for (const [col, read] of Object.entries(EDITABLE)) {
      if (Object.prototype.hasOwnProperty.call(req.body ?? {}, col)) {
        const val = read(req.body[col])
        if (val === undefined) {
          await client.query('ROLLBACK')
          const error = col === 'stipend' ? STIPEND_REFUSED
            : col === 'received_date' ? RECEIVED_DATE_INVALID.body.error
            : col === 'payment_method'
              ? 'Payment method must be cash, check, card, or other. Nothing was changed.'
              : `Invalid value for ${col}`
          const code = col === 'received_date' ? RECEIVED_DATE_INVALID.body.code
            : col === 'payment_method' ? 'payment_method_invalid'
            : undefined
          return res.status(400).json(code ? { code, error } : { error })
        }
        params.push(val); sets.push(`${col} = $${params.length}`)
      }
    }

    // SP-266: a positive stipend on the resulting row needs received_date + method.
    {
      const body = req.body ?? {}
      let nextStipend = current.stipend
      if (Object.prototype.hasOwnProperty.call(body, 'stipend')) {
        const st = readStipend(body.stipend)
        if (st.ok) nextStipend = st.value
      }
      if (nextStipend != null && Number(nextStipend) > 0) {
        let nextReceived = current.received_date
        if (Object.prototype.hasOwnProperty.call(body, 'received_date')) {
          const rr = parseReceivedDate(body.received_date)
          if (rr.ok) nextReceived = rr.value
          if (!nextReceived) {
            await client.query('ROLLBACK')
            return res.status(RECEIVED_DATE_REQUIRED.status).json(RECEIVED_DATE_REQUIRED.body)
          }
        }
        let nextMethod = current.payment_method
        if (Object.prototype.hasOwnProperty.call(body, 'payment_method')) {
          const mr = parsePaymentMethod(body.payment_method)
          if (mr.ok) nextMethod = mr.value
          if (!nextMethod) {
            await client.query('ROLLBACK')
            return res.status(PAYMENT_METHOD_REQUIRED.status).json(PAYMENT_METHOD_REQUIRED.body)
          }
        }
        // Legacy rows: latch cash-in defaults only when this write touches
        // the offering (or the cash-in fields themselves). Ordinary edits to
        // note/status must not rewrite received_date.
        const offeringTouched = Object.prototype.hasOwnProperty.call(body, 'stipend')
          || Object.prototype.hasOwnProperty.call(body, 'received_date')
          || Object.prototype.hasOwnProperty.call(body, 'payment_method')
        if (offeringTouched && (!nextReceived || !nextMethod)) {
          const today = await orgCivilToday(client, req.organizationId)
          if (!nextReceived) {
            nextReceived = today
            if (!Object.prototype.hasOwnProperty.call(body, 'received_date')) {
              params.push(nextReceived); sets.push(`received_date = $${params.length}`)
            }
          }
          if (!nextMethod) {
            nextMethod = 'cash'
            if (!Object.prototype.hasOwnProperty.call(body, 'payment_method')) {
              params.push(nextMethod); sets.push(`payment_method = $${params.length}`)
            }
          }
        }
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
                  to_char(received_date, 'YYYY-MM-DD') AS received_date,
                  ${CHANGE_COLS}`,
      params
    )
    if (!rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    // R285-F1/F2: audit records WHICH fields really changed (stored before
    // vs stored after, same transaction), never their text.
    // #285 F5: written on this transaction, before COMMIT.
    const change = massIntentionChange(current, rows[0])
    // #285 F6: the offering and the Mass link of a fulfilled row are locked,
    // for the admin correction too (stricter than Decision 8 alone).
    if ((current.status === 'fulfilled' || hasFulfilmentStamp(current))
        && change.changed.some(f => f === 'stipend' || f === 'calendar_event_id')) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_FULFILLED_OFFERING_EDIT, code: FULFILLED_OFFERING_LOCKED_CODE })
    }
    // Decision 8: a fulfilled row is not silently edited. Any stored change
    // to it rolls back unless it came through the admin correction path.
    // R339-1: the durable latch, not the current status, decides.
    if ((current.entered_history || current.status === 'fulfilled') && change.changed.length > 0 && !correction) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_FULFILLED_EDIT, code: FULFILLED_LOCKED_CODE })
    }
    if (correction) {
      if (change.changed.length === 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Nothing to correct. Nothing was changed.' })
      }
      // A corrected row has entered history (R339-1).
      await client.query(
        'UPDATE ochr_mass_intentions SET entered_history = true WHERE id = $1 AND organization_id = $2',
        [id, req.organizationId]
      )
      await client.query(
        `INSERT INTO ochr_mass_intention_corrections
           (organization_id, mass_intention_id, actor_user_id, kind, reason, before, after)
         VALUES ($1, $2, $3, 'correction', $4, $5, $6)`,
        [req.organizationId, id, req.user.id, correction.reason,
         JSON.stringify(correctionValues(current, change.changed)),
         JSON.stringify(correctionValues(rows[0], change.changed))]
      )
    }
    await writeMassIntentionAuditInTx(client, req, { status: 200, change, snapshot: change.snapshot })
    {
      // N439-2 / N442-1 / N442-6: every stipend change (set, increase,
      // decrease, clear, re-set) is a delta against current open 2330 via
      // syncStipendLiability — never recordStipendIfNeeded's fixed
      // recorded:${id} key (that conflicts after a clear). Create still
      // uses recordStipendIfNeeded. Ordinary PATCH cannot null-clear.
      const afterStipend = change?.snapshot?.stipend ?? rows[0]?.stipend
      const stipendTouched = change?.changed?.includes('stipend')
      const positiveAfter = afterStipend != null && Number(afterStipend) > 0
      if (stipendTouched || positiveAfter) {
        // Prefer the cash-in day on the row (SP-266). Snapshot does not
        // carry received_date; re-read from the RETURNING / locked current.
        const afterReceived = rows[0]?.received_date || current.received_date || null
        const afterMass = change?.snapshot?.mass_date || rows[0]?.mass_date || current.mass_date
        const today = await orgCivilToday(client, req.organizationId)
        const eff = stipendEffectiveDate({
          receivedDate: afterReceived,
          massDate: afterMass,
          today,
        })
        await syncStipendLiability(client, {
          organizationId: req.organizationId,
          massIntentionId: id,
          amount: positiveAfter ? afterStipend : 0,
          effectiveDate: String(eff).slice(0, 10),
          userId: req.user?.id ?? null,
          reason: correction?.reason || (positiveAfter
            ? 'Stipend amount corrected'
            : 'Stipend cleared'),
        })
      }
    }
    await client.query('COMMIT')
    res.locals.auditRecorded = true
    res.json(await loadFull(id, req.organizationId))
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    monitor.error('massIntentions.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update Mass intention' })
  } finally {
    client.release()
  }
}

// Before/after of exactly the fields that changed, as stored.
function correctionValues(row, fields) {
  const out = {}
  for (const f of fields) out[f] = row?.[f] == null ? null : row[f]
  return out
}

// POST /api/mass-intentions/:id/void  { reason, disposition? }
// Admin only. Marks an erroneous or duplicate entry void instead of
// removing it: the row stays in the book, status becomes cancelled, the
// stamp and Mass link are untouched, and the void is recorded with who,
// when, the reason, and before/after.
router.post('/:id/void', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: REFUSE_ADMIN_ONLY, code: ADMIN_ONLY_CODE })
  }
  const reason = readReason(req.body?.reason)
  if (!reason) return res.status(400).json({ error: REFUSE_REASON_REQUIRED, code: REASON_REQUIRED_CODE })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const locked = await client.query(
      `SELECT id, status, voided_at, stipend, offering_recorded,
              to_char(mass_date, 'YYYY-MM-DD') AS mass_date
         FROM ochr_mass_intentions
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!locked.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    const before = locked.rows[0]
    if (before.voided_at != null) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_VOIDED, code: VOIDED_CODE })
    }

    // SP-250 W1 / N442-7: nonzero open 2330 liability needs a disposition
    // in the same TX as the void. After a book clear (open already 0), no
    // disposition is required and submit hold keys on open balance.
    let disposition = null
    const openBefore = await openStipendLiability(client, {
      organizationId: req.organizationId, massIntentionId: id,
    })
    // N449-3: fulfilled + open 2330 cannot void (would clear 2330 without
    // remittance CoA — same as deferred SP-268 Release).
    if (before.status === 'fulfilled' && openBefore > 0) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: REFUSE_VOID_FULFILLED_HELD,
        code: VOID_FULFILLED_HELD_CODE,
      })
    }
    if (openBefore > 0) {
      try {
        disposition = parseDisposition(req.body)
      } catch (e) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          code: e.code || 'disposition_invalid',
          error: 'A disposition of refund, transfer, or pastor-directed apply is required. Nothing was changed.',
        })
      }
      if (!disposition) {
        await client.query('ROLLBACK')
        return res.status(DISPOSITION_REQUIRED.status).json(DISPOSITION_REQUIRED.body)
      }
      // Prefer an explicit disposition.reason; otherwise the void reason.
      if (!disposition.reason) disposition = { ...disposition, reason }
      const eff = await orgCivilToday(client, req.organizationId) // SP-266 / N449-1: parish action day
      try {
        await writeDisposition(client, {
          organizationId: req.organizationId,
          massIntentionId: id,
          disposition,
          voidReason: reason,
          userId: req.user.id,
          effectiveDate: eff,
        })
      } catch (e) {
        await client.query('ROLLBACK')
        const msg = {
          disposition_amount_mismatch: 'The disposition amount must equal the open stipend liability. Nothing was changed.',
          disposition_reason: 'A disposition reason is required. Nothing was changed.',
          transfer_target: 'Transfer target must be another open intention in this parish. Nothing was changed.',
          transfer_self: 'Cannot transfer a stipend to the same intention. Nothing was changed.',
        }[e.code] || 'Disposition refused. Nothing was changed.'
        return res.status(400).json({ code: e.code || 'disposition_refused', error: msg })
      }
    } else if (req.body?.disposition != null) {
      // D449-4: open 2330 is already 0 — a disposition is not applicable.
      // Fulfilled → disposition_fulfilled (Mass was said; stipend exit is
      // deferred SP-268 Release). Not fulfilled → no_open_stipend (honest
      // refuse; do not record a false disposition on the void correction).
      await client.query('ROLLBACK')
      if (before.status === 'fulfilled') {
        return res.status(409).json({
          code: DISPOSITION_FULFILLED_CODE,
          error: REFUSE_DISPOSITION_FULFILLED,
        })
      }
      return res.status(409).json({
        code: 'no_open_stipend',
        error: 'There is no open stipend liability on this intention. Nothing was changed.',
      })
    }

    const voided = await client.query(
      `UPDATE ochr_mass_intentions
          SET status = 'cancelled', voided_at = NOW(), voided_by = $1,
              void_reason = $2, updated_at = NOW()
        WHERE id = $3 AND organization_id = $4
        RETURNING ${SNAP_COLS}, voided_at`,
      [req.user.id, reason, id, req.organizationId]
    )
    await client.query(
      `INSERT INTO ochr_mass_intention_corrections
         (organization_id, mass_intention_id, actor_user_id, kind, reason, before, after)
       VALUES ($1, $2, $3, 'void', $4, $5, $6)`,
      [req.organizationId, id, req.user.id, reason,
       JSON.stringify({ status: before.status, voided: false }),
       JSON.stringify({ status: 'cancelled', voided: true, disposition: disposition?.kind || null })]
    )
    await writeMassIntentionAuditInTx(client, req, { status: 200, snapshot: massIntentionSnapshot(voided.rows[0]) })
    await client.query('COMMIT')
    res.locals.auditRecorded = true
    res.json(await loadFull(id, req.organizationId))
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    monitor.error('massIntentions.void', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to void Mass intention' })
  } finally {
    client.release()
  }
})

// GET /api/mass-intentions/:id/corrections — the correction trail for one
// row, tenant-scoped, newest last. Reasons and before/after are parish
// record text; readable by the same roles that read the book.
router.get('/:id/corrections', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `SELECT k.id, k.kind, k.reason, k.before, k.after, k.created_at,
              k.actor_user_id, u.name AS actor_name
         FROM ochr_mass_intention_corrections k
         JOIN ochr_mass_intentions s
           ON s.id = k.mass_intention_id AND s.organization_id = k.organization_id
         LEFT JOIN ochr_users u
           ON u.id = k.actor_user_id AND u.organization_id = k.organization_id
        WHERE k.mass_intention_id = $1 AND k.organization_id = $2
        ORDER BY k.created_at, k.id`,
      [id, req.organizationId]
    )
    res.json(rows)
  } catch (err) {
    monitor.error('massIntentions.corrections', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load corrections' })
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
              to_char(fulfilled_mass_time, 'HH24:MI:SS') AS fulfilled_mass_time,
              voided_at, entered_history
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
    // R339-2: a voided row is closed to every write path, before any update.
    if (row.voided_at != null) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_VOIDED, code: VOIDED_CODE })
    }
    // #285 F6 / R405-1, same order as patchIntention: a fulfilled row, or a
    // stamped row whose Mass would change, answers fulfilled_offering_locked
    // before the older stamped_history refusal. Same Mass on a reopened
    // stamped row is not a change and stays the no-op below. ROLLBACK, so
    // no update, correction, or audit row.
    if (row.status === 'fulfilled' || (hasFulfilmentStamp(row) && !sameEventId(row.calendar_event_id, eid))) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_FULFILLED_OFFERING_EDIT, code: FULFILLED_OFFERING_LOCKED_CODE })
    }
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
      // #285 F3: already at this Mass. Nothing changed, so no audit row.
      res.locals.auditNoop = true
      return res.json(await loadFull(id, req.organizationId))
    }

    if (hasExpected && !sameEventId(row.calendar_event_id, expectedId)) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: 'This intention was just assigned elsewhere. Nothing was lost — please look again.',
      })
    }

    // R339-1: protected history (durable latch) changes its Mass only via
    // the reasoned admin correction. Checked under the lock, after the
    // genuine no-op return and before any update; no audit row on refusal.
    if (row.entered_history) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_FULFILLED_EDIT, code: FULFILLED_LOCKED_CODE })
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
    await writeMassIntentionAuditInTx(client, req, { status: 200, snapshot: massIntentionSnapshot(assigned.rows[0]) })
    await client.query('COMMIT')
    res.locals.auditRecorded = true
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
              to_char(fulfilled_mass_time, 'HH24:MI:SS') AS fulfilled_mass_time,
              voided_at, entered_history
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
    // R339-2: a voided row is closed to every write path, before any update.
    if (row.voided_at != null) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_VOIDED, code: VOIDED_CODE })
    }
    // #285 F6 / R405-1, same order as patchIntention: releasing a fulfilled
    // or stamped row changes the Mass link, so it answers
    // fulfilled_offering_locked before the older stamped_history refusal.
    // ROLLBACK, so no update, correction, or audit row.
    if (row.status === 'fulfilled' || hasFulfilmentStamp(row)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_FULFILLED_OFFERING_EDIT, code: FULFILLED_OFFERING_LOCKED_CODE })
    }
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
      // #285 F3: already unassigned. Nothing changed, so no audit row.
      res.locals.auditNoop = true
      return res.json(await loadFull(id, req.organizationId))
    }
    if (hasExpected && !sameEventId(row.calendar_event_id, expectedId)) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: 'This intention was just assigned elsewhere. Nothing was lost — please look again.',
      })
    }

    // R339-1: protected history (durable latch) changes its Mass only via
    // the reasoned admin correction. Checked under the lock, after the
    // genuine no-op return and before any update; no audit row on refusal.
    if (row.entered_history) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_FULFILLED_EDIT, code: FULFILLED_LOCKED_CODE })
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
    await writeMassIntentionAuditInTx(client, req, { status: 200, snapshot: massIntentionSnapshot(released.rows[0]) })
    await client.query('COMMIT')
    res.locals.auditRecorded = true
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
  // #285 F5: delete and its audit row commit together. Metadata stays {}.
  // Hard delete only for a row with no history and no recorded offering (F4).
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const held = await client.query(
      `SELECT status, voided_at, entered_history, fulfilled_mass_date, fulfilled_mass_title, fulfilled_mass_time, stipend, offering_recorded
         FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, req.organizationId]
    )
    // Decision 8: fulfilled, stamped (even if later reopened), or voided
    // rows are history. Refuse before any DELETE so nothing is removed.
    const h = held.rows[0]
    if (h && (h.entered_history || h.status === 'fulfilled' || hasFulfilmentStamp(h) || h.voided_at != null)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_FULFILLED_DELETE, code: FULFILLED_HISTORY_CODE })
    }
    // SP-133: under the same row lock, every role is refused once an
    // offering amount has ever been recorded. Void with a reason instead.
    if (h && offeringEverRecorded(h)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_OFFERING_DELETE, code: OFFERING_RECORDED_CODE })
    }
    const { rowCount } = await client.query(
      'DELETE FROM ochr_mass_intentions WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    await writeMassIntentionAuditInTx(client, req, { status: 204 })
    await client.query('COMMIT')
    res.locals.auditRecorded = true
    res.status(204).end()
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    // Ledger P2: transfer_fk (NO ACTION) blocks deleting a transfer target —
    // surface an honest 409, not a 500.
    if (err && (err.code === '23503' || /ochr_mass_stipend_facts_transfer_fk/i.test(String(err.message || '')))) {
      return res.status(409).json({
        code: 'stipend_transfer_target',
        error: 'This intention is the target of a stipend transfer. Void it with a disposition instead of deleting. Nothing was changed.',
      })
    }
    monitor.error('massIntentions.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete Mass intention' })
  } finally {
    client.release()
  }
})


// POST /api/mass-intentions/:id/disposition
// Ledger P2: legacy voided+paid intentions (backfill left them without a
// clearing fact) cannot be re-voided (409 already voided). This path records
// a disposition only so period submit can proceed.
router.post('/:id/disposition', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: REFUSE_ADMIN_ONLY, code: ADMIN_ONLY_CODE })
  }
  let disposition
  try {
    disposition = parseDisposition(req.body)
  } catch (e) {
    return res.status(400).json({
      code: e.code || 'disposition_invalid',
      error: 'A disposition of refund, transfer, or pastor-directed apply is required. Nothing was changed.',
    })
  }
  if (!disposition) {
    return res.status(400).json({
      code: DISPOSITION_REQUIRED.body.code,
      error: DISPOSITION_REQUIRED.body.error,
    })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const held = await client.query(
      `SELECT id, status, voided_at, stipend, offering_recorded, mass_date
         FROM ochr_mass_intentions
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [id, req.organizationId])
    if (!held.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    const row = held.rows[0]
    if (row.voided_at == null) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        code: 'not_voided',
        error: 'Record a disposition through void when the intention is still open. Nothing was changed.',
      })
    }
    // D449-4: after void, status is cancelled — recover "was fulfilled" from
    // the latest void correction's before.status. Missing correction → fail
    // closed (same code). Must run BEFORE the legacy recorded:legacy seed.
    const voidCorr = await client.query(
      `SELECT before FROM ochr_mass_intention_corrections
        WHERE organization_id = $1 AND mass_intention_id = $2 AND kind = 'void'
        ORDER BY id DESC
        LIMIT 1`,
      [req.organizationId, id])
    const beforeSnap = voidCorr.rows[0]?.before
    const beforeStatus = beforeSnap && typeof beforeSnap === 'object'
      ? beforeSnap.status
      : (typeof beforeSnap === 'string'
          ? (() => { try { return JSON.parse(beforeSnap).status } catch { return undefined } })()
          : undefined)
    if (!voidCorr.rows.length || beforeStatus === 'fulfilled') {
      await client.query('ROLLBACK')
      return res.status(409).json({
        code: DISPOSITION_FULFILLED_CODE,
        error: REFUSE_DISPOSITION_FULFILLED,
      })
    }
    const open = await openStipendLiability(client, {
      organizationId: req.organizationId, massIntentionId: id,
    })
    if (!(open > 0) && !row.offering_recorded) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        code: 'no_open_stipend',
        error: 'There is no open stipend liability on this intention. Nothing was changed.',
      })
    }
    // N449-1 / N449-2: action day in the parish zone (same as void),
    // never Mass day and never process UTC.
    const actionDay = await orgCivilToday(client, req.organizationId)
    // Legacy voided+paid with no recorded fact: seed one so writeDisposition can clear.
    if (!(open > 0) && row.offering_recorded && row.stipend != null && Number(row.stipend) > 0) {
      await recordStipendIfNeeded(client, {
        organizationId: req.organizationId,
        massIntentionId: id,
        amount: row.stipend,
        effectiveDate: actionDay,
        userId: req.user?.id ?? null,
        idempotencyKey: `recorded:legacy:${id}`,
      })
    }
    if (!disposition.reason) {
      disposition = { ...disposition, reason: 'Legacy disposition after void' }
    }
    const eff = actionDay
    try {
      await writeDisposition(client, {
        organizationId: req.organizationId,
        massIntentionId: id,
        disposition,
        voidReason: disposition.reason,
        userId: req.user?.id ?? null,
        effectiveDate: String(eff).slice(0, 10),
      })
    } catch (e) {
      await client.query('ROLLBACK')
      const msg = ({
        disposition_amount_mismatch: 'The disposition amount must equal the open stipend liability. Nothing was changed.',
        disposition_reason: 'A disposition reason is required. Nothing was changed.',
        transfer_target: 'Transfer target must be another open intention in this parish. Nothing was changed.',
        transfer_self: 'Cannot transfer a stipend to the same intention. Nothing was changed.',
      })[e.code] || 'Disposition refused. Nothing was changed.'
      return res.status(400).json({ code: e.code || 'disposition_refused', error: msg })
    }
    await writeMassIntentionAuditInTx(client, req, {
      status: 200,
      snapshot: { disposition: disposition.kind },
    })
    await client.query('COMMIT')
    res.locals.auditRecorded = true
    const liability = await openStipendLiability(pool, {
      organizationId: req.organizationId, massIntentionId: id,
    })
    res.json({ id, disposition: disposition.kind, open_liability: liability.toFixed(2) })
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    monitor.error('massIntentions.disposition', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to record stipend disposition' })
  } finally {
    client.release()
  }
})

export default router
