import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  BookOpen, MessageCircle, Sun, Megaphone, Search, RotateCcw,
  Loader2, Copy, Check, ChevronDown, ChevronUp,
} from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { LibraryIllustration } from '../components/illustrations'
import { SkeletonCard } from '../components/Skeleton'
import { useToast } from '../components/ToastProvider'
import { apiUrl } from '../api'
import { startOfLocalDayISO, endOfLocalDayISO } from '../utils/dates'

// Library — browse every AI generation the org has saved. Reads
// /api/ai/generations with type/q/since/until/offset support.
// Card list with click-to-expand for the full output, copy button,
// and Load-more pagination.

const TYPE_META = {
  sermon:       { label: 'Sermon Outline', icon: BookOpen,      accent: 'from-church-600 to-church-800' },
  message:      { label: 'Church Message', icon: MessageCircle, accent: 'from-ink-600 to-ink-800' },
  devotional:   { label: 'Devotional',     icon: Sun,           accent: 'from-amber-700 to-amber-900' },
  announcement: { label: 'Announcement',   icon: Megaphone,     accent: 'from-brass-600 to-brass-800' },
}

const TYPE_OPTIONS = [
  { value: '',             label: 'All types' },
  { value: 'sermon',       label: 'Sermon Outline' },
  { value: 'message',      label: 'Church Message' },
  { value: 'devotional',   label: 'Devotional' },
  { value: 'announcement', label: 'Announcement' },
]

const PAGE_SIZE = 25

const EMPTY_FILTERS = { type: '', q: '', since: '', until: '' }

function timeAgo(dateStr) {
  const d = new Date(dateStr)
  const sec = Math.floor((Date.now() - d.getTime()) / 1000)
  if (sec < 60)        return 'just now'
  const min = Math.floor(sec / 60); if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60);  if (hr < 24)  return `${hr}h ago`
  const day = Math.floor(hr / 24);  if (day < 7)  return `${day}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function GenerationCard({ entry }) {
  const meta = TYPE_META[entry.type] ?? TYPE_META.sermon
  const Icon = meta.icon
  const [open, setOpen]     = useState(false)
  const [copied, setCopied] = useState(false)
  const toast = useToast()

  async function copyOutput(e) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(entry.output ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  const promptPreview = (entry.prompt ?? '').replace(/\s+/g, ' ').trim()

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-sm overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-parchment-100 dark:hover:bg-ink-800/40 transition-colors"
      >
        <div className={`shrink-0 w-9 h-9 rounded-lg bg-gradient-to-br ${meta.accent} flex items-center justify-center text-parchment-50 shadow-sm`}>
          <Icon size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-ink-700 dark:text-parchment-100">{meta.label}</span>
            <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">· {timeAgo(entry.created_at)}</span>
          </div>
          <p className="mt-1 text-sm text-ink-800 dark:text-parchment-100 line-clamp-2 leading-snug">
            {promptPreview || <span className="italic text-ink-500 dark:text-parchment-300/70">No prompt recorded</span>}
          </p>
        </div>
        <div className="shrink-0 self-center text-ink-400 dark:text-parchment-300/50">
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="border-t border-parchment-300/50 dark:border-brass-900/25"
          >
            <div className="px-4 py-3 space-y-3">
              {entry.prompt && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70 mb-1">Prompt</p>
                  <p className="text-xs text-ink-700 dark:text-parchment-200 whitespace-pre-wrap leading-relaxed">{entry.prompt}</p>
                </div>
              )}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70">Output</p>
                  <button
                    type="button"
                    onClick={copyOutput}
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium text-church-700 dark:text-brass-200 hover:text-church-900 dark:hover:text-parchment-50 transition-colors"
                  >
                    {copied ? <Check size={11} className="text-brass-500" /> : <Copy size={11} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="text-sm text-ink-800 dark:text-parchment-100 whitespace-pre-wrap leading-relaxed">
                  {entry.output || <span className="italic text-ink-500 dark:text-parchment-300/70">Empty output</span>}
                </p>
              </div>
              {(entry.provider || entry.model) && (
                <p className="text-[10px] text-ink-500 dark:text-parchment-300/70">
                  {[entry.provider, entry.model].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default function Library() {
  const [filters,  setFilters]  = useState(EMPTY_FILTERS)
  const [rows,     setRows]     = useState([])
  const [total,    setTotal]    = useState(0)
  const [hasMore,  setHasMore]  = useState(false)
  const [offset,   setOffset]   = useState(0)
  const [loading,  setLoading]  = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const toast = useToast()

  const buildQuery = useCallback((nextOffset) => {
    const params = new URLSearchParams()
    if (filters.type)  params.set('type',  filters.type)
    if (filters.q)     params.set('q',     filters.q)
    // Local-day bounds — `until` runs through end-of-day so items
    // created today aren't dropped by a UTC-midnight cutoff (1.1).
    if (filters.since) params.set('since', startOfLocalDayISO(filters.since))
    if (filters.until) params.set('until', endOfLocalDayISO(filters.until))
    params.set('limit',  String(PAGE_SIZE))
    params.set('offset', String(nextOffset))
    return params.toString()
  }, [filters])

  const fetchFirstPage = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(apiUrl(`/api/ai/generations?${buildQuery(0)}`))
      if (!res.ok) throw new Error(`Failed to load library (${res.status})`)
      const data = await res.json()
      setRows(data.rows ?? [])
      setTotal(data.total ?? 0)
      setHasMore(!!data.hasMore)
      setOffset(data.rows?.length ?? 0)
    } catch (e) {
      toast.error("Couldn't load the library. Nothing was lost — please retry.")
    } finally {
      setLoading(false)
    }
  }, [buildQuery, toast])

  useEffect(() => { fetchFirstPage() }, [fetchFirstPage])

  async function loadMore() {
    if (!hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(apiUrl(`/api/ai/generations?${buildQuery(offset)}`))
      if (!res.ok) throw new Error(`Failed to load more (${res.status})`)
      const data = await res.json()
      setRows(prev => [...prev, ...(data.rows ?? [])])
      setHasMore(!!data.hasMore)
      setOffset(o => o + (data.rows?.length ?? 0))
    } catch (e) {
      toast.error("Couldn't load more of the library. Nothing was lost — please retry.")
    } finally {
      setLoadingMore(false)
    }
  }

  const updateFilter = (k) => (e) => setFilters(f => ({ ...f, [k]: e.target.value }))
  const resetFilters = () => setFilters(EMPTY_FILTERS)
  const isFiltered   = !!(filters.type || filters.q || filters.since || filters.until)

  return (
    <PageWrapper>
      <div className="max-w-5xl mx-auto space-y-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Library</h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            Every sermon outline, message, devotional, and announcement you’ve generated. Search, filter, and copy back into use.
          </p>
        </motion.div>

        {/* Filter bar */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-sm p-4"
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Search</label>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 dark:text-parchment-300/50" />
                <input
                  type="text"
                  value={filters.q}
                  onChange={updateFilter('q')}
                  placeholder="Find a phrase from a past prompt or output…" aria-label="Find a phrase from a past prompt or output…"
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
                />
              </div>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Type</label>
              <select
                value={filters.type}
                aria-label="Filter by type"
                onChange={updateFilter('type')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
              >
                {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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

        {/* Body */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            illustration={!isFiltered ? LibraryIllustration : undefined}
            icon={BookOpen}
            title={isFiltered ? 'No matching generations' : 'Your library is empty'}
            body={isFiltered
              ? 'No generations match the current filters. Try a wider date range or a different search term.'
              : 'Generations from the AI Studio land here. Draft a sermon outline or a devotional and it will be browsable forever.'}
            action={isFiltered ? { label: 'Clear filters', onClick: resetFilters } : undefined}
          />
        ) : (
          <>
            <div className="space-y-2">
              <AnimatePresence initial={false}>
                {rows.map(r => <GenerationCard key={r.id} entry={r} />)}
              </AnimatePresence>
            </div>
            <div className="flex items-center justify-between px-1 py-2">
              <span className="text-xs text-ink-500 dark:text-parchment-300/70">
                Showing {rows.length} of {total}
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
          </>
        )}
      </div>
    </PageWrapper>
  )
}
