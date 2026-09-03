import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ScrollText, Loader2, Shield, RotateCcw, Download, X } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'
import { useToast } from '../components/ToastProvider'
import { apiUrl } from '../api'
import { initials } from '../utils/format'
import { startOfLocalDayISO, endOfLocalDayISO, todayLocalISO } from '../utils/dates'

// Admin-only audit log viewer. Reads /api/audit-log (paginated +
// filterable). Server already gates by admin role; the sidebar hides
// this from non-admins. If a non-admin somehow lands here directly,
// the 403 surfaces a friendly Forbidden state instead of a blank list.

const ACTIONS = [
  { value: '',       label: 'All actions' },
  { value: 'create', label: 'Created' },
  { value: 'update', label: 'Updated' },
  { value: 'delete', label: 'Deleted' },
]

// Mirrors the entity_type allowlist in server/src/routes/auditLog.js.
// Update both when a new audit mount lands.
const ENTITY_TYPES = [
  { value: '',               label: 'All types' },
  { value: 'client',         label: 'Member' },
  { value: 'group',          label: 'Group' },
  { value: 'group_interest', label: 'Connect-card interest' },
  { value: 'event',          label: 'Event' },
  { value: 'calendar_event', label: 'Schedule entry' },
  { value: 'availability',   label: 'Availability' },
  { value: 'swap_request',   label: 'Swap request' },
  { value: 'attendance',     label: 'Attendance' },
  { value: 'checkin',        label: 'Check-in' },
  { value: 'room',           label: 'Room / class' },
  { value: 'kiosk',          label: 'Kiosk' },
  { value: 'task',           label: 'Task' },
  { value: 'donation',       label: 'Donation' },
  { value: 'fund',           label: 'Giving fund' },
  { value: 'pledge',         label: 'Pledge' },
  { value: 'payroll',        label: 'Payroll' },
  { value: 'form',           label: 'Form' },
  { value: 'parish_feast',   label: 'Parish feast' },
  { value: 'bulletin',       label: 'Bulletin' },
  { value: 'service_plan',   label: 'Service plan' },
  { value: 'sacrament',      label: 'Sacrament' },
  { value: 'mass_intention', label: 'Mass intention' },
  { value: 'support_ticket', label: 'Support ticket' },
  { value: 'fee_schedule', label: 'Fee schedule' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'import_batch', label: 'Import' },
  { value: 'user',           label: 'Team member' },
  { value: 'organization',   label: 'Org settings' },
]

const ACTION_BADGE = {
  create: 'bg-brass-100 text-brass-800 dark:bg-brass-900/30 dark:text-brass-200',
  update: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  delete: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200',
}

const PAGE_SIZE = 50

function timeAgo(iso) {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60)        return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60)        return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24)         return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7)         return `${day}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: hr > 24 * 365 ? 'numeric' : undefined })
}

function fmtAbsolute(iso) {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
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
  const toast = useToast()

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
    try {
      const res = await fetch(apiUrl(`/api/audit-log?${buildQuery(0)}`))
      if (res.status === 403) { setForbidden(true); setRows([]); setTotal(0); setTotalCapped(false); return }
      if (!res.ok) throw new Error(`Failed to load audit log (${res.status})`)
      const data = await res.json()
      setRows(data.rows ?? [])
      setTotal(data.total ?? 0)
      setTotalCapped(!!data.total_capped)
      setHasMore(!!data.hasMore)
      setOffset(data.rows?.length ?? 0)
    } catch (e) {
      toast.error("Couldn't load the audit log. Nothing was lost — please retry.")
    } finally {
      setLoading(false)
    }
  }, [buildQuery, toast])

  useEffect(() => { fetchFirstPage() }, [fetchFirstPage])

  async function loadMore() {
    if (!hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(apiUrl(`/api/audit-log?${buildQuery(offset)}`))
      if (!res.ok) throw new Error(`Failed to load more (${res.status})`)
      const data = await res.json()
      setRows(prev => [...prev, ...(data.rows ?? [])])
      setHasMore(!!data.hasMore)
      setOffset(o => o + (data.rows?.length ?? 0))
    } catch (e) {
      toast.error("Couldn't load more of the audit log. Nothing was lost — please retry.")
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
  const scopedTypeLabel = (ENTITY_TYPES.find(t => t.value === filters.entity_type)?.label) || 'record'

  // Export the current filtered view as CSV (AUD.2). Reuses the same
  // filter params (minus pagination) so what you see is what you export.
  // The global fetch interceptor attaches the bearer token, so we pull
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
      toast.error("Couldn't export the audit log. Nothing was lost — please retry.")
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
            title="Admins only"
            body="The audit log is restricted to admins. Ask an admin in your church if you need to review changes."
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
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Audit log</h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
              Every change made to members, events, tasks, and the schedule. Use this to trace who edited what.
            </p>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting || loading}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-200/60 dark:hover:bg-ink-800/70 disabled:opacity-40 transition-colors"
            title="Download the current filtered view as CSV"
          >
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            Export CSV
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
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Action</label>
              <select
                value={filters.action}
                aria-label="Filter by action"
                onChange={updateFilter('action')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
              >
                {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Type</label>
              <select
                value={filters.entity_type}
                aria-label="Filter by record type"
                onChange={updateFilter('entity_type')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
              >
                {ENTITY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Since</label>
              <input
                type="date"
                value={filters.since}
                aria-label="Filter from date"
                onChange={updateFilter('since')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
              />
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Until</label>
              <input
                type="date"
                value={filters.until}
                aria-label="Filter until date"
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
                <RotateCcw size={13} /> Reset
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
              Scoped to one {scopedTypeLabel} (#{filters.entity_id})
              <button type="button" onClick={clearEntityScope} aria-label="Clear record scope" className="hover:text-rose-700 transition-colors">
                <X size={13} />
              </button>
            </span>
          </div>
        )}

        {/* Body */}
        {loading ? (
          <SkeletonRowList count={6} withAvatar={false} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={isFiltered ? 'No matching activity' : 'Nothing recorded yet'}
            body={isFiltered
              ? 'No changes match the current filters. Try a wider date range or fewer filters.'
              : 'When members are added, events created, or tasks edited, the activity will appear here.'}
            action={isFiltered ? { label: 'Clear filters', onClick: resetFilters } : undefined}
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
                  {['When', 'Who', 'What', 'Status'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
                {rows.map(r => (
                  <tr key={r.id} className="hover:bg-parchment-100/40 dark:hover:bg-ink-800/40 transition-colors">
                    <td className="px-4 py-3 text-ink-700 dark:text-parchment-200" title={fmtAbsolute(r.created_at)}>
                      <span className="whitespace-nowrap">{timeAgo(r.created_at)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-7 h-7 rounded-full bg-church-900 dark:bg-church-700 flex items-center justify-center text-parchment-50 text-[10px] font-bold shrink-0">
                          {initials(r.user_name || r.user_email || '?')}
                        </span>
                        <div className="min-w-0">
                          <p className="font-medium text-ink-900 dark:text-parchment-50 truncate">{r.user_name || '—'}</p>
                          <p className="text-xs text-ink-500 dark:text-parchment-300/70 truncate">{r.user_email || '—'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${ACTION_BADGE[r.action] ?? 'bg-parchment-200 text-ink-700'}`}>
                          {r.action}
                        </span>
                        <span className="text-ink-700 dark:text-parchment-200">{r.summary || `${r.action} ${r.entity_type}`}</span>
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
                Showing {rows.length.toLocaleString()} of {total.toLocaleString()}{totalCapped ? '+' : ''}
              </span>
              {hasMore && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-church-800 dark:text-brass-200 hover:text-church-900 dark:hover:text-parchment-50 disabled:opacity-50 transition-colors"
                >
                  {loadingMore && <Loader2 size={12} className="animate-spin" />}
                  Load more
                </button>
              )}
            </div>
          </motion.div>
        )}
      </div>
    </PageWrapper>
  )
}
