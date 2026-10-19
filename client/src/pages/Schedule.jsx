import { useState, useEffect, useRef } from 'react'
import { useSearchParams, Link, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft, ChevronRight, Plus, X, Trash2, Clock, Users, Users2, Repeat, AlertTriangle, History, Cross, CalendarDays, Printer, UserCheck } from 'lucide-react'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'
import { viewerMayOpen } from '../auth/viewerPages'
import { useToast } from '../components/ToastProvider'
import LoadFailure from '../components/LoadFailure'
import MemberPicker from '../components/MemberPicker'
import OrderedMemberPicker from '../components/OrderedMemberPicker'
import PageWrapper from '../components/PageWrapper'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip } from '../components/MobileSheet'
import { LIT_COLOR_DOT, LIT_COLOR_TEXT, LIT_COLOR_STRIPE } from '../utils/liturgicalColors'
import { seasonLabel } from '../i18n/liturgical'
import { initials, loadList } from '../utils/format'
import { toLocalISO, parseLocalDate, calendarDay } from '../utils/dates'
import { useConfirm } from '../components/ConfirmProvider'
import MassIntentionAssign from '../components/MassIntentionAssign'
import { isIntentionDraftNonce } from '../utils/intentionDraft'
import { isMassCalendarEvent } from '../utils/massEvent'

// ── Constants ────────────────────────────────────────────────
const START_HOUR  = 7
const END_HOUR    = 21
const HOUR_HEIGHT = 64 // px per hour
const HOURS       = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i)
// Parchment & Brass inversion: the liturgical color of the day owns each
// tile's left edge; the event *type* is expressed as a quiet ink glyph,
// not a color fill. All tiles share one parchment surface so the season's
// hue is the only polychrome element on the calendar.
const TYPE_META = {
  service: { label: 'Service', icon: Cross },
  meeting: { label: 'Meeting', icon: Users },
  event:   { label: 'Event',   icon: CalendarDays },
}

// Shared tile treatment — surface, text, and the neutral type badge.
const TILE_BLOCK = 'bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30'
const TILE_TEXT  = 'text-ink-800 dark:text-parchment-100'
const TILE_BADGE = 'bg-parchment-200/70 dark:bg-ink-700 text-ink-600 dark:text-parchment-300'

const EMPTY_FORM = { title: '', date: '', start_time: '', end_time: '', type: 'service', assigned_to: [], group_id: '' }

// ── Helpers ──────────────────────────────────────────────────
function toMinutes(t) {
  if (!t) return 0
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

// R321-1: the conflict and availability checks validate every entry the
// modal consumes before committing a result. One unusable entry makes the
// whole check UNKNOWN (the amber note), never a crash and never a silently
// shortened, clean-looking result. Shapes follow GET /api/calendar/conflicts
// (routes/calendar.js) and GET /api/availability?date= (routes/availability.js).
const isRowId = v => Number.isInteger(v) && v > 0
function validConflictList(list) {
  return Array.isArray(list) && list.every(c =>
    isPlainObject(c) && isRowId(c.id) && typeof c.title === 'string'
    && typeof c.start_time === 'string' && typeof c.end_time === 'string'
    && Array.isArray(c.conflicting_members) && c.conflicting_members.length > 0
    && c.conflicting_members.every(m => isPlainObject(m) && typeof m.name === 'string'))
}
function validUnavailabilityList(list) {
  return Array.isArray(list) && list.every(u => isPlainObject(u) && isRowId(u.client_id))
}

function fmt12(t) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`
}

function getMondayOf(date) {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

// Local 'YYYY-MM-DD' — the week grid builds Dates at local midnight, so
// toISOString() here would shift the day across the UTC boundary (the
// classic off-by-one). Use the shared local-date helper instead (1.1).
function toDateStr(date) {
  return toLocalISO(date)
}

function isSameDay(a, b) {
  return toDateStr(a) === toDateStr(b)
}

// Open(eventId): a Mass is a stable destination, named by
// ochr_calendar_events.id — never by title or date. The same gate as
// check-in's ?event= reader. A garbled token is not a Mass.
export function parseScheduleEventId(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isInteger(n) || n <= 0 || String(n) !== s) return null
  return n
}

export function findCalendarEventById(events, id) {
  const n = parseScheduleEventId(id)
  if (n == null || !Array.isArray(events)) return null
  return events.find(e => parseScheduleEventId(e?.id) === n) ?? null
}

export function weekStartForEventDate(dateRaw) {
  const dateStr = dateRaw != null ? String(dateRaw).slice(0, 10) : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  return getMondayOf(parseLocalDate(dateStr))
}

export function dayIndexForEventDate(weekStart, dateRaw) {
  const monday = weekStart instanceof Date ? weekStart : null
  if (!monday) return null
  const dateStr = dateRaw != null ? String(dateRaw).slice(0, 10) : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  const day = parseLocalDate(dateStr)
  day.setHours(0, 0, 0, 0)
  const start = new Date(monday)
  start.setHours(0, 0, 0, 0)
  const idx = Math.round((day.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
  return idx >= 0 && idx < 7 ? idx : null
}

export function scheduleEventHref(eventId) {
  const id = parseScheduleEventId(eventId)
  return id == null ? '/schedule' : `/schedule?event=${id}`
}

// Intention book → existing Schedule create flow, for one calendar day.
// The query value is a fixed token, never a caller-supplied URL.
export const INTENTION_RETURN_TOKEN = 'intention'
const RETURN_PARAM = 'return'

export function isIntentionReturn(value) {
  return value === INTENTION_RETURN_TOKEN
}

const DRAFT_PARAM = 'draft'

export function isCalendarDayParam(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const utc = new Date(Date.UTC(y, m - 1, d))
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d
}

export function scheduleNewMassHref(date, nonce) {
  const qs = new URLSearchParams()
  qs.set('new', '1')
  qs.set(RETURN_PARAM, INTENTION_RETURN_TOKEN)
  if (isCalendarDayParam(date)) qs.set('date', date)
  if (isIntentionDraftNonce(nonce)) qs.set(DRAFT_PARAM, nonce)
  return `/schedule?${qs.toString()}`
}

// After that Mass is saved, come back to the book with the new id.
// resume is the one-time nonce from this trip, never a standing "1".
export function intentionResumeHref({ eventId, date, nonce } = {}) {
  const qs = new URLSearchParams()
  const id = parseScheduleEventId(eventId)
  if (id != null) qs.set('event', String(id))
  if (isCalendarDayParam(date)) qs.set('date', date)
  if (isIntentionDraftNonce(nonce)) qs.set('resume', nonce)
  const q = qs.toString()
  return q ? `/mass-intentions?${q}` : '/mass-intentions'
}

export function withScheduleEventParam(searchParams, eventId) {
  const next = new URLSearchParams(searchParams)
  const id = parseScheduleEventId(eventId)
  if (id == null) next.delete('event')
  else next.set('event', String(id))
  return next
}

// ── Current time indicator ───────────────────────────────────
function NowLine() {
  const [top, setTop] = useState(null)

  useEffect(() => {
    const calc = () => {
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const gridStart = START_HOUR * 60
      const gridEnd   = END_HOUR   * 60
      if (mins < gridStart || mins > gridEnd) { setTop(null); return }
      setTop(((mins - gridStart) / 60) * HOUR_HEIGHT)
    }
    calc()
    const id = setInterval(calc, 60000)
    return () => clearInterval(id)
  }, [])

  if (top === null) return null
  return (
    <div className="absolute left-0 right-0 z-10 flex items-center pointer-events-none" style={{ top }}>
      <div className="w-2 h-2 rounded-full bg-church-700 dark:bg-brass-400 -ml-1 shrink-0" />
      <div className="flex-1 h-px bg-church-700 dark:bg-brass-400" />
    </div>
  )
}

// ── Event block ──────────────────────────────────────────────
// Mass intentions (MI.3) — the calendar side of the intention↔Mass link.
// Shown as the traditional † with the intention text; the schedule is a
// read surface for these, the book (/mass-intentions) stays the editor.
function IntentionLine({ intentions, compact = false }) {
  if (!intentions.length) return null
  const first = intentions[0].formatted_intention || intentions[0].intention
  const extra = intentions.length - 1
  return (
    <p
      className={`${compact ? 'text-[10px]' : 'text-xs'} mt-0.5 truncate text-brass-700 dark:text-brass-300`}
      title={intentions.map(mi => mi.formatted_intention || mi.intention).join('\n')}
    >
      <span className="font-display">†</span> {first}{extra > 0 ? ` +${extra}` : ''}
    </p>
  )
}

function EventBlock({ event, onClick, members, litColor, intentions = [] }) {
  const meta      = TYPE_META[event.type] ?? TYPE_META.event
  const gridStart = START_HOUR * 60
  const startMins = toMinutes(event.start_time)
  const endMins   = toMinutes(event.end_time)
  const top       = ((startMins - gridStart) / 60) * HOUR_HEIGHT
  const height    = Math.max(((endMins - startMins) / 60) * HOUR_HEIGHT, 20)
  const short     = height < 36
  const tall      = height >= 56

  // assigned_to is a JSONB array of member ids; resolve to objects we
  // can render. Cap at 3 visible chips + "+N" overflow.
  const assignedIds = Array.isArray(event.assigned_to) ? event.assigned_to : []
  const assigned    = assignedIds
    .map(id => members.find(m => String(m.id) === String(id)))
    .filter(Boolean)
  const visible  = assigned.slice(0, 3)
  const overflow = assigned.length - visible.length

  // The season's canonical hue (Purple / White / Green / Red / Gold)
  // owns the tile's left edge — the one polychrome element on the grid.
  const stripeCls = litColor ? (LIT_COLOR_STRIPE[litColor] ?? 'border-brass-400') : 'border-brass-400'
  const TypeIcon  = meta.icon

  return (
    <motion.button
      onClick={() => onClick(event)}
      className={`absolute left-1 right-1 rounded-lg px-2 py-1 overflow-hidden text-left cursor-pointer shadow-warm ${TILE_BLOCK} border-l-[3px] ${stripeCls} hover:border-brass-400 dark:hover:border-brass-500/60 transition-colors`}
      style={{ top, height }}
    >
      <p className={`font-semibold leading-tight truncate flex items-center gap-1 ${TILE_TEXT} ${short ? 'text-[10px]' : 'text-xs'}`}>
        <TypeIcon size={10} className="shrink-0 text-ink-400 dark:text-parchment-400/60" aria-label={meta.label} />
        {event.recurrence_parent_id && <Repeat size={10} className="shrink-0 opacity-70" />}
        <span className="truncate">{event.title}</span>
      </p>
      {!short && (
        <p className={`text-[10px] opacity-70 mt-0.5 ${TILE_TEXT}`}>
          {fmt12(event.start_time)} – {fmt12(event.end_time)}
        </p>
      )}
      {!short && <IntentionLine intentions={intentions} compact />}
      {tall && assigned.length > 0 && (
        <div className="flex -space-x-1 mt-1" title={assigned.map(m => m.name).join(', ')}>
          {visible.map(m => (
            <span
              key={m.id}
              className="w-4 h-4 rounded-full bg-church-900 dark:bg-church-700 ring-1 ring-white dark:ring-ink-900 flex items-center justify-center text-parchment-50 text-[8px] font-bold"
            >
              {initials(m.name)}
            </span>
          ))}
          {overflow > 0 && (
            <span className="w-4 h-4 rounded-full bg-parchment-300 dark:bg-ink-700 ring-1 ring-white dark:ring-ink-900 flex items-center justify-center text-[8px] font-bold text-ink-700 dark:text-parchment-200">
              +{overflow}
            </span>
          )}
        </div>
      )}
    </motion.button>
  )
}

// ── Mobile event card (used in the day-list under md) ────────
// Full-width, tap-to-edit. Avoids the absolute time-positioned math
// that the desktop EventBlock relies on, since the day-list flow is
// linear top-to-bottom.
function MobileEventCard({ event, onClick, members, litColor, intentions = [] }) {
  const meta = TYPE_META[event.type] ?? TYPE_META.event
  const assignedIds = Array.isArray(event.assigned_to) ? event.assigned_to : []
  const assigned = assignedIds
    .map(id => members.find(m => String(m.id) === String(id)))
    .filter(Boolean)
  const visible = assigned.slice(0, 4)
  const overflow = assigned.length - visible.length

  // Liturgical color stripe — same treatment as the desktop tile.
  const stripeCls = litColor ? (LIT_COLOR_STRIPE[litColor] ?? 'border-brass-400') : 'border-brass-400'
  const TypeIcon  = meta.icon

  return (
    <button
      onClick={() => onClick(event)}
      className={`block w-full text-left rounded-lg px-3 py-2.5 shadow-warm ${TILE_BLOCK} border-l-[3px] ${stripeCls} hover:border-brass-400 dark:hover:border-brass-500/60 transition-colors`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={`font-semibold leading-tight flex items-center gap-1 ${TILE_TEXT}`}>
          {event.recurrence_parent_id && <Repeat size={11} className="shrink-0 opacity-70" />}
          <span>{event.title}</span>
        </p>
        <span className={`shrink-0 flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${TILE_BADGE}`}>
          <TypeIcon size={9} className="shrink-0 opacity-70" />
          {meta.label}
        </span>
      </div>
      <p className={`text-xs opacity-70 mt-0.5 ${TILE_TEXT}`}>
        {fmt12(event.start_time)} – {fmt12(event.end_time)}
      </p>
      <IntentionLine intentions={intentions} />
      {assigned.length > 0 && (
        <div className="flex -space-x-1 mt-2" title={assigned.map(m => m.name).join(', ')}>
          {visible.map(m => (
            <span
              key={m.id}
              className="w-5 h-5 rounded-full bg-church-900 dark:bg-church-700 ring-2 ring-white dark:ring-ink-900 flex items-center justify-center text-parchment-50 text-[9px] font-bold"
            >
              {initials(m.name)}
            </span>
          ))}
          {overflow > 0 && (
            <span className="w-5 h-5 rounded-full bg-parchment-300 dark:bg-ink-700 ring-2 ring-white dark:ring-ink-900 flex items-center justify-center text-[9px] font-bold text-ink-700 dark:text-parchment-200">
              +{overflow}
            </span>
          )}
        </div>
      )}
    </button>
  )
}

// A figure counts only as a finite number or a plain decimal string
// (including zero and Postgres numeric text). Booleans, arrays, objects,
// and blanks are not zero. Same rule as the offerings workbench.
function knownNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function positiveIntId(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v
  if (typeof v === 'string' && /^[1-9]\d*$/.test(v)) {
    const n = Number(v)
    if (Number.isSafeInteger(n)) return n
  }
  return null
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isInvoiceRow(row) {
  return isPlainObject(row) && positiveIntId(row.id) != null
}

// A bare array of invoice rows. An object, a non-array, or a row without
// a canonical id is not "no invoices".
function asInvoiceList(body) {
  if (!Array.isArray(body)) return null
  if (body.some(row => !isInvoiceRow(row))) return null
  return body
}

async function readEventInvoices(eventId) {
  const id = positiveIntId(eventId)
  if (id == null) return { failed: true }
  try {
    const res = await fetch(apiUrl(`/api/invoices?event=${id}&limit=20`))
    if (!res.ok) return { failed: true }
    const body = await res.json()
    const list = asInvoiceList(body)
    if (!list) return { failed: true }
    return { failed: false, invoices: list.filter(i => i.status !== 'cancelled') }
  } catch {
    return { failed: true }
  }
}

// ── Add/Edit Modal ───────────────────────────────────────────
export function EventModal({ event, onClose, onSave, onDelete, members, membersFailed = false, groups = [], groupsFailed = false, intentions = [], intentionsFailed = false, onIntentionsChanged }) {
  const { isAdmin } = useAuth()
  const { t, tradition } = useLocale()
  const [form, setForm] = useState(() => {
    if (!event) return EMPTY_FORM
    // Normalize assigned_to in case the server returns it as null / a string
    const normalized = Array.isArray(event.assigned_to) ? event.assigned_to : []
    // Postgres DATE arrives as a full ISO timestamp ("2026-08-02T00:00:00.000Z"),
    // which <input type="date"> silently rejects — the required Date field
    // rendered BLANK on every edit (QA audit H1). Slice to YYYY-MM-DD.
    const date = event.date ? String(event.date).slice(0, 10) : EMPTY_FORM.date
    return { ...EMPTY_FORM, ...event, date, assigned_to: normalized }
  })
  const field = k => e => setForm(f => ({ ...f, [k]: e.target.value }))
  // Edit mode is keyed off a persisted id, not mere truthiness — a
  // prefilled "new" event (day-click date or a group deep-link) is an
  // object too, but should still render as New (Repeat option on,
  // no Delete, "Add Event" button).
  const isEdit = !!event?.id

  // Offerings & fees linked to this event (BILL.2). A failed read stays
  // visible with retry. An empty linked list still hides the block.
  const [eventInvoices, setEventInvoices] = useState([])
  const [invoicesFailed, setInvoicesFailed] = useState(false)
  const invoiceGen = useRef(0)
  const eventIdRef = useRef(event?.id)
  eventIdRef.current = event?.id
  const applyInvoices = (forId, result) => {
    if (positiveIntId(eventIdRef.current) !== positiveIntId(forId)) return
    if (result.failed) {
      setEventInvoices([])
      setInvoicesFailed(true)
    } else {
      setEventInvoices(result.invoices)
      setInvoicesFailed(false)
    }
  }
  const retryInvoices = async () => {
    const forId = event?.id
    const gen = ++invoiceGen.current
    const result = await readEventInvoices(forId)
    if (gen !== invoiceGen.current || positiveIntId(eventIdRef.current) !== positiveIntId(forId)) return
    applyInvoices(forId, result)
  }
  useEffect(() => {
    if (!isEdit) {
      invoiceGen.current += 1
      setEventInvoices([])
      setInvoicesFailed(false)
      return
    }
    const forId = event.id
    const gen = ++invoiceGen.current
    let cancelled = false
    setInvoicesFailed(false)
    setEventInvoices([])
    ;(async () => {
      const result = await readEventInvoices(forId)
      if (cancelled || gen !== invoiceGen.current) return
      applyInvoices(forId, result)
    })()
    return () => { cancelled = true; invoiceGen.current += 1 }
  }, [isEdit, event?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Liturgical context for the event's date. Fetched whenever the
  // date field changes — the /api/liturgical endpoint is private-
  // cached for 1h (S5.1) so repeated reads of the same date round-
  // trip once per hour at worst. We render a tiny chip near the
  // date so admins know "this falls on Pentecost / Lent / etc."
  // without leaving the modal.
  const [liturgical, setLiturgical] = useState(null)
  useEffect(() => {
    if (!form.date) { setLiturgical(null); return }
    let cancelled = false
    fetch(apiUrl(`/api/liturgical?date=${form.date}`))
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setLiturgical(d) })
      .catch(() => { if (!cancelled) setLiturgical(null) })
    return () => { cancelled = true }
  }, [form.date])

  // Pre-flight overlap check. Re-runs (debounced) whenever the
  // date / time range / assignees change. The backend returns a
  // soft warning shape; we render but never block saving — admins
  // sometimes intentionally double-book ("the choir leader IS in
  // both the rehearsal and the performance").
  // A failed or malformed check is UNKNOWN, not "no conflicts": it is
  // reported as such (conflictCheckFailed) and never shown as clean.
  const [conflicts, setConflicts] = useState([])
  const [conflictCheckFailed, setConflictCheckFailed] = useState(false)
  useEffect(() => {
    const ready = form.date && form.start_time && form.end_time && form.assigned_to?.length
    setConflictCheckFailed(false)
    if (!ready) { setConflicts([]); return }
    const params = new URLSearchParams({
      date:        form.date,
      start_time:  form.start_time,
      end_time:    form.end_time,
      assigned_to: form.assigned_to.join(','),
    })
    if (event?.id) params.set('exclude_id', String(event.id))
    let cancelled = false
    const t = setTimeout(() => {
      fetch(apiUrl(`/api/calendar/conflicts?${params}`))
        .then(r => {
          if (!r.ok) throw new Error(`conflicts ${r.status}`)
          return r.json()
        })
        .then(d => {
          if (cancelled) return
          if (!validConflictList(d?.conflicts)) throw new Error('conflicts: malformed')
          setConflicts(d.conflicts)
          setConflictCheckFailed(false)
        })
        .catch(() => {
          if (cancelled) return
          setConflicts([])
          setConflictCheckFailed(true)
        })
    }, 400)
    return () => { cancelled = true; clearTimeout(t) }
  }, [form.date, form.start_time, form.end_time, form.assigned_to, event?.id])

  // Availability warning (VS.4b) — flag any assigned member who has a
  // blackout range covering the event's date. Soft + non-blocking, same
  // spirit as the conflict warning: the admin may knowingly assign
  // someone who said they're out. Re-runs when the date or roster
  // changes. `unavailableIds` is the subset of assigned_to that's out.
  // Same rule: a failed or malformed availability read is reported, not
  // shown as "everyone is available".
  const [unavailableIds, setUnavailableIds] = useState([])
  const [availabilityCheckFailed, setAvailabilityCheckFailed] = useState(false)
  useEffect(() => {
    const ready = form.date && form.assigned_to?.length
    setAvailabilityCheckFailed(false)
    if (!ready) { setUnavailableIds([]); return }
    let cancelled = false
    fetch(apiUrl(`/api/availability?date=${form.date}`))
      .then(r => {
        if (!r.ok) throw new Error(`availability ${r.status}`)
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        if (!validUnavailabilityList(d?.unavailability)) throw new Error('availability: malformed')
        const outSet = new Set(d.unavailability.map(u => u.client_id))
        setUnavailableIds(form.assigned_to.filter(id => outSet.has(id)))
        setAvailabilityCheckFailed(false)
      })
      .catch(() => {
        if (cancelled) return
        setUnavailableIds([])
        setAvailabilityCheckFailed(true)
      })
    return () => { cancelled = true }
  }, [form.date, form.assigned_to])

  // Rotation auto-fill (VS.1b) — only meaningful when editing an
  // existing recurring series. Selection is ORDERED (drives the
  // round-robin server-side). Result is kept in local state so the
  // success line persists until the user picks a fresh set; the toast
  // is the moment-of-action confirmation.
  const toast = useToast()
  const [rotationIds,    setRotationIds]    = useState([])
  const [rotationBusy,   setRotationBusy]   = useState(false)
  const [rotationResult, setRotationResult] = useState(null)
  const onAutoFillRotation = async () => {
    if (rotationIds.length === 0 || !event?.recurrence_parent_id) return
    setRotationBusy(true)
    setRotationResult(null)
    let res
    try {
      res = await fetch(apiUrl('/api/calendar/auto-fill-rotation'), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recurrence_parent_id: event.recurrence_parent_id,
          member_ids:           rotationIds,
        }),
      })
    } catch (err) {
      toast.error(t('sched.saveLost'))
      setRotationBusy(false)
      return
    }
    const data = await res.json().catch(() => ({}))
    setRotationBusy(false)
    if (!res.ok) {
      toast.error(data.error || `Auto-fill failed (${res.status})`)
      return
    }
    setRotationResult(data)
    const skipNote = data.skipped > 0 ? `, ${data.skipped} already assigned` : ''
    toast.success(`Rotation filled across ${data.occurrences} occurrences (${data.assigned} new${skipNote})`)
  }

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400/50'

  return (
    <div className={sheetOverlayCls}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18 }}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
          <h2 className="font-bold text-ink-900 dark:text-parchment-50">{isEdit ? 'Edit Event' : 'New Event'}</h2>
          <button onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Type selector — quiet parchment pills; the active type is
              marked by a brass edge, not a color fill. */}
          <div className="flex gap-2">
            {Object.entries(TYPE_META).map(([key, meta]) => {
              const TypeIcon = meta.icon
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, type: key }))}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    form.type === key
                      ? 'bg-parchment-200 dark:bg-ink-700 border-brass-400 dark:border-brass-500/60 text-ink-900 dark:text-parchment-50'
                      : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:border-brass-300 dark:hover:border-brass-900/60'
                  }`}
                >
                  <TypeIcon size={11} className="shrink-0 opacity-70" />
                  {meta.label}
                </button>
              )
            })}
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('sched.field.title')} *</label>
            <input value={form.title} onChange={field('title')} placeholder={t('sched.field.titlePh')} aria-label={t('sched.field.titlePh')} className={inputCls} />
          </div>

          {/* Date */}
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('sched.field.date')} *</label>
            <input type="date" value={form.date} onChange={field('date')} className={inputCls} />
            {/* Liturgical context for this date — purely informational.
                Fades in once the /api/liturgical fetch resolves; absent
                on dates outside the algorithm's coverage. */}
            {liturgical?.season && (
              <div className={`mt-2 flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-[11px] font-medium ${LIT_COLOR_TEXT[liturgical.color] ?? LIT_COLOR_TEXT.White}`}>
                <span className={`w-2 h-2 rounded-full shrink-0 ${LIT_COLOR_DOT[liturgical.color] ?? 'bg-parchment-300'}`} />
                <span className="font-semibold">{seasonLabel(t, liturgical.season, { tradition, block: liturgical.ordinary_block })}</span>
                {liturgical.feast_name && (
                  <span className="opacity-75">· {liturgical.feast_name}</span>
                )}
              </div>
            )}
          </div>

          {/* Times */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('sched.field.start')} *</label>
              <input type="time" value={form.start_time} onChange={field('start_time')} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('sched.field.end')} *</label>
              <input type="time" value={form.end_time} onChange={field('end_time')} className={inputCls} />
            </div>
          </div>

          {/* Group — optional. Links this event to a ministry / life
              group / committee so the Schedule page can filter to it
              and the Groups page can deep-link "create event". */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">
              <Users2 size={12} /> Group <span className="font-normal text-ink-400 dark:text-parchment-300/70">(optional)</span>
            </label>
            <select
              value={form.group_id ?? ''}
              onChange={e => setForm(f => ({ ...f, group_id: e.target.value }))}
              className={inputCls}
            >
              <option value="">No group</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            {/* An empty list here can mean the groups did not load, not
                that the parish has none. */}
            {groupsFailed && (
              <p role="status" className="mt-1 text-[11px] text-amber-800 dark:text-amber-200">{t('sched.groupsLoadFailed')}</p>
            )}
          </div>

          {/* Mass intentions at this Mass (MI.4) — assign from the drawer
              so the book, week, weekly sheet, and packet share one fact. */}
          {isEdit && isMassCalendarEvent(event) && (
            <MassIntentionAssign
              event={event}
              assigned={intentions}
              assignedFailed={intentionsFailed}
              onChanged={onIntentionsChanged}
            />
          )}

          {/* Offerings & fees linked to this event (BILL.2) — read-only
              here; the workbench stays the single place money is handled.
              A wedding's deposit, balance, and date read from one drawer.
              Failure stays in the drawer. A real empty link still hides it. */}
          {isEdit && (invoicesFailed || eventInvoices.length > 0) && (
            <div className="px-2.5 py-2 rounded-md border border-brass-200/70 dark:border-brass-800/40 bg-brass-50 dark:bg-brass-900/20">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300 mb-1">
                Offerings &amp; fees
              </p>
              {invoicesFailed ? (
                <LoadFailure variant="strip" body={t('sched.invoicesUnread')} onRetry={retryInvoices} />
              ) : (
                <ul className="space-y-0.5">
                  {eventInvoices.map(inv => {
                    const total = knownNumber(inv.total)
                    const paid = knownNumber(inv.amount_paid)
                    const bal = total == null || paid == null ? null : Math.max(total - paid, 0)
                    return (
                      <li key={inv.id} className="text-xs text-ink-800 dark:text-parchment-100">
                        {inv.invoice_no ? `${inv.invoice_no} · ` : ''}{inv.title}
                        <span className="text-ink-500 dark:text-parchment-300/70">
                          {' — '}
                          {inv.status === 'paid' ? 'settled'
                            : inv.status === 'waived' ? 'waived'
                            : inv.status === 'draft' ? 'draft'
                            : bal == null ? t('money.unavailable')
                            : `$${bal.toFixed(2)} remaining`}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
              <Link to="/offerings" className="mt-1 inline-block text-[11px] font-semibold text-brass-700 dark:text-brass-300 hover:underline">
                Open the offerings workbench →
              </Link>
            </div>
          )}

          {/* Assigned members — drives the personal calendar feed */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">
              <Users size={12} /> Assigned Members
            </label>
            <MemberPicker
              failed={membersFailed}
              members={members}
              value={form.assigned_to}
              onChange={(ids) => setForm(f => ({ ...f, assigned_to: ids }))}
              linkProfiles
            />
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
              Assigned members see this on their calendar feed and get a
              serving reminder before the event.
            </p>
          </div>

          {/* Conflict warnings — soft, non-blocking. The save
              button reflects the warning state; admins may still
              intentionally double-book. */}
          {conflicts.length > 0 && (
            <div className="rounded-lg bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 px-3 py-2.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <AlertTriangle size={13} className="text-rose-700 dark:text-rose-300 shrink-0" />
                <span className="text-xs font-semibold text-rose-700 dark:text-rose-200">
                  {conflicts.length === 1 ? 'Schedule conflict' : `${conflicts.length} schedule conflicts`}
                </span>
              </div>
              <ul className="space-y-1.5">
                {conflicts.map(c => (
                  <li key={c.id} className="text-[11px] text-ink-700 dark:text-parchment-200 leading-snug">
                    <span className="font-semibold">
                      {c.conflicting_members.map(m => m.name).join(', ')}
                    </span>
                    <span className="text-ink-500 dark:text-parchment-300/70">
                      {' '}also assigned to{' '}
                    </span>
                    <span className="font-medium">{c.title}</span>
                    <span className="text-ink-500 dark:text-parchment-300/70">
                      {' '}({fmt12(c.start_time)} – {fmt12(c.end_time)})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* A conflict check that did not complete is not a clean result. */}
          {conflictCheckFailed && (
            <div role="status" className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 px-3 py-2.5">
              <div className="flex items-center gap-1.5">
                <AlertTriangle size={13} className="text-amber-600 dark:text-amber-300 shrink-0" />
                <span className="text-xs text-amber-800 dark:text-amber-200">{t('sched.conflictCheckFailed')}</span>
              </div>
            </div>
          )}

          {availabilityCheckFailed && (
            <div role="status" className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 px-3 py-2.5">
              <div className="flex items-center gap-1.5">
                <AlertTriangle size={13} className="text-amber-600 dark:text-amber-300 shrink-0" />
                <span className="text-xs text-amber-800 dark:text-amber-200">{t('sched.availabilityCheckFailed')}</span>
              </div>
            </div>
          )}

          {/* Availability warning (VS.4b) — soft, non-blocking. An
              assigned member has a blackout range over this date. */}
          {unavailableIds.length > 0 && (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 px-3 py-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <AlertTriangle size={13} className="text-amber-600 dark:text-amber-300 shrink-0" />
                <span className="text-xs font-semibold text-amber-800 dark:text-amber-200">
                  {unavailableIds.length === 1 ? 'Member unavailable' : `${unavailableIds.length} members unavailable`}
                </span>
              </div>
              <p className="text-[11px] text-ink-700 dark:text-parchment-200 leading-snug">
                <span className="font-semibold">
                  {unavailableIds.map(id => members.find(m => m.id === id)?.name ?? `Member #${id}`).join(', ')}
                </span>
                <span className="text-ink-500 dark:text-parchment-300/70">
                  {' '}marked themselves unavailable on this date.
                </span>
              </p>
            </div>
          )}

          {/* Repeat — only on create. Editing the seed of an existing
              series is a deeper UX (apply to all / future) we haven't
              built yet, so we keep edit-mode focused on the single row. */}
          {!isEdit && (
            <div>
              <label className="flex items-center gap-2 text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-2">
                <Repeat size={12} />
                <span>Repeat</span>
                <input
                  type="checkbox"
                  className="ml-auto h-4 w-4 accent-church-700"
                  checked={!!form.recurrence}
                  onChange={(e) => setForm(f => ({
                    ...f,
                    recurrence: e.target.checked
                      ? { freq: 'weekly', interval: 1, count: 6 }
                      : null,
                  }))}
                />
              </label>
              {form.recurrence && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Every</label>
                    <select
                      value={form.recurrence.interval}
                      onChange={(e) => setForm(f => ({ ...f, recurrence: { ...f.recurrence, interval: Number(e.target.value) } }))}
                      className={inputCls}
                    >
                      <option value={1}>1 week</option>
                      <option value={2}>2 weeks</option>
                      <option value={3}>3 weeks</option>
                      <option value={4}>4 weeks</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">For</label>
                    <select
                      value={form.recurrence.count}
                      onChange={(e) => setForm(f => ({ ...f, recurrence: { ...f.recurrence, count: Number(e.target.value) } }))}
                      className={inputCls}
                    >
                      {[2, 4, 6, 8, 10, 12, 16, 20, 26].map(n => (
                        <option key={n} value={n}>{n} occurrences</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

          {/* Rotation auto-fill (VS.1b) — only when editing a recurring
              series. Server walks FUTURE occurrences and round-robins
              the ordered list onto each. The current occurrence's
              `assigned_to` may also change server-side; the modal form
              shown is the pre-fill snapshot, so we leave the rest of
              the form alone and let the user re-open if they want to
              see/edit the updated assignees on this row. */}
          {isEdit && event?.recurrence_parent_id && (
            <div>
              <label className="flex items-center gap-2 text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-2">
                <Repeat size={12} />
                <span>Auto-fill rotation</span>
              </label>
              <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 leading-snug mb-2">
                Pick members in the order they should serve. Each future
                occurrence in this series gets the next person on the list
                (anyone already assigned is skipped).
              </p>
              <OrderedMemberPicker
                members={members}
                value={rotationIds}
                onChange={ids => { setRotationIds(ids); setRotationResult(null) }}
              />
              <div className="flex items-center justify-between gap-3 mt-3">
                <div className="text-[11px] text-ink-500 dark:text-parchment-300/70 min-w-0">
                  {rotationResult ? (
                    <span className="text-brass-700 dark:text-brass-300 font-medium">
                      Filled {rotationResult.occurrences} occurrences ({rotationResult.assigned} new
                      {rotationResult.skipped > 0 ? `, ${rotationResult.skipped} already assigned` : ''})
                    </span>
                  ) : rotationIds.length === 0 ? (
                    'Add at least one member to enable auto-fill.'
                  ) : (
                    `Will rotate ${rotationIds.length} member${rotationIds.length === 1 ? '' : 's'} across all future occurrences.`
                  )}
                </div>
                <button
                  type="button"
                  onClick={onAutoFillRotation}
                  disabled={rotationBusy || rotationIds.length === 0}
                  className="px-3 py-2 text-xs font-semibold rounded-lg border border-church-900 dark:border-parchment-100 text-church-900 dark:text-parchment-100 hover:bg-church-900 hover:text-parchment-50 dark:hover:bg-parchment-100 dark:hover:text-church-900 transition-colors disabled:opacity-40 shrink-0"
                >
                  {rotationBusy ? 'Filling…' : 'Auto-fill rotation'}
                </button>
              </div>
            </div>
          )}

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-parchment-300/50 dark:border-brass-900/25">
          <div className="flex items-center gap-3">
            {isEdit && (
              <button onClick={() => onDelete(event.id)} className="flex items-center gap-1.5 text-xs font-medium text-rose-500 hover:text-rose-700 transition-colors">
                <Trash2 size={13} /> Delete
              </button>
            )}
            {isEdit && event?.recurrence_parent_id && (
              <button onClick={() => onDelete(event.id, 'series')} className="flex items-center gap-1.5 text-xs font-medium text-rose-500 hover:text-rose-700 transition-colors">
                <Repeat size={13} /> Delete series
              </button>
            )}
            {/* Take attendance for THIS service. The desk already has the
                service open; without this it leaves for Check-in and finds
                the same one again in a thirty-day dropdown, and for a Mass
                that has already happened it could not be reached at all.
                `?event=` is the check-in page's source of truth, so the
                service on that screen is the service written to. Not gated on
                edit rights — taking attendance is not editing the schedule. */}
            {isEdit && (
              <Link
                to={`/checkin?event=${event.id}`}
                className="flex items-center gap-1.5 text-xs font-medium text-ink-500 dark:text-parchment-300/70 hover:text-ink-900 dark:hover:text-parchment-50 transition-colors"
                title="Open check-in for this service"
              >
                <UserCheck size={13} /> Check-in
              </Link>
            )}
            {/* This event's audit trail (AUD.4) — admin-only, edit mode
                only. Navigating away closes the modal. */}
            {isEdit && isAdmin && (
              <Link
                to={`/audit?entity_type=calendar_event&entity_id=${event.id}`}
                className="flex items-center gap-1.5 text-xs font-medium text-ink-500 dark:text-parchment-300/70 hover:text-ink-900 dark:hover:text-parchment-50 transition-colors"
                title="See every change made to this schedule entry"
              >
                <History size={13} /> History
              </Link>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button onClick={onClose} className="text-sm text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors px-3 py-1.5">
              Cancel
            </button>
            {isEdit && event?.recurrence_parent_id && (
              <button
                onClick={() => onSave(form, 'following')}
                disabled={!form.title.trim() || !form.date || !form.start_time || !form.end_time}
                title="Apply this edit to this occurrence and every later one in the series"
                className="px-3 py-2 text-xs font-semibold rounded-lg border border-church-900 dark:border-parchment-100 text-church-900 dark:text-parchment-100 hover:bg-church-900 hover:text-parchment-50 dark:hover:bg-parchment-100 dark:hover:text-church-900 transition-colors disabled:opacity-40"
              >
                Save & apply to following
              </button>
            )}
            <button
              onClick={() => onSave(form)}
              disabled={!form.title.trim() || !form.date || !form.start_time || !form.end_time}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {conflicts.length > 0 ? (isEdit ? 'Save anyway' : 'Add anyway') : (isEdit ? 'Save' : 'Add Event')}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────
export default function Schedule() {
  const [weekStart, setWeekStart] = useState(() => getMondayOf(new Date()))
  const [events, setEvents]       = useState([])
  const [members, setMembers]     = useState([])
  const [membersFailed, setMembersFailed] = useState(false)
  const [groups, setGroups]       = useState([])
  const [groupsFailed, setGroupsFailed] = useState(false)
  const [groupFilter, setGroupFilter] = useState('')   // '' = all groups
  const [modal, setModal]         = useState(null)   // null | 'new' | event object
  // True while the week's events are in flight. An empty grid that
  // silently fills two seconds later reads, briefly, as lost data —
  // the one emotion this product exists to never cause.
  const [loadingWeek, setLoadingWeek] = useState(true)
  const [prefillDate, setPrefillDate] = useState('')
  const [prefillGroup, setPrefillGroup] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  // Date → {color, season, feast_name} for the visible week. Built
  // from /api/liturgical/range so event tiles can carry a left-edge
  // stripe in the liturgical color of that day. One round-trip per
  // week change; server is private-cached 1h.
  const [litByDate, setLitByDate]   = useState({})
  // Mass intentions scheduled in the visible week (MI.3). Read from the
  // same manifest the sacristy sheet prints, so the schedule and the
  // printed week can never disagree. Failure is a banner, not an empty
  // week — UNKNOWN is not ZERO.
  const [intentions, setIntentions] = useState([])
  const [intentionsFailed, setIntentionsFailed] = useState(false)
  // Mobile day-list selection. Defaults to today when today is in the
  // visible week, else Monday. Recomputed when the visible week changes.
  const [selectedDayIndex, setSelectedDayIndex] = useState(0)
  const scrollRef = useRef(null)
  // Open(eventId): when we jump the week to a named Mass, the week-change
  // effect must select that Mass's day — not fall back to today/Monday.
  const pendingSelectDate = useRef(null)
  const eventResolveGen = useRef(0)
  const { canWrite, user } = useAuth()
  // SP-021: intentions and groups are not in the Viewer's role table.
  const isViewer = user?.role === 'viewer'
  const { t, dateLocale } = useLocale()
  const toast = useToast()
  const ask = useConfirm()
  const navigate = useNavigate()

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const weekEnd  = weekDays[6]
  const today    = new Date(); today.setHours(0, 0, 0, 0)

  // Scroll to 7am on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [])

  const load = async () => {
    setLoadingWeek(true)
    try {
      const start = toDateStr(weekStart)
      const end   = toDateStr(weekEnd)
      const res   = await fetch(apiUrl(`/api/calendar?start=${start}&end=${end}`))
      if (!res.ok) throw new Error()
      setEvents(await res.json())
    } catch {
      // Never fail silently — a quiet week and a failed load must not
      // look identical.
      toast.error(t('sched.weekOpenFailed'))
    } finally {
      setLoadingWeek(false)
    }
  }

  useEffect(() => { load() }, [weekStart])

  // Pull the liturgical color for each day in the visible week. Refetch
  // when the user navigates weeks. /range merges DB feast-day overrides
  // with the algorithm-computed defaults.
  useEffect(() => {
    let cancelled = false
    const start = toDateStr(weekStart)
    const end   = toDateStr(weekEnd)
    fetch(apiUrl(`/api/liturgical/range?start=${start}&end=${end}`))
      .then(r => r.ok ? r.json() : {})
      .then(map => { if (!cancelled) setLitByDate(map ?? {}) })
      .catch(() => { if (!cancelled) setLitByDate({}) })
    return () => { cancelled = true }
  }, [weekStart])

  // Pull the week's scheduled Mass intentions alongside the events.
  const reloadIntentions = () => {
    const start = toDateStr(weekStart)
    const end   = toDateStr(weekEnd)
    setIntentionsFailed(false)
    if (isViewer) return Promise.resolve()
    return fetch(apiUrl(`/api/mass-intentions/weekly?start=${start}&end=${end}`))
      .then(async (r) => {
        if (!r.ok) throw new Error('weekly')
        return r.json()
      })
      .then(d => {
        setIntentions(Array.isArray(d.intentions) ? d.intentions : [])
        setIntentionsFailed(false)
      })
      .catch(() => { setIntentionsFailed(true) })
  }

  useEffect(() => {
    let cancelled = false
    const start = toDateStr(weekStart)
    const end   = toDateStr(weekEnd)
    setIntentionsFailed(false)
    setIntentions([])
    if (isViewer) return () => { cancelled = true }
    fetch(apiUrl(`/api/mass-intentions/weekly?start=${start}&end=${end}`))
      .then(async (r) => {
        if (!r.ok) throw new Error('weekly')
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        setIntentions(Array.isArray(d.intentions) ? d.intentions : [])
        setIntentionsFailed(false)
      })
      .catch(() => { if (!cancelled) setIntentionsFailed(true) })
    return () => { cancelled = true }
  }, [weekStart, isViewer])

  // Sync selected day to today when navigating weeks. If today isn't
  // in the visible week, fall back to Monday. Open(eventId) stashes the
  // Mass's date so a week jump lands on that day, not on today.
  useEffect(() => {
    if (pendingSelectDate.current) {
      const idx = dayIndexForEventDate(weekStart, pendingSelectDate.current)
      pendingSelectDate.current = null
      if (idx != null) {
        setSelectedDayIndex(idx)
        return
      }
    }
    const t = new Date(); t.setHours(0, 0, 0, 0)
    const ms = t.getTime() - weekStart.getTime()
    const idx = Math.floor(ms / (24 * 60 * 60 * 1000))
    setSelectedDayIndex(idx >= 0 && idx < 7 ? idx : 0)
  }, [weekStart])

  // Load org members once for the assignment picker + EventBlock chips.
  // A bounded sample is enough here, so ask for the max (200) rather than
  // relying on the /api/clients endpoint's invisible safety cap.
  useEffect(() => {
    loadList(apiUrl('/api/clients?limit=200')).then(({ ok, data }) => {
      setMembers(data)
      setMembersFailed(!ok)
    })
  }, [])

  // Load groups once for the toolbar filter + the modal's group picker.
  useEffect(() => {
    if (isViewer) return
    // A refused, dropped or malformed groups read is not "no groups":
    // `r.ok ? r.json() : { groups: [] }` hid the toolbar filter and left the
    // modal's group picker with only "No group", as for a parish without
    // groups. The flag says so in both places.
    let cancelled = false
    fetch(apiUrl('/api/groups'))
      .then(r => {
        if (!r.ok) throw new Error(`groups ${r.status}`)
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        const list = d && typeof d === 'object' && !Array.isArray(d) ? d.groups : null
        if (!Array.isArray(list) || !list.every(g =>
          g && typeof g === 'object' && !Array.isArray(g)
          && Number.isInteger(g.id) && g.id > 0 && typeof g.name === 'string')) {
          throw new Error('groups: malformed')
        }
        setGroups(list)
        setGroupsFailed(false)
      })
      .catch(() => {
        if (cancelled) return
        setGroups([])
        setGroupsFailed(true)
      })
    return () => { cancelled = true }
  }, [isViewer])

  // Deep-link entry from the Groups page: /schedule?group=ID&new=1
  // pre-selects the group filter and (when new=1) opens the modal with
  // that group pre-filled. The intention book adds &date=YYYY-MM-DD so
  // the same modal opens on that day. We strip `new` from the URL
  // afterward so a refresh or back-nav doesn't keep re-opening the modal.
  // `date` and `return=intention` stay so a saved Mass can come back.
  // A named Mass (?event=) wins — do not also open New over the Mass
  // that was asked for.
  useEffect(() => {
    const g = searchParams.get('group')
    if (g) setGroupFilter(g)
    if (searchParams.get('new') === '1') {
      if (parseScheduleEventId(searchParams.get('event')) != null) {
        const next = new URLSearchParams(searchParams)
        next.delete('new')
        setSearchParams(next, { replace: true })
        return
      }
      const dateRaw = searchParams.get('date')
      const date = isCalendarDayParam(dateRaw) ? dateRaw : ''
      openNew(date, g || '')
      if (date) {
        const monday = weekStartForEventDate(date)
        if (monday) {
          pendingSelectDate.current = date
          const idx = dayIndexForEventDate(monday, date)
          setWeekStart(prev => (toDateStr(prev) === toDateStr(monday) ? prev : monday))
          if (idx != null) setSelectedDayIndex(idx)
        }
      }
      const next = new URLSearchParams(searchParams)
      next.delete('new')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const askedEventRaw = searchParams.get('event')

  const writeEventParam = (eventId) => {
    const next = withScheduleEventParam(searchParams, eventId)
    if (next.toString() === searchParams.toString()) return
    setSearchParams(next, { replace: true })
  }

  const clearEventParam = () => {
    if (!searchParams.has('event')) return
    const next = new URLSearchParams(searchParams)
    next.delete('event')
    setSearchParams(next, { replace: true })
  }

  const positionToEvent = (event) => {
    const monday = weekStartForEventDate(event?.date)
    if (!monday) return
    const dateStr = String(event.date).slice(0, 10)
    const idx = dayIndexForEventDate(monday, event.date)
    if (idx != null) setSelectedDayIndex(idx)
    setWeekStart(prev => {
      if (toDateStr(prev) === toDateStr(monday)) return prev
      pendingSelectDate.current = dateStr
      return monday
    })
  }

  const openEvent = (event) => {
    const id = parseScheduleEventId(event?.id)
    if (id == null) return
    positionToEvent(event)
    setModal(event)
    writeEventParam(id)
  }

  const closeEvent = () => {
    setModal(null)
    clearEventParam()
  }

  // Open(eventId): ?event=<positive-integer> is the source of truth for
  // which Mass is open. Resolve against the loaded week, or ask
  // GET /api/calendar/:id when the Mass sits outside this window.
  // Refuse — do not invent a Mass by title, date, or "today" — and take
  // the id off the URL so a refresh cannot claim a Mass that is not open.
  useEffect(() => {
    const askedId = parseScheduleEventId(askedEventRaw)
    if (searchParams.has('event') && askedId == null) {
      clearEventParam()
      return
    }
    if (askedId == null) return

    const found = findCalendarEventById(events, askedId)
    if (found) {
      eventResolveGen.current += 1
      positionToEvent(found)
      setModal(found)
      return
    }
    if (loadingWeek) return

    const gen = ++eventResolveGen.current
    let cancelled = false
    fetch(apiUrl(`/api/calendar/${askedId}`))
      .then(async (res) => {
        if (cancelled || gen !== eventResolveGen.current) return
        if (res.ok) {
          const ev = await res.json().catch(() => null)
          if (parseScheduleEventId(ev?.id) === askedId) {
            positionToEvent(ev)
            setModal(ev)
            return
          }
        }
        const next = new URLSearchParams(searchParams)
        next.delete('event')
        setSearchParams(next, { replace: true })
        if (res.status === 404) {
          toast.error(t('sched.massMissing'))
        } else {
          toast.error(t('sched.massOpenFailed'))
        }
      })
      .catch(() => {
        if (cancelled || gen !== eventResolveGen.current) return
        const next = new URLSearchParams(searchParams)
        next.delete('event')
        setSearchParams(next, { replace: true })
        toast.error(t('sched.massOpenFailed'))
      })
    return () => { cancelled = true }
    // askedEventRaw is the URL token; events/loadingWeek are the resolve inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedEventRaw, events, loadingWeek])

  const prevWeek = () => setWeekStart(d => addDays(d, -7))
  const nextWeek = () => setWeekStart(d => addDays(d, 7))
  const goToday  = () => setWeekStart(getMondayOf(new Date()))

  const openNew = (date = '', groupId = '') => {
    setPrefillDate(date)
    setPrefillGroup(groupId)
    setModal('new')
    clearEventParam()
  }

  // scope is undefined for a single-row save and 'following' when
  // the user clicked "Save & apply to following" on a recurring row.
  // POST creates ignore scope entirely.
  const handleSave = async (form, scope) => {
    const isEdit = modal !== 'new' && modal !== null
    const baseUrl = isEdit ? apiUrl(`/api/calendar/${modal.id}`) : apiUrl('/api/calendar')
    const url = isEdit && scope === 'following'
      ? `${baseUrl}?scope=following`
      : baseUrl
    // Don't ship `recurrence` on PATCH — the server ignores it on
    // updates, but sending it makes the request body misleading
    // about what we're asking for.
    const body = isEdit ? (() => { const { recurrence, ...rest } = form; return rest })() : form
    let res
    try {
      res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      toast.error(t('sched.saveLost'))
      return
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || t('sched.saveFailed', { status: res.status }))
      return // keep the modal open so the user can see their input + retry
    }
    // The intention book asked for a Mass on a day that had none.
    // Hand the new event back; do not leave the secretary on the week.
    if (!isEdit && isIntentionReturn(searchParams.get(RETURN_PARAM))) {
      const created = await res.json().catch(() => null)
      const id = parseScheduleEventId(created?.id)
      const date = calendarDay(created?.date) || calendarDay(form.date)
      if (id != null) {
        navigate(intentionResumeHref({
          eventId: id,
          date,
          nonce: searchParams.get(DRAFT_PARAM),
        }))
        return
      }
    }
    closeEvent()
    load()
  }

  // Scope is undefined for a single-occurrence delete and 'series'
  // when the user chose "Delete entire series" from the modal footer.
  const handleDelete = async (id, scope) => {
    // `recoverable` is what every other protected delete says, and events
    // are protected now — a series goes to the Archive as one entry, so
    // "removed" was true and is no longer the whole truth.
    const prompt = scope === 'series'
      ? { title: 'Delete the whole recurring series?', body: 'Every linked occurrence is removed, not just this one.', confirmLabel: 'Delete series', recoverable: true }
      : { title: 'Delete this scheduled event?', confirmLabel: 'Delete event', recoverable: true }
    if (!(await ask(prompt))) return
    const url = scope === 'series'
      ? apiUrl(`/api/calendar/${id}?scope=series`)
      : apiUrl(`/api/calendar/${id}`)
    let res
    try {
      res = await fetch(url, { method: 'DELETE' })
    } catch (err) {
      toast.error(t('sched.saveLost'))
      return
    }
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || t('sched.deleteFailed', { status: res.status }))
      return
    }
    closeEvent()
    load()
  }

  // Group filter is applied client-side: the week's events are already
  // loaded, so filtering in memory avoids an extra round-trip per filter
  // change. '' means "all groups".
  const visibleEvents = groupFilter
    ? events.filter(e => String(e.group_id ?? '') === groupFilter)
    : events

  const eventsOnDay = (day) =>
    visibleEvents.filter(e => e.date?.slice(0, 10) === toDateStr(day))

  // MI.3 lookups: intentions pinned to a specific Mass ride its tile;
  // dated-but-unassigned ones surface on the day itself so they aren't
  // invisible until someone assigns them.
  const intentionsForEvent = (ev) =>
    intentions.filter(mi => mi.calendar_event_id != null && String(mi.calendar_event_id) === String(ev.id))
  const unassignedIntentionsOnDay = (day) =>
    intentions.filter(mi => mi.calendar_event_id == null && mi.mass_date === toDateStr(day))

  // Week label
  const monthA = weekStart.toLocaleDateString(dateLocale, { month: 'short' })
  const monthB = weekEnd.toLocaleDateString(dateLocale, { month: 'short' })
  const yearA  = weekStart.getFullYear()
  const yearB  = weekEnd.getFullYear()
  const weekLabel = monthA === monthB
    ? `${monthA} ${weekStart.getDate()}–${weekEnd.getDate()}, ${yearA}`
    : yearA === yearB
      ? `${monthA} ${weekStart.getDate()} – ${monthB} ${weekEnd.getDate()}, ${yearA}`
      : `${monthA} ${weekStart.getDate()}, ${yearA} – ${monthB} ${weekEnd.getDate()}, ${yearB}`

  const returningToIntention = isIntentionReturn(searchParams.get(RETURN_PARAM))
  const intentionBackDate = isCalendarDayParam(searchParams.get('date') || '')
    ? searchParams.get('date')
    : ''
  const intentionDraftNonce = searchParams.get(DRAFT_PARAM)

  return (
    <PageWrapper className="flex flex-col h-full max-w-full">

      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between mb-5 gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">{t('sched.title')}</h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-0.5">{weekLabel}</p>
          {returningToIntention && (
            <Link
              to={intentionResumeHref({ date: intentionBackDate, nonce: intentionDraftNonce })}
              data-testid="back-to-intention"
              className="mt-1 inline-block text-xs font-semibold text-brass-700 dark:text-brass-300 hover:underline"
            >
              {t('sched.backIntention')}
            </Link>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Group filter — only shown once the org has groups. Narrows
              the visible week to a single ministry / committee. */}
          {groupsFailed && (
            <span role="status" className="text-[11px] text-amber-800 dark:text-amber-200">{t('sched.groupsLoadFailed')}</span>
          )}
          {groups.length > 0 && (
            <div className="relative flex items-center">
              <Users2 size={14} className="absolute left-2.5 text-ink-400 pointer-events-none" />
              <select
                value={groupFilter}
                onChange={e => setGroupFilter(e.target.value)}
                className="appearance-none pl-8 pr-7 py-2 text-xs font-semibold rounded-xl bg-parchment-50 dark:bg-ink-900 border border-parchment-300/60 dark:border-brass-900/30 text-ink-600 dark:text-parchment-200 focus:outline-none focus:ring-2 focus:ring-brass-400/40 cursor-pointer"
                title={t('sched.filterGroup')}
              >
                <option value="">{t('sched.allGroups')}</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}
          {/* Week nav */}
          <div className="flex items-center gap-1 bg-parchment-50 dark:bg-ink-900 border border-parchment-300/60 dark:border-brass-900/30 rounded-xl p-1">
            <button onClick={prevWeek} aria-label={t('sched.prevWeek')} className="tap-reach p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
              <ChevronLeft size={16} />
            </button>
            <button onClick={goToday} className="px-3 py-1 text-xs font-semibold text-ink-600 dark:text-parchment-200 hover:text-ink-900 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 rounded-lg transition-colors">
              {t('sched.today')}
            </button>
            <button onClick={nextWeek} aria-label={t('sched.nextWeek')} className="tap-reach p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
              <ChevronRight size={16} />
            </button>
          </div>
          {/* Sunday Packet — serving print already lives at /packet; this
              is the one-click hop from the week the secretary is looking at
              (Sunday of the visible Mon–Sun grid, same YYYY-MM-DD as
              SundayPacket.jsx). */}
          {/* SP-029: hidden for a Viewer unless the Viewer scope opens /packet. */}
          {(!isViewer || viewerMayOpen('/packet')) && <Link
            to={`/packet?date=${toDateStr(weekEnd)}&from=schedule`}
            className="flex items-center gap-2 px-3 py-2 text-sm font-semibold rounded-xl border border-parchment-300/60 dark:border-brass-900/30 text-ink-600 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors"
          >
            <Printer size={15} /> {t('plan.packet')}
          </Link>}
          {canWrite && (
            <button
              onClick={() => openNew()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 text-sm font-semibold shadow hover:opacity-90 transition-opacity"
            >
              <Plus size={15} /> {t('sched.addEvent')}
            </button>
          )}
        </div>
      </div>

      {/* Empty-week hint — appears when the week has nothing scheduled.
          Subtle inline banner rather than a big card so the calendar
          stays the primary surface (clickable day headers are still
          the primary write CTA for staff/admin). */}
      {loadingWeek && visibleEvents.length === 0 && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-parchment-100 dark:bg-ink-800/40 border border-parchment-300/60 dark:border-brass-900/30 text-sm text-ink-500 dark:text-parchment-300/70 italic">
          {t('sched.openingWeek')}
        </div>
      )}
      {!loadingWeek && visibleEvents.length === 0 && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-parchment-100 dark:bg-ink-800/40 border border-parchment-300/60 dark:border-brass-900/30 text-sm text-ink-600 dark:text-parchment-300">
          {groupFilter
            ? t('sched.weekEmptyGroup')
            : t('sched.weekEmpty')}
          {canWrite && !groupFilter && <span className="text-ink-500 dark:text-parchment-300/70"> {t('sched.weekEmptyHint')}</span>}
        </div>
      )}
      {intentionsFailed && (
        <div role="status" className="mb-4 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-900/40 text-sm text-amber-900 dark:text-amber-200">
          {t('sched.intentionsFailed')}
          <button
            type="button"
            onClick={reloadIntentions}
            className="ml-2 font-semibold underline hover:no-underline"
          >
            {t('sched.intentionsRetry')}
          </button>
        </div>
      )}

      {/* ── Calendar (desktop, ≥md) ── */}
      <div className="flex-1 bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden hidden md:flex flex-col">

        {/* Day headers */}
        <div className="flex border-b border-parchment-300/50 dark:border-brass-900/25 shrink-0">
          {/* Time gutter */}
          <div className="w-14 shrink-0" />
          {/* Day columns */}
          {weekDays.map((day, i) => {
            const isToday = isSameDay(day, today)
            return (
              <div
                key={i}
                className={`flex-1 min-w-0 px-2 py-3 text-center border-l border-parchment-300/50 dark:border-brass-900/25 transition-colors ${
                  canWrite ? 'cursor-pointer hover:bg-parchment-100 dark:hover:bg-ink-800/60' : ''
                }`}
                onClick={canWrite ? () => openNew(toDateStr(day)) : undefined}
                title={canWrite ? t('sched.addOnDay', { date: day.toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' }) }) : undefined}
              >
                <p className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">{day.toLocaleDateString(dateLocale, { weekday: 'short' })}</p>
                <div className={`text-sm font-bold mt-0.5 w-7 h-7 mx-auto flex items-center justify-center rounded-full transition-colors ${
                  isToday
                    ? 'bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900'
                    : 'text-ink-900 dark:text-parchment-50'
                }`}>
                  {day.getDate()}
                </div>
                {/* Dated-but-unassigned intentions for this day (MI.3) */}
                {unassignedIntentionsOnDay(day).length > 0 && (
                  <span
                    className="mt-0.5 inline-block text-[10px] font-semibold text-brass-700 dark:text-brass-300"
                    title={`${unassignedIntentionsOnDay(day).length} intention(s) awaiting a Mass:\n${unassignedIntentionsOnDay(day).map(mi => mi.formatted_intention || mi.intention).join('\n')}`}
                  >
                    <span className="font-display">†</span> {unassignedIntentionsOnDay(day).length}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        {/* Scrollable time grid */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="flex" style={{ height: HOUR_HEIGHT * HOURS.length }}>

            {/* Time labels */}
            <div className="w-14 shrink-0 relative">
              {HOURS.map(h => (
                <div
                  key={h}
                  className="absolute right-2 text-[10px] font-medium text-ink-500 dark:text-parchment-300/70 -translate-y-2.5"
                  style={{ top: (h - START_HOUR) * HOUR_HEIGHT }}
                >
                  {h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`}
                </div>
              ))}
            </div>

            {/* Day columns */}
            {weekDays.map((day, i) => {
              const isToday = isSameDay(day, today)
              const dayEvents = eventsOnDay(day)

              return (
                <div
                  key={i}
                  className={`flex-1 min-w-0 relative border-l border-parchment-300/50 dark:border-brass-900/25 ${
                    isToday ? 'bg-brass-50/40 dark:bg-brass-500/[0.05]' : ''
                  }`}
                >
                  {/* Hour lines */}
                  {HOURS.map(h => (
                    <div
                      key={h}
                      className="absolute left-0 right-0 border-t border-parchment-300/50 dark:border-brass-900/20"
                      style={{ top: (h - START_HOUR) * HOUR_HEIGHT }}
                    />
                  ))}

                  {/* Half-hour lines (subtler) */}
                  {HOURS.map(h => (
                    <div
                      key={`half-${h}`}
                      className="absolute left-0 right-0 border-t border-parchment-200/40 dark:border-brass-900/15"
                      style={{ top: (h - START_HOUR) * HOUR_HEIGHT + HOUR_HEIGHT / 2 }}
                    />
                  ))}

                  {/* Current time line */}
                  {isToday && <NowLine />}

                  {/* Events */}
                  <AnimatePresence>
                    {dayEvents.map(ev => (
                      <EventBlock
                        key={ev.id}
                        event={ev}
                        members={members}
                        litColor={litByDate[ev.date]?.color}
                        intentions={intentionsForEvent(ev)}
                        onClick={openEvent}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Mobile day-list (<md) ── */}
      <div className="md:hidden flex-1 bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden flex flex-col">
        {/* Day picker — pill row, current day highlighted, dot when day has events */}
        <div className="flex border-b border-parchment-300/50 dark:border-brass-900/25 shrink-0">
          {weekDays.map((day, i) => {
            const isSelected = i === selectedDayIndex
            const isToday    = isSameDay(day, today)
            const dayCount   = eventsOnDay(day).length
            return (
              <button
                key={i}
                onClick={() => setSelectedDayIndex(i)}
                className={`flex-1 min-w-0 px-1 py-2.5 text-center transition-colors ${
                  isSelected
                    ? 'bg-church-900 dark:bg-parchment-100'
                    : 'hover:bg-parchment-100 dark:hover:bg-ink-800/60'
                }`}
              >
                <p className={`text-[10px] font-semibold uppercase tracking-wider ${
                  isSelected
                    ? 'text-parchment-50/90 dark:text-church-900/80'
                    : 'text-ink-500 dark:text-parchment-300/70'
                }`}>{day.toLocaleDateString(dateLocale, { weekday: 'short' })}</p>
                <p className={`text-base font-bold mt-0.5 ${
                  isSelected
                    ? 'text-parchment-50 dark:text-church-900'
                    : isToday
                      ? 'text-church-900 dark:text-parchment-50'
                      : 'text-ink-700 dark:text-parchment-200'
                }`}>{day.getDate()}</p>
                <span className={`inline-block w-1.5 h-1.5 rounded-full mt-0.5 ${
                  dayCount > 0
                    ? (isSelected ? 'bg-parchment-50 dark:bg-church-900' : 'bg-church-700 dark:bg-brass-400')
                    : 'bg-transparent'
                }`} />
              </button>
            )
          })}
        </div>

        {/* Events for the selected day */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {(() => {
            const day = weekDays[selectedDayIndex]
            const dayEvents = eventsOnDay(day)
              .slice()
              .sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time))
            if (dayEvents.length === 0) {
              return (
                <div className="text-center py-12 text-sm text-ink-500 dark:text-parchment-300/70">
                  <p>{t('sched.dayEmpty', { date: day.toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' }) })}</p>
                  {canWrite && (
                    <button
                      onClick={() => openNew(toDateStr(day))}
                      className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 text-xs font-semibold"
                    >
                      <Plus size={14} /> {t('sched.dayAdd')}
                    </button>
                  )}
                </div>
              )
            }
            return (
              <>
                {/* Dated-but-unassigned intentions for the selected day (MI.3) */}
                {unassignedIntentionsOnDay(day).length > 0 && (
                  <Link
                    to={`/mass-intentions?date=${toDateStr(day)}`}
                    className="block px-3 py-2 rounded-lg border border-brass-200/70 dark:border-brass-800/40 bg-brass-50 dark:bg-brass-900/20 text-xs text-brass-700 dark:text-brass-300"
                  >
                    <span className="font-display">†</span>{' '}
                    {(unassignedIntentionsOnDay(day)[0].formatted_intention || unassignedIntentionsOnDay(day)[0].intention)}
                    {unassignedIntentionsOnDay(day).length > 1 ? ` +${unassignedIntentionsOnDay(day).length - 1} more` : ''}
                    <span className="block mt-0.5 text-[10px] opacity-80">{t('sched.awaitingDay')}</span>
                  </Link>
                )}
                {dayEvents.map(ev => (
                  <MobileEventCard
                    key={ev.id}
                    event={ev}
                    members={members}
                    litColor={litByDate[ev.date]?.color}
                    intentions={intentionsForEvent(ev)}
                    onClick={openEvent}
                  />
                ))}
              </>
            )
          })()}
        </div>
      </div>

      {/* Modal */}
      <AnimatePresence>
        {modal && (
          <EventModal
            key={modal === 'new' ? 'new' : modal.id}
            event={modal === 'new'
              ? (prefillDate || prefillGroup ? { ...EMPTY_FORM, date: prefillDate, group_id: prefillGroup } : null)
              : modal}
            members={members}
            membersFailed={membersFailed}
            groups={groups}
            groupsFailed={groupsFailed}
            intentions={modal !== 'new' && modal ? intentionsForEvent(modal) : []}
            intentionsFailed={intentionsFailed}
            onIntentionsChanged={reloadIntentions}
            onClose={closeEvent}
            onSave={handleSave}
            onDelete={handleDelete}
          />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}
