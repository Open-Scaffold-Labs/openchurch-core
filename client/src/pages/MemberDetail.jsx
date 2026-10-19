import { useEffect, useId, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ChevronLeft, Mail, Phone, Building2, Calendar, CalendarOff,
  Activity, Heart, AlertTriangle, Loader2, Target, Plus, X, UserCheck, History, Church, Pencil,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useLoad } from '../hooks/useLoad'
import { useLocale } from '../i18n'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadFailure from '../components/LoadFailure'
import CalendarSync from '../components/CalendarSync'
import { apiUrl } from '../api'
import { formatStoredDate } from '../utils/dates'
import { initials } from '../utils/format'
import { LIT_COLOR_DOT, LIT_COLOR_TEXT } from '../utils/liturgicalColors'

// Full-route member profile (Sprint M / M.2). The Clients page slide-
// over remains for quick-view; "Open full profile" links here when an
// admin needs the deeper picture — donation history, birthday feast,
// calendar feed token, full notes.
//
// Data sources:
//   - GET /api/clients/:id          → member core record
//   - GET /api/clients/:id/donations → matched-by-email donation list
//   - GET /api/liturgical?date=birth → feast-day overlap (same logic
//                                      as the slide-over from L.2)
// All three fire in parallel on mount. /api/liturgical is private-
// cached 1h server-side, so it's effectively free after the first hit.

// Parchment & Brass: one avatar color for the whole parish. A member
// directory is not a chat workspace — identity comes from the name and
// initials, not a hashed rainbow.
function avatarColor() {
  return 'bg-church-800 dark:bg-church-700'
}

const STATUS_COLORS = {
  active:   'bg-parchment-200/80 text-ink-700 dark:bg-ink-800 dark:text-parchment-200',
  inactive: 'bg-parchment-100 text-ink-500 dark:bg-ink-800/60 dark:text-parchment-300/60',
}

function fmtCurrency(n) {
  return Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

// Same read rules as the pledges book: a figure counts only as a finite
// number or a plain decimal string (including zero). Booleans, arrays,
// objects, and blanks are not zero.
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

function fmtKnownCurrency(n, unavailable) {
  const v = knownNumber(n)
  if (v == null) return unavailable
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

function isPledgeRow(row) {
  return !!row && typeof row === 'object' && !Array.isArray(row)
    && positiveIntId(row.id) != null && typeof row.frequency === 'string'
}

// `{ pledges: null }`, a bare array, or a row without a canonical id is
// not an empty pledge list for this member.
function asPledgeList(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (!Array.isArray(body.pledges)) return null
  if (body.pledges.some(row => !isPledgeRow(row))) return null
  return body.pledges
}
function fmtDateLong(iso) {
  if (!iso) return null
  const [y, m, d] = iso.split('T')[0].split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  })
}
function fmtBirthMonthDay(iso) {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
}

// Swap-link admin sub-section (VS.2b). Generates a per-member
// magic link via POST /api/swap-admin/clients/:id/rotate-token; the
// token is only surfaced for the current page-load (GitHub-PAT-style)
// so it doesn't sit around in the UI on every reload. Rotating
// invalidates the previous link.
function SwapLinkSection({ clientId, clientName }) {
  const { t } = useLocale()
  const [busy,   setBusy]   = useState(false)
  const [token,  setToken]  = useState(null)
  const [copied, setCopied] = useState(false)
  const [error,  setError]  = useState(null)

  const swapUrl = token ? `${window.location.origin}/p/swap/${token}` : null

  const onGenerate = async () => {
    setBusy(true); setError(null); setCopied(false)
    let res
    try {
      res = await fetch(apiUrl(`/api/swap-admin/clients/${clientId}/rotate-token`), {
        method: 'POST',
      })
    } catch (err) {
      setError(t('err.save'))
      setBusy(false)
      return
    }
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      setError(data.error || t('member.failedStatus', { status: res.status }))
      return
    }
    setToken(data.swap_token)
  }

  const onCopy = async () => {
    if (!swapUrl) return
    try {
      await navigator.clipboard.writeText(swapUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError(t('member.copyFailed'))
    }
  }

  return (
    <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
          {t('member.swapLink')}
        </h2>
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-church-900 dark:border-parchment-100 text-church-900 dark:text-parchment-100 hover:bg-church-900 hover:text-parchment-50 dark:hover:bg-parchment-100 dark:hover:text-church-900 transition-colors disabled:opacity-40"
        >
          {busy ? t('member.generating') : (token ? t('member.rotateLink') : t('member.generateLink'))}
        </button>
      </div>
      <p className="text-[12px] text-ink-500 dark:text-parchment-300/70 leading-snug">
        A private link {clientName} can use to view their upcoming events
        and request swaps — no login required. Rotating invalidates the
        old link.
      </p>
      {token && swapUrl && (
        <div className="space-y-2">
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={swapUrl}
              onFocus={e => e.target.select()}
              className="flex-1 min-w-0 px-3 py-2 text-xs font-mono rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-700 dark:text-parchment-200 focus:outline-none focus:ring-2 focus:ring-church-500"
            />
            <button
              type="button"
              onClick={onCopy}
              className="px-3 py-2 text-xs font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity shrink-0"
            >
              {copied ? t('member.copied') : t('member.copy')}
            </button>
          </div>
          <p className="text-[11px] text-amber-700 dark:text-amber-300">
            Save this somewhere — the link won&apos;t be shown again after you
            leave the page. Rotating any time produces a fresh one.
          </p>
        </div>
      )}
      {!token && !busy && (
        <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">
          No link generated this session.
        </p>
      )}
      {error && (
        <p className="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>
      )}
    </section>
  )
}

// Attendance history (CHK.4) — the services this member checked in to.
// Self-fetching like the other profile sub-sections; hides itself when
// there's no attendance on file.
function fmtServiceDate(v) {
  if (!v) return ''
  const [y, m, d] = String(v).slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Historical attendance on the profile. A missing stamp is unknown —
// never a live Schedule title presented as what they attended.
export function attendedHistoryLabel(row, t) {
  const title = typeof row?.event_title === 'string' ? row.event_title.trim() : ''
  return title || t('checkin.attendedUnknown')
}

export function attendedHistoryDateLabel(row, t) {
  if (!row?.event_date) return t('checkin.attendedDateUnknown')
  return fmtServiceDate(row.event_date)
}

// Positive integer IDs only — same contract as the check-in desk.
export function parseMemberId(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isInteger(n) || n <= 0 || String(n) !== s) return null
  return n
}

// Check-in opened this profile with the Mass already named. Return there.
// A missing or garbled event stays on the Members roll — we do not invent a service.
export function memberReturnHome(searchParams) {
  const from = searchParams?.get?.('from')
  const event = parseMemberId(searchParams?.get?.('event'))
  if (from === 'checkin' && event) {
    return { to: `/checkin?event=${event}`, labelKey: 'member.backCheckin' }
  }
  return { to: '/clients', labelKey: 'member.backMembers' }
}

// Attendance row → that Mass, carrying this person so the desk can return.
export function attendanceServiceHref(eventId, clientId) {
  const event = parseMemberId(eventId)
  if (!event) return null
  const person = parseMemberId(clientId)
  return person
    ? `/checkin?event=${event}&from=member&client=${person}`
    : `/checkin?event=${event}`
}

function AttendanceSection({ clientId }) {
  const { t } = useLocale()
  const [list, setList] = useState(null)
  // A refused attendance read is not "never attended". It used to become
  // [], and an empty list hides this section, so a 500 looked exactly like
  // a parishioner with no attendance history. Hidden stays reserved for a
  // real empty answer; a failed read says so and offers a retry.
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    fetch(apiUrl(`/api/clients/${clientId}/checkins`))
      .then(async r => {
        if (!r.ok) throw new Error('checkins')
        const d = await r.json()
        if (!Array.isArray(d?.checkins)) throw new Error('checkins')
        return d.checkins
      })
      .then(rows => { if (!cancelled) setList(rows) })
      .catch(() => { if (!cancelled) { setList(null); setFailed(true) } })
    return () => { cancelled = true }
  }, [clientId, attempt])

  if (failed) {
    return (
      <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
        <div className="flex items-center gap-2">
          <UserCheck size={14} className="text-brass-700 dark:text-brass-300" />
          <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">{t('member.attendance')}</h2>
        </div>
        <LoadFailure
          variant="strip"
          title={t('load.failedTitle')}
          body={t('load.failedBody')}
          onRetry={() => setAttempt(a => a + 1)}
        />
      </section>
    )
  }

  if (!list || list.length === 0) return null

  return (
    <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
      <div className="flex items-center gap-2">
        <UserCheck size={14} className="text-brass-700 dark:text-brass-300" />
        <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">{t('member.attendance')}</h2>
      </div>
      <ul className="space-y-1.5">
        {list.slice(0, 8).map(c => {
          const serviceHref = attendanceServiceHref(c.event_id, clientId)
          return (
          <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
            {/* The row already knows which service this was — the API returns
                event_id alongside the title. It used to be dead text, so
                "who else was at that Mass" meant finding it again by hand.
                The service opens where its attendance lives. The person
                travels with the Mass so the desk can return here. */}
            {serviceHref ? (
              <Link
                to={serviceHref}
                className="text-ink-800 dark:text-parchment-100 truncate hover:text-church-800 dark:hover:text-brass-200 hover:underline"
                title={c.event_title
                  ? `Open check-in for ${c.event_title}`
                  : t('checkin.attendedUnknown')}
              >
                {attendedHistoryLabel(c, t)}
              </Link>
            ) : (
              <span className="text-ink-800 dark:text-parchment-100 truncate">{attendedHistoryLabel(c, t)}</span>
            )}
            <span className="text-xs text-ink-500 dark:text-parchment-300/70 shrink-0">{attendedHistoryDateLabel(c, t)}</span>
          </li>
          )
        })}
      </ul>
      <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">
        {list.length} service{list.length === 1 ? '' : 's'} attended
      </p>
    </section>
  )
}

// Format a 'YYYY-MM-DD' range for display; collapses a single-day range
// to one date.
function fmtRange(start, end) {
  const f = iso => {
    const [y, m, d] = iso.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return start === end ? f(start) : `${f(start)} – ${f(end)}`
}

// Availability / blackout-date editor (VS.4b). Lists a member's
// unavailability ranges and lets an admin add/remove them. The rotation
// auto-fill (VS.4a) reads these to skip the member, and the EventModal
// warns when they're assigned on a blacked-out date.
function AvailabilitySection({ clientId, clientName }) {
  const { t } = useLocale()
  const [list,    setList]    = useState([])
  const [loading, setLoading] = useState(true)
  // A refused or dropped read is not "No blackout dates." It used to
  // become [] (or leave the initial []), so a 500 told the secretary this
  // person could serve any day, right above the form for adding the very
  // dates the rotation auto-fill relies on. The list is only an answer
  // when the server gave one.
  const [readFailed, setReadFailed] = useState(false)
  const [form,    setForm]    = useState({ start_date: '', end_date: '', reason: '' })
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState(null)

  // R310-2: a retry and the post-add refresh can overlap. Only the latest
  // read may commit rows / readFailed / loading; an older one (an empty
  // retry, a failure, or its finally) that lands late is dropped. A change
  // of member or unmount retires whatever is in flight.
  const readGen = useRef(0)
  const load = async () => {
    const gen = ++readGen.current
    const live = () => gen === readGen.current
    try {
      const res = await fetch(apiUrl(`/api/availability?client_id=${clientId}`))
      if (!live()) return
      if (!res.ok) throw new Error('availability')
      const d = await res.json()
      if (!live()) return
      if (!Array.isArray(d?.unavailability)) throw new Error('availability')
      setList(d.unavailability)
      setReadFailed(false)
    } catch {
      if (live()) setReadFailed(true)
    } finally { if (live()) setLoading(false) }
  }
  const retryLoad = () => { setLoading(true); load() }
  useEffect(() => {
    load()
    return () => { readGen.current++ }
  }, [clientId])

  const onAdd = async (e) => {
    e.preventDefault()
    if (!form.start_date) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(apiUrl('/api/availability'), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:  clientId,
          start_date: form.start_date,
          end_date:   form.end_date || form.start_date,
          reason:     form.reason || undefined,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || t('member.failedStatus', { status: res.status }))
      }
      setForm({ start_date: '', end_date: '', reason: '' })
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async (id) => {
    setError(null)
    try {
      const res = await fetch(apiUrl(`/api/availability/${id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(t('member.failedStatus', { status: res.status }))
      setList(l => l.filter(u => u.id !== id))
    } catch (err) {
      setError(err.message)
    }
  }

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500'

  return (
    <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
      <div className="flex items-center gap-2">
        <CalendarOff size={14} className="text-brass-700 dark:text-brass-300" />
        <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
          {t('member.availability')}
        </h2>
      </div>
      <p className="text-[12px] text-ink-500 dark:text-parchment-300/70 leading-snug">
        Dates {clientName} can&apos;t serve. The rotation auto-fill skips
        these, and the schedule warns if you assign them anyway.
      </p>

      {loading ? (
        <div className="flex justify-center py-3">
          <Loader2 size={16} className="animate-spin text-brass-600" />
        </div>
      ) : readFailed ? (
        <LoadFailure
          variant="strip"
          title={t('load.failedTitle')}
          body={t('load.failedBody')}
          onRetry={retryLoad}
        />
      ) : list.length === 0 ? (
        <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">
          No blackout dates.
        </p>
      ) : (
        <ul className="space-y-2">
          {list.map(u => (
            <li
              key={u.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-100 dark:bg-ink-800 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-800 dark:text-parchment-100">
                  {fmtRange(u.start_date, u.end_date)}
                </p>
                {u.reason && (
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 truncate">{u.reason}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(u.id)}
                aria-label="Remove blackout date"
                className="shrink-0 -m-1 p-1 text-ink-400 hover:text-rose-700 dark:hover:text-rose-300 transition-colors"
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onAdd} className="space-y-2 pt-1 border-t border-parchment-300/50 dark:border-brass-900/25">
        <div className="grid grid-cols-2 gap-2 pt-2">
          <div>
            <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">From</label>
            <input
              type="date"
              value={form.start_date}
              onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">
              To <span className="font-normal text-ink-400 dark:text-parchment-300/70">(optional)</span>
            </label>
            <input
              type="date"
              value={form.end_date}
              min={form.start_date || undefined}
              onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
              className={inputCls}
            />
          </div>
        </div>
        <input
          type="text"
          value={form.reason}
          onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
          placeholder="Reason (optional) — e.g. Vacation"
          className={inputCls}
        />
        <button
          type="submit"
          disabled={busy || !form.start_date}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          <Plus size={13} /> {busy ? t('member.adding') : t('member.addBlackout')}
        </button>
      </form>

      {error && (
        <p className="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>
      )}
    </section>
  )
}

// Sacramental register (SAC.1) — a member's sacraments received. Reads for
// everyone; add/remove is staff/admin (the server enforces the same via the
// writeGate, this just hides the controls from viewers).
const SACRAMENT_ORDER = [
  'baptism',
  'reconciliation',
  'first_communion',
  'confirmation',
  'marriage',
  'holy_orders',
  'anointing',
  'burial',
]
const SACRAMENT_TYPES = new Set(SACRAMENT_ORDER)

function sacramentLabel(t, type) {
  const key = `sac.${type}`
  const label = t(key)
  return label === key ? type : label
}

function SacramentsSection({ clientId, clientName }) {
  const { user } = useAuth()
  const { t } = useLocale()
  const canWrite = user?.role === 'admin' || user?.role === 'staff'

  const [adding,  setAdding]  = useState(false)
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState(null)
  const emptyForm = { type: 'baptism', date: '', minister: '', place: '', certificate_no: '', notes: '' }
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState(null) // null = adding a new record
  // REG.1 (migration 073): the server will not amend a register entry without
  // a reason, and this form never had a field for one — so every edit made
  // from a member profile came back "A reason is required to change the
  // register" and no correction was possible from here at all.
  const [reason, setReason] = useState('')
  const formId = useId().replace(/:/g, '')

  // Pass 6 wrote this load by hand: keep the last known list on failure,
  // report a failed post-write refresh, and never let a failed read reach
  // "No sacraments recorded yet." Pass 7 replaces it with the shared
  // primitive, and the nine tests written against the hand-written version
  // are the acceptance criteria — the correct behaviour does not bend to fit
  // the abstraction.
  //
  // `reload()` returns true/false, which is what the save path branches on.
  const sacraments = useLoad(async () => {
    const res = await fetch(apiUrl(`/api/sacraments?client_id=${clientId}`))
    if (!res.ok) throw new Error(t('member.failedStatus', { status: res.status }))
    const data = await res.json()
    // `{ records: null }` and a non-array are unread. `?? []` said
    // "No sacraments recorded yet."
    if (!data || !Array.isArray(data.records)) throw new Error(t('member.entriesUnread'))
    return data.records
  }, [clientId])

  const list      = sacraments.data ?? []
  const loading   = sacraments.state === 'loading'
  const loadError = sacraments.error
  const load      = sacraments.reload

  const closeForm = () => { setAdding(false); setEditingId(null); setForm(emptyForm); setReason(''); setError(null) }

  const startAdd = () => { setEditingId(null); setForm(emptyForm); setReason(''); setAdding(true); setError(null) }

  const startEdit = (r) => {
    setEditingId(r.id)
    setForm({
      type: r.type,
      date: r.date || '',
      minister: r.minister || '',
      place: r.place || '',
      certificate_no: r.certificate_no || '',
      notes: r.notes || '',
    })
    setReason('')
    setAdding(true)
    setError(null)
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!SACRAMENT_TYPES.has(form.type)) return
    setBusy(true); setError(null)
    // Editing PATCHes the record; adding POSTs a new one linked to this member.
    // Send explicit nulls on edit so cleared fields are actually cleared.
    const editing = editingId != null
    const payload = editing
      ? {
          type: form.type,
          date: form.date || null,
          minister: form.minister || null,
          place: form.place || null,
          certificate_no: form.certificate_no || null,
          notes: form.notes || null,
          reason: reason.trim(),
        }
      : {
          client_id: clientId,
          type: form.type,
          date: form.date || undefined,
          minister: form.minister || undefined,
          place: form.place || undefined,
          certificate_no: form.certificate_no || undefined,
          notes: form.notes || undefined,
        }
    try {
      const res = await fetch(apiUrl(editing ? `/api/sacraments/${editingId}` : '/api/sacraments'), {
        method:  editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || t('member.failedStatus', { status: res.status }))
      }
      const saved = editing ? t('member.savedWhatCorrection') : t('member.savedWhatRecord')
      closeForm()
      // The write landed. If the reload does not, say so — the list on
      // screen is now older than the truth, and silence here is what made a
      // saved baptism look like it was never entered.
      const refreshed = await load()
      if (!refreshed) {
        setError(t('member.savedListStale', { what: saved }))
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // REG.1: DELETE /api/sacraments/:id answers 405 for everyone, on purpose —
  // a register entry is retired by VOIDING, never erased. This button called
  // it anyway and reported the refusal as "Failed (405)", throwing away the
  // server's own instruction. There is no void UI yet (see the Pass 6
  // report), so the honest thing is to say what the register's rule is
  // rather than offer an erasure that cannot happen.
  const onRemove = async (recId) => {
    setError(null)
    try {
      const res = await fetch(apiUrl(`/api/sacraments/${recId}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || t('member.failedStatus', { status: res.status }))
      }
      // The list is the hook's now, so a successful removal re-reads rather
      // than editing a local copy. This path is unreachable today — the
      // server answers 405 for everyone — but leaving it to mutate state the
      // hook owns would be a landmine for whoever wires up voiding.
      await sacraments.reload()
    } catch (err) {
      setError(err.message)
    }
  }

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500'

  return (
    <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Church size={14} className="text-brass-700 dark:text-brass-300" />
        <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
          {t('member.sacraments')}
        </h2>
      </div>
      <p className="text-[12px] text-ink-500 dark:text-parchment-300/70 leading-snug">
        {t('member.sacramentsSub', { name: clientName })}
      </p>

      {loading ? (
        <div className="flex justify-center py-3">
          <Loader2 size={16} className="animate-spin text-brass-600" />
        </div>
      ) : sacraments.state === 'failed' ? (
        /* UNREAD, not empty. */
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          {t('member.sacramentsUnread')}
          <span className="text-ink-500 dark:text-parchment-300/70"> ({loadError})</span>.
          {' '}{t('member.sacramentsUnreadHint')}
        </p>
      ) : list.length === 0 ? (
        <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">
          {t('register.emptyTitle')}
        </p>
      ) : (
        <ul className="space-y-2">
          {list.map(r => (
            <li
              key={r.id}
              className="flex items-start justify-between gap-2 rounded-lg border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-100 dark:bg-ink-800 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-800 dark:text-parchment-100">
                  {sacramentLabel(t, r.type)}
                  {r.date && (
                    <span className="text-ink-500 dark:text-parchment-300/70 font-normal">
                      {' · '}{formatStoredDate(r.date)}
                    </span>
                  )}
                </p>
                {(r.minister || r.place) && (
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 truncate">
                    {[r.minister, r.place].filter(Boolean).join(' — ')}
                  </p>
                )}
                {r.certificate_no && (
                  <p className="text-[11px] text-ink-400 dark:text-parchment-300/60">{t('register.certLine', { n: r.certificate_no })}</p>
                )}
                {r.notes && (
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">{r.notes}</p>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-2">
                <Link
                  to={`/register/${r.id}/certificate?from=member`}
                  className="text-[11px] font-semibold text-church-700 dark:text-brass-300 hover:underline"
                >
                  {t('register.certificate')}
                </Link>
                {canWrite && (
                  <>
                    <button
                      type="button"
                      onClick={() => startEdit(r)}
                      aria-label={t('register.editRecord', { sacrament: t(`sac.${r.type}`) })}
                      className="-m-1 p-1 text-ink-400 hover:text-church-700 dark:hover:text-brass-300 transition-colors"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(r.id)}
                      aria-label={t('register.removeRecord', { sacrament: t(`sac.${r.type}`) })}
                      className="-m-1 p-1 text-ink-400 hover:text-rose-700 dark:hover:text-rose-300 transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {sacraments.isStale && (
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400">
          {t('member.listStale', { detail: loadError })}
        </p>
      )}

      {error && (
        <p role="status" className="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>
      )}

      {canWrite && !adding && (
        <button
          type="button"
          onClick={startAdd}
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-church-700 dark:text-brass-300 hover:underline"
        >
          <Plus size={13} /> {t('member.recordSacrament')}
        </button>
      )}

      {canWrite && adding && (
        <form onSubmit={onSubmit} className="space-y-2 pt-1 border-t border-parchment-300/50 dark:border-brass-900/25">
          <p className="pt-2 text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">
            {editingId ? t('member.editSacramentRecord') : t('member.newSacramentRecord')}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <label htmlFor={`${formId}-type`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('register.sacrament')}</label>
              <select
                id={`${formId}-type`}
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                className={inputCls}
              >
                {SACRAMENT_ORDER.map(type => (
                  <option key={type} value={type}>{sacramentLabel(t, type)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${formId}-date`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('register.date')}</label>
              <input id={`${formId}-date`} type="date" value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label htmlFor={`${formId}-minister`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('register.minister')}</label>
              <input id={`${formId}-minister`} type="text" value={form.minister} placeholder="Fr. …"
                onChange={e => setForm(f => ({ ...f, minister: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label htmlFor={`${formId}-place`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('register.place')}</label>
              <input id={`${formId}-place`} type="text" value={form.place} placeholder="Parish / church"
                onChange={e => setForm(f => ({ ...f, place: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label htmlFor={`${formId}-cert`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('member.certificateNo')}</label>
              <input id={`${formId}-cert`} type="text" value={form.certificate_no}
                onChange={e => setForm(f => ({ ...f, certificate_no: e.target.value }))} className={inputCls} />
            </div>
            <div className="col-span-2">
              <label htmlFor={`${formId}-notes`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('record.f.notes')}</label>
              <input id={`${formId}-notes`} type="text" value={form.notes} placeholder="Sponsor, godparents, etc."
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className={inputCls} />
            </div>

            {/* REG.1 — a register entry is corrected by amendment, and an
                amendment without a reason is just an overwrite. The server
                has required this since migration 073; this form did not ask
                for it, so every correction attempted from a member profile
                failed with "A reason is required to change the register".
                Only on edit: a first entry is not a correction of anything. */}
            {editingId != null && (
              <div className="col-span-2">
                <label htmlFor={`${formId}-reason`} className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">
                  Reason for this correction
                </label>
                <input id={`${formId}-reason`} type="text" value={reason} required minLength={3}
                  aria-describedby={`${formId}-reason-hint`}
                  placeholder="e.g. minister's name was misspelled in the original entry"
                  onChange={e => setReason(e.target.value)} className={inputCls} />
                <p id={`${formId}-reason-hint`} className="mt-1 text-[10px] text-ink-500 dark:text-parchment-300/70">
                  Kept with the entry, dated and attributed, so the register shows what changed and why.
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy || (editingId != null && reason.trim().length < 3)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {editingId ? t('member.saveChanges') : t('member.save')}
            </button>
            <button type="button" onClick={closeForm}
              className="text-[12px] text-ink-500 dark:text-parchment-300/70 hover:underline">
              {t('mem.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

// The donations read, on its own so the panel can retry it alone. A failure
// resolves to a marked value rather than an empty one: `{ lines: [] }` is
// the shape of a parishioner who has never given, and a dropped connection
// must not be allowed to wear it. (C5)
async function readDonations(id, t) {
  try {
    const r = await fetch(apiUrl(`/api/clients/${id}/donations`))
    if (!r.ok) return { failed: true, error: t('member.failedStatus', { status: r.status }) }
    const body = await r.json()
    // A 200 of {} (or any body whose lines are not a list) is not an empty
    // history. Rendering it used to throw on lines.slice and unmount the
    // profile. No amount is invented and none is rewritten.
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.lines)) {
      return { failed: true }
    }
    return body
  } catch (e) {
    return { failed: true, error: e?.message || t('member.failedToLoad') }
  }
}

// Active pledges for this member. A refused or shapeless book is not
// "no pledges" — the section says the read failed and can be retried.
// Non-admins never call this; the endpoint is admin-only.
async function readMemberPledges(memberId) {
  const want = positiveIntId(memberId)
  if (want == null) return { failed: true }
  try {
    const res = await fetch(apiUrl('/api/pledges?status=active'))
    if (!res.ok) return { failed: true }
    const body = await res.json()
    const list = asPledgeList(body)
    if (!list) return { failed: true }
    return {
      failed: false,
      pledges: list.filter(p => positiveIntId(p.member_id) === want),
    }
  } catch {
    return { failed: true }
  }
}

export default function MemberDetail() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const { t } = useLocale()
  const isAdmin = user?.role === 'admin'
  const isViewer = user?.role === 'viewer'
  const home = memberReturnHome(searchParams)
  const [member, setMember] = useState(null)
  const [donations, setDonations] = useState(null)
  const [birthFeast, setBirthFeast] = useState(null)
  const [pledges, setPledges] = useState(null) // null until fetched (admin-only)
  // A refused or shapeless read is not an empty list. The section stays
  // visible and offers retry; it never hides as "no pledges".
  const [pledgesFailed, setPledgesFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  // Which member the last error is an answer about. A 404 or 500 for Alpha
  // is not an answer about Omega: ⌘K and in-app links change :id without
  // unmounting this page, and the previous err used to keep saying
  // "Member not found" after Omega had already loaded.
  const [errForId, setErrForId] = useState(null)
  // Bumped by "Try again" so the effect below re-runs for the same id.
  const [attempt, setAttempt] = useState(0)
  const retry = () => { setErr(''); setErrForId(null); setAttempt(a => a + 1) }
  const [giftsRetrying, setGiftsRetrying] = useState(false)
  // The member this page is showing NOW, readable from inside an async
  // handler that started under a previous one. The main effect guards its
  // own reads with `cancelled`. A retry pressed on Alpha and resolving
  // after the secretary had moved on to Omega filed Alpha's gifts under
  // Omega's name. Data belongs to the member it was fetched for, or it
  // is not filed at all. The same rule applies to `err` and to the
  // profile header: a render-time id check, not an effect reset, is what
  // stops Alpha's answer from wearing Omega's URL for even one frame.
  const idRef = useRef(id)
  idRef.current = id
  // Latest pledge read for the member on screen. A retry and the load
  // started for the previous member can be in flight together; only the
  // newest one may write.
  const pledgeGen = useRef(0)
  const retryPledges = async () => {
    const forId = id
    const gen = ++pledgeGen.current
    const pl = await readMemberPledges(forId)
    if (gen !== pledgeGen.current || String(idRef.current) !== String(forId)) return
    setPledges(pl.failed ? null : pl.pledges)
    setPledgesFailed(pl.failed)
  }
  const retryGifts = async () => {
    const forId = id
    setGiftsRetrying(true)
    try {
      const d = await readDonations(forId, t)
      if (idRef.current === forId) setDonations(d)
    } finally {
      if (idRef.current === forId) setGiftsRetrying(false)
    }
  }

  useEffect(() => {
    if (!id) return
    let cancelled = false
    const pledgeRead = ++pledgeGen.current
    setLoading(true)
    setErr('')
    setErrForId(null)
    setDonations(null)
    setBirthFeast(null)
    setPledges(null)
    setPledgesFailed(false)

    fetch(apiUrl(`/api/clients/${id}`))
      .then(async r => {
        if (r.status === 404) throw new Error('not-found')
        if (!r.ok) throw new Error(t('member.failedStatus', { status: r.status }))
        return r.json()
      })
      .then(async m => {
        if (cancelled) return
        // A 200 `{}` (or any body without a matching id) never set errHere
        // and never yielded memberHere, so the profile spun forever. That is
        // not "Member not found" and not a successful load — refuse it as a
        // failed read so LoadFailure can speak.
        if (
          !m
          || typeof m !== 'object'
          || Array.isArray(m)
          || String(m.id) !== String(id)
          // A matching id is not a profile. The book returns a flat row
          // with the name on the record (NOT NULL). A wrapper
          // `{ id, client: { name } }` used to paint an empty header.
          // A blank stored name is still a real row: it renders, so the
          // record can be opened and corrected (PATCH refuses new blanks).
          || typeof m.name !== 'string'
        ) {
          throw new Error(t('member.failedToLoad'))
        }
        setErr('')
        setErrForId(null)
        setMember(m)

        // Fan out — donations + feast lookup. Neither may cost the reader
        // the profile itself; the donations panel says so for itself when
        // its read fails, the feast simply goes unshown.
        const dPromise = isViewer ? Promise.resolve(null) : readDonations(id, t)

        const fPromise = m.birth_date
          ? fetch(apiUrl(`/api/liturgical?date=${m.birth_date}`))
              .then(r => r.ok ? r.json() : null)
              .then(d => d?.feast_name ? d : null)
              .catch(() => null)
          : Promise.resolve(null)

        // Pledges (Sprint D / D.3) — admin-only endpoint, so non-
        // admins get a no-op resolve. Filter client-side to this
        // member's pledges to avoid a per-member server endpoint.
        const plPromise = isAdmin ? readMemberPledges(id) : Promise.resolve(null)

        const [d, f, pl] = await Promise.all([dPromise, fPromise, plPromise])
        if (cancelled || pledgeRead !== pledgeGen.current) return
        setDonations(d)
        setBirthFeast(f)
        if (pl == null) {
          setPledges(null)
          setPledgesFailed(false)
        } else {
          setPledges(pl.failed ? null : pl.pledges)
          setPledgesFailed(pl.failed)
        }
      })
      .catch(e => { if (!cancelled) { setErr(e.message); setErrForId(id) } })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true; pledgeGen.current += 1 }
  }, [id, attempt, isViewer])

  // RENDER-TIME identity. An effect that only resets `err`/`member` still
  // paints one frame of Alpha under Omega's URL — enough to be read and
  // enough, after a 404, to leave "Member not found" parked on a member
  // who loaded. Same rule as useLoad: data is surfaced only while it
  // belongs to the key being asked for now.
  const errHere = err && errForId != null && String(errForId) === String(id) ? err : ''
  const memberHere = member && String(member.id) === String(id) ? member : null

  if (loading || (!memberHere && !errHere)) {
    return (
      <PageWrapper>
        <div className="flex items-center justify-center py-24">
          <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      </PageWrapper>
    )
  }

  // Not-found is the server's answer, and only the server's. Every other
  // way of arriving here without a member — a 500, a dropped connection —
  // is the ABSENCE of an answer, and used to be shown as this same screen:
  // "This member doesn't exist or belongs to another organization," said of
  // a member who was there the whole time. (C5)
  if (errHere === 'not-found') {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16 space-y-4">
          <EmptyState
            icon={AlertTriangle}
            title={t('member.notFound')}
            body={t('member.notFoundBody')}
          />
          <Link
            to={home.to}
            className="tap inline-flex items-center gap-1.5 text-sm font-semibold text-church-700 dark:text-brass-300 hover:underline"
          >
            <ChevronLeft size={16} /> {t(home.labelKey)}
          </Link>
        </div>
      </PageWrapper>
    )
  }
  if (errHere || !memberHere) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-10 space-y-4">
          <LoadFailure body={t('member.loadFailedBody')} cause={errHere || undefined} onRetry={retry} />
          <Link to={home.to} className="tap inline-flex items-center gap-1 text-sm text-church-700 dark:text-brass-300 hover:underline">
            <ChevronLeft size={16} /> {t(home.labelKey)}
          </Link>
        </div>
      </PageWrapper>
    )
  }

  const tags = member.tags ? member.tags.split(',').filter(Boolean) : []

  return (
    <PageWrapper>
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Back link + (admin) this member's audit trail (AUD.3) */}
        <div className="flex items-center justify-between gap-3">
          <Link
            to={home.to}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-church-700 dark:text-brass-300 hover:underline"
          >
            <ChevronLeft size={15} /> {t(home.labelKey)}
          </Link>
          {isAdmin && (
            <Link
              to={`/audit?entity_type=client&entity_id=${id}`}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-500 dark:text-parchment-300/70 hover:text-ink-900 dark:hover:text-parchment-50 transition-colors"
              title={t('member.viewHistoryTitle')}
            >
              <History size={14} /> {t('member.viewHistory')}
            </Link>
          )}
        </div>

        {/* Header: avatar + name + status pill */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 flex flex-col sm:flex-row sm:items-center gap-5"
        >
          {member.avatar ? (
            <img
              src={member.avatar}
              alt={`${member.name}'s photo`}
              className="w-20 h-20 rounded-full object-cover shadow-warm-md shrink-0"
            />
          ) : (
            <div className={`w-20 h-20 rounded-full flex items-center justify-center text-parchment-50 font-display text-2xl font-semibold shadow-warm-md shrink-0 ${avatarColor(member.name)}`}>
              {initials(member.name)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
              {member.name}
            </h1>
            {member.company && (
              <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-0.5">{member.company}</p>
            )}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full capitalize ${STATUS_COLORS[member.status] || STATUS_COLORS.active}`}>
                {t(`mem.status.${member.status}`) === `mem.status.${member.status}` ? member.status : t(`mem.status.${member.status}`)}
              </span>
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200">
                {t(`mem.role.${member.role}`) === `mem.role.${member.role}` ? member.role : t(`mem.role.${member.role}`)}
              </span>
            </div>
          </div>
        </motion.div>

        {/* Two-column body — contact + activity on left, deep content on right.
            Stacks on mobile. */}
        <div className="grid md:grid-cols-3 gap-6">
          {/* Left rail */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="md:col-span-1 space-y-6"
          >
            {/* Contact */}
            <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
              <p className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">{t('mem.contact')}</p>
              {[
                { icon: Mail,      val: member.email,   label: 'email' },
                { icon: Phone,     val: member.phone,   label: 'phone' },
                { icon: Building2, val: member.company, label: 'ministry' },
              ].map(({ icon: Icon, val, label }) => val ? (
                <div key={label} className="flex items-center gap-3 text-sm">
                  <Icon size={14} className="text-ink-400 shrink-0" />
                  <span className="text-ink-700 dark:text-parchment-200 break-all">{val}</span>
                </div>
              ) : null)}
              {!member.email && !member.phone && !member.company && (
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 italic">{t('member.noContact')}</p>
              )}
            </section>

            {/* Birthday + feast overlap (mirrors slide-over from L.2) */}
            {member.birth_date && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-2">
                <p className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">{t('mem.birthday')}</p>
                <div className="flex items-center gap-2 text-sm text-ink-700 dark:text-parchment-200">
                  <Calendar size={13} className="text-ink-400 shrink-0" />
                  <span>{fmtBirthMonthDay(member.birth_date)}</span>
                </div>
                {birthFeast?.feast_name && (
                  <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-medium ${LIT_COLOR_TEXT[birthFeast.color] ?? LIT_COLOR_TEXT.White}`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${LIT_COLOR_DOT[birthFeast.color] ?? 'bg-parchment-300'}`} />
                    <span>{t('mem.bornOn', { feast: birthFeast.feast_name })}</span>
                  </div>
                )}
              </section>
            )}

            {/* Tags */}
            {tags.length > 0 && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-2">
                <p className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">{t('mem.tags')}</p>
                <div className="flex flex-wrap gap-2">
                  {tags.map(t => (
                    <span key={t} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-200">
                      {t}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {/* Activity meta */}
            <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-2">
              <p className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">{t('mem.activity')}</p>
              <div className="flex items-center gap-2 text-sm text-ink-500 dark:text-parchment-300/70">
                <Calendar size={13} />
                <span>{t('mem.joined', { date: fmtDateLong(member.created_at) })}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-ink-500 dark:text-parchment-300/70">
                <Activity size={13} />
                <span>{t('member.updatedOn', { date: fmtDateLong(member.updated_at) })}</span>
              </div>
            </section>
          </motion.div>

          {/* Right column — donations + notes + calendar sync */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="md:col-span-2 space-y-6"
          >
            {/* Donation history — SP-021: not shown to Viewers (the API refuses them). */}
            {!isViewer && (
            <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5">
              <div className="flex items-baseline justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Heart size={14} className="text-brass-700 dark:text-brass-300" />
                  <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
                    {t('member.donationHistory')}
                  </h2>
                </div>
                {donations?.gift_count > 0 && (
                  <p className="text-xs text-ink-500 dark:text-parchment-300/70">
                    {donations.gift_count} gift{donations.gift_count === 1 ? '' : 's'} ·{' '}
                    <span className="font-semibold text-ink-900 dark:text-parchment-50">
                      {fmtCurrency(donations.total)}
                    </span>
                  </p>
                )}
              </div>
              {/* Three answers, not two. Unread (null, or a failed read) is
                  its own branch — "No gifts recorded" is a claim about a
                  parishioner's giving and is reachable only from a
                  successful read. (C5) */}
              {!donations || donations.failed ? (
                <LoadFailure variant="strip" body={t('member.giftsFailedBody')} cause={donations?.error}
                  onRetry={retryGifts} retrying={giftsRetrying} />
              ) : donations.gift_count === 0 ? (
                <p className="text-sm text-ink-500 dark:text-parchment-300/70 italic py-4 text-center">
                  No gifts recorded for this member.
                  {member.email
                    ? ` Donations are matched by email (${member.email}).`
                    : ' Add an email to this member so future gifts auto-match.'}
                </p>
              ) : (
                <ul className="divide-y divide-parchment-200/60 dark:divide-brass-900/25">
                  {donations.lines.slice(0, 25).map(l => (
                    <li key={l.id} className="py-2.5 flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 capitalize">
                          {l.category || 'Donation'}
                        </p>
                        <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
                          {fmtDateLong(l.date)} · {l.method}
                          {l.notes && !l.notes.startsWith('[Sample]') && (
                            <span className="text-ink-400 dark:text-parchment-300/70"> · {l.notes}</span>
                          )}
                        </p>
                      </div>
                      <p className="font-display text-base font-semibold text-church-900 dark:text-brass-200 tabular-nums shrink-0">
                        {fmtCurrency(l.amount)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            )}

            {/* Active pledges — admin-only. A real empty list stays
                hidden. A failed read stays on screen with retry; it is
                not "no pledges". */}
            {isAdmin && pledgesFailed && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Target size={14} className="text-brass-700 dark:text-brass-300" />
                  <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
                    {t('member.activePledges')}
                  </h2>
                </div>
                <LoadFailure variant="strip" body={t('member.pledgesUnread')} onRetry={retryPledges} />
              </section>
            )}
            {isAdmin && !pledgesFailed && pledges?.length > 0 && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Target size={14} className="text-brass-700 dark:text-brass-300" />
                  <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
                    {t('member.activePledges')}
                  </h2>
                </div>
                <ul className="space-y-3">
                  {pledges.map(p => {
                    const ratio = knownNumber(p.fulfillment)
                    const pct = ratio == null ? null : Math.round(ratio * 100)
                    const unavailable = t('money.unavailable')
                    // One brass fill — a pledge is a promise being kept,
                    // not a KPI to grade with traffic lights.
                    const barCls = 'bg-brass-500 dark:bg-brass-400'
                    return (
                      <li key={p.id} className="rounded-lg bg-parchment-100 dark:bg-ink-800/60 px-4 py-3">
                        <div className="flex items-baseline justify-between gap-3 mb-2">
                          <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
                            {fmtKnownCurrency(p.amount, unavailable)}
                            <span className="text-ink-500 text-xs font-normal"> / {p.frequency.replace('_', ' ')}</span>
                          </p>
                          <p className="text-xs font-semibold text-ink-700 dark:text-parchment-200 tabular-nums">
                            {pct == null ? unavailable : `${pct}%`}
                          </p>
                        </div>
                        {pct != null && (
                          <div className="h-1.5 rounded-full bg-parchment-200/80 dark:bg-ink-700 overflow-hidden">
                            <div
                              className={`h-full ${barCls} transition-all duration-300`}
                              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                            />
                          </div>
                        )}
                        <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 mt-1.5 tabular-nums">
                          {fmtKnownCurrency(p.matched_total, unavailable)} of {fmtKnownCurrency(p.period_total, unavailable)} expected
                        </p>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {/* Notes */}
            {member.notes && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-2">
                <p className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">{t('mem.notes')}</p>
                <p className="text-sm text-ink-700 dark:text-parchment-200 leading-relaxed whitespace-pre-wrap">
                  {member.notes}
                </p>
              </section>
            )}

            {/* Calendar feed token — same component the slide-over uses */}
            {!isViewer && <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5">
              <CalendarSync clientId={member.id} clientName={member.name} />
            </section>}

            {/* SP-021: swap link, availability and register entries are not in
                the Viewer's role table; their reads would be refused. */}
            {!isViewer && <SwapLinkSection clientId={member.id} clientName={member.name} />}

            {!isViewer && <AvailabilitySection clientId={member.id} clientName={member.name} />}

            {!isViewer && <SacramentsSection clientId={member.id} clientName={member.name} />}

            {/* R288-2: attendance (event titles, times) is outside Viewer
                scope; the server refuses /checkins for Viewers too. */}
            {!isViewer && <AttendanceSection clientId={member.id} />}
          </motion.div>
        </div>
      </div>
    </PageWrapper>
  )
}
