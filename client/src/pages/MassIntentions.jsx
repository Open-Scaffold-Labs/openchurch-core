import { useEffect, useState, useCallback } from 'react'
import { Flame, Plus, X, Pencil, Loader2, Search, Printer } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { formatLocalDate } from '../utils/dates'

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
const emptyForm = { intention: '', requested_by: '', mass_date: '', stipend: '', status: 'open', note: '', calendar_event_id: '', departed: false }

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

export default function MassIntentions() {
  const { user } = useAuth()
  const { t, dateLocale } = useLocale()
  const canWrite = user?.role === 'admin' || user?.role === 'staff'

  const [list,    setList]    = useState([])
  const [status,  setStatus]  = useState('')
  const [q,       setQ]       = useState('')
  const [loading, setLoading] = useState(true)
  const [more,    setMore]    = useState(false)
  const [done,    setDone]    = useState(false)
  const [error,   setError]   = useState(null)

  const [adding,   setAdding]   = useState(false)
  const [masses,   setMasses]   = useState(null) // upcoming calendar events; lazy-fetched on first form open
  const [editingId, setEditingId] = useState(null)
  const [form,     setForm]     = useState(emptyForm)
  const [busy,     setBusy]     = useState(false)

  const fetchPage = useCallback(async (offset, st, query) => {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (st) qs.set('status', st)
    if (query) qs.set('q', query)
    const res = await fetch(apiUrl(`/api/mass-intentions?${qs.toString()}`))
    if (!res.ok) throw new Error("Couldn't load the intention book. Nothing was lost — please retry.")
    const d = await res.json()
    return d.intentions ?? []
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setDone(false)
    const timer = setTimeout(() => {
      fetchPage(0, status, q.trim())
        .then(rows => { if (!cancelled) { setList(rows); setDone(rows.length < PAGE_SIZE) } })
        .catch(err => { if (!cancelled) setError(err.message) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [status, q, fetchPage])

  const loadMore = async () => {
    setMore(true); setError(null)
    try {
      const rows = await fetchPage(list.length, status, q.trim())
      setList(prev => [...prev, ...rows])
      if (rows.length < PAGE_SIZE) setDone(true)
    } catch (err) { setError(err.message) } finally { setMore(false) }
  }

  // Upcoming events for the "Assign to Mass" dropdown — next 60 days,
  // fetched once per page visit, only when a form is actually opened.
  const loadMasses = useCallback(() => {
    if (masses !== null) return
    const pad = n => String(n).padStart(2, '0')
    const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const today = new Date()
    const end = new Date(today); end.setDate(end.getDate() + 60)
    fetch(apiUrl(`/api/calendar?start=${iso(today)}&end=${iso(end)}`))
      .then(r => r.ok ? r.json() : [])
      .then(rows => setMasses(Array.isArray(rows) ? rows : []))
      .catch(() => setMasses([]))
  }, [masses])

  const closeForm = () => { setAdding(false); setEditingId(null); setForm(emptyForm); setError(null) }
  const startAdd = () => { setEditingId(null); setForm(emptyForm); setAdding(true); setError(null); loadMasses() }
  const startEdit = (r) => {
    loadMasses()
    setEditingId(r.id)
    setForm({
      intention: stripDeathMark(r.intention || ''),
      departed: hasDeathMark(r.intention),
      requested_by: r.requested_by || '',
      mass_date: r.mass_date || '',
      calendar_event_id: r.calendar_event_id != null ? String(r.calendar_event_id) : '',
      stipend: r.stipend != null ? String(r.stipend) : '',
      status: r.status || 'open',
      note: r.note || '',
    })
    setAdding(true); setError(null)
  }

  const reload = async () => {
    const rows = await fetchPage(0, status, q.trim())
    setList(rows); setDone(rows.length < PAGE_SIZE)
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!form.intention.trim()) { setError(t('mi.required')); return }
    setBusy(true); setError(null)
    const editing = editingId != null
    // The toggle (or a hand-typed †/+) guarantees the proper dagger.
    const rawIntention = form.intention.trim()
    const markDeparted = form.departed || hasDeathMark(rawIntention)
    const payload = {
      intention: markDeparted ? `${DAGGER} ${stripDeathMark(rawIntention)}` : rawIntention,
      requested_by: form.requested_by.trim() || (editing ? null : undefined),
      mass_date: form.mass_date || (editing ? null : undefined),
      calendar_event_id: form.calendar_event_id === '' ? (editing ? null : undefined) : Number(form.calendar_event_id),
      stipend: form.stipend === '' ? (editing ? null : undefined) : Number(form.stipend),
      status: form.status,
      note: form.note.trim() || (editing ? null : undefined),
    }
    try {
      const res = await fetch(apiUrl(editing ? `/api/mass-intentions/${editingId}` : '/api/mass-intentions'), {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || "That didn't save — nothing was lost. Please try again.")
      }
      closeForm()
      await reload()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const onRemove = async (id) => {
    setError(null)
    try {
      const res = await fetch(apiUrl(`/api/mass-intentions/${id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error("That didn't delete — the intention is untouched. Please try again.")
      setList(l => l.filter(r => r.id !== id))
    } catch (err) { setError(err.message) }
  }

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500'

  return (
    <PageWrapper>
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <Flame size={20} className="text-church-700 dark:text-brass-300" />
          <div>
            <h1 className="text-2xl font-display font-bold text-ink-900 dark:text-parchment-50">{t('mi.title')}</h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70">{t('mi.sub')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/mass-intentions/print"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800">
            <Printer size={15} /> {t('mi.weeklySheet')}
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
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.intention')}</label>
              <input type="text" value={form.intention} placeholder={t('mi.placeholder')}
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
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.requestedBy')}</label>
              <input type="text" value={form.requested_by}
                onChange={e => setForm(f => ({ ...f, requested_by: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.massDate')}</label>
              <input type="date" value={form.mass_date}
                onChange={e => setForm(f => ({ ...f, mass_date: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.assign')}</label>
              <select
                value={form.calendar_event_id}
                onChange={e => {
                  const id = e.target.value
                  const ev = (masses ?? []).find(m => String(m.id) === id)
                  setForm(f => ({
                    ...f,
                    calendar_event_id: id,
                    // Assigning a Mass adopts its date (still editable above).
                    mass_date: ev?.date ? String(ev.date).slice(0, 10) : f.mass_date,
                  }))
                }}
                className={inputCls}
              >
                <option value="">{t('mi.notAssigned')}</option>
                {(masses ?? []).map(m => (
                  <option key={m.id} value={m.id}>
                    {String(m.date).slice(0, 10)} — {m.title}{m.start_time ? ` (${String(m.start_time).slice(0, 5)})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.offering')}</label>
              <input type="number" min="0" step="0.01" value={form.stipend}
                onChange={e => setForm(f => ({ ...f, stipend: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.status')}</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className={inputCls}>
                {STATUSES.map(s => <option key={s} value={s}>{t(`mi.${s}`)}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('mi.note')}</label>
              <input type="text" value={form.note}
                onChange={e => setForm(f => ({ ...f, note: e.target.value }))} className={inputCls} />
            </div>
          </div>
          {error && <p className="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>}
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
        <div className="relative flex-1 min-w-[12rem]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input type="search" value={q} onChange={e => setQ(e.target.value)}
            placeholder={t('mi.search')} aria-label={t('mi.search')}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500" />
        </div>
      </div>

      {error && !adding && <p className="mb-3 text-sm text-rose-700 dark:text-rose-300">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
      ) : list.length === 0 ? (
        <EmptyState icon={Flame} title={t('mi.emptyTitle')}
          body={t('mi.emptyBody')} />
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
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {r.mass_date ? formatLocalDate(r.mass_date, undefined, dateLocale) : '—'}
                    {r.mass_title && (
                      <span className="block text-[11px] text-ink-400 dark:text-parchment-400/60">
                        {r.mass_title}{r.mass_time ? ` · ${r.mass_time}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-medium">
                    {displayIntention(r.intention)}
                    {r.note && <span className="block text-[11px] font-normal text-ink-500 dark:text-parchment-300/70">{r.note}</span>}
                  </td>
                  <td className="px-4 py-2.5">{r.requester_name || r.requested_by || '—'}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{fmtStipend(r.stipend) || '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_CLS[r.status] || ''}`}>
                      {STATUSES.includes(r.status) ? t(`mi.${r.status}`) : r.status}
                    </span>
                  </td>
                  {canWrite && (
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => startEdit(r)} aria-label="Edit intention"
                          className="text-ink-400 hover:text-church-700 dark:hover:text-brass-300"><Pencil size={14} /></button>
                        <button type="button" onClick={() => onRemove(r.id)} aria-label="Delete intention"
                          className="text-ink-400 hover:text-rose-700 dark:hover:text-rose-300"><X size={15} /></button>
                      </div>
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
