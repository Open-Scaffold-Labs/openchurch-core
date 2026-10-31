import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  BookOpen, MessageCircle, Sun, Megaphone, Search, RotateCcw,
  Loader2, Copy, Check, ChevronDown, ChevronUp,
} from 'lucide-react'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { LibraryIllustration } from '../components/illustrations'
import { SkeletonCard } from '../components/Skeleton'
import { useToast } from '../components/ToastProvider'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { startOfLocalDayISO, endOfLocalDayISO } from '../utils/dates'

// Library — browse every AI generation the org has saved. Reads
// /api/ai/generations with type/q/since/until/offset support.
// Card list with click-to-expand for the full output, copy button,
// and Load-more pagination.

const TYPE_META = {
  sermon:       { labelKey: 'lib.type.sermon',       icon: BookOpen,      accent: 'from-church-600 to-church-800' },
  message:      { labelKey: 'lib.type.message',      icon: MessageCircle, accent: 'from-ink-600 to-ink-800' },
  devotional:   { labelKey: 'lib.type.devotional',   icon: Sun,           accent: 'from-amber-700 to-amber-900' },
  announcement: { labelKey: 'lib.type.announcement', icon: Megaphone,     accent: 'from-brass-600 to-brass-800' },
}

const TYPE_OPTIONS = [
  { value: '',             labelKey: 'lib.allTypes' },
  { value: 'sermon',       labelKey: 'lib.type.sermon' },
  { value: 'message',      labelKey: 'lib.type.message' },
  { value: 'devotional',   labelKey: 'lib.type.devotional' },
  { value: 'announcement', labelKey: 'lib.type.announcement' },
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
  const { t } = useLocale()
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
      toast.error(t('lib.copyFailed'))
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
            <span className="text-xs font-semibold text-ink-700 dark:text-parchment-100">{t(meta.labelKey)}</span>
            <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">· {timeAgo(entry.created_at)}</span>
          </div>
          <p className="mt-1 text-sm text-ink-800 dark:text-parchment-100 line-clamp-2 leading-snug">
            {promptPreview || <span className="italic text-ink-500 dark:text-parchment-300/70">{t('lib.noPrompt')}</span>}
          </p>
        </div>
        <div className="shrink-0 self-center text-ink-400 dark:text-parchment-300/70">
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
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70 mb-1">{t('lib.prompt')}</p>
                  <p className="text-xs text-ink-700 dark:text-parchment-200 whitespace-pre-wrap leading-relaxed">{entry.prompt}</p>
                </div>
              )}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70">{t('lib.output')}</p>
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
                  {entry.output || <span className="italic text-ink-500 dark:text-parchment-300/70">{t('lib.emptyOutput')}</span>}
                </p>
              </div>
              {(entry.provider || entry.model) && (
                <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">
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
  const { t } = useLocale()
  const [filters,  setFilters]  = useState(EMPTY_FILTERS)
  const [rows,     setRows]     = useState([])
  const [total,    setTotal]    = useState(0)
  const [hasMore,  setHasMore]  = useState(false)
  const [offset,   setOffset]   = useState(0)
  const [loading,  setLoading]  = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // Distinct from an empty archive: the first page was refused, thrown,
  // or was not a list. Leaving `rows` as [] would render "Your library is empty".
  const [loadFailed, setLoadFailed] = useState(false)
  const [adminOnly, setAdminOnly] = useState(false)
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

  const sayUnread = useCallback(() => {
    toast.error(`${t('load.failedTitle')} ${t('load.failedBody')}`)
  }, [toast, t])

  const fetchFirstPage = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(apiUrl(`/api/ai/generations?${buildQuery(0)}`))
      if (res.status === 403) { setAdminOnly(true); setLoadFailed(false); return }
      if (!res.ok) throw new Error('unread')
      const data = await res.json()
      // A missing or non-list `rows` is not an empty archive.
      if (!data || !Array.isArray(data.rows)) throw new Error('malformed')
      setRows(data.rows)
      setTotal(data.total ?? 0)
      setHasMore(!!data.hasMore)
      setOffset(data.rows.length)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
      sayUnread()
    } finally {
      setLoading(false)
    }
  }, [buildQuery, sayUnread])

  useEffect(() => { fetchFirstPage() }, [fetchFirstPage])

  async function loadMore() {
    if (!hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(apiUrl(`/api/ai/generations?${buildQuery(offset)}`))
      if (!res.ok) throw new Error('unread')
      const data = await res.json()
      if (!data || !Array.isArray(data.rows)) throw new Error('malformed')
      setRows(prev => [...prev, ...data.rows])
      setHasMore(!!data.hasMore)
      setOffset(o => o + data.rows.length)
    } catch {
      // Keep the rows already on screen. A failed next page is not an empty archive.
      sayUnread()
    } finally {
      setLoadingMore(false)
    }
  }

  const updateFilter = (k) => (e) => setFilters(f => ({ ...f, [k]: e.target.value }))
  const resetFilters = () => setFilters(EMPTY_FILTERS)
  const isFiltered   = !!(filters.type || filters.q || filters.since || filters.until)

  return (
    <PageWrapper type="list">
      <div className="max-w-5xl mx-auto space-y-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <PageHeader title={t('lib.title')} />
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            {t('lib.subtitle')}
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
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('lib.search')}</label>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 dark:text-parchment-300/70" />
                <input
                  type="text"
                  value={filters.q}
                  onChange={updateFilter('q')}
                  placeholder={t('lib.searchPh')} aria-label={t('lib.searchPh')}
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
                />
              </div>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('lib.type')}</label>
              <select
                value={filters.type}
                aria-label={t('lib.filterType')}
                onChange={updateFilter('type')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
              >
                {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('lib.since')}</label>
              <input
                type="date"
                value={filters.since}
                aria-label={t('lib.filterFrom')}
                onChange={updateFilter('since')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
              />
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('lib.until')}</label>
              <input
                type="date"
                value={filters.until}
                aria-label={t('lib.filterUntil')}
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
                <RotateCcw size={13} /> {t('lib.reset')}
              </button>
            )}
          </div>
        </motion.div>

        {/* Body */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : adminOnly ? (
          <EmptyState
            icon={BookOpen}
            title={t('lib.adminOnlyTitle')}
            body={t('lib.adminOnlyBody')}
          />
        ) : loadFailed ? (
          <EmptyState
            icon={BookOpen}
            title={t('load.failedTitle')}
            body={t('load.failedBody')}
            action={{ label: t('load.retry'), onClick: fetchFirstPage }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            illustration={!isFiltered ? LibraryIllustration : undefined}
            icon={BookOpen}
            title={isFiltered ? t('lib.noMatchTitle') : t('lib.emptyTitle')}
            body={isFiltered ? t('lib.noMatchBody') : t('lib.emptyBody')}
            action={isFiltered ? { label: t('lib.clearFilters'), onClick: resetFilters } : undefined}
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
                  {t('mem.loadMore')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </PageWrapper>
  )
}
