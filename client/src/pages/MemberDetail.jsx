import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ChevronLeft, Mail, Phone, Building2, Calendar, CalendarOff,
  Activity, Heart, AlertTriangle, Loader2, Target, Plus, X, UserCheck, History, Church, Pencil,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import CalendarSync from '../components/CalendarSync'
import { apiUrl } from '../api'
import { formatLocalDate } from '../utils/dates'
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
      setError("That didn't save — nothing was lost. Please try again.")
      setBusy(false)
      return
    }
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      setError(data.error || `Failed (${res.status})`)
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
      setError('Copy failed — select the link and copy manually.')
    }
  }

  return (
    <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
          Swap link
        </h2>
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-church-900 dark:border-parchment-100 text-church-900 dark:text-parchment-100 hover:bg-church-900 hover:text-parchment-50 dark:hover:bg-parchment-100 dark:hover:text-church-900 transition-colors disabled:opacity-40"
        >
          {busy ? 'Generating…' : (token ? 'Rotate' : 'Generate link')}
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
              {copied ? 'Copied' : 'Copy'}
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

function AttendanceSection({ clientId }) {
  const [list, setList] = useState(null)
  useEffect(() => {
    let cancelled = false
    fetch(apiUrl(`/api/clients/${clientId}/checkins`))
      .then(r => (r.ok ? r.json() : { checkins: [] }))
      .then(d => { if (!cancelled) setList(d.checkins ?? []) })
      .catch(() => { if (!cancelled) setList([]) })
    return () => { cancelled = true }
  }, [clientId])

  if (!list || list.length === 0) return null

  return (
    <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
      <div className="flex items-center gap-2">
        <UserCheck size={14} className="text-brass-700 dark:text-brass-300" />
        <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">Attendance</h2>
      </div>
      <ul className="space-y-1.5">
        {list.slice(0, 8).map(c => (
          <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-ink-800 dark:text-parchment-100 truncate">{c.event_title}</span>
            <span className="text-xs text-ink-500 dark:text-parchment-300/70 shrink-0">{fmtServiceDate(c.event_date)}</span>
          </li>
        ))}
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
  const [list,    setList]    = useState([])
  const [loading, setLoading] = useState(true)
  const [form,    setForm]    = useState({ start_date: '', end_date: '', reason: '' })
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState(null)

  const load = async () => {
    try {
      const res = await fetch(apiUrl(`/api/availability?client_id=${clientId}`))
      const d = res.ok ? await res.json() : { unavailability: [] }
      setList(d.unavailability ?? [])
    } catch { /* leave the list as-is on a transient error */ }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [clientId])

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
        throw new Error(data.error || `Failed (${res.status})`)
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
      if (!res.ok && res.status !== 204) throw new Error(`Failed (${res.status})`)
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
          Availability
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
              To <span className="font-normal text-ink-400 dark:text-parchment-300/50">(optional)</span>
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
          <Plus size={13} /> {busy ? 'Adding…' : 'Add blackout date'}
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
const SACRAMENT_LABELS = {
  baptism:         'Baptism',
  reconciliation:  'First Reconciliation',
  first_communion: 'First Communion',
  confirmation:    'Confirmation',
  marriage:        'Marriage',
  holy_orders:     'Holy Orders',
  anointing:       'Anointing of the Sick',
  burial:          'Christian Burial',
}
const SACRAMENT_ORDER = Object.keys(SACRAMENT_LABELS)

function SacramentsSection({ clientId, clientName }) {
  const { user } = useAuth()
  const canWrite = user?.role === 'admin' || user?.role === 'staff'

  const [list,    setList]    = useState([])
  const [loading, setLoading] = useState(true)
  const [adding,  setAdding]  = useState(false)
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState(null)
  const emptyForm = { type: 'baptism', date: '', minister: '', place: '', certificate_no: '', notes: '' }
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState(null) // null = adding a new record

  const load = async () => {
    try {
      const res = await fetch(apiUrl(`/api/sacraments?client_id=${clientId}`))
      const d = res.ok ? await res.json() : { records: [] }
      setList(d.records ?? [])
    } catch { /* leave list as-is on a transient error */ }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [clientId])

  const closeForm = () => { setAdding(false); setEditingId(null); setForm(emptyForm); setError(null) }

  const startAdd = () => { setEditingId(null); setForm(emptyForm); setAdding(true); setError(null) }

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
    setAdding(true)
    setError(null)
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!SACRAMENT_LABELS[form.type]) return
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
        throw new Error(data.error || `Failed (${res.status})`)
      }
      closeForm()
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async (recId) => {
    setError(null)
    try {
      const res = await fetch(apiUrl(`/api/sacraments/${recId}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(`Failed (${res.status})`)
      setList(l => l.filter(r => r.id !== recId))
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
          Sacraments
        </h2>
      </div>
      <p className="text-[12px] text-ink-500 dark:text-parchment-300/70 leading-snug">
        {clientName}&apos;s sacramental register — the record of sacraments received.
      </p>

      {loading ? (
        <div className="flex justify-center py-3">
          <Loader2 size={16} className="animate-spin text-brass-600" />
        </div>
      ) : list.length === 0 ? (
        <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">
          No sacraments recorded yet.
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
                  {SACRAMENT_LABELS[r.type] ?? r.type}
                  {r.date && (
                    <span className="text-ink-500 dark:text-parchment-300/70 font-normal">
                      {' · '}{formatLocalDate(r.date)}
                    </span>
                  )}
                </p>
                {(r.minister || r.place) && (
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 truncate">
                    {[r.minister, r.place].filter(Boolean).join(' — ')}
                  </p>
                )}
                {r.certificate_no && (
                  <p className="text-[11px] text-ink-400 dark:text-parchment-300/60">Cert. {r.certificate_no}</p>
                )}
                {r.notes && (
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">{r.notes}</p>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-2">
                <Link
                  to={`/register/${r.id}/certificate`}
                  className="text-[11px] font-semibold text-church-700 dark:text-brass-300 hover:underline"
                >
                  Certificate
                </Link>
                {canWrite && (
                  <>
                    <button
                      type="button"
                      onClick={() => startEdit(r)}
                      aria-label={`Edit ${SACRAMENT_LABELS[r.type] ?? r.type} record`}
                      className="-m-1 p-1 text-ink-400 hover:text-church-700 dark:hover:text-brass-300 transition-colors"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(r.id)}
                      aria-label={`Remove ${SACRAMENT_LABELS[r.type] ?? r.type} record`}
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

      {error && (
        <p className="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>
      )}

      {canWrite && !adding && (
        <button
          type="button"
          onClick={startAdd}
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-church-700 dark:text-brass-300 hover:underline"
        >
          <Plus size={13} /> Record a sacrament
        </button>
      )}

      {canWrite && adding && (
        <form onSubmit={onSubmit} className="space-y-2 pt-1 border-t border-parchment-300/50 dark:border-brass-900/25">
          <p className="pt-2 text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">
            {editingId ? 'Edit record' : 'New record'}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Sacrament</label>
              <select
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                className={inputCls}
              >
                {SACRAMENT_ORDER.map(t => (
                  <option key={t} value={t}>{SACRAMENT_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Date</label>
              <input type="date" value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Minister</label>
              <input type="text" value={form.minister} placeholder="Fr. …"
                onChange={e => setForm(f => ({ ...f, minister: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Place</label>
              <input type="text" value={form.place} placeholder="Parish / church"
                onChange={e => setForm(f => ({ ...f, place: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Certificate #</label>
              <input type="text" value={form.certificate_no}
                onChange={e => setForm(f => ({ ...f, certificate_no: e.target.value }))} className={inputCls} />
            </div>
            <div className="col-span-2">
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Notes</label>
              <input type="text" value={form.notes} placeholder="Sponsor, godparents, etc."
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className={inputCls} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {editingId ? 'Save changes' : 'Save'}
            </button>
            <button type="button" onClick={closeForm}
              className="text-[12px] text-ink-500 dark:text-parchment-300/70 hover:underline">
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

export default function MemberDetail() {
  const { id } = useParams()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [member, setMember] = useState(null)
  const [donations, setDonations] = useState(null)
  const [birthFeast, setBirthFeast] = useState(null)
  const [pledges, setPledges] = useState(null) // null until fetched (admin-only)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)

    fetch(apiUrl(`/api/clients/${id}`))
      .then(async r => {
        if (r.status === 404) throw new Error('not-found')
        if (!r.ok) throw new Error(`Failed (${r.status})`)
        return r.json()
      })
      .then(async m => {
        if (cancelled) return
        setMember(m)

        // Fan out — donations + feast lookup. Both are tolerant of
        // failure (we render what we have).
        const dPromise = fetch(apiUrl(`/api/clients/${id}/donations`))
          .then(r => r.ok ? r.json() : { lines: [], total: 0, gift_count: 0 })
          .catch(() => ({ lines: [], total: 0, gift_count: 0 }))

        const fPromise = m.birth_date
          ? fetch(apiUrl(`/api/liturgical?date=${m.birth_date}`))
              .then(r => r.ok ? r.json() : null)
              .then(d => d?.feast_name ? d : null)
              .catch(() => null)
          : Promise.resolve(null)

        // Pledges (Sprint D / D.3) — admin-only endpoint, so non-
        // admins get a no-op resolve. Filter client-side to this
        // member's pledges to avoid a per-member server endpoint.
        const plPromise = isAdmin
          ? fetch(apiUrl('/api/pledges?status=active'))
              .then(r => r.ok ? r.json() : { pledges: [] })
              .then(d => (d.pledges ?? []).filter(p => p.member_id === Number(id)))
              .catch(() => [])
          : Promise.resolve(null)

        const [d, f, pl] = await Promise.all([dPromise, fPromise, plPromise])
        if (cancelled) return
        setDonations(d)
        setBirthFeast(f)
        setPledges(pl)
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return (
      <PageWrapper>
        <div className="flex items-center justify-center py-24">
          <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      </PageWrapper>
    )
  }

  if (err === 'not-found' || !member) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState
            icon={AlertTriangle}
            title="Member not found"
            body="This member doesn't exist or belongs to another organization."
            action={{ label: 'Back to Members', onClick: () => window.history.back() }}
          />
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
            to="/clients"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-church-700 dark:text-brass-300 hover:underline"
          >
            <ChevronLeft size={15} /> Back to Members
          </Link>
          {isAdmin && (
            <Link
              to={`/audit?entity_type=client&entity_id=${id}`}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-500 dark:text-parchment-300/70 hover:text-ink-900 dark:hover:text-parchment-50 transition-colors"
              title="See every change made to this member's record"
            >
              <History size={14} /> View change history
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
                {member.status}
              </span>
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200">
                {member.role}
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
              <p className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">Contact</p>
              {[
                { icon: Mail,      val: member.email,   label: 'Email' },
                { icon: Phone,     val: member.phone,   label: 'Phone' },
                { icon: Building2, val: member.company, label: 'Ministry' },
              ].map(({ icon: Icon, val, label }) => val ? (
                <div key={label} className="flex items-center gap-3 text-sm">
                  <Icon size={14} className="text-ink-400 shrink-0" />
                  <span className="text-ink-700 dark:text-parchment-200 break-all">{val}</span>
                </div>
              ) : null)}
              {!member.email && !member.phone && !member.company && (
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 italic">No contact info on file.</p>
              )}
            </section>

            {/* Birthday + feast overlap (mirrors slide-over from L.2) */}
            {member.birth_date && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-2">
                <p className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">Birthday</p>
                <div className="flex items-center gap-2 text-sm text-ink-700 dark:text-parchment-200">
                  <Calendar size={13} className="text-ink-400 shrink-0" />
                  <span>{fmtBirthMonthDay(member.birth_date)}</span>
                </div>
                {birthFeast?.feast_name && (
                  <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-medium ${LIT_COLOR_TEXT[birthFeast.color] ?? LIT_COLOR_TEXT.White}`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${LIT_COLOR_DOT[birthFeast.color] ?? 'bg-parchment-300'}`} />
                    <span>Born on {birthFeast.feast_name}</span>
                  </div>
                )}
              </section>
            )}

            {/* Tags */}
            {tags.length > 0 && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-2">
                <p className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">Tags</p>
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
              <p className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">Activity</p>
              <div className="flex items-center gap-2 text-sm text-ink-500 dark:text-parchment-300/70">
                <Calendar size={13} />
                <span>Joined {fmtDateLong(member.created_at)}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-ink-500 dark:text-parchment-300/70">
                <Activity size={13} />
                <span>Updated {fmtDateLong(member.updated_at)}</span>
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
            {/* Donation history */}
            <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5">
              <div className="flex items-baseline justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Heart size={14} className="text-brass-700 dark:text-brass-300" />
                  <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
                    Donation history
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
              {!donations || donations.gift_count === 0 ? (
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
                            <span className="text-ink-400 dark:text-parchment-300/50"> · {l.notes}</span>
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

            {/* Active pledges — admin-only block. Hidden when no
                pledges OR when viewer is non-admin (pledges array is
                null for non-admins). */}
            {isAdmin && pledges?.length > 0 && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Target size={14} className="text-brass-700 dark:text-brass-300" />
                  <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
                    Active pledges
                  </h2>
                </div>
                <ul className="space-y-3">
                  {pledges.map(p => {
                    const pct = Math.round(p.fulfillment * 100)
                    // One brass fill — a pledge is a promise being kept,
                    // not a KPI to grade with traffic lights.
                    const barCls = 'bg-brass-500 dark:bg-brass-400'
                    return (
                      <li key={p.id} className="rounded-lg bg-parchment-100 dark:bg-ink-800/60 px-4 py-3">
                        <div className="flex items-baseline justify-between gap-3 mb-2">
                          <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
                            {fmtCurrency(p.amount)}
                            <span className="text-ink-500 text-xs font-normal"> / {p.frequency.replace('_', ' ')}</span>
                          </p>
                          <p className="text-xs font-semibold text-ink-700 dark:text-parchment-200 tabular-nums">
                            {pct}%
                          </p>
                        </div>
                        <div className="h-1.5 rounded-full bg-parchment-200/80 dark:bg-ink-700 overflow-hidden">
                          <div
                            className={`h-full ${barCls} transition-all duration-300`}
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 mt-1.5 tabular-nums">
                          {fmtCurrency(p.matched_total)} of {fmtCurrency(p.period_total)} expected
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
                <p className="text-xs font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">Notes</p>
                <p className="text-sm text-ink-700 dark:text-parchment-200 leading-relaxed whitespace-pre-wrap">
                  {member.notes}
                </p>
              </section>
            )}

            {/* Calendar feed token — same component the slide-over uses */}
            <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5">
              <CalendarSync clientId={member.id} clientName={member.name} />
            </section>

            <SwapLinkSection clientId={member.id} clientName={member.name} />

            <AvailabilitySection clientId={member.id} clientName={member.name} />

            <SacramentsSection clientId={member.id} clientName={member.name} />

            <AttendanceSection clientId={member.id} />
          </motion.div>
        </div>
      </div>
    </PageWrapper>
  )
}
