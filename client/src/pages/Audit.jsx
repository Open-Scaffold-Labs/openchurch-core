import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ScrollText, Loader2, Shield, RotateCcw, Download, X } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadFailure from '../components/LoadFailure'
import { SkeletonRowList } from '../components/Skeleton'
import { useToast } from '../components/ToastProvider'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { initials } from '../utils/format'
import { startOfLocalDayISO, endOfLocalDayISO, todayLocalISO } from '../utils/dates'

// Admin-only audit log viewer. Reads /api/audit-log (paginated +
// filterable). Server already gates by admin role; the sidebar hides
// this from non-admins. If a non-admin somehow lands here directly,
// the 403 surfaces a friendly Forbidden state instead of a blank list.

const ACTIONS = [
  { value: '', key: 'audit.action.all' },
  { value: 'create', key: 'audit.action.create' },
  { value: 'update', key: 'audit.action.update' },
  { value: 'delete', key: 'audit.action.delete' },
  { value: 'close', key: 'audit.action.close' },
  { value: 'deactivate', key: 'audit.action.deactivate' },
  { value: 'reactivate', key: 'audit.action.reactivate' },
  { value: 'deidentify', key: 'audit.action.deidentify' },
  { value: 'hold', key: 'audit.action.hold' },
]

// Mirrors the entity_type allowlist in server/src/routes/auditLog.js.
// Update both when a new audit mount lands.
const ENTITY_TYPES = [
  { value: '', key: 'audit.type.all' },
  { value: 'client', key: 'audit.type.client' },
  { value: 'group', key: 'audit.type.group' },
  { value: 'group_interest', key: 'audit.type.group_interest' },
  { value: 'event', key: 'audit.type.event' },
  { value: 'calendar_event', key: 'audit.type.calendar_event' },
  { value: 'availability', key: 'audit.type.availability' },
  { value: 'swap_request', key: 'audit.type.swap_request' },
  { value: 'attendance', key: 'audit.type.attendance' },
  { value: 'checkin', key: 'audit.type.checkin' },
  { value: 'room', key: 'audit.type.room' },
  { value: 'kiosk', key: 'audit.type.kiosk' },
  { value: 'task', key: 'audit.type.task' },
  { value: 'donation', key: 'audit.type.donation' },
  { value: 'fund', key: 'audit.type.fund' },
  { value: 'pledge', key: 'audit.type.pledge' },
  { value: 'payroll', key: 'audit.type.payroll' },
  { value: 'form', key: 'audit.type.form' },
  { value: 'parish_feast', key: 'audit.type.parish_feast' },
  { value: 'bulletin', key: 'audit.type.bulletin' },
  { value: 'service_plan', key: 'audit.type.service_plan' },
  { value: 'sacrament', key: 'audit.type.sacrament' },
  { value: 'mass_intention', key: 'audit.type.mass_intention' },
  { value: 'support_ticket', key: 'audit.type.support_ticket' },
  { value: 'fee_schedule', key: 'audit.type.fee_schedule' },
  { value: 'invoice', key: 'audit.type.invoice' },
  { value: 'import_batch', key: 'audit.type.import_batch' },
  { value: 'user', key: 'audit.type.user' },
  { value: 'organization', key: 'audit.type.organization' },
]

const ACTION_BADGE = {
  create: 'bg-brass-100 text-brass-800 dark:bg-brass-900/30 dark:text-brass-200',
  update: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  delete: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200',
  close: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200',
  deactivate: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  reactivate: 'bg-brass-100 text-brass-800 dark:bg-brass-900/30 dark:text-brass-200',
  deidentify: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  hold: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200',
}

const PAGE_SIZE = 50

const TH = 'text-left px-4 py-3 text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider'

function timeAgo(iso, t, dateLocale) {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60)        return t('audit.agoSec', { n: sec })
  const min = Math.floor(sec / 60)
  if (min < 60)        return t('audit.agoMin', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24)         return t('audit.agoHour', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 7)         return t('audit.agoDay', { n: day })
  return d.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: hr > 24 * 365 ? 'numeric' : undefined })
}

function fmtAbsolute(iso, dateLocale) {
  return new Date(iso).toLocaleString(dateLocale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

// Login lifecycle rows (Stage 6). The server writes action close /
// deactivate / reactivate on these rows and on no others, so the label comes
// from the action column — never from metadata, which on older rows could
// hold whatever a client sent. Every other summary is stored text and shows
// as written; rows from before the fix keep their original wording.
function lifecycleText(action, via, id, t) {
  if (action === 'close')      return via === 'self' ? t('audit.life.closeSelf', { id }) : t('audit.life.close', { id })
  if (action === 'deactivate') return via === 'self' ? t('audit.life.deactivateSelf', { id }) : t('audit.life.deactivate', { id })
  if (action === 'reactivate') return t('audit.life.reactivate', { id })
  return null
}

function alreadyText(action, t) {
  if (action === 'close')      return t('audit.life.already.close')
  if (action === 'deactivate') return t('audit.life.already.deactivate')
  return t('audit.life.already.reactivate')
}

// Stage 6 stewardship rows: the server writes these action values only for
// the route that did the work (member contact minimization, organization
// HOLD), so the label comes from the action column, never from metadata.
function stewardshipText(r, t) {
  if (r.action === 'deidentify' && r.entity_type === 'client') {
    const base = t('audit.stew.deidentify', { id: r.entity_id })
    return r.metadata?.already === true ? `${base} ${t('audit.stew.already.deidentify')}` : base
  }
  if (r.action === 'hold' && r.entity_type === 'organization') {
    let text = t('audit.stew.hold', { id: r.entity_id })
    if (r.metadata?.already === true) text = `${text} ${t('audit.stew.already.hold')}`
    if (r.metadata?.cleanup_complete === false) text = `${text} ${t('audit.stew.incomplete.hold')}`
    if (r.metadata?.cleanup_complete === true && r.metadata?.via === 'operator') text = `${text} ${t('audit.stew.completed.hold')}`
    return text
  }
  return null
}

function summaryFor(r, t) {
  const base = r.entity_type === 'user' ? lifecycleText(r.action, r.metadata?.via, r.entity_id, t) : null
  if (base) return r.metadata?.already === true ? `${base} ${alreadyText(r.action, t)}` : base
  const stew = stewardshipText(r, t)
  if (stew) return stew
  return r.summary || `${r.action} ${r.entity_type}`
}

const EMPTY_FILTERS = { action: '', entity_type: '', entity_id: '', since: '', until: '' }

export default function Audit() {
  // Seed filters from the URL once (AUD.3) so a deep link like
  // /audit?entity_type=client&entity_id=42 opens scoped to one record's
  // change history. After mount the filter controls own the state.
  const [searchParams] = useSearchParams()
  const [filters,  setFilters]  = useState(() => ({
    action:      searchParams.get('action')      || '',
    entity_type: searchParams.get('entity_type') || '',
    entity_id:   searchParams.get('entity_id')   || '',
    since:       searchParams.get('since')        || '',
    until:       searchParams.get('until')        || '',
  }))
  const [rows,     setRows]     = useState([])
  const [total,    setTotal]    = useState(0)
  // The server stops counting past its cap and says so. Rendering that as a
  // plain number would claim a precision it isn't offering.
  const [totalCapped, setTotalCapped] = useState(false)
  const [hasMore,  setHasMore]  = useState(false)
  const [offset,   setOffset]   = useState(0)
  const [loading,  setLoading]  = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  // Distinct from "nothing recorded": the first page was refused, thrown,
  // or was not a list. An empty array is the only quiet parish.
  const [loadFailed, setLoadFailed] = useState(false)
  const toast = useToast()
  const { t, dateLocale } = useLocale()
  const badgeLabel = {
    create: t('audit.badge.create'),
    update: t('audit.badge.update'),
    delete: t('audit.badge.delete'),
    close: t('audit.badge.close'),
    deactivate: t('audit.badge.deactivate'),
    reactivate: t('audit.badge.reactivate'),
    deidentify: t('audit.badge.deidentify'),
    hold: t('audit.badge.hold'),
  }

  // Build a query string from the current filters + offset. Empty
  // filter values are dropped so the URL stays clean.
  const buildQuery = useCallback((nextOffset) => {
    const params = new URLSearchParams()
    if (filters.action)      params.set('action', filters.action)
    if (filters.entity_type) params.set('entity_type', filters.entity_type)
    if (filters.entity_id)   params.set('entity_id', filters.entity_id)
    // Anchor date-input bounds to the LOCAL day. `until` covers through
    // end-of-day so today's entries aren't excluded by a UTC-midnight
    // cutoff (1.1).
    if (filters.since)       params.set('since', startOfLocalDayISO(filters.since))
    if (filters.until)       params.set('until', endOfLocalDayISO(filters.until))
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(nextOffset))
    return params.toString()
  }, [filters])

  // Fetch the first page whenever filters change. Resets offset.
  const fetchFirstPage = useCallback(async () => {
    setLoading(true)
    setForbidden(false)
    setLoadFailed(false)
    try {
      const res = await fetch(apiUrl(`/api/audit-log?${buildQuery(0)}`))
      if (res.status === 403) { setForbidden(true); setRows([]); setTotal(0); setTotalCapped(false); return }
      if (!res.ok) throw new Error('unread')
      const data = await res.json()
      // Missing or non-array `rows` is not an empty log. Only a real array
      // — including [] — is an answer about this parish.
      const nextRows = data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.rows)
        ? data.rows
        : null
      if (nextRows === null) throw new Error('malformed')
      setRows(nextRows)
      setTotal(data.total ?? 0)
      setTotalCapped(!!data.total_capped)
      setHasMore(!!data.hasMore)
      setOffset(nextRows.length)
      setLoadFailed(false)
    } catch {
      // Do not substitute []. The empty state would then claim nothing
      // has been recorded. Rows already read stay in state; the failure
      // panel is what the body shows until a first page succeeds.
      setLoadFailed(true)
      toast.error(t('err.load'))
    } finally {
      setLoading(false)
    }
  }, [buildQuery, toast, t])

  useEffect(() => { fetchFirstPage() }, [fetchFirstPage])

  async function loadMore() {
    if (!hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(apiUrl(`/api/audit-log?${buildQuery(offset)}`))
      if (!res.ok) throw new Error('unread')
      const data = await res.json()
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.rows)) {
        throw new Error('malformed')
      }
      setRows(prev => [...prev, ...data.rows])
      setHasMore(!!data.hasMore)
      setOffset(o => o + data.rows.length)
    } catch {
      // A failed next page must not replace the rows already on screen
      // with [] — that is the same quiet-parish claim as a failed first page.
      toast.error(t('err.load'))
    } finally {
      setLoadingMore(false)
    }
  }

  // Changing the entity type also drops any single-record scope: an
  // entity_id only means something paired with its type, so keeping a
  // stale id would mix record types under the "scoped to one record"
  // chip (the id filter is type-agnostic server-side).
  const updateFilter = (k) => (e) => setFilters(f => ({
    ...f,
    [k]: e.target.value,
    ...(k === 'entity_type' ? { entity_id: '' } : {}),
  }))
  const resetFilters = () => setFilters(EMPTY_FILTERS)
  const clearEntityScope = () => setFilters(f => ({ ...f, entity_id: '' }))
  const isFiltered   = filters.action || filters.entity_type || filters.entity_id || filters.since || filters.until

  // Friendly label for the scoped entity type, for the AUD.3 chip.
  const scopedTypeLabel = ENTITY_TYPES
    .filter(e => e.value && e.value === filters.entity_type)
    .map(e => t(e.key))[0] || t('audit.scopedRecord')

  // Export the current filtered view as CSV (AUD.2). Reuses the same
  // filter params (minus pagination) so what you see is what you export.
  // The global fetch interceptor sends the session cookie, so we pull
  // the file as a blob and trigger a download rather than a bare link.
  const [exporting, setExporting] = useState(false)
  async function exportCsv() {
    if (exporting) return
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (filters.action)      params.set('action', filters.action)
      if (filters.entity_type) params.set('entity_type', filters.entity_type)
      if (filters.entity_id)   params.set('entity_id', filters.entity_id)
      if (filters.since)       params.set('since', startOfLocalDayISO(filters.since))
      if (filters.until)       params.set('until', endOfLocalDayISO(filters.until))
      const qs = params.toString()
      const res = await fetch(apiUrl(`/api/audit-log/export.csv${qs ? `?${qs}` : ''}`))
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit-log-${todayLocalISO()}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(t('audit.exportFailed'))
    } finally {
      setExporting(false)
    }
  }

  // Forbidden state — non-admins shouldn't see this page, but if they
  // navigate here directly the server returns 403 and we render a
  // helpful message rather than a blank table.
  if (forbidden) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState
            icon={Shield}
            title={t('audit.adminOnly')}
            body={t('audit.adminOnlyBody')}
          />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">{t('audit.title')}</h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
              {t('audit.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting || loading}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-200/60 dark:hover:bg-ink-800/70 disabled:opacity-40 transition-colors"
            title={t('audit.exportTitle')}
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            {t('audit.export')}
          </button>
        </motion.div>

        {/* Filter bar */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-sm p-4"
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('audit.filterAction')}</label>
              <select
                value={filters.action}
                aria-label={t('audit.filterActionAria')}
                onChange={updateFilter('action')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
              >
                {ACTIONS.map(a => <option key={a.value} value={a.value}>{t(a.key)}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('audit.filterType')}</label>
              <select
                value={filters.entity_type}
                aria-label={t('audit.filterTypeAria')}
                onChange={updateFilter('entity_type')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
              >
                {ENTITY_TYPES.map(e => <option key={e.value} value={e.value}>{t(e.key)}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('audit.filterSince')}</label>
              <input
                type="date"
                value={filters.since}
                aria-label={t('audit.filterSinceAria')}
                onChange={updateFilter('since')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
              />
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('audit.filterUntil')}</label>
              <input
                type="date"
                value={filters.until}
                aria-label={t('audit.filterUntilAria')}
                onChange={updateFilter('until')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
              />
            </div>
            {isFiltered && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-500 hover:text-ink-900 dark:text-parchment-300/70 dark:hover:text-parchment-50 px-2 py-2 transition-colors"
              >
                <RotateCcw size={13} /> {t('audit.reset')}
              </button>
            )}
          </div>
        </motion.div>

        {/* Entity scope chip (AUD.3) — shown when the log is pinned to one
            record via entity_id (e.g. arrived from a member's "View
            history" link). No dedicated input, so this is how you see and
            clear it. */}
        {filters.entity_id && (
          <div className="flex items-center gap-2 -mt-2">
            <span className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full bg-church-900/10 dark:bg-parchment-100/10 text-church-900 dark:text-parchment-100 border border-church-900/20 dark:border-parchment-100/20">
              {t('audit.scopedTo', { type: scopedTypeLabel, id: filters.entity_id })}
              <button type="button" onClick={clearEntityScope} aria-label={t('audit.clearScope')} className="hover:text-rose-700 transition-colors">
                <X size={13} />
              </button>
            </span>
          </div>
        )}

        {/* Body */}
        {loading ? (
          <SkeletonRowList count={6} withAvatar={false} />
        ) : loadFailed ? (
          <LoadFailure
            title={t('load.failedTitle')}
            body={t('load.failedBody')}
            onRetry={fetchFirstPage}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={isFiltered ? t('audit.emptyFilteredTitle') : t('audit.emptyTitle')}
            body={isFiltered ? t('audit.emptyFilteredBody') : t('audit.emptyBody')}
            action={isFiltered ? { label: t('audit.clearFilters'), onClick: resetFilters } : undefined}
          />
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden"
          >
            <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[44rem]">
              <thead className="bg-parchment-100/60 dark:bg-ink-800/40 border-b border-parchment-300/60 dark:border-brass-900/30">
                <tr>
                  <th className={TH}>{t('audit.colWhen')}</th>
                  <th className={TH}>{t('audit.colWho')}</th>
                  <th className={TH}>{t('audit.colWhat')}</th>
                  <th className={TH}>{t('audit.colStatus')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
                {rows.map(r => (
                  <tr key={r.id} className="hover:bg-parchment-100/40 dark:hover:bg-ink-800/40 transition-colors">
                    <td className="px-4 py-3 text-ink-700 dark:text-parchment-200" title={fmtAbsolute(r.created_at, dateLocale)}>
                      <span className="whitespace-nowrap">{timeAgo(r.created_at, t, dateLocale)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-7 h-7 rounded-full bg-church-900 dark:bg-church-700 flex items-center justify-center text-parchment-50 text-[10px] font-bold shrink-0">
                          {initials(r.actor_closed ? t('audit.formerOperator') : (r.user_name || r.user_email || '?'))}
                        </span>
                        <div className="min-w-0">
                          <p className="font-medium text-ink-900 dark:text-parchment-50 truncate">{r.actor_closed ? t('audit.formerOperator') : (r.user_name || '—')}</p>
                          <p className="text-xs text-ink-500 dark:text-parchment-300/70 truncate">{r.actor_closed ? '—' : (r.user_email || '—')}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${ACTION_BADGE[r.action] ?? 'bg-parchment-200 text-ink-700'}`}>
                          {badgeLabel[r.action] ?? r.action}
                        </span>
                        <span className="text-ink-700 dark:text-parchment-200">{summaryFor(r, t)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-ink-500 dark:text-parchment-300/70">{r.status_code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {/* Footer: load more + count */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-parchment-300/60 dark:border-brass-900/30 bg-parchment-100/40 dark:bg-ink-800/20">
              <span className="text-xs text-ink-500 dark:text-parchment-300/70">
                {t('audit.showing', { shown: rows.length.toLocaleString(dateLocale), total: `${total.toLocaleString(dateLocale)}${totalCapped ? '+' : ''}` })}
              </span>
              {hasMore && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-church-800 dark:text-brass-200 hover:text-church-900 dark:hover:text-parchment-50 disabled:opacity-50 transition-colors"
                >
                  {loadingMore && <Loader2 size={12} className="animate-spin" />}
                  {t('audit.loadMore')}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </div>
    </PageWrapper>
  )
}
