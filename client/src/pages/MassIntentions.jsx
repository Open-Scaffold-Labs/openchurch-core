import { useEffect, useId, useState, useCallback, useMemo, useRef } from 'react'
import { Flame, Plus, X, Pencil, Loader2, Search, Printer } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import RequesterMemberLink from '../components/RequesterMemberLink'
import EmptyState from '../components/EmptyState'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { formatStoredDate, formatLocalDate, calendarDay } from '../utils/dates'
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

export function formatMassOptionLabel(m) {
  if (!m) return ''
  const date = calendarDay(m.date)
  const time = m.start_time ? ` (${String(m.start_time).slice(0, 5)})` : ''
  const title = m.title || ''
  return `${date} — ${title}${time}`
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

export function formatMassChromeParts(m, dateLocale = 'en-US') {
  if (!m) return null
  const date = m.date ? formatStoredDate(String(m.date).slice(0, 10), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }, dateLocale) : ''
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

const emptyForm = { intention: '', requested_by: '', requested_by_client_id: null, requester_name: '', mass_date: '', stipend: '', status: 'open', note: '', calendar_event_id: '', departed: false }

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
function IntentionMassCell({ r, t, dateLocale }) {
  if (r.status === 'fulfilled' && !r.mass_date && !r.mass_title) {
    return (
      <span className="block text-[11px] italic text-ink-400 dark:text-parchment-400/60">
        {t('mi.massAsOfferedUnknown')}
      </span>
    )
  }
  return (
    <>
      {r.mass_date ? formatStoredDate(r.mass_date, undefined, dateLocale) : '—'}
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
function IntentionStatusCell({ r, t }) {
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
      {priorFulfilmentText(t, r, 'mi.previouslyRecorded') && (
        <span className="block mt-1 text-[11px] italic text-ink-500 dark:text-parchment-300/70">
          {priorFulfilmentText(t, r, 'mi.previouslyRecorded')}
        </span>
      )}
    </>
  )
}
function IntentionRowActions({ r, t, onEdit, onRemove }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => onEdit(r)} aria-label={t('mi.edit')}
        className="text-ink-400 hover:text-church-700 dark:hover:text-brass-300"><Pencil size={14} /></button>
      <button type="button" onClick={() => onRemove(r.id)} aria-label={t('mi.delete')}
        className="text-ink-400 hover:text-rose-700 dark:hover:text-rose-300"><X size={15} /></button>
    </div>
  )
}

export default function MassIntentions() {
  const { user } = useAuth()
  const { t, dateLocale } = useLocale()
  const toast = useToast()
  const phone = usePhoneLayout()
  const canWrite = user?.role === 'admin' || user?.role === 'staff'

  const [list,    setList]    = useState([])
  const [status,  setStatus]  = useState('')
  const [pastOnly, setPastOnly] = useState(false)
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
  const [searchParams, setSearchParams] = useSearchParams()
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

  const fetchPage = useCallback(async (offset, st, query, past) => {
    const unreadMessage = t('mi.loadFailed')
    const unread = () => new Error(unreadMessage)
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
      if (st) qs.set('status', st)
      if (query) qs.set('q', query)
      // SP-064: filtered by the server before pagination, never client-side.
      if (past) qs.set('view', 'past_scheduled')
      const res = await fetch(apiUrl(`/api/mass-intentions?${qs.toString()}`))
      if (!res.ok) throw unread()
      const d = await res.json()
      // Missing or non-array `intentions` is unread. `?? []` rendered that
      // as an empty book, including after a save whose reload came back wrong.
      if (!d || !Array.isArray(d.intentions)) throw unread()
      return d.intentions
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
    const timer = setTimeout(() => {
      fetchPage(0, status, q.trim(), pastOnly)
        .then(rows => { if (live()) { setList(rows); setDone(rows.length < PAGE_SIZE); setLoadError(null) } })
        .catch(err => {
          // The rows on screen belong to the previous filters; keeping them
          // under a failed read would present them as matching the new one.
          if (live()) { setList([]); setLoadError(err.message) }
        })
        // A same-query save reload may have replaced the list meanwhile; the
        // spinner still belongs to this query's first read.
        .finally(() => { if (queryGenRef.current === qg) setLoading(false) })
    }, 250)
    return () => { queryGenRef.current += 1; clearTimeout(timer) }
    // claimList only touches refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, q, pastOnly, fetchPage])

  const loadMore = async () => {
    const live = claimList({ replace: false })
    setMore(true); setLoadError(null)
    try {
      const rows = await fetchPage(list.length, status, q.trim(), pastOnly)
      if (!live()) return
      setList(prev => [...prev, ...rows])
      if (rows.length < PAGE_SIZE) setDone(true)
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
  const hopChrome = hopMass ? formatMassChromeParts(hopMass, dateLocale) : null
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
  const dateDisagrees = !fulfilledFrozen && intentionDateConflicts(form.mass_date, heldDay)
  if (noMassOnDate && !isIntentionDraftNonce(draftNonceRef.current)) {
    draftNonceRef.current = newIntentionDraftNonce()
  }
  const returnNonce = noMassOnDate ? draftNonceRef.current : ''
  const enteredLabel = form.mass_date
    ? formatLocalDate(form.mass_date, { weekday: 'short', month: 'short', day: 'numeric' }, dateLocale)
    : ''
  const heldDayLabel = heldDay
    ? formatLocalDate(heldDay, { weekday: 'short', month: 'short', day: 'numeric' }, dateLocale)
    : ''
  const massDateLabel = form.mass_date
    ? formatLocalDate(form.mass_date, { weekday: 'short', month: 'short', day: 'numeric' }, dateLocale)
    : ''

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
    setEditingId(null); setForm(emptyForm); setAdding(true); setError(null); loadMasses()
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
    setForm({ ...emptyForm, calendar_event_id, mass_date })
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
      calendar_event_id: calendar_event_id || (drafted?.calendar_event_id ?? ''),
      mass_date: mass_date || (drafted?.mass_date ?? ''),
      departed: Boolean(drafted?.departed),
      status: drafted?.status || emptyForm.status,
    })
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
      const rows = await fetchPage(0, status, q.trim(), pastOnly)
      if (!live()) return
      setList(rows); setDone(rows.length < PAGE_SIZE); setLoadError(null)
    } catch (err) {
      if (live()) setLoadError(err.message)
    }
  }

  const persistIntention = async (next) => {
    // Captured before any await: the query this save's reload belongs to.
    const saveQueryGen = queryGenRef.current
    if (!next.intention.trim()) { setError(t('mi.required')); return }
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
    if (!fulfilledFrozen && intentionDateConflicts(next.mass_date, massDay)) return
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
      status: next.status,
      note: next.note.trim() || (editing ? null : undefined),
    }
    let saved = false
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
                : t('err.save'))
        return
      }
      saved = true
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
      : (editing ? t('mi.updatedToast') : t('mi.addedToast')))
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

  const chooseMassDate = () => {
    const next = { ...form, mass_date: heldDay }
    setForm(next)
    persistIntention(next)
  }

  const clearAssignmentAndSave = () => {
    const next = {
      ...form,
      calendar_event_id: '',
      status: form.status === 'scheduled' ? 'open' : form.status,
    }
    setForm(next)
    persistIntention(next)
  }

  const onRemove = async (id) => {
    setError(null)
    try {
      const res = await fetch(apiUrl(`/api/mass-intentions/${id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) {
        const d = await res.json().catch(() => ({}))
        console.error('[MassIntentions] delete refused', {
          status: res.status,
          error: d && d.error != null ? d.error : null,
        })
        setError(t('mi.deleteFailed'))
        return
      }
      setList(l => l.filter(r => r.id !== id))
    } catch (err) {
      console.error('[MassIntentions] delete failed', err)
      setError(t('mi.deleteFailed'))
    }
  }

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500'

  return (
    <PageWrapper>
      <div
        data-testid="intention-book-header"
        className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-start sm:justify-between"
      >
        <div className="min-w-0 w-full sm:min-w-[16rem] sm:flex-1">
          <div className="flex items-start gap-2">
            <Flame size={20} className="shrink-0 mt-1 text-church-700 dark:text-brass-300" />
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-display font-bold text-ink-900 dark:text-parchment-50">{t('mi.title')}</h1>
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
                onChange={e => setForm(f => ({ ...f, intention: e.target.value }))} className={inputCls} />
              <label className="mt-2 flex items-center gap-2 text-[12px] text-ink-600 dark:text-parchment-300/80 cursor-pointer w-fit">
                <input
                  type="checkbox"
                  checked={form.departed}
                  onChange={e => setForm(f => ({ ...f, departed: e.target.checked }))}
                  className="h-3.5 w-3.5 accent-church-700"
                />
                <span>{t('mi.departed')} <span className="font-display">{DAGGER}</span></span>
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
                      ? formatMassOptionLabel(heldListedMass)
                      : heldAssignStatus === 'missing' ? t('mi.massUnknown')
                      : heldAssignStatus === 'failed' ? t('mi.massUnreachable')
                      : t('mi.massLookingUp')}
                  </option>
                )}
                {primaryAssign.map(m => (
                  <option key={String(m.id)} value={String(m.id)}>
                    {formatMassOptionLabel(m)}
                  </option>
                ))}
                {otherAssign.length > 0 && (
                  <optgroup label={t('mi.otherCalendarEntries')}>
                    {otherAssign.map(m => (
                      <option key={String(m.id)} value={String(m.id)}>
                        {formatMassOptionLabel(m)}
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
                      onClick={clearAssignmentAndSave}
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
                onChange={e => setForm(f => ({ ...f, stipend: e.target.value }))} className={inputCls} />
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
        <button type="button" aria-pressed={pastOnly} onClick={() => setPastOnly(v => !v)}
          data-testid="mi-past-filter"
          className={`px-3 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-church-500 ${pastOnly
            ? 'border-amber-600 bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
            : 'border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50'}`}>
          {t('mi.pastScheduledFilter')}
        </button>
        <div className="relative flex-1 min-w-[12rem]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input type="search" value={q} onChange={e => setQ(e.target.value)}
            placeholder={t('mi.search')} aria-label={t('mi.search')}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500" />
        </div>
      </div>

      {loadError && <p role="alert" className="mb-3 text-sm text-rose-700 dark:text-rose-300">{loadError}</p>}

      {error && !adding && <p role="alert" className="mb-3 text-sm text-rose-700 dark:text-rose-300">{error}</p>}

      {loading ? (
        <div role="status" aria-label={t('mi.loading')} className="flex justify-center py-16">
          <Loader2 size={22} className="animate-spin text-brass-600" aria-hidden="true" />
        </div>
      ) : loadError && list.length === 0 ? null : list.length === 0 && pastOnly && (status || q.trim()) ? (
        // R313-2: search/status narrow the past-scheduled view (AND on the
        // server). An empty result says only that nothing MATCHES them.
        <EmptyState icon={Flame} title={t('mi.pastScheduledNoMatchTitle')}
          body={t('mi.pastScheduledNoMatchBody')} />
      ) : list.length === 0 && pastOnly ? (
        <EmptyState icon={Flame} title={t('mi.pastScheduledEmptyTitle')}
          body={t('mi.pastScheduledEmptyBody')} />
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
                <div data-testid="mi-card-mass" className="min-w-0 flex-1 text-[12px] text-ink-600 dark:text-parchment-300/80">
                  <IntentionMassCell r={r} t={t} dateLocale={dateLocale} />
                </div>
                {canWrite && <div className="shrink-0"><IntentionRowActions r={r} t={t} onEdit={startEdit} onRemove={onRemove} /></div>}
              </div>
              <p className="mt-1.5 font-medium"><IntentionTextCell r={r} /></p>
              <dl data-testid="mi-card-fields" className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
                <dt className="text-ink-500 dark:text-parchment-300/70">{t('mi.requestedBy')}</dt>
                <dd className="min-w-0">{requesterText(r)}</dd>
                <dt className="text-ink-500 dark:text-parchment-300/70">{t('mi.offeringShort')}</dt>
                <dd>{fmtStipend(r.stipend) || '—'}</dd>
                <dt className="text-ink-500 dark:text-parchment-300/70">{t('mi.status')}</dt>
                <dd><IntentionStatusCell r={r} t={t} /></dd>
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
                  <td className="px-4 py-2.5 whitespace-nowrap"><IntentionMassCell r={r} t={t} dateLocale={dateLocale} /></td>
                  <td className="px-4 py-2.5 font-medium"><IntentionTextCell r={r} /></td>
                  <td className="px-4 py-2.5">{requesterText(r)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{fmtStipend(r.stipend) || '—'}</td>
                  <td className="px-4 py-2.5"><IntentionStatusCell r={r} t={t} /></td>
                  {canWrite && (
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <IntentionRowActions r={r} t={t} onEdit={startEdit} onRemove={onRemove} />
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
    </PageWrapper>
  )
}
