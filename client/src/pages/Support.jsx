// Support console (SUP.2 UI) — the triage queue.
//
// One page, two postures decided by the SERVER (the `vendor` flag on the
// list response — the client never guesses):
//   · Parish admin — their own org's reports: read everything, mark
//     resolved/closed with a note. Triage fields render read-only.
//   · Vendor (Open Scaffold Labs, env-identified) — every org's reports
//     with org names, full triage: status walk, severity, classification,
//     assignment, notes.
//
// Queue is severity-ordered (critical first) by the API. Default view is
// open work (?open=1); the "All" toggle includes resolved/closed history.
// The detail drawer shows the report, its context bundle, and the AI
// diagnosis (root cause, suspected files, proposed fix) when present.

import { useCallback, useEffect, useState } from 'react'
import { LifeBuoy, ChevronDown, ChevronRight, Loader2, RefreshCw, Search } from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'

const SEVERITIES = ['critical', 'high', 'normal', 'low']
const STATUSES = ['new', 'diagnosing', 'waiting_on_parish', 'in_progress', 'resolved', 'closed']
const CLASSIFICATIONS = ['bug', 'confusion', 'feature_request', 'product_insight']
const ORG_ADMIN_STATUSES = ['resolved', 'closed']

const SEV_TONE = {
  critical: 'bg-church-50 text-church-800 border border-church-200/60 dark:bg-church-900/40 dark:text-brass-200 dark:border-church-800/40',
  high:     'bg-amber-50 text-amber-800 border border-amber-200/60 dark:bg-amber-900/25 dark:text-amber-300 dark:border-amber-800/40',
  normal:   'bg-brass-50 text-brass-700 border border-brass-200/70 dark:bg-brass-900/20 dark:text-brass-300 dark:border-brass-800/40',
  low:      'bg-parchment-200 text-ink-500 border border-parchment-300/70 dark:bg-ink-800 dark:text-parchment-300/70 dark:border-brass-900/30',
}
const STATUS_TONE = {
  new:               'bg-church-50 text-church-800 dark:bg-church-900/40 dark:text-brass-200',
  diagnosing:        'bg-brass-50 text-brass-700 dark:bg-brass-900/25 dark:text-brass-300',
  waiting_on_parish: 'bg-amber-50 text-amber-800 dark:bg-amber-900/25 dark:text-amber-300',
  in_progress:       'bg-brass-50 text-brass-700 dark:bg-brass-900/25 dark:text-brass-300',
  resolved:          'bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-300/80',
  closed:            'bg-parchment-200 text-ink-500 dark:bg-ink-800 dark:text-parchment-300/70',
}

const inputCls = 'rounded-lg border border-parchment-300 dark:border-brass-900/40 bg-white dark:bg-ink-900 px-2.5 py-1.5 text-sm text-ink-800 dark:text-parchment-100 focus:outline-none focus:ring-2 focus:ring-church-500/40'

function Badge({ tone, children }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap ${tone}`}>
      {children}
    </span>
  )
}

// The AI's structured triage, rendered read-only. Internal tool — the
// diagnosis is engineering-facing and deliberately not translated.
function DiagnosisBlock({ diagnosis }) {
  const { t } = useLocale()
  if (!diagnosis) return null
  if (diagnosis.error) {
    return <p className="text-xs italic text-ink-500 dark:text-parchment-300/70">{diagnosis.error}</p>
  }
  return (
    <div className="rounded-xl bg-parchment-100 dark:bg-ink-900/60 px-3.5 py-3 space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">
        {t('sup.diagnosis')}{diagnosis.confidence ? ` · ${diagnosis.confidence}` : ''}
      </div>
      {diagnosis.narrative && <p className="text-xs text-ink-700 dark:text-parchment-200 leading-relaxed">{diagnosis.narrative}</p>}
      {diagnosis.root_cause && (
        <p className="text-xs text-ink-600 dark:text-parchment-300/80"><span className="font-semibold">{t('sup.rootCause')}:</span> {diagnosis.root_cause}</p>
      )}
      {diagnosis.proposed_fix && (
        <p className="text-xs text-ink-600 dark:text-parchment-300/80"><span className="font-semibold">{t('sup.proposedFix')}:</span> {diagnosis.proposed_fix}</p>
      )}
      {diagnosis.suspected_files?.length > 0 && (
        <p className="text-[11px] font-mono text-ink-500 dark:text-parchment-300/70 break-all">
          {diagnosis.suspected_files.join(' · ')}
        </p>
      )}
    </div>
  )
}

function TicketRow({ ticket, vendor, onSaved }) {
  const { t, dateLocale } = useLocale()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function toggle() {
    if (open) { setOpen(false); return }
    setOpen(true)
    if (detail) return
    setLoading(true)
    try {
      const r = await fetch(apiUrl(`/api/support-tickets/${ticket.id}`))
      if (!r.ok) throw new Error(t('sup.loadError'))
      const d = await r.json()
      setDetail(d)
      setForm({
        status: d.status, severity: d.severity, classification: d.classification || '',
        assigned_to: d.assigned_to || '', resolution_notes: d.resolution_notes || '',
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    setSaving(true); setError('')
    try {
      const body = vendor
        ? {
            status: form.status, severity: form.severity,
            classification: form.classification || null,
            assigned_to: form.assigned_to || null,
            resolution_notes: form.resolution_notes || null,
          }
        : (() => {
            const b = { resolution_notes: form.resolution_notes || null }
            // Only send status when it changed to a state the parish may set.
            if (form.status !== detail.status) b.status = form.status
            return b
          })()
      const r = await fetch(apiUrl(`/api/support-tickets/${ticket.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || t('sup.saveError'))
      setDetail(d => ({ ...d, ...data }))
      onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const statusOptions = vendor ? STATUSES
    : [...new Set([detail?.status, ...ORG_ADMIN_STATUSES])].filter(Boolean)

  return (
    <div className="rounded-xl border border-parchment-300/70 dark:border-brass-900/30 bg-white/70 dark:bg-ink-800/60">
      <button onClick={toggle} className="w-full flex items-center gap-3 px-4 py-3 text-left">
        {open ? <ChevronDown size={15} className="shrink-0 text-ink-400" /> : <ChevronRight size={15} className="shrink-0 text-ink-400" />}
        <Badge tone={SEV_TONE[ticket.severity]}>{t(`sup.sev.${ticket.severity}`)}</Badge>
        <Badge tone={STATUS_TONE[ticket.status]}>{t(`sup.status.${ticket.status}`)}</Badge>
        <span className="flex-1 min-w-0 text-sm text-ink-800 dark:text-parchment-100 truncate">{ticket.description}</span>
        {vendor && ticket.org_name && (
          <span className="hidden sm:inline text-xs text-ink-500 dark:text-parchment-300/70 truncate max-w-[10rem]">{ticket.org_name}</span>
        )}
        <span className="hidden md:inline text-[11px] text-ink-500 dark:text-parchment-300/70 whitespace-nowrap">
          {new Date(ticket.created_at).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-parchment-200/70 dark:border-brass-900/25">
          {loading && <div className="flex justify-center py-6"><Loader2 size={18} className="animate-spin text-brass-600" /></div>}
          {detail && form && (
            <div className="space-y-3">
              <p className="text-sm text-ink-700 dark:text-parchment-200 whitespace-pre-wrap">{detail.description}</p>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70">
                {detail.reporter_name || t('sup.unknownReporter')}
                {detail.reporter_email ? ` · ${detail.reporter_email}` : ''}
                {detail.page_route ? ` · ${detail.page_route}` : ''}
                {` · ${new Date(detail.created_at).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })}`}
              </p>
              {detail.context_bundle && (
                <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 break-all">
                  {[detail.context_bundle.viewport,
                    detail.context_bundle.language,
                    detail.context_bundle.userAgent?.slice(0, 110)]
                    .filter(Boolean).join(' · ')}
                </p>
              )}

              <DiagnosisBlock diagnosis={detail.diagnosis} />

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <label className="block">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">{t('sup.fStatus')}</span>
                  <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                    className={`mt-1 w-full ${inputCls}`}>
                    {statusOptions.map(s => <option key={s} value={s}>{t(`sup.status.${s}`)}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">{t('sup.fSeverity')}</span>
                  <select value={form.severity} disabled={!vendor}
                    onChange={e => setForm(f => ({ ...f, severity: e.target.value }))}
                    className={`mt-1 w-full ${inputCls} disabled:opacity-60`}>
                    {SEVERITIES.map(s => <option key={s} value={s}>{t(`sup.sev.${s}`)}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">{t('sup.fClassification')}</span>
                  <select value={form.classification} disabled={!vendor}
                    onChange={e => setForm(f => ({ ...f, classification: e.target.value }))}
                    className={`mt-1 w-full ${inputCls} disabled:opacity-60`}>
                    <option value="">{t('sup.unclassified')}</option>
                    {CLASSIFICATIONS.map(c => <option key={c} value={c}>{t(`sup.cls.${c}`)}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">{t('sup.fAssigned')}</span>
                  <input value={form.assigned_to} disabled={!vendor}
                    onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))}
                    placeholder="—" className={`mt-1 w-full ${inputCls} disabled:opacity-60`} />
                </label>
              </div>

              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">{t('sup.fNotes')}</span>
                <textarea rows={2} value={form.resolution_notes}
                  onChange={e => setForm(f => ({ ...f, resolution_notes: e.target.value }))}
                  className={`mt-1 w-full ${inputCls}`} />
              </label>

              {error && <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p>}
              <button onClick={save} disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-church-800 px-3.5 py-2 text-sm font-medium text-parchment-50 hover:bg-church-900 disabled:opacity-60 dark:bg-brass-700 dark:hover:bg-brass-600">
                {saving && <Loader2 size={14} className="animate-spin" />}
                {t('sup.save')}
              </button>
            </div>
          )}
          {!loading && !detail && error && <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>}
        </div>
      )}
    </div>
  )
}

export default function Support() {
  const { t } = useLocale()
  const [tickets, setTickets] = useState(null)
  const [vendor, setVendor] = useState(false)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [sevFilter, setSevFilter] = useState('')
  const [orgFilter, setOrgFilter] = useState('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  // Every org ever seen in a response, so the vendor's org dropdown
  // doesn't shrink to only the orgs matching the current filters.
  const [knownOrgs, setKnownOrgs] = useState([])

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(id)
  }, [query])

  const load = useCallback(async () => {
    setError('')
    try {
      const params = new URLSearchParams()
      if (!showAll) params.set('open', '1')
      if (sevFilter) params.set('severity', sevFilter)
      if (orgFilter) params.set('org_id', orgFilter)
      if (debouncedQuery) params.set('q', debouncedQuery)
      params.set('limit', '200')
      const r = await fetch(apiUrl(`/api/support-tickets?${params}`))
      if (!r.ok) throw new Error(t('sup.loadError'))
      const d = await r.json()
      setTickets(d.tickets)
      setVendor(d.vendor)
      setKnownOrgs(prev => {
        const seen = new Map(prev.map(o => [o.id, o.name]))
        for (const tk of d.tickets) if (tk.org_name) seen.set(tk.organization_id, tk.org_name)
        return [...seen.entries()].map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      })
    } catch (e) {
      setError(e.message)
      setTickets([])
    }
  }, [showAll, sevFilter, orgFilter, debouncedQuery, t])

  useEffect(() => { setTickets(null); load() }, [load])

  return (
    <PageWrapper>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="font-display text-2xl font-semibold text-church-900 dark:text-parchment-50">{t('sup.title')}</h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-0.5">
            {vendor ? t('sup.subtitleVendor') : t('sup.subtitle')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-ink-400" />
            <input value={query} onChange={e => setQuery(e.target.value)}
              placeholder={t('sup.searchPh')} aria-label={t('sup.searchPh')}
              className={`${inputCls} pl-8 w-44`} />
          </div>
          {vendor && knownOrgs.length > 1 && (
            <select value={orgFilter} onChange={e => setOrgFilter(e.target.value)} aria-label={t('sup.allParishes')} className={inputCls}>
              <option value="">{t('sup.allParishes')}</option>
              {knownOrgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <select value={sevFilter} onChange={e => setSevFilter(e.target.value)} aria-label={t('sup.fSeverity')} className={inputCls}>
            <option value="">{t('sup.allSeverities')}</option>
            {SEVERITIES.map(s => <option key={s} value={s}>{t(`sup.sev.${s}`)}</option>)}
          </select>
          <button onClick={() => setShowAll(a => !a)}
            className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${showAll
              ? 'bg-church-800 text-parchment-50 border-church-800 dark:bg-brass-700 dark:border-brass-700'
              : 'bg-white dark:bg-ink-900 text-ink-700 dark:text-parchment-200 border-parchment-300 dark:border-brass-900/40 hover:bg-parchment-100 dark:hover:bg-ink-800'}`}>
            {showAll ? t('sup.showingAll') : t('sup.openOnly')}
          </button>
          <button onClick={load} aria-label={t('sup.refresh')}
            className="p-2 rounded-lg border border-parchment-300 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {tickets === null ? (
        <SkeletonRowList count={5} withAvatar={false} />
      ) : error && tickets.length === 0 ? (
        <p className="text-sm text-rose-700 dark:text-rose-300 text-center py-10" role="alert">{error}</p>
      ) : tickets.length === 0 ? (
        <EmptyState icon={LifeBuoy} title={t('sup.emptyTitle')} body={t('sup.emptyBody')} />
      ) : (
        <div className="space-y-2">
          {tickets.map(ticket => (
            <TicketRow key={ticket.id} ticket={ticket} vendor={vendor} onSaved={load} />
          ))}
        </div>
      )}
    </PageWrapper>
  )
}
