import { useEffect, useId, useState, useCallback, useMemo, useRef } from 'react'
import { Flame, Plus, X, Pencil, Loader2, Search, Printer } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import RequesterMemberLink from '../components/RequesterMemberLink'
import EmptyState from '../components/EmptyState'
import { useToast } from '../components/ToastProvider'
import { useConfirm } from '../components/ConfirmProvider'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { calendarDay, formatParishDay, formatStoredDate } from '../utils/dates'
import { loadList } from '../utils/format'
import { scheduleEventHref, scheduleNewMassHref } from './Schedule'
import {
  INTENTION_DRAFT_KEY,
  stashIntentionDraft,
  peekIntentionDraft,
  takeIntentionDraft,
  draftMatchesResume,
  isIntentionDraftNonce,
  newIntentionDraftNonce,
} from '../utils/intentionDraft'
import { groupAssignableEntries, isMassCalendarEvent } from '../utils/massEvent'
import { priorFulfilmentText } from '../utils/priorFulfilment'
import { canonicalIntentionId, defaultSaidDate, intentionMayBeMarkedSaid, linkedMassId, newMarkRequestId, parishTodayIso, readMarkSaidResponse, readUndoResponse, saidRowFuture } from '../utils/markSaid'
import { thisSundayPair } from '../../../server/src/utils/sheetWeek.js'

export { isMassCalendarEvent, groupAssignableEntries }

// Mass Intentions (MI.1) — the parish book of requested Mass intentions.
// Reads GET /api/mass-intentions (status filter + keyword search, paginated);
// staff/admin can add / edit / delete.

const STATUSES = ['open', 'scheduled', 'fulfilled', 'cancelled']
// Parchment & Brass: status is a fact, not a traffic light. Fulfilled
// earns the brass; everything else sits quietly in parchment and ink.
const STATUS_CLS = {
  open:      'bg-parchment-200/80 text-ink-700 dark:bg-ink-800 dark:text-parchment-200',
  scheduled: 'bg-brass-50 text-brass-700 dark:bg-brass-900/20 dark:text-brass-300 border border-brass-200/70 dark:border-brass-800/40',
  fulfilled: 'bg-brass-100/70 text-brass-800 dark:bg-brass-900/30 dark:text-brass-200',
  cancelled: 'bg-parchment-100 text-ink-500 dark:bg-ink-800/60 dark:text-parchment-300/60',
}
const PAGE_SIZE = 50

// Dates for the This Sunday filter come from the server (parish clock).
// Only a real Saturday and the next civil day are a weekend. Anything
// else is unknown — the book does not invent one or treat it as empty.
export function readThisSundayWindow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return thisSundayPair(raw.saturday, raw.sunday)
}

// A Mass is named by ochr_calendar_events.id — never by title or date.
// The same gate as check-in's ?event= reader and Schedule's Open(eventId).
export function parseIntentionEventId(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isInteger(n) || n <= 0 || String(n) !== s) return null
  return n
}

// Read ?event=&date= from the Schedule hop. Only a positive integer event
// id and a YYYY-MM-DD date are accepted — labels never invent a Mass.
export function readIntentionBookContext(searchParams) {
  const eventRaw = searchParams?.get?.('event')
  const dateRaw = searchParams?.get?.('date')
  const parsed = parseIntentionEventId(eventRaw)
  const calendar_event_id = parsed != null ? String(parsed) : ''
  const mass_date = (dateRaw != null && /^\d{4}-\d{2}-\d{2}$/.test(String(dateRaw))) ? String(dateRaw) : ''
  return { calendar_event_id, mass_date, hasContext: Boolean(calendar_event_id || mass_date) }
}

// SP-073 (MIN-32): lead with the localized weekday so a Monday-dated
// "Sunday Mass" cannot read as next Sunday. The day is the stored civil
// day (formatParishDay), never a UTC slice re-read in the browser zone.
export function formatMassOptionLabel(m, dateLocale, timeZone) {
  if (!m) return ''
  const date = formatParishDay(m.date, dateLocale || 'en-US', timeZone)
  const time = m.start_time ? ` (${String(m.start_time).slice(0, 5)})` : ''
  const title = m.title || ''
  if (!date && !title && !time) return ''
  return date ? `${date} — ${title}${time}` : `${title}${time}`
}

// Masses whose stored calendar day is `day` (YYYY-MM-DD). A DATE column
// compared as text — not the browser's local reinterpretation of an instant.
export function massesOnLocalDay(masses, day) {
  if (!day || !Array.isArray(masses)) return []
  return masses.filter(m => isMassCalendarEvent(m) && calendarDay(m?.date) === day)
}

// True when the secretary typed a day and the assigned Mass is a different day.
// The save must stop: the server would keep the Mass and overwrite the typed day.
export function intentionDateConflicts(enteredDay, massDay) {
  return Boolean(enteredDay) && Boolean(massDay) && enteredDay !== massDay
}

// An assigned id whose day is not in any loaded list must not be saved.
// Sending it would let the server replace the typed day with the Mass day.
export function assignedMassDayUnknown(eventId, massDay) {
  return parseIntentionEventId(eventId) != null && !massDay
}

function findMassById(id, pools) {
  const n = parseIntentionEventId(id)
  if (n == null) return null
  for (const pool of pools) {
    const list = Array.isArray(pool) ? pool : (pool ? [pool] : [])
    const found = list.find(m => parseIntentionEventId(m?.id) === n)
    if (found) return found
  }
  return null
}

export function formatMassChromeParts(m, dateLocale = 'en-US', timeZone) {
  if (!m) return null
  const date = m.date ? formatParishDay(m.date, dateLocale, timeZone) : ''
  const time = m.start_time ? String(m.start_time).slice(0, 5) : ''
  return { title: m.title || '', date, time }
}

export function withHeldMassOptions(masses, extras) {
  const list = Array.isArray(masses) ? [...masses] : []
  const extraList = Array.isArray(extras) ? extras : [extras]
  for (const extra of extraList) {
    if (extra && extra.id != null && !list.some(m => String(m.id) === String(extra.id))) {
      list.unshift(extra)
    }
  }
  return list
}

export function massesIncludeId(masses, id) {
  const n = parseIntentionEventId(id)
  if (n == null || !Array.isArray(masses)) return false
  return masses.some(m => parseIntentionEventId(m?.id) === n)
}

// Fetch one Mass by the id another surface is already holding.
// 404 and "not yours" are the same answer from GET /api/calendar/:id.
// A wrong-shaped 200 is not a Mass — do not invent one from title or date.
export async function fetchCalendarEventById(id) {
  const n = parseIntentionEventId(id)
  if (n == null) return { status: 'invalid' }
  try {
    const res = await fetch(apiUrl(`/api/calendar/${n}`))
    if (res.ok) {
      const ev = await res.json().catch(() => null)
      if (ev && parseIntentionEventId(ev.id) === n) return { status: 'ok', event: ev }
      return { status: 'failed' }
    }
    if (res.status === 404) return { status: 'missing' }
    return { status: 'failed' }
  } catch {
    return { status: 'failed' }
  }
}

const emptyForm = { intention: '', requested_by: '', requested_by_client_id: null, requester_name: '', mass_date: '', stipend: '', received_date: '', payment_method: 'cash', status: 'open', note: '', calendar_event_id: '', departed: false }
const PAYMENT_METHODS = ['cash', 'check', 'card', 'other']

// The book → Schedule → book hop. The in-progress intention stays in
// this tab only, never on the URL. StrictMode remounts effects; peek
// does not consume, and the page removes the draft after it has applied.
// Tests import these from the page; the nonce and expiry live in the util.
export {
  INTENTION_DRAFT_KEY,
  INTENTION_DRAFT_TTL_MS,
  stashIntentionDraft,
  peekIntentionDraft,
  takeIntentionDraft,
  clearIntentionDraft,
  draftMatchesResume,
  isIntentionDraftNonce,
  newIntentionDraftNonce,
} from '../utils/intentionDraft'

// ── The traditional † for the departed ───────────────────────
// The dagger is stored in the intention text itself, so every consumer
// (this table, the printed sacristy sheet, exports) carries it without
// schema changes. A hand-typed "+" from older entries or habit is
// normalized to the proper † on save and on display.
const DAGGER = '†'
const hasDeathMark = t => /^\s*[†+]/.test(t || '')
const stripDeathMark = t => (t || '').replace(/^\s*[†+]\s*/, '')
export const displayIntention = t => hasDeathMark(t) ? `${DAGGER} ${stripDeathMark(t)}` : t

function fmtStipend(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : null
}

// SP-057: phone layout. Same breakpoint as the app shell (App.jsx POL.4).
// Only one layout is in the DOM at a time, so each row's controls exist
// once. No matchMedia (old browsers, jsdom) → the desktop table.
const PHONE_MQ = '(max-width: 767px)'
function usePhoneLayout() {
  const mq = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_MQ) : null)
  const [phone, setPhone] = useState(() => !!mq()?.matches)
  useEffect(() => {
    const m = mq()
    if (!m) return
    const onChange = e => setPhone(!!e.matches)
    setPhone(!!m.matches)
    m.addEventListener?.('change', onChange)
    return () => m.removeEventListener?.('change', onChange)
  }, [])
  return phone
}

// SP-057: the row cells shared by the table and the phone cards, so the
// fulfilled-unknown and prior-fulfilment branches cannot diverge.
export function IntentionMassCell({ r, t, dateLocale }) {
  if (r.status === 'fulfilled' && !r.mass_date && !r.mass_title) {
    return (
      <span className="block text-[11px] italic text-ink-400 dark:text-parchment-400/60">
        {t('mi.massAsOfferedUnknown')}
      </span>
    )
  }
  return (
    <>
      {r.mass_date ? formatParishDay(r.mass_date, dateLocale) : (
        // SP-121: an intention with no Mass date said only "—"; say so plainly.
        <span className="italic text-ink-500 dark:text-parchment-300/70">{t('mi.noDateSet')}</span>
      )}
      {r.mass_title && (
        <span className="block text-[11px] text-ink-400 dark:text-parchment-400/60">
          {r.mass_title}{r.mass_time ? ` · ${r.mass_time}` : ''}
        </span>
      )}
    </>
  )
}
function IntentionTextCell({ r }) {
  return (
    <>
      {displayIntention(r.intention)}
      {r.note && <span className="block text-[11px] font-normal text-ink-500 dark:text-parchment-300/70">{r.note}</span>}
    </>
  )
}
const requesterText = r => r.requester_name || r.requested_by || '—'
function IntentionStatusCell({ r, t, dateLocale }) {
  return (
    <>
      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_CLS[r.status] || ''}`}>
        {STATUSES.includes(r.status) ? t(`mi.${r.status}`) : r.status}
      </span>
      {/* SP-064 (MIN-28): server-computed on the parish clock. A reminder
          that no fulfilment is recorded yet — never "missed", never "said". */}
      {r.past_scheduled === true && (
        <span data-testid="mi-past-scheduled" className="block mt-1 text-[11px] font-medium text-amber-800 dark:text-amber-300">
          {t('mi.pastScheduled')}
        </span>
      )}
      {/* SP-183: the said day (fulfilment stamp) is shown with the status. */}
      {r.status === 'fulfilled' && (
        <span data-testid="mi-said-on" className="block mt-1 text-[11px] text-ink-600 dark:text-parchment-300/80">
          {r.mass_date ? t('mi.saidOn', { date: formatParishDay(r.mass_date, dateLocale) }) : t('mi.saidDateUnknown')}
        </span>
      )}
      {r.voided_at != null && (
        <span data-testid="mi-voided" className="block mt-1 text-[11px] font-medium text-rose-800 dark:text-rose-300">
          {t('mi.voided')}
        </span>
      )}
      {priorFulfilmentText(t, r, 'mi.previouslyRecorded') && (
        <span className="block mt-1 text-[11px] italic text-ink-500 dark:text-parchment-300/70">
          {priorFulfilmentText(t, r, 'mi.previouslyRecorded')}
        </span>
      )}
    </>
  )
}
// Decision 8 (2026-10-19): fulfilled, previously recorded, or voided rows
// are parish history. The server refuses their delete; the book does not
// offer it. Correction and void are admin actions with a reason.
export function isIntentionHistory(r) {
  // R339-1: the server's durable latch first; the rest covers older payloads.
  return r?.entered_history === true || r?.status === 'fulfilled' || Boolean(r?.fulfilment_label) || r?.voided_at != null
}
// SP-133 (2026-10-23): once an offering amount is recorded (0.00 included;
// null means none), no role may delete the intention. The server also
// refuses rows whose amount was cleared earlier; this only hides the button.
export function hasRecordedOffering(r) {
  return r?.stipend !== null && r?.stipend !== undefined && r?.stipend !== ''
}
function exclusionSentence(t, code) {
  switch (code) {
    case 'already_fulfilled': return t('mi.markSaidAlready')
    case 'already_recorded': return t('mi.markSaidRecorded')
    case 'needs_date': return t('mi.markSaidNeedsDate')
    case 'not_found': return t('mi.markSaidNotInBook')
    case 'voided': return t('mi.markSaidVoided')
    case 'cancelled': return t('mi.markSaidCancelled')
    case 'conflict': return t('mi.markSaidConflict')
    case 'history_locked': return t('mi.markSaidHistory')
    case 'future_mass': return t('mi.markSaidFuture')
    default: return t('mi.markSaidConflict')
  }
}

// SP-160: an undated row, or one whose day or Mass is still ahead, is left out.
function saidRowReady(row, todayIso) {
  if (!(Boolean(row.date) || row.linked)) return false
  if (!row.date && !row.massDay) return false
  return !saidRowFuture(row, todayIso)
}

function IntentionRowActions({ r, t, onEdit, onRemove, isAdmin, onVoid, onDisposition }) {
  const openStipend = Number(r?.open_stipend_liability || 0) > 0
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => onEdit(r)} aria-label={t('mi.edit')}
        className="text-ink-400 hover:text-church-700 dark:hover:text-brass-300"><Pencil size={14} /></button>
      {!isIntentionHistory(r) && !hasRecordedOffering(r) && <button type="button" onClick={() => onRemove(r.id)} aria-label={t('mi.delete')}
        className="text-ink-400 hover:text-rose-700 dark:hover:text-rose-300"><X size={15} /></button>}
      {/* N449-3: fulfilled + held 2330 cannot void (deferred remittance / SP-268). */}
      {isAdmin && r.voided_at == null && !(r.status === 'fulfilled' && openStipend) && (
        <button type="button" data-testid="mi-void" onClick={() => onVoid?.(r)}
          className="text-[11px] font-semibold text-rose-800 dark:text-rose-300 hover:underline">
          {t('mi.void')}
        </button>
      )}
      {/* D449-4 P3 / F468-1: disposition is only for Masses not said.
          Fulfilled, fulfilment_label, or void-correction was_fulfilled hide it. */}
      {isAdmin && r.voided_at != null && openStipend && r.status !== 'fulfilled' && !r.fulfilment_label && r.was_fulfilled !== true && (
        <button type="button" data-testid="mi-disposition" onClick={() => onDisposition?.(r)}
          className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 hover:underline">
          {t('mi.dispositionConfirm')}
        </button>
      )}
    </div>
  )
}

export default function MassIntentions() {
  const { user } = useAuth()
  const { t, dateLocale } = useLocale()
  const parishTz = user?.organization?.timezone
  const saidToday = parishTodayIso(parishTz)
  const toast = useToast()
  const ask = useConfirm()
  const phone = usePhoneLayout()
  const canWrite = user?.role === 'admin' || user?.role === 'staff'
  const isAdmin = user?.role === 'admin'
  // D-1. The chosen ids live only in this visit. Refreshing the book
  // drops the selection and the undo, which is the session boundary.
  const [selected, setSelected] = useState(() => new Set())
  const [review, setReview] = useState(null)
  const [markResult, setMarkResult] = useState(null)
  const [markError, setMarkError] = useState(null)
  const [markBusy, setMarkBusy] = useState(false)
  const [undoOpen, setUndoOpen] = useState(false)

  const [list,    setList]    = useState([])
  const [status,  setStatus]  = useState('')
  const [pastOnly, setPastOnly] = useState(false)
  const [thisSunday, setThisSunday] = useState(false)
  const [weekend, setWeekend] = useState(null)
  const [q,       setQ]       = useState('')
  const [loading, setLoading] = useState(true)
  const [more,    setMore]    = useState(false)
  const [done,    setDone]    = useState(false)
  const [error,   setError]   = useState(null)
  // A failed read is not an empty book. Kept apart from the form's `error`
  // so opening Add cannot clear it and reveal "No Mass intentions yet".
  const [loadError, setLoadError] = useState(null)

  const [adding,   setAdding]   = useState(false)
  const [masses,   setMasses]   = useState(null) // upcoming calendar events; lazy-fetched on first form open
  const [massesFailed, setMassesFailed] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form,     setForm]     = useState(emptyForm)
  const [busy,     setBusy]     = useState(false)
  const [stipendAction, setStipendAction] = useState(null) // { mode, row }
  const [stipendBusy, setStipendBusy] = useState(false)
  const [stipendErr, setStipendErr] = useState(null)
  const [voidForm, setVoidForm] = useState({ reason: '', kind: 'refunded', dispositionReason: '', transferTo: '' })
  const [searchParams, setSearchParams] = useSearchParams()
  // SP-185: the Dashboard's after-Mass prompt opens the book on this filter.
  const pastViewParam = searchParams.get('view') === 'past_scheduled'
  useEffect(() => { if (pastViewParam) setPastOnly(true) }, [pastViewParam])
  // SP-185: ⌘K deep-link seeds the book search from ?q= once.
  useEffect(() => {
    const fromUrl = searchParams.get('q')
    if (fromUrl != null && fromUrl !== '') setQ(fromUrl)
    // Intentionally once on mount for this entry URL — do not fight typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Exact Mass context lives on the URL (?event=), not in React state.
  // Refresh / direct entry keep "Back to this Mass" from the same parser.
  const { calendar_event_id: hopMassId } = readIntentionBookContext(searchParams)
  const backHref = hopMassId ? scheduleEventHref(hopMassId) : '/schedule'
  // A Mass named in ?event= or held on the form that sits outside the
  // 60-day window. Resolved by GET /api/calendar/:id — never invented
  // from the hop title or date. UNKNOWN is not "Not assigned".
  const [hopMass, setHopMass] = useState(null)
  const [hopMassStatus, setHopMassStatus] = useState(hopMassId ? 'loading' : 'idle')
  const [heldMass, setHeldMass] = useState(null)
  const [heldMassStatus, setHeldMassStatus] = useState('idle')
  // Masses on the chosen calendar day. null = that day's lookup has not
  // landed. Kept apart from the 60-day window so a date outside it is
  // not reported as "no Mass".
  const [dayMasses, setDayMasses] = useState(null)
  const [dayMassesFailed, setDayMassesFailed] = useState(false)
  const [dayMassesFor, setDayMassesFor] = useState('')
  const hopResolveGen = useRef(0)
  const heldResolveGen = useRef(0)
  const editBaselineRef = useRef(null)
  const draftNonceRef = useRef('')
  // compose=1 may name a meeting. Hold that id until the row is loaded,
  // then drop it so the new intention is not pre-selected onto a meeting.
  const composePrefillRef = useRef(null)
  const formId = useId().replace(/:/g, '')
  // The weekend already accepted for this filter. Later pages and the
  // sheet link use these dates, so parish midnight cannot move them.
  const acceptedWeekendRef = useRef(null)

  const fetchPage = useCallback(async (offset, st, query, past, sunday, anchor) => {
    const unreadMessage = t('mi.loadFailed')
    const unread = () => new Error(unreadMessage)
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
      if (st) qs.set('status', st)
      if (query) qs.set('q', query)
      // SP-064: filtered by the server before pagination, never client-side.
      if (past) qs.set('view', 'past_scheduled')
      // D-2: the parish clock chooses the first weekend. Once accepted,
      // saturday and sunday pin every later read to that pair.
      if (sunday) qs.set('weekend', 'this_sunday')
      if (sunday && anchor) {
        qs.set('saturday', anchor.saturday)
        qs.set('sunday', anchor.sunday)
      }
      const res = await fetch(apiUrl(`/api/mass-intentions?${qs.toString()}`))
      if (!res.ok) throw unread()
      const d = await res.json()
      // Missing or non-array `intentions` is unread. `?? []` rendered that
      // as an empty book, including after a save whose reload came back wrong.
      if (!d || !Array.isArray(d.intentions)) throw unread()
      if (!sunday) return { intentions: d.intentions, weekend: null }
      const window = readThisSundayWindow(d.weekend)
      // A missing, impossible, or non-adjacent window is unread. Hiding
      // the dates must not leave the rows looking like a verified weekend.
      if (!window) throw unread()
      if (anchor && (window.saturday !== anchor.saturday || window.sunday !== anchor.sunday)) throw unread()
      return { intentions: d.intentions, weekend: window }
    } catch (err) {
      if (err instanceof Error && err.message === unreadMessage) throw err
      throw unread()
    }
  }, [t])

  // R313-1: one ownership rule for every list-result writer (first page,
  // Load more, save reload). queryGen moves when status/search/view changes
  // or the page unmounts; listGen moves whenever the list is replaced. A
  // reader may commit rows, done, loadError or its spinner only while BOTH
  // still match what it captured, so an older read's success, failure or
  // completion can never land on the current query or a newer list.
  const queryGenRef = useRef(0)
  const listGenRef = useRef(0)
  const claimList = ({ replace }) => {
    if (replace) listGenRef.current += 1
    const qg = queryGenRef.current, lg = listGenRef.current
    return () => queryGenRef.current === qg && listGenRef.current === lg
  }

  useEffect(() => {
    queryGenRef.current += 1
    const qg = queryGenRef.current
    const live = claimList({ replace: true })
    setLoading(true); setError(null); setDone(false); setLoadError(null); setMore(false)
    if (!thisSunday) {
      acceptedWeekendRef.current = null
      setWeekend(null)
    }
    const timer = setTimeout(() => {
      const anchor = thisSunday ? acceptedWeekendRef.current : null
      fetchPage(0, status, q.trim(), pastOnly, thisSunday, anchor)
        .then(page => {
          if (!live()) return
          if (thisSunday) acceptedWeekendRef.current = page.weekend
          setList(page.intentions)
          setWeekend(thisSunday ? page.weekend : null)
          setDone(page.intentions.length < PAGE_SIZE)
          setLoadError(null)
        })
        .catch(err => {
          // The rows on screen belong to the previous filters; keeping them
          // under a failed read would present them as matching the new one.
          // An already accepted weekend stays the sheet's target.
          if (!live()) return
          setList([])
          if (!acceptedWeekendRef.current) setWeekend(null)
          setLoadError(err.message)
        })
        // A same-query save reload may have replaced the list meanwhile; the
        // spinner still belongs to this query's first read.
        .finally(() => { if (queryGenRef.current === qg) setLoading(false) })
    }, 250)
    return () => { queryGenRef.current += 1; clearTimeout(timer) }
    // claimList only touches refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, q, pastOnly, thisSunday, fetchPage])

  const loadMore = async () => {
    const live = claimList({ replace: false })
    setMore(true); setLoadError(null)
    try {
      const page = await fetchPage(list.length, status, q.trim(), pastOnly, thisSunday, acceptedWeekendRef.current)
      if (!live()) return
      setList(prev => [...prev, ...page.intentions])
      if (page.intentions.length < PAGE_SIZE) setDone(true)
    } catch (err) { if (live()) setLoadError(err.message) } finally { if (live()) setMore(false) }
  }

  // Upcoming events for the "Assign to Mass" dropdown — next 60 days,
  // fetched once per page visit, only when a form is actually opened.
  // A hop or past Mass outside this window is resolved separately by
  // GET /api/calendar/:id below. Widening the window is not enough.
  const loadMasses = useCallback(() => {
    // Retry on a later form open if the last attempt failed — an empty
    // dropdown must not become the permanent answer because of one 500.
    if (masses !== null && !massesFailed) return
    const pad = n => String(n).padStart(2, '0')
    const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const today = new Date()
    const end = new Date(today); end.setDate(end.getDate() + 60)
    loadList(apiUrl(`/api/calendar?start=${iso(today)}&end=${iso(end)}`)).then(({ ok, data }) => {
      setMasses(data)
      setMassesFailed(!ok)
    })
  }, [masses, massesFailed])

  // Chrome: when durable ?event=<id> is present, resolve THAT Mass so the
  // book can name it. Refresh keeps the token; the generic title alone
  // would look unassigned. 404/cross-org is honest unknown — do not
  // invent from ?date= or strip the id without a human action.
  useEffect(() => {
    if (!hopMassId) {
      hopResolveGen.current += 1
      setHopMass(null)
      setHopMassStatus('idle')
      return
    }
    const gen = ++hopResolveGen.current
    setHopMass(null)
    setHopMassStatus('loading')
    fetchCalendarEventById(hopMassId).then((result) => {
      if (gen !== hopResolveGen.current) return
      if (result.status === 'ok') {
        setHopMass(result.event)
        setHopMassStatus('ok')
        const prefill = composePrefillRef.current
        if (prefill != null && !isMassCalendarEvent(result.event)
            && parseIntentionEventId(prefill) === parseIntentionEventId(result.event.id)) {
          composePrefillRef.current = null
          setForm(f => (
            parseIntentionEventId(f.calendar_event_id) === parseIntentionEventId(result.event.id)
              ? { ...f, calendar_event_id: '' }
              : f
          ))
        }
        return
      }
      setHopMass(null)
      setHopMassStatus(result.status === 'missing' ? 'missing' : 'failed')
    })
  }, [hopMassId])

  // Dropdown honesty: a held id that is not in the 60-day list must still
  // have an <option>. Without one the browser paints "Not assigned" while
  // the form still holds the id — the secretary may then pick another Mass.
  useEffect(() => {
    if (!adding) {
      heldResolveGen.current += 1
      setHeldMass(null)
      setHeldMassStatus('idle')
      return
    }
    const heldId = parseIntentionEventId(form.calendar_event_id)
    if (heldId == null) {
      heldResolveGen.current += 1
      setHeldMass(null)
      setHeldMassStatus('idle')
      return
    }
    if (massesIncludeId(masses, heldId) || (hopMass && parseIntentionEventId(hopMass.id) === heldId)) {
      heldResolveGen.current += 1
      setHeldMass(hopMass && parseIntentionEventId(hopMass.id) === heldId ? hopMass : null)
      setHeldMassStatus('ok')
      return
    }
    const gen = ++heldResolveGen.current
    setHeldMass(null)
    setHeldMassStatus('loading')
    fetchCalendarEventById(heldId).then((result) => {
      if (gen !== heldResolveGen.current) return
      if (result.status === 'ok') {
        setHeldMass(result.event)
        setHeldMassStatus('ok')
        return
      }
      setHeldMass(null)
      setHeldMassStatus(result.status === 'missing' ? 'missing' : 'failed')
    })
  }, [adding, form.calendar_event_id, masses, hopMass])

  const assignMasses = useMemo(() => {
    const windowMasses = Array.isArray(masses) ? masses : []
    const dayList = form.mass_date && Array.isArray(dayMasses) ? dayMasses : []
    const merged = form.mass_date
      ? massesOnLocalDay([...windowMasses, ...dayList], form.mass_date)
      : windowMasses
    const seen = new Set()
    const unique = []
    for (const m of merged) {
      const id = m?.id != null ? String(m.id) : ''
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      unique.push(m)
    }
    // The assigned Mass stays known after the day filter drops it, so a
    // typed day on another date can be named at save time.
    const knownAssigned = findMassById(form.calendar_event_id, [windowMasses, dayList, hopMass, heldMass])
    return withHeldMassOptions(unique, [hopMass, heldMass, knownAssigned])
  }, [masses, dayMasses, form.mass_date, form.calendar_event_id, hopMass, heldMass])
  const heldAssignId = parseIntentionEventId(form.calendar_event_id)
  const heldAssignInList = massesIncludeId(assignMasses, heldAssignId)
  const heldListedMass = heldAssignId == null ? null : assignMasses.find(m => parseIntentionEventId(m?.id) === heldAssignId) ?? null
  const heldAssignStatus = (() => {
    if (heldAssignId == null || heldAssignInList) return 'ok'
    if (hopMassId && String(hopMassId) === String(heldAssignId) && hopMassStatus !== 'idle') return hopMassStatus
    return heldMassStatus
  })()
  const hopChrome = hopMass ? formatMassChromeParts(hopMass, dateLocale, parishTz) : null
  const heldDay = calendarDay(heldListedMass?.date)
  const windowSameDay = form.mass_date ? massesOnLocalDay(masses, form.mass_date) : []
  const fetchedSameDay = dayMassesFor === form.mass_date && Array.isArray(dayMasses)
    ? massesOnLocalDay(dayMasses, form.mass_date)
    : []
  const dayQueryReady = Boolean(form.mass_date) && dayMassesFor === form.mass_date && dayMasses !== null
  const noMassOnDate = Boolean(form.mass_date) && dayQueryReady && !dayMassesFailed
    && windowSameDay.length === 0 && fetchedSameDay.length === 0
  const assignChoices = (form.mass_date
    ? massesOnLocalDay(assignMasses, form.mass_date)
    : assignMasses.filter(isMassCalendarEvent))
    .filter(m => parseIntentionEventId(m?.id) !== heldAssignId)
  const { primary: primaryAssign, other: otherAssign } = groupAssignableEntries(assignChoices)
  const dayLookupPending = Boolean(form.mass_date) && !dayQueryReady && windowSameDay.length === 0 && !dayMassesFailed
  const editBaseline = editBaselineRef.current
  const fieldsUnchanged = editBaseline != null
    && (form.mass_date || '') === (editBaseline.mass_date || '')
    && String(form.calendar_event_id || '') === String(editBaseline.calendar_event_id || '')
  const fulfilledFrozen = editingId != null && editBaseline?.status === 'fulfilled' && fieldsUnchanged
  // #285 F6: a fulfilled intention's offering and Mass are read-only; the
  // server refuses those edits too (fulfilled_offering_locked).
  const fulfilledLock = editingId != null && editBaseline?.status === 'fulfilled'
  const dateDisagrees = !fulfilledFrozen && intentionDateConflicts(form.mass_date, heldDay)
  if (noMassOnDate && !isIntentionDraftNonce(draftNonceRef.current)) {
    draftNonceRef.current = newIntentionDraftNonce()
  }
  const returnNonce = noMassOnDate ? draftNonceRef.current : ''
  const enteredLabel = form.mass_date ? formatParishDay(form.mass_date, dateLocale, parishTz) : ''
  const heldDayLabel = heldDay ? formatParishDay(heldDay, dateLocale, parishTz) : ''
  const massDateLabel = form.mass_date ? formatParishDay(form.mass_date, dateLocale, parishTz) : ''

  // The chosen day, including dates outside the next-60-days window.
  // Compared as the stored DATE, which is the parish calendar day.
  useEffect(() => {
    if (!adding || !/^\d{4}-\d{2}-\d{2}$/.test(form.mass_date || '')) return
    const day = form.mass_date
    let cancelled = false
    setDayMasses(null)
    setDayMassesFailed(false)
    setDayMassesFor('')
    loadList(apiUrl(`/api/calendar?start=${day}&end=${day}`)).then(({ ok, data }) => {
      if (cancelled) return
      setDayMassesFor(day)
      setDayMasses(ok ? data : [])
      setDayMassesFailed(!ok)
    })
    return () => { cancelled = true }
  }, [adding, form.mass_date])

  const onMassDateChange = (nextDate) => {
    setForm(f => ({ ...f, mass_date: nextDate }))
  }

  const closeForm = () => {
    takeIntentionDraft()
    editBaselineRef.current = null
    setAdding(false); setEditingId(null); setForm(emptyForm); setError(null)
  }
  const startAdd = () => {
    editBaselineRef.current = null
    setEditingId(null)
    setForm({ ...emptyForm, received_date: parishTodayIso(parishTz), payment_method: 'cash' })
    setAdding(true); setError(null); loadMasses()
  }

  // Schedule "Open the intention book" adds &compose=1 for a one-shot
  // form open. Durable ?event= (and optional ?date=) stay on the URL so
  // refresh / direct entry keep the Mass. Strip only compose.
  useEffect(() => {
    if (searchParams.get('resume')) return
    if (searchParams.get('compose') !== '1') return
    const { calendar_event_id, mass_date, hasContext } = readIntentionBookContext(searchParams)
    const next = new URLSearchParams(searchParams)
    next.delete('compose')
    setSearchParams(next, { replace: true })
    if (!hasContext || !canWrite) return
    composePrefillRef.current = calendar_event_id || null
    setEditingId(null)
    setForm({ ...emptyForm, calendar_event_id, mass_date, received_date: parishTodayIso(parishTz), payment_method: 'cash' })
    setAdding(true)
    setError(null)
    loadMasses()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Schedule saved a Mass and sent the secretary back. Restore the
  // in-progress intention, then adopt the new Mass and its day.
  useEffect(() => {
    const resume = searchParams.get('resume')
    if (!resume) return
    let cancelled = false
    const draft = peekIntentionDraft()
    const matches = draftMatchesResume(draft, resume)
    const expired = Boolean(draft)
      && isIntentionDraftNonce(resume)
      && draft.nonce === resume
      && !matches
    if (expired) takeIntentionDraft()
    const { calendar_event_id, mass_date } = readIntentionBookContext(searchParams)
    const next = new URLSearchParams(searchParams)
    next.delete('resume')
    setSearchParams(next, { replace: true })
    if (!canWrite) return undefined
    const drafted = matches && draft?.form && typeof draft.form === 'object' ? draft.form : null
    const adoptedId = calendar_event_id || (drafted?.calendar_event_id != null ? String(drafted.calendar_event_id) : '')
    const draftedStatus = drafted?.status || emptyForm.status
    const urlEventId = parseIntentionEventId(calendar_event_id)
    const seeded = matches && urlEventId != null && parseIntentionEventId(draft?.createdMass?.id) === urlEventId
      ? { ...draft.createdMass, id: urlEventId }
      : null
    if (matches && draft?.editingId != null) {
      editBaselineRef.current = {
        mass_date: drafted?.mass_date || '',
        calendar_event_id: drafted?.calendar_event_id != null ? String(drafted.calendar_event_id) : '',
        status: drafted?.status || 'open',
      }
    } else {
      editBaselineRef.current = null
    }
    setEditingId(matches ? (draft?.editingId ?? null) : null)
    setForm({
      ...emptyForm,
      ...(drafted || {}),
      calendar_event_id: adoptedId,
      mass_date: mass_date || (drafted?.mass_date ?? ''),
      departed: Boolean(drafted?.departed),
      status: parseIntentionEventId(adoptedId) != null && draftedStatus === 'open' ? 'scheduled' : draftedStatus,
    })
    // The POST body names the Mass on this same option. A later
    // GET /api/calendar/:id replaces it, or clears it when this church
    // has no such Mass. A mismatch never invents a title.
    if (seeded) {
      setHopMass(seeded)
      setHopMassStatus('ok')
    }
    setAdding(true)
    setError(null)
    loadMasses()
    const timer = setTimeout(() => {
      if (!cancelled && matches) takeIntentionDraft()
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startEdit = (r) => {
    loadMasses()
    editBaselineRef.current = {
      mass_date: r.mass_date || '',
      calendar_event_id: r.calendar_event_id != null ? String(r.calendar_event_id) : '',
      status: r.status || 'open',
      requested_by_client_id: r.requested_by_client_id ?? null,
      stipend: r.stipend != null ? String(r.stipend) : '',
      received_date: r.received_date || '',
      payment_method: r.payment_method || '',
    }
    setEditingId(r.id)
    setForm({
      intention: stripDeathMark(r.intention || ''),
      departed: hasDeathMark(r.intention),
      requested_by: r.requested_by || '',
      requested_by_client_id: r.requested_by_client_id ?? null,
      requester_name: r.requester_name || '',
      mass_date: r.mass_date || '',
      calendar_event_id: r.calendar_event_id != null ? String(r.calendar_event_id) : '',
      stipend: r.stipend != null ? String(r.stipend) : '',
      received_date: r.received_date || '',
      payment_method: r.payment_method || 'cash',
      status: r.status || 'open',
      note: r.note || '',
    })
    setAdding(true); setError(null)
  }

  // After a landed write. Retires any pending Load more or older reload of
  // this list; a query change retires this one. A failed CURRENT reload keeps
  // the rows and shows the load error (never the empty book); a stale one,
  // success or failure, changes nothing.
  //
  // R313-1 (delta): `ownerQueryGen` is the query generation captured when the
  // SAVE began, before its write await. If the query changed or the page
  // unmounted while the write was pending, this continuation is obsolete: it
  // returns BEFORE claiming, so it never borrows the new query's generation,
  // never retires that query's reads, and never fetches with the old
  // closure's status/search/view. The new query's own read stands.
  const reload = async (ownerQueryGen) => {
    if (queryGenRef.current !== ownerQueryGen) return
    const live = claimList({ replace: true })
    setMore(false)
    try {
      const page = await fetchPage(0, status, q.trim(), pastOnly, thisSunday, thisSunday ? acceptedWeekendRef.current : null)
      if (!live()) return
      if (thisSunday) acceptedWeekendRef.current = page.weekend
      setList(page.intentions); setWeekend(thisSunday ? page.weekend : null); setDone(page.intentions.length < PAGE_SIZE); setLoadError(null)
    } catch (err) {
      if (live()) setLoadError(err.message)
    }
  }

  const persistIntention = async (next) => {
    // Captured before any await: the query this save's reload belongs to.
    const saveQueryGen = queryGenRef.current
    if (!next.intention.trim()) { setError(t('mi.required')); return }
    const stipendNum = next.stipend === '' ? null : Number(next.stipend)
    const hasStipend = stipendNum != null && Number.isFinite(stipendNum) && stipendNum > 0
    const editingRow = editingId != null
    // SP-266: creating with an offering needs received day + method. A
    // status-only edit of a legacy paid row may leave received_date blank —
    // the server keeps the existing fact. Require the fields when creating,
    // when the offering amount changes, or when the secretary typed a day.
    const stipendChanged = editingRow
      && String(next.stipend || '') !== String(editBaselineRef.current?.stipend ?? '')
    if (hasStipend && (!editingRow || stipendChanged || next.received_date)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(next.received_date || '')) {
        setError(t('mi.receivedRequired')); return
      }
      if (!PAYMENT_METHODS.includes(next.payment_method || '')) {
        setError(t('mi.methodRequired')); return
      }
    }
    const massDay = calendarDay(findMassById(next.calendar_event_id, [masses, dayMasses, hopMass, heldMass])?.date)
    const editing = editingId != null
    const baseline = editing ? editBaselineRef.current : null
    const dateUnchanged = Boolean(baseline) && (next.mass_date || '') === (baseline.mass_date || '')
    const eventUnchanged = Boolean(baseline)
      && String(next.calendar_event_id || '') === String(baseline.calendar_event_id || '')
    const fulfilledFrozen = Boolean(baseline) && baseline.status === 'fulfilled' && dateUnchanged && eventUnchanged
    // A typed day and a Mass on another day must not be sent together.
    // The server would keep the Mass and replace the typed day with no notice.
    // A fulfilled row whose stamp and link are unchanged is not that case:
    // the stamp is frozen, and the fields are left off the request.
    // SP-095: say why nothing happened instead of a silent no-op.
    if (!fulfilledFrozen && intentionDateConflicts(next.mass_date, massDay)) {
      setError(t('mi.dateConflictRefused'))
      return
    }
    // The assigned Mass is not in a loaded list, so its day is unknown.
    // Do not send a new id — the server would store that Mass's day.
    // An unchanged link is omitted, so an unloaded Mass does not block a note.
    if (!eventUnchanged && assignedMassDayUnknown(next.calendar_event_id, massDay)) {
      setError(t('mi.massDayUnknown'))
      return
    }
    setBusy(true); setError(null)
    // The toggle (or a hand-typed †/+) guarantees the proper dagger.
    const rawIntention = next.intention.trim()
    const markDeparted = next.departed || hasDeathMark(rawIntention)
    const payload = {
      intention: markDeparted ? `${DAGGER} ${stripDeathMark(rawIntention)}` : rawIntention,
      requested_by: next.requested_by.trim() || (editing ? null : undefined),
      // SP-052: send the link only when it changed (edit) or is set (create).
      requested_by_client_id: editing
        ? ((next.requested_by_client_id ?? null) === (baseline?.requested_by_client_id ?? null) ? undefined : (next.requested_by_client_id ?? null))
        : (next.requested_by_client_id ?? undefined),
      mass_date: editing && dateUnchanged ? undefined : (next.mass_date || (editing ? null : undefined)),
      calendar_event_id: editing && eventUnchanged
        ? undefined
        : (next.calendar_event_id === '' ? (editing ? null : undefined) : Number(next.calendar_event_id)),
      stipend: next.stipend === '' ? (editing ? null : undefined) : Number(next.stipend),
      // Omit blank received_date/method on edit so a status-only save does
      // not clear a legacy latch; create with stipend already validated above.
      received_date: next.received_date
        ? next.received_date
        : (editing ? undefined : (hasStipend ? next.received_date : undefined)),
      payment_method: next.payment_method && (!editing || hasStipend || next.received_date)
        ? next.payment_method
        : (editing ? undefined : (hasStipend ? next.payment_method : undefined)),
      status: next.status,
      note: next.note.trim() || (editing ? null : undefined),
    }
    let saved = false
    let savedDay = ''
    try {
      const res = await fetch(apiUrl(editing ? `/api/mass-intentions/${editingId}` : '/api/mass-intentions'), {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        // The route's `error` is English diagnostic text. The secretary
        // sees the book sentence. The detail stays in the log.
        console.error('[MassIntentions] save refused', {
          status: res.status,
          error: d && d.error != null ? d.error : null,
        })
        const code = d && typeof d.code === 'string' ? d.code : ''
        setError(res.status === 409 && code === 'date_conflict'
          ? t('mi.dateConflictRefused')
          : res.status === 409 && code === 'not_a_mass'
            ? t('mi.notAMass')
            : res.status === 409 && code === 'stamped_history'
              ? t('mi.stampedHistory')
              : res.status === 409 && code === 'stamp_conflict'
                ? t('mi.stampConflict')
                : res.status === 409 && code === 'fulfilled_offering_locked'
                  ? t('mi.fulfilledOfferingLocked')
                : res.status === 409 && code === 'fulfilled_locked'
                  ? t('mi.fulfilledLocked')
                  : res.status === 409 && code === 'voided'
                    ? t('mi.voidedLocked')
                    : res.status === 409 && code === 'offering_clear_refused'
                      ? t('mi.offeringClearRefused')
                      : t('err.save'))
        return
      }
      saved = true
      // The server stores the day of the chosen Mass, so prefer what it
      // returned over what was typed when naming the new date below.
      const body = await res.json().catch(() => null)
      const rawDay = body && typeof body.mass_date === 'string' ? body.mass_date : ''
      const storedDay = /^\d{4}-\d{2}-\d{2}(T|$)/.test(rawDay)
        && !Number.isNaN(Date.parse(rawDay.slice(0, 10)))
        ? rawDay.slice(0, 10)
        : ''
      // R364-1: only a day the server says it stored is named. A null,
      // missing or unreadable mass_date gets the plain toast — the typed
      // form value is never a stand-in for what was saved.
      savedDay = storedDay
    } catch (err) {
      console.error('[MassIntentions] save failed', err)
      setError(t('err.save'))
      return
    } finally {
      if (!saved) setBusy(false)
    }
    closeForm()
    // SP-055: confirm the WRITE (it landed). This fires before the reload,
    // so it never claims the list refreshed; a failed reload keeps its own
    // message. Refused or thrown saves returned above with no toast.
    // SP-063: marking fulfilled gets its own sentence, still only after
    // the server accepted the write. A note on a row already fulfilled
    // stays the ordinary update toast. The reload below is unchanged:
    // it still belongs to the query captured before the write await.
    const markingFulfilled = next.status === 'fulfilled' && baseline?.status !== 'fulfilled'
    toast.success(markingFulfilled
      ? t('mi.fulfilledToast')
      : editing
        // A move (new day or new Mass) names where the intention now is,
        // so the caller can be told the date without reopening the row.
        ? ((!dateUnchanged || !eventUnchanged) && savedDay
          ? t('mi.updatedToastDate', { date: formatParishDay(savedDay, dateLocale, parishTz) })
          : t('mi.updatedToast'))
        : t('mi.addedToast'))
    // The write landed. reload() owns its own failure (the load error, never
    // the empty book) and ignores itself once the query has moved on.
    try {
      await reload(saveQueryGen)
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (e) => {
    e.preventDefault()
    persistIntention(form)
  }

  // SP-094: the two conflict buttons change the form only. Nothing is
  // written until Save changes, so Cancel still discards the choice.
  const chooseMassDate = () => {
    setError(null)
    setForm({ ...form, mass_date: heldDay })
  }

  const clearAssignment = () => {
    setError(null)
    setForm({
      ...form,
      calendar_event_id: '',
      status: form.status === 'scheduled' ? 'open' : form.status,
    })
  }

  const onRemove = async (id) => {
    const confirmed = await ask({
      title: t('mi.deleteConfirmTitle'),
      body: t('mi.deleteConfirmBody'),
      confirmLabel: t('mi.deleteConfirm'),
    })
    if (!confirmed) return
    setError(null)
    try {
      const res = await fetch(apiUrl(`/api/mass-intentions/${id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) {
        const d = await res.json().catch(() => ({}))
        console.error('[MassIntentions] delete refused', {
          status: res.status,
          error: d && d.error != null ? d.error : null,
        })
        setError(res.status === 409 && d && d.code === 'fulfilled_history'
          ? t('mi.fulfilledHistory')
          : res.status === 409 && d && d.code === 'offering_recorded'
            ? t('mi.offeringRecordedDelete')
            : t('mi.deleteFailed'))
        return
      }
      setList(l => l.filter(r => r.id !== id))
    } catch (err) {
      console.error('[MassIntentions] delete failed', err)
      setError(t('mi.deleteFailed'))
    }
  }


  const closeStipendAction = () => {
    if (stipendBusy) return
    setStipendAction(null)
    setStipendErr(null)
  }

  const submitStipendAction = async () => {
    if (!stipendAction?.row) return
    const { mode, row } = stipendAction
    const openHeld = Number(row.open_stipend_liability || 0) > 0
    const reason = (voidForm.reason || '').trim()
    if (mode === 'void' && !reason) {
      setStipendErr(t('mi.voidReason')); return
    }
    if (mode === 'void' && openHeld) {
      if (!['refunded', 'transferred', 'pastor_applied'].includes(voidForm.kind)) {
        setStipendErr(t('mi.disposition')); return
      }
      if (voidForm.kind === 'transferred') {
        const tid = Number(voidForm.transferTo)
        if (!Number.isInteger(tid) || tid <= 0) {
          setStipendErr(t('mi.transferTo')); return
        }
      }
    }
    if (mode === 'disposition') {
      if (!['refunded', 'transferred', 'pastor_applied'].includes(voidForm.kind)) {
        setStipendErr(t('mi.disposition')); return
      }
      const dReason = (voidForm.dispositionReason || reason || '').trim()
      if (!dReason && (voidForm.kind === 'pastor_applied' || voidForm.kind === 'refunded')) {
        setStipendErr(t('mi.dispositionReason')); return
      }
      if (voidForm.kind === 'transferred') {
        const tid = Number(voidForm.transferTo)
        if (!Number.isInteger(tid) || tid <= 0) {
          setStipendErr(t('mi.transferTo')); return
        }
      }
    }
    setStipendBusy(true); setStipendErr(null)
    try {
      let url
      let body
      if (mode === 'void') {
        url = apiUrl(`/api/mass-intentions/${row.id}/void`)
        body = { reason }
        if (openHeld) {
          body.disposition = {
            kind: voidForm.kind,
            reason: (voidForm.dispositionReason || reason).trim() || undefined,
            transfer_to_intention_id: voidForm.kind === 'transferred' ? Number(voidForm.transferTo) : undefined,
          }
        }
      } else if (mode === 'disposition') {
        url = apiUrl(`/api/mass-intentions/${row.id}/disposition`)
        body = {
          disposition: {
            kind: voidForm.kind,
            reason: (voidForm.dispositionReason || reason).trim() || undefined,
            transfer_to_intention_id: voidForm.kind === 'transferred' ? Number(voidForm.transferTo) : undefined,
          },
        }
      } else {
        setStipendErr(t('err.save'))
        return
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        console.error('[MassIntentions] stipend action refused', { mode, status: res.status, error: d?.error, code: d?.code })
        setStipendErr(
          d?.code === 'void_fulfilled_held' ? t('mi.voidFulfilledHeld')
            : d?.code === 'disposition_fulfilled' ? t('mi.dispositionFulfilled')
            : typeof d?.error === 'string' ? d.error
              : t('err.save')
        )
        return
      }
      setStipendAction(null)
      toast.success(mode === 'disposition' ? t('mi.dispositionConfirm') : t('mi.voidConfirm'))
      await reload(queryGenRef.current)
    } catch (err) {
      console.error('[MassIntentions] stipend action failed', err)
      setStipendErr(t('err.save'))
    } finally {
      setStipendBusy(false)
    }
  }

  const toggleSelected = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openReview = () => {
    const rows = []
    for (const r of list) {
      if (!selected.has(r.id) || !intentionMayBeMarkedSaid(r)) continue
      rows.push({
        id: r.id,
        intention: r.intention || '',
        requestedBy: r.requested_by || r.requester_name || '',
        massTitle: r.mass_title || '',
        linked: linkedMassId(r) != null,
        date: defaultSaidDate(r),
        massDay: defaultSaidDate(r),
        priorStatus: r.status,
        priorMassDate: r.mass_date || '',
      })
    }
    if (!rows.length) return
    setMarkError(null)
    setUndoOpen(false)
    setReview({ requestId: newMarkRequestId(), heldId: null, rows })
  }

  const leaveOut = (id) => {
    setReview(prev => {
      if (!prev) return prev
      const rows = prev.rows.filter(r => r.id !== id)
      return rows.length ? { ...prev, rows, requestId: newMarkRequestId(), heldId: null } : null
    })
    setSelected(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const setSaidDate = (id, date) => {
    setReview(prev => {
      if (!prev) return prev
      return {
        ...prev,
        heldId: null,
        requestId: prev.heldId ? newMarkRequestId() : prev.requestId,
        rows: prev.rows.map(r => r.id === id ? { ...r, date } : r),
      }
    })
  }

  const commitMark = async () => {
    if (!review || markBusy) return
    const saveQueryGen = queryGenRef.current
    const requestId = review.heldId || review.requestId
    const items = review.rows.map(r => ({ id: r.id, fulfilled_date: r.date || null }))
    setMarkBusy(true)
    setMarkError(null)
    try {
      let res
      try {
        res = await fetch(apiUrl('/api/mass-intentions/bulk-mark-said'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true, request_id: requestId, items }),
        })
      } catch (err) {
        console.error('[MassIntentions] mark said failed', err)
        setReview(r => r && ({ ...r, heldId: requestId }))
        setMarkError(t('mi.markSaidUnreachable'))
        return
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        console.error('[MassIntentions] mark said refused', {
          status: res.status,
          error: d && d.error != null ? d.error : null,
        })
        setMarkError(d && d.code === 'undo_conflict' ? t('mi.markSaidUndoConflict') : t('mi.markSaidFailed'))
        setReview(r => r && ({ ...r, requestId: newMarkRequestId(), heldId: null }))
        return
      }
      const body = await res.json().catch(() => null)
      const parsed = readMarkSaidResponse(body, { requestId, submittedIds: items.map(i => i.id) })
      if (!parsed) {
        console.error('[MassIntentions] mark said response unreadable', { status: res.status })
        setReview(r => r && ({ ...r, heldId: requestId }))
        setMarkError(t('mi.markSaidUnreadable'))
        return
      }
      const markedIds = new Set(parsed.marked.map(m => m.id))
      setList(rows => rows.map(r => {
        const hit = parsed.marked.find(m => m.id === canonicalIntentionId(r.id))
        if (!hit) return r
        // L3 / R355-1: the cached title/time describe the PLANNED Mass as
        // this page last read it (it may have moved since). The fulfilment
        // stamp is the server's; until the authoritative reload supplies
        // it, show the confirmed day only. The scheduling link is kept.
        return {
          ...r, status: 'fulfilled', mass_date: hit.fulfilled_date, entered_history: true,
          mass_title: null, mass_time: null,
        }
      }))
      setMarkResult({
        batchId: parsed.batchId,
        marked: parsed.marked,
        excluded: parsed.excluded,
        priors: review.rows.filter(r => markedIds.has(canonicalIntentionId(r.id))),
        undone: false,
      })
      setSelected(new Set())
      setReview(null)
      await reload(saveQueryGen)
    } finally {
      setMarkBusy(false)
    }
  }

  const commitUndo = async () => {
    if (!markResult || markBusy) return
    const saveQueryGen = queryGenRef.current
    setMarkBusy(true)
    setMarkError(null)
    try {
      let res
      try {
        res = await fetch(apiUrl(`/api/mass-intentions/bulk-mark-said/${markResult.batchId}/undo`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        })
      } catch (err) {
        console.error('[MassIntentions] undo mark said failed', err)
        setMarkError(t('mi.markSaidUnreachable'))
        return
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        console.error('[MassIntentions] undo mark said refused', {
          status: res.status,
          error: d && d.error != null ? d.error : null,
        })
        setMarkError(d && d.code === 'undo_conflict' ? t('mi.markSaidUndoConflict') : t('mi.markSaidUndoFailed'))
        return
      }
      const body = await res.json().catch(() => null)
      const parsed = readUndoResponse(body, {
        batchId: markResult.batchId,
        markedIds: markResult.marked.map(m => m.id),
      })
      if (!parsed) {
        console.error('[MassIntentions] undo mark said response unreadable', { status: res.status })
        setMarkError(t('mi.markSaidUnreadable'))
        return
      }
      const restored = new Set(parsed.restored.map(r => r.id))
      setList(rows => rows.map(r => {
        if (!restored.has(canonicalIntentionId(r.id))) return r
        const prior = markResult.priors.find(p => canonicalIntentionId(p.id) === canonicalIntentionId(r.id))
        if (!prior) return r
        return { ...r, status: prior.priorStatus, mass_date: prior.priorMassDate, entered_history: false }
      }))
      setMarkResult(prev => prev && ({ ...prev, undone: true }))
      setUndoOpen(false)
      await reload(saveQueryGen)
    } finally {
      setMarkBusy(false)
    }
  }

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500'

  return (
    <PageWrapper type="list">
      <div
        data-testid="intention-book-header"
        className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-start sm:justify-between"
      >
        <div className="min-w-0 w-full sm:min-w-[16rem] sm:flex-1">
          <div className="min-w-0 flex-1">
              <PageHeader title={t('mi.title')} leading={<Flame size={20} />} />
              {hopMassId ? (
                <div data-testid="intention-mass-chrome" className="mt-1 min-w-0 w-full">
                  {hopMassStatus === 'loading' && (
                    <p role="status" className="text-sm text-ink-500 dark:text-parchment-300/70">{t('mi.massLookingUp')}</p>
                  )}
                  {hopMassStatus === 'ok' && hopChrome && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">
                        {t('mi.bookOpenedFrom')}
                      </p>
                      <p className="text-sm text-ink-700 dark:text-parchment-200 whitespace-normal">
                        <span className="font-semibold">{hopChrome.title}</span>
                        {(hopChrome.date || hopChrome.time) && (
                          <span className="block sm:inline text-ink-500 dark:text-parchment-300/80">
                            <span className="hidden sm:inline"> · </span>
                            {[hopChrome.date, hopChrome.time].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </p>
                    </div>
                  )}
                  {hopMassStatus === 'missing' && (
                    <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{t('mi.massUnknown')}</p>
                  )}
                  {hopMassStatus === 'failed' && (
                    <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{t('mi.massUnreachable')}</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-ink-500 dark:text-parchment-300/70">{t('mi.sub')}</p>
              )}
              {hopMassId && backHref !== '/schedule' && (
                <Link
                  to={backHref}
                  className="mt-1 inline-block text-xs font-semibold text-brass-700 dark:text-brass-300 hover:underline"
                >
                  {t('mi.backMass')}
                </Link>
              )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0 self-start">
          <Link to="/mass-intentions/print"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800">
            <Printer size={15} className="shrink-0" />
            <span className="flex flex-col items-start leading-tight">
              <span className="text-sm font-medium">{t('mi.weeklySheet')}</span>
              <span data-testid="weekly-sheet-not-emailed" className="text-[11px] font-normal text-ink-500 dark:text-parchment-300/70">
                {t('mi.weeklySheetHint')}
              </span>
            </span>
          </Link>
          {canWrite && !adding && (
            <button type="button" onClick={startAdd}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900">
              <Plus size={15} /> {t('mi.add')}
            </button>
          )}
        </div>
      </div>

      {canWrite && adding && (
        <form onSubmit={onSubmit} className="mb-5 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 shadow-warm p-4 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">
            {editingId ? t('mi.edit') : t('mi.new')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="sm:col-span-2">
              <label htmlFor={`${formId}-intention`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.intention')}</label>
              <input id={`${formId}-intention`} type="text" value={form.intention} placeholder={t('mi.placeholder')}
                onChange={e => {
                  const intention = e.target.value
                  // SP-316: typing † (or +) ticks Departed; the box stays
                  // if the mark is later removed so a hand-ticked box is not cleared.
                  setForm(f => ({
                    ...f,
                    intention,
                    ...(hasDeathMark(intention) ? { departed: true } : {}),
                  }))
                }} className={inputCls} />
              <label className="mt-2 flex items-start gap-2 text-[12px] leading-snug text-ink-600 dark:text-parchment-300/80 cursor-pointer max-w-full">
                <input
                  type="checkbox"
                  checked={form.departed}
                  onChange={e => setForm(f => ({ ...f, departed: e.target.checked }))}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-church-700"
                />
                <span className="min-w-0">{t('mi.departed')} <span className="font-display">{DAGGER}</span></span>
              </label>
            </div>
            <div>
              <label htmlFor={`${formId}-requested`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.requestedBy')}</label>
              <input id={`${formId}-requested`} type="text" value={form.requested_by}
                onChange={e => setForm(f => ({ ...f, requested_by: e.target.value }))} className={inputCls} />
              <RequesterMemberLink t={t} inputCls={inputCls}
                memberId={form.requested_by_client_id} memberName={form.requester_name}
                onChange={(id, name) => setForm(f => ({ ...f, requested_by_client_id: id, requester_name: name, requested_by: f.requested_by || name }))} />
            </div>
            <div>
              <label htmlFor={`${formId}-date`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.massDate')}</label>
              <input id={`${formId}-date`} type="date" value={form.mass_date}
                onChange={e => onMassDateChange(e.target.value)} className={inputCls} />
            </div>
            <div className="min-w-0">
              <label htmlFor={`${formId}-assign`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.assign')}</label>
              <select
                id={`${formId}-assign`}
                disabled={fulfilledLock}
                aria-describedby={fulfilledLock ? `${formId}-locked-note` : undefined}
                value={heldAssignId != null ? String(heldAssignId) : ''}
                onChange={e => {
                  const id = e.target.value
                  const ev = assignMasses.find(m => String(m.id) === id)
                  setForm(f => ({
                    ...f,
                    calendar_event_id: id,
                    // Assigning a Mass adopts its stored calendar day.
                    mass_date: calendarDay(ev?.date) || f.mass_date,
                    // The Mass is the scheduling fact — open becomes scheduled;
                    // clearing a Mass returns scheduled to open. Server agrees.
                    status: id
                      ? (f.status === 'open' ? 'scheduled' : f.status)
                      : (f.status === 'scheduled' ? 'open' : f.status),
                  }))
                }}
                className={inputCls}
              >
                <option value="">{t('mi.notAssigned')}</option>
                {/* Held id keeps one stable <option> from first paint. Swapping
                    a placeholder for the resolved Mass unmounts the selected
                    node; React skips updateOptions because value is unchanged,
                    and a headed browser resets to "Not assigned". jsdom still
                    reports the React property, so that gap is not a pass. */}
                {heldAssignId != null && (
                  <option key={`held-${heldAssignId}`} value={String(heldAssignId)}>
                    {heldListedMass
                      ? formatMassOptionLabel(heldListedMass, dateLocale, parishTz)
                      : heldAssignStatus === 'missing' ? t('mi.massUnknown')
                      : heldAssignStatus === 'failed' ? t('mi.massUnreachable')
                      : t('mi.massLookingUp')}
                  </option>
                )}
                {primaryAssign.map(m => (
                  <option key={String(m.id)} value={String(m.id)}>
                    {formatMassOptionLabel(m, dateLocale, parishTz)}
                  </option>
                ))}
                {otherAssign.length > 0 && (
                  <optgroup label={t('mi.otherCalendarEntries')}>
                    {otherAssign.map(m => (
                      <option key={String(m.id)} value={String(m.id)}>
                        {formatMassOptionLabel(m, dateLocale, parishTz)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {dayLookupPending && (
                <p role="status" className="mt-1 text-[11px] text-ink-500 dark:text-parchment-300/70">
                  {t('mi.dayMassesLoading')}
                </p>
              )}
              {noMassOnDate && (
                <p role="status" data-testid="no-mass-on-date" className="mt-1 text-[11px] text-ink-700 dark:text-parchment-200">
                  {t('mi.noMassOnDate', { date: massDateLabel })}
                  {' '}
                  <Link
                    to={scheduleNewMassHref(form.mass_date, returnNonce)}
                    onClick={() => stashIntentionDraft({ form, editingId, nonce: returnNonce })}
                    className="font-semibold text-brass-700 dark:text-brass-300 hover:underline"
                  >
                    {t('mi.addMassOnDate')}
                  </Link>
                </p>
              )}
              {form.mass_date && dayMassesFailed && (
                <p role="status" className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
                  {t('mi.dayMassesFailed')}
                </p>
              )}
              {dateDisagrees && (
                <div role="alert" data-testid="save-date-conflict" className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
                  <p>
                    {t('mi.dateDisagrees', { entered: enteredLabel, massDate: heldDayLabel })}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={chooseMassDate}
                      className="px-2 py-1 text-[11px] font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900"
                    >
                      {t('mi.useMassDate')}
                    </button>
                    <button
                      type="button"
                      onClick={clearAssignment}
                      className="px-2 py-1 text-[11px] font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-800 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800"
                    >
                      {t('mi.clearAssignment')}
                    </button>
                  </div>
                </div>
              )}
              {hopMassId && heldAssignId != null && String(hopMassId) !== String(heldAssignId) && (
                <p role="status" data-testid="intention-assign-differs" className="mt-1 text-[11px] text-ink-600 dark:text-parchment-300/80">
                  {t('mi.assignDiffers')}
                </p>
              )}
              {heldAssignId != null && !heldAssignInList && heldAssignStatus === 'missing' && (
                <p role="status" className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
                  {t('mi.massHeldMissing')}
                </p>
              )}
              {heldAssignId != null && !heldAssignInList && heldAssignStatus === 'failed' && (
                <p role="status" className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
                  {t('mi.massHeldFailed')}
                </p>
              )}
              {massesFailed && (
                <p role="status" className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                  {t('mi.massesFailed')}
                </p>
              )}
            </div>
            <div>
              <label htmlFor={`${formId}-offering`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.offering')}</label>
              <input id={`${formId}-offering`} type="number" min="0" step="0.01" value={form.stipend}
                readOnly={fulfilledLock} aria-readonly={fulfilledLock || undefined}
                aria-describedby={fulfilledLock ? `${formId}-locked-note` : undefined}
                onChange={e => { if (!fulfilledLock) setForm(f => ({ ...f, stipend: e.target.value })) }}
                className={`${inputCls}${fulfilledLock ? ' opacity-70 cursor-not-allowed' : ''}`} />
              {fulfilledLock && (
                <p id={`${formId}-locked-note`} data-testid="mi-offering-locked" className="mt-1 text-[11px] text-ink-600 dark:text-parchment-300/80">
                  {t('mi.offeringLockedNote')}
                </p>
              )}
              {fulfilledLock && (
                <p data-testid="mi-edit-said-on" className="mt-1 text-[11px] font-semibold text-brass-700 dark:text-brass-300">
                  {editBaseline?.mass_date ? t('mi.saidOn', { date: formatParishDay(editBaseline.mass_date, dateLocale, parishTz) }) : t('mi.saidDateUnknown')}
                </p>
              )}
            </div>
            <div>
              <label htmlFor={`${formId}-received`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.receivedDate')}</label>
              <input id={`${formId}-received`} data-testid="mi-received-date" type="date" value={form.received_date}
                readOnly={fulfilledLock} aria-readonly={fulfilledLock || undefined}
                onChange={e => { if (!fulfilledLock) setForm(f => ({ ...f, received_date: e.target.value })) }}
                className={`${inputCls}${fulfilledLock ? ' opacity-70 cursor-not-allowed' : ''}`} />
            </div>
            <div>
              <label htmlFor={`${formId}-method`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.paymentMethod')}</label>
              <select id={`${formId}-method`} data-testid="mi-payment-method" value={form.payment_method}
                disabled={fulfilledLock}
                onChange={e => { if (!fulfilledLock) setForm(f => ({ ...f, payment_method: e.target.value })) }}
                className={`${inputCls}${fulfilledLock ? ' opacity-70 cursor-not-allowed' : ''}`}>
                {PAYMENT_METHODS.map(m => <option key={m} value={m}>{t(`mi.method.${m}`)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${formId}-status`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.status')}</label>
              <select id={`${formId}-status`} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className={inputCls}>
                {STATUSES.map(s => <option key={s} value={s}>{t(`mi.${s}`)}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={`${formId}-note`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.note')}</label>
              <input id={`${formId}-note`} type="text" value={form.note}
                onChange={e => setForm(f => ({ ...f, note: e.target.value }))} className={inputCls} />
            </div>
          </div>
          {error && <p role="alert" className="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>}
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {editingId ? t('mi.saveChanges') : t('mi.save')}
            </button>
            <button type="button" onClick={closeForm} className="text-[12px] text-ink-500 dark:text-parchment-300/70 hover:underline">{t('mi.cancel')}</button>
          </div>
        </form>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label={t('mi.allStatuses')}
          className="px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500">
          <option value="">{t('mi.allStatuses')}</option>
          {STATUSES.map(s => <option key={s} value={s}>{t(`mi.${s}`)}</option>)}
        </select>
        <button type="button" aria-pressed={thisSunday} onClick={() => setThisSunday(v => !v)}
          data-testid="mi-this-sunday"
          className={`px-3 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-church-500 ${thisSunday
            ? 'border-church-700 bg-church-50 text-church-900 dark:border-brass-700 dark:bg-church-900/40 dark:text-parchment-50'
            : 'border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50'}`}>
          {t('mi.thisSunday')}
        </button>
        {thisSunday && weekend && (
          <span data-testid="mi-this-sunday-dates" className="text-xs text-ink-600 dark:text-parchment-300/80">
            {formatStoredDate(weekend.saturday, { weekday: 'short', month: 'short', day: 'numeric' }, dateLocale)}
            {' – '}
            {formatStoredDate(weekend.sunday, { weekday: 'short', month: 'short', day: 'numeric' }, dateLocale)}
          </span>
        )}
        {thisSunday && weekend && (
          <Link to={`/mass-intentions/print?start=${weekend.saturday}`} data-testid="mi-this-sunday-sheet"
            className="text-sm font-semibold text-brass-700 dark:text-brass-300 hover:underline">
            {t('mi.thisSundaySheet')}
          </Link>
        )}
        <button type="button" aria-pressed={pastOnly} onClick={() => setPastOnly(v => !v)}
          data-testid="mi-past-filter"
          className={`px-3 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-church-500 ${pastOnly
            ? 'border-amber-600 bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
            : 'border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50'}`}>
          {t('mi.pastScheduledFilter')}
        </button>
        {canWrite && selected.size > 0 && (
          <button type="button" data-testid="mi-mark-said-open" onClick={openReview}
            className="px-3 py-2 text-sm font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 focus:outline-none focus:ring-2 focus:ring-church-500">
            {t('mi.markSaidOpen')}
          </button>
        )}
        <div className="relative flex-1 min-w-[12rem]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input type="search" value={q} onChange={e => setQ(e.target.value)}
            placeholder={t('mi.search')} aria-label={t('mi.search')}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500" />
        </div>
      </div>

      {canWrite && review && (
        <section data-testid="mi-mark-said-panel" aria-labelledby="mi-mark-said-title"
          className="mb-4 rounded-2xl border border-brass-300/70 dark:border-brass-800/50 bg-parchment-50 dark:bg-ink-900 shadow-warm p-4 space-y-3">
          <h2 id="mi-mark-said-title" className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('mi.markSaidTitle')}</h2>
          <p className="text-[13px] text-ink-600 dark:text-parchment-300/80">{t('mi.markSaidBody')}</p>
          <ul className="space-y-3">
            {review.rows.map(row => (
              <li key={row.id} data-testid="mi-mark-said-row" className="rounded-xl border border-parchment-300/60 dark:border-brass-900/30 px-3 py-2">
                <p className="text-sm font-medium text-ink-900 dark:text-parchment-50">{row.intention}</p>
                <p className="text-[12px] text-ink-500 dark:text-parchment-300/70">
                  {row.requestedBy}{row.massTitle ? ` — ${row.massTitle}` : ''}
                </p>
                <label className="mt-2 block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70" htmlFor={`said-date-${row.id}`}>
                  {t('mi.markSaidDate')}
                </label>
                <input id={`said-date-${row.id}`} type="date" value={row.date}
                  aria-label={`${t('mi.markSaidDate')} ${row.intention}`}
                  max={saidToday}
                  onChange={e => setSaidDate(row.id, e.target.value)}
                  className="mt-1 px-2 py-1 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50" />
                {!row.date && row.linked && (
                  <p className="mt-1 text-[12px] text-ink-600 dark:text-parchment-300/80">{t('mi.markSaidFromMass')}</p>
                )}
                {saidRowFuture(row, saidToday) && (
                  <p role="status" className="mt-1 text-[12px] text-amber-800 dark:text-amber-300">{t('mi.markSaidFuture')}</p>
                )}
                {!row.date && !row.linked && (
                  <p className="mt-1 text-[12px] text-ink-600 dark:text-parchment-300/80">{t('mi.markSaidNoMass')}</p>
                )}
                <button type="button" onClick={() => leaveOut(row.id)}
                  className="mt-1 text-[12px] text-ink-500 dark:text-parchment-300/70 hover:underline">
                  {t('mi.markSaidLeaveOut')}
                </button>
              </li>
            ))}
          </ul>
          {review.rows.some(r => !saidRowReady(r, saidToday)) && (
            <p className="text-[12px] text-ink-600 dark:text-parchment-300/80">
              {t('mi.markSaidWillLeave', { n: review.rows.filter(r => !saidRowReady(r, saidToday)).length })}
            </p>
          )}
          {markError && <p role="alert" className="text-[13px] text-rose-700 dark:text-rose-300">{markError}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-testid="mi-mark-said-commit" disabled={markBusy || review.rows.filter(r => saidRowReady(r, saidToday)).length === 0}
              onClick={commitMark}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60">
              {markBusy ? <Loader2 size={13} className="animate-spin" /> : null}
              {markBusy ? t('mi.markSaidWorking') : t('mi.markSaidCommit', { n: review.rows.filter(r => saidRowReady(r, saidToday)).length })}
            </button>
            {review.heldId && (
              <button type="button" data-testid="mi-mark-said-retry" onClick={commitMark} disabled={markBusy}
                className="text-[12px] font-semibold text-ink-700 dark:text-parchment-100 hover:underline">
                {t('mi.markSaidRetry')}
              </button>
            )}
            <button type="button" onClick={() => { setReview(null); setMarkError(null) }}
              className="text-[12px] text-ink-500 dark:text-parchment-300/70 hover:underline">
              {t('mi.markSaidNotNow')}
            </button>
          </div>
        </section>
      )}

      {canWrite && markResult && (
        <section data-testid="mi-mark-said-result" aria-live="polite"
          className="mb-4 rounded-2xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 px-4 py-3 space-y-2">
          <p className="text-sm text-ink-800 dark:text-parchment-100">
            {markResult.undone
              ? t('mi.markSaidUndone')
              : markResult.marked.length
                ? t('mi.markSaidDone', { n: markResult.marked.length })
                : t('mi.markSaidNone')}
          </p>
          {!markResult.undone && markResult.excluded.length > 0 && (
            <div>
              <p className="text-[12px] font-semibold text-ink-600 dark:text-parchment-300/80">{t('mi.markSaidLeftIntro')}</p>
              <ul className="mt-1 space-y-1">
                {markResult.excluded.map(item => (
                  <li key={item.id} data-testid="mi-mark-said-excluded" className="text-[12px] text-ink-600 dark:text-parchment-300/80">
                    {exclusionSentence(t, item.code)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!markResult.undone && markResult.marked.length > 0 && !undoOpen && (
            <button type="button" data-testid="mi-mark-said-undo" onClick={() => { setUndoOpen(true); setMarkError(null) }}
              className="text-[12px] font-semibold text-ink-700 dark:text-parchment-100 hover:underline">
              {t('mi.markSaidUndo')}
            </button>
          )}
          {undoOpen && !markResult.undone && (
            <div data-testid="mi-mark-said-undo-panel" className="space-y-2">
              <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('mi.markSaidUndoTitle')}</p>
              <p className="text-[13px] text-ink-600 dark:text-parchment-300/80">{t('mi.markSaidUndoBody')}</p>
              {markError && <p role="alert" className="text-[13px] text-rose-700 dark:text-rose-300">{markError}</p>}
              <div className="flex items-center gap-2">
                <button type="button" data-testid="mi-mark-said-undo-commit" onClick={commitUndo} disabled={markBusy}
                  className="px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60">
                  {t('mi.markSaidUndoCommit')}
                </button>
                <button type="button" onClick={() => setUndoOpen(false)}
                  className="text-[12px] text-ink-500 dark:text-parchment-300/70 hover:underline">
                  {t('mi.markSaidNotNow')}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {loadError && <p role="alert" className="mb-3 text-sm text-rose-700 dark:text-rose-300">{loadError}</p>}

      {error && !adding && <p role="alert" className="mb-3 text-sm text-rose-700 dark:text-rose-300">{error}</p>}

      {loading ? (
        <div role="status" aria-label={t('mi.loading')} className="flex justify-center py-16">
          <Loader2 size={22} className="animate-spin text-brass-600" aria-hidden="true" />
        </div>
      ) : loadError && list.length === 0 ? null : list.length === 0 && thisSunday && (pastOnly || status || q.trim()) ? (
        <EmptyState icon={Flame} title={t('mi.thisSundayNoMatchTitle')}
          body={t('mi.thisSundayNoMatchBody')} />
      ) : list.length === 0 && thisSunday ? (
        <EmptyState icon={Flame} title={t('mi.thisSundayEmptyTitle')}
          body={t('mi.thisSundayEmptyBody')} />
      ) : list.length === 0 && pastOnly && (status || q.trim()) ? (
        // R313-2: search/status narrow the past-scheduled view (AND on the
        // server). An empty result says only that nothing MATCHES them.
        <EmptyState icon={Flame} title={t('mi.pastScheduledNoMatchTitle')}
          body={t('mi.pastScheduledNoMatchBody')} />
      ) : list.length === 0 && pastOnly ? (
        <EmptyState icon={Flame} title={t('mi.pastScheduledEmptyTitle')}
          body={t('mi.pastScheduledEmptyBody')} />
      ) : list.length === 0 && (status || q.trim()) ? (
        // SP-132: a status filter or search with no matches is not an empty
        // book. Say only that nothing matches.
        <EmptyState icon={Flame} title={t('mi.filterNoMatchTitle')}
          body={t('mi.filterNoMatchBody')} />
      ) : list.length === 0 ? (
        <EmptyState icon={Flame} title={t('mi.emptyTitle')}
          body={t('mi.emptyBody')} />
      ) : phone ? (
        // SP-057 (MIN-20): at phone width the book is a card list — the same
        // rows, fields and handlers as the table, without sideways scroll.
        <ul data-testid="mi-cards" aria-label={t('mi.title')} className="space-y-2">
          {list.map(r => (
            // R312-1: stored text can be one unbroken token (a requester or a
            // Mass title). min-w-0 lets the columns shrink below that token's
            // width, and overflow-wrap:anywhere breaks it (it also reduces the
            // min-content size, unlike break-word), so nothing is clipped and
            // the card never grows past the screen.
            <li key={r.id} data-testid="mi-card" className="min-w-0 [overflow-wrap:anywhere] rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm bg-parchment-50 dark:bg-ink-900 px-4 py-3 text-sm text-ink-800 dark:text-parchment-100">
              <div className="flex items-start justify-between gap-3">
                {canWrite && intentionMayBeMarkedSaid(r) && (
                  // SP-317: phone list checkboxes need a ≥44px hit target.
                  <label className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] -ml-2 -mt-1 shrink-0 cursor-pointer">
                    <input type="checkbox" data-testid="mi-mark-said-check" className="h-4 w-4 accent-church-700"
                      checked={selected.has(r.id)}
                      aria-label={t('mi.markSaidSelect', { name: r.intention || '' })}
                      onChange={() => toggleSelected(r.id)} />
                  </label>
                )}
                <div data-testid="mi-card-mass" className="min-w-0 flex-1 text-[12px] text-ink-600 dark:text-parchment-300/80">
                  <IntentionMassCell r={r} t={t} dateLocale={dateLocale} />
                </div>
                {canWrite && <div className="shrink-0"><IntentionRowActions r={r} t={t} onEdit={startEdit} onRemove={onRemove}
                      isAdmin={isAdmin}
                      onVoid={(row) => { setStipendErr(null); setVoidForm({ reason: '', kind: 'refunded', dispositionReason: '', transferTo: '' }); setStipendAction({ mode: 'void', row }) }}
                      onDisposition={(row) => { setStipendErr(null); setVoidForm({ reason: '', kind: 'refunded', dispositionReason: '', transferTo: '' }); setStipendAction({ mode: 'disposition', row }) }}
                    /></div>}
              </div>
              <p className="mt-1.5 font-medium"><IntentionTextCell r={r} /></p>
              <dl data-testid="mi-card-fields" className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
                <dt className="text-ink-500 dark:text-parchment-300/70">{t('mi.requestedBy')}</dt>
                <dd className="min-w-0">{requesterText(r)}</dd>
                <dt className="text-ink-500 dark:text-parchment-300/70">{t('mi.offeringShort')}</dt>
                <dd>{fmtStipend(r.stipend) || '—'}</dd>
                <dt className="text-ink-500 dark:text-parchment-300/70">{t('mi.status')}</dt>
                <dd><IntentionStatusCell r={r} t={t} dateLocale={dateLocale} /></dd>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <div
          // `relative` is load-bearing, not cosmetic — the same bug the
          // register had (QA audit M1). The actions column's sr-only <span>
          // is position:absolute, so without a positioned ancestor here it
          // anchored to an element further out and stretched the ROOT
          // scrollWidth: at 768px the whole page panned 61px sideways while
          // the table itself looked innocent.
          //
          // It only surfaced once the demo parish put real rows in this
          // table — an empty intention book never reproduced it.
          //
          // tabIndex/role/aria-label: a region that genuinely scrolls has to
          // be reachable by keyboard, or the offering and status columns are
          // unreachable without a mouse.
          className="relative overflow-x-auto rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm"
          tabIndex={0}
          role="region"
          aria-label={t('mi.title')}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-brass-700 dark:text-brass-300 bg-parchment-100 dark:bg-ink-800">
                {canWrite && <th className="px-4 py-3 font-bold"><span className="sr-only">{t('mi.markSaid')}</span></th>}
                <th className="px-4 py-3 font-bold">{t('mi.date')}</th>
                <th className="px-4 py-3 font-bold">{t('mi.intention')}</th>
                <th className="px-4 py-3 font-bold">{t('mi.requestedBy')}</th>
                <th className="px-4 py-3 font-bold">{t('mi.offeringShort')}</th>
                <th className="px-4 py-3 font-bold">{t('mi.status')}</th>
                {canWrite && <th className="px-4 py-3 font-bold"><span className="sr-only">{t('mi.actions')}</span></th>}
              </tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.id} className="border-t border-parchment-300/50 dark:border-brass-900/25 text-ink-800 dark:text-parchment-100 align-top">
                  {canWrite && (
                    <td className="px-4 py-2.5">
                      {intentionMayBeMarkedSaid(r) && (
                        <label className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] -mx-2 cursor-pointer">
                          <input type="checkbox" data-testid="mi-mark-said-check" className="h-4 w-4 accent-church-700"
                            checked={selected.has(r.id)}
                            aria-label={t('mi.markSaidSelect', { name: r.intention || '' })}
                            onChange={() => toggleSelected(r.id)} />
                        </label>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-2.5 whitespace-nowrap"><IntentionMassCell r={r} t={t} dateLocale={dateLocale} /></td>
                  <td className="px-4 py-2.5 font-medium"><IntentionTextCell r={r} /></td>
                  <td className="px-4 py-2.5">{requesterText(r)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{fmtStipend(r.stipend) || '—'}</td>
                  <td className="px-4 py-2.5"><IntentionStatusCell r={r} t={t} dateLocale={dateLocale} /></td>
                  {canWrite && (
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <IntentionRowActions r={r} t={t} onEdit={startEdit} onRemove={onRemove}
                      isAdmin={isAdmin}
                      onVoid={(row) => { setStipendErr(null); setVoidForm({ reason: '', kind: 'refunded', dispositionReason: '', transferTo: '' }); setStipendAction({ mode: 'void', row }) }}
                      onDisposition={(row) => { setStipendErr(null); setVoidForm({ reason: '', kind: 'refunded', dispositionReason: '', transferTo: '' }); setStipendAction({ mode: 'disposition', row }) }}
                    />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !done && list.length > 0 && (
        <div className="flex justify-center mt-4">
          <button type="button" onClick={loadMore} disabled={more}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800 disabled:opacity-60">
            {more ? <Loader2 size={15} className="animate-spin" /> : null} {t('mi.loadMore')}
          </button>
        </div>
      )}

      {stipendAction && (
        <div data-testid="mi-stipend-action" className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-ink-950/50 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 shadow-warm p-4 space-y-3">
            <h2 className="text-base font-display font-bold text-ink-900 dark:text-parchment-50">
              {stipendAction.mode === 'void' ? t('mi.voidTitle') : t('mi.dispositionOnlyTitle')}
            </h2>
            <p className="text-[12px] text-ink-600 dark:text-parchment-300/80">
              {stipendAction.mode === 'void' ? t('mi.voidBody') : t('mi.dispositionOnlyBody')}
            </p>
            {/* F468-2: "You can still void" is wrong when open 2330 > 0
                (server returns void_fulfilled_held). Show only when open = 0. */}
            {stipendAction.mode === 'void' && stipendAction.row?.status === 'fulfilled'
              && Number(stipendAction.row?.open_stipend_liability || 0) === 0 && (
              <p data-testid="mi-void-fulfilled-note" className="text-[12px] text-ink-700 dark:text-parchment-200">
                {t('mi.voidFulfilledNote')}
              </p>
            )}
            {stipendAction.mode === 'void' && (
              <div>
                <label htmlFor="mi-void-reason" className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">
                  {t('mi.voidReason')}
                </label>
                <input id="mi-void-reason" data-testid="mi-void-reason" type="text" value={voidForm.reason}
                  onChange={e => setVoidForm(f => ({ ...f, reason: e.target.value }))}
                  className={inputCls} />
              </div>
            )}
            {((stipendAction.mode === 'void' && Number(stipendAction.row?.open_stipend_liability || 0) > 0 && stipendAction.row?.status !== 'fulfilled') || (stipendAction.mode === 'disposition' && stipendAction.row?.status !== 'fulfilled')) ? (
              <div className="space-y-2">
                <label htmlFor="mi-disposition-kind" className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.disposition')}</label>
                <select id="mi-disposition-kind" data-testid="mi-disposition-kind" value={voidForm.kind}
                  onChange={e => setVoidForm(f => ({ ...f, kind: e.target.value }))}
                  className={inputCls}>
                  <option value="refunded">{t('mi.disposition.refunded')}</option>
                  <option value="transferred">{t('mi.disposition.transferred')}</option>
                  <option value="pastor_applied">{t('mi.disposition.pastor_applied')}</option>
                </select>
                {voidForm.kind === 'transferred' && (
                  <div>
                    <label htmlFor="mi-transfer-to" className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.transferTo')}</label>
                    <input id="mi-transfer-to" data-testid="mi-transfer-to" type="number" min="1" step="1" value={voidForm.transferTo}
                      onChange={e => setVoidForm(f => ({ ...f, transferTo: e.target.value }))}
                      className={inputCls} />
                  </div>
                )}
                {stipendAction.mode === 'disposition' && (
                  <div>
                    <label htmlFor="mi-disposition-reason" className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.dispositionReason')}</label>
                    <input id="mi-disposition-reason" data-testid="mi-disposition-reason" type="text" value={voidForm.dispositionReason}
                      onChange={e => setVoidForm(f => ({ ...f, dispositionReason: e.target.value }))}
                      className={inputCls} />
                  </div>
                )}
              </div>
            ) : null}
            {stipendErr && <p role="alert" className="text-[12px] text-rose-700 dark:text-rose-300">{stipendErr}</p>}
            <div className="flex items-center gap-2 pt-1">
              <button type="button" data-testid="mi-stipend-action-confirm" disabled={stipendBusy}
                onClick={submitStipendAction}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60">
                {stipendBusy ? <Loader2 size={13} className="animate-spin" /> : null}
                {stipendAction.mode === 'void' ? t('mi.voidConfirm') : t('mi.dispositionConfirm')}
              </button>
              <button type="button" onClick={closeStipendAction} disabled={stipendBusy}
                className="text-[12px] text-ink-500 dark:text-parchment-300/70 hover:underline">{t('mi.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </PageWrapper>
  )
}
