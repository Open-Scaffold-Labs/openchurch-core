import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Users, Calendar, CheckSquare, DollarSign, Heart,
  Loader2, X, Clock, ArrowRight, History,
} from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { scrimCls } from './MobileSheet'

// Global search palette (Sprint G / G.1). Modal overlay opened from
// the header search button — replaces the inline 320px bar that
// was previously embedded in App.jsx.
//
// Why a modal palette over an inline bar:
// - Works on mobile (the inline bar was hidden under md)
// - Bigger input + roomier results = faster scanning
// - Hosts type-filter chips + recent-queries list without crowding
//   the header
// - Future-proofs for cmd-k keyboard shortcut (Sprint G / G.2)
//
// Props:
//   open      — boolean
//   onClose   — () => void
//   typeFilter / setTypeFilter — controlled chip state (G.2 plugs in)
//
// /api/search returns a flat array of results tagged with `type`;
// see server/src/routes/search.js. We group on the client because
// the server is deliberately backend-agnostic.

const TYPE_META = {
  member:   { icon: Users,       path: '/clients' },
  event:    { icon: Calendar,    path: '/events' },
  task:     { icon: CheckSquare, path: '/tasks' },
  staff:    { icon: DollarSign,  path: '/payroll' },
  donation: { icon: Heart,       path: '/donations' },
}

// Static t() calls so the critical-surface harness can see every key.
// A t(variable) here would be an unresolved binding.
function typeLabel(t, type) {
  if (type === 'member') return t('nav.Members')
  if (type === 'event') return t('nav.Events')
  if (type === 'task') return t('dash.glance.tasks')
  if (type === 'staff') return t('mem.role.Staff')
  if (type === 'donation') return t('nav.Donations')
  return t('shell.search.unknown')
}

// ⌘K used to find the person and then lose them: selectItem always
// navigated to the type's list page (`/clients`, `/donations`). The
// search payload already carries `id` (see server/src/routes/search.js).
// Members open the profile; gifts open the log with that row focused.
function hasItemId(item) {
  return item?.id != null && String(item.id).trim() !== ''
}

export function pathForSearchItem(item) {
  const meta = TYPE_META[item?.type]
  if (!meta) return null
  if (item.type === 'member' && hasItemId(item)) return `/clients/${item.id}`
  if (item.type === 'donation' && hasItemId(item)) {
    return `/donations?id=${encodeURIComponent(item.id)}`
  }
  return meta.path
}

const RECENTS_KEY = 'ochr_search_recents'
const RECENTS_MAX = 8

function readRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(0, RECENTS_MAX) : []
  } catch { return [] }
}

function writeRecents(list) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)))
  } catch { /* storage disabled — degrade silently */ }
}

function pushRecent(query) {
  const trimmed = query.trim()
  if (!trimmed) return
  const existing = readRecents().filter(q => q.toLowerCase() !== trimmed.toLowerCase())
  writeRecents([trimmed, ...existing])
}

function clearRecents() {
  try { localStorage.removeItem(RECENTS_KEY) } catch {}
}

// Title/subtitle per type — same shape the old inline search used so
// the row layout reads consistent across types.
function getTitle(item, t) {
  if (item.type === 'member')   return item.name
  if (item.type === 'event')    return item.title
  if (item.type === 'task')     return item.title
  if (item.type === 'staff')    return item.name
  if (item.type === 'donation') return item.donor_name
  return item.name || item.title || t('shell.search.unknown')
}

function getSubtitle(item) {
  if (item.type === 'member')   return [item.role, item.email].filter(Boolean).join(' · ')
  if (item.type === 'event')    return [item.service_division, item.location].filter(Boolean).join(' · ')
  if (item.type === 'task')     return [item.category?.replace(/_/g, ' '), item.priority].filter(Boolean).join(' · ')
  if (item.type === 'staff')    return [item.role, item.status].filter(Boolean).join(' · ')
  if (item.type === 'donation') {
    return [item.category, item.amount ? `$${Number(item.amount).toFixed(2)}` : ''].filter(Boolean).join(' · ')
  }
  return ''
}

export default function GlobalSearchPalette({ open, onClose, typeFilter, setTypeFilter }) {
  const { t } = useLocale()
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState([])
  const [searchFailed, setSearchFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  // Bumped when the same letters are tried again after a failure. setQuery
  // of an unchanged string does not re-run the search effect.
  const [attempt, setAttempt] = useState(0)
  const [recents, setRecents] = useState(() => readRecents())
  const inputRef    = useRef(null)
  const debounceRef = useRef(null)
  const navigate = useNavigate()

  // Focus the input + reset state every time the palette opens. Reset
  // results too so the previous query doesn't briefly flash.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setSearchFailed(false)
    setRecents(readRecents())
    // Focus on the next frame — the input mounts after the AnimatePresence
    // resolves, so a same-tick focus() races with React.
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(focusTimer)
  }, [open])

  // Escape closes — registered globally while open so it works even
  // when the input is blurred (e.g. user clicked a filter chip).
  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Debounced search — 300ms after typing stops we hit /api/search.
  // Fewer than two characters is not a search.
  //
  // Layout, not a passive effect: its cleanup marks the previous request
  // stale and aborts it before paint, so a reply already in flight cannot
  // land between "clear the old answer" and "ignore that reply". Typing
  // "maria" then "pedro" used to let maria's [] render as
  // "No results for pedro". Only the latest query may set results or the
  // failure note. Functional updates on the short-query path bail out when
  // nothing changed — a fresh [] every time would loop.
  useLayoutEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults(prev => (prev.length === 0 ? prev : []))
      setSearchFailed(prev => (prev ? false : prev))
      setLoading(prev => (prev ? false : prev))
      return
    }

    const controller = new AbortController()
    let stale = false
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      if (stale) return
      try {
        const r = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(trimmed)}`), {
          signal: controller.signal,
        })
        if (stale) return
        if (!r.ok) {
          setResults([])
          setSearchFailed(true)
          return
        }
        const data = await r.json()
        if (stale) return
        // A body that is not a list is a read we could not use, not a
        // parish where nothing matched.
        if (!Array.isArray(data)) {
          setResults([])
          setSearchFailed(true)
          return
        }
        setSearchFailed(false)
        setResults(data)
      } catch {
        // Every abort this effect starts has already set stale. An
        // AbortError with stale still false came from the browser, and
        // treating it as "nothing matched" is the empty-parish lie.
        if (stale) return
        setResults([])
        setSearchFailed(true)
      } finally {
        if (!stale) setLoading(false)
      }
    }, 300)

    return () => {
      stale = true
      controller.abort()
      clearTimeout(debounceRef.current)
    }
  }, [query, attempt])

  const selectItem = useCallback((item) => {
    pushRecent(query)
    setRecents(readRecents())
    const path = pathForSearchItem(item)
    if (path) navigate(path)
    onClose()
  }, [query, navigate, onClose])

  const runRecent = useCallback((q) => {
    if (q === query && searchFailed) setAttempt(n => n + 1)
    setQuery(q)
    inputRef.current?.focus()
  }, [query, searchFailed])

  // React drops an input event whose value did not change, so pasting or
  // retyping the same query after a failure never reaches onChange and the
  // search effect does not run. A native listener still hears that event.
  //
  // The listener reads the latest query/failure from refs written during
  // render. It used to close over state and be re-registered by a passive
  // effect, which runs AFTER the failure note is painted: an input arriving
  // in that window (a fast retype, or a test continuing as soon as the note
  // appears) saw searchFailed=false and was dropped. Refs are current at
  // commit, so there is no window.
  const queryRef = useRef(query)
  const searchFailedRef = useRef(searchFailed)
  queryRef.current = query
  searchFailedRef.current = searchFailed
  //
  // TARS R294-1: attached by a ref callback on the input itself, not a
  // mount effect. The app keeps the palette mounted with open=false, so a
  // mount-only effect found no input and never attached, and a reopen mounts
  // a new input node. React calls this callback in the commit that mounts the
  // input (before paint, so no failure-state window) and with null when it
  // unmounts on close, so each open has exactly one listener.
  const retryListenerRef = useRef(null)
  const setInputEl = useCallback((el) => {
    const prev = inputRef.current
    if (prev && retryListenerRef.current) prev.removeEventListener('input', retryListenerRef.current)
    retryListenerRef.current = null
    inputRef.current = el
    if (!el) return
    const onInput = (e) => {
      const next = e.target?.value ?? ''
      if (next === queryRef.current && searchFailedRef.current) setAttempt(n => n + 1)
    }
    retryListenerRef.current = onInput
    el.addEventListener('input', onInput)
  }, [])

  // Filter results client-side. Server returns everything; the chip
  // narrows the view without an extra round-trip.
  const filtered = typeFilter
    ? results.filter(r => r.type === typeFilter)
    : results

  // Group by type for the rendered list.
  const grouped = filtered.reduce((acc, item) => {
    if (!acc[item.type]) acc[item.type] = []
    acc[item.type].push(item)
    return acc
  }, {})

  const hasQuery   = query.trim().length >= 2
  const hasResults = filtered.length > 0

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className={`${scrimCls} z-50 flex items-start justify-center pt-[12vh] px-4`}
          onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
        >
          <motion.div
            role="dialog"
            aria-label={t('shell.searchShort')}
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
            className="w-full max-w-xl bg-parchment-50 dark:bg-ink-900 border border-parchment-300/60 dark:border-brass-900/30 rounded-2xl shadow-warm-lg overflow-hidden"
          >
            {/* Input row */}
            <div className="relative border-b border-parchment-300/60 dark:border-brass-900/25">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-400 dark:text-parchment-400/60 pointer-events-none" />
              <input
                ref={setInputEl}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('shell.search.placeholder')}
                aria-label={t('shell.search.query')}
                className="w-full pl-11 pr-12 py-3.5 text-sm bg-transparent text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none"
              />
              {loading && <Loader2 size={15} className="absolute right-12 top-1/2 -translate-y-1/2 text-ink-400 animate-spin" />}
              <button
                type="button"
                onClick={onClose}
                aria-label={t('shell.search.close')}
                className="absolute right-3 top-1/2 -translate-y-1/2 -m-1 p-1 text-ink-400 dark:text-parchment-400/60 hover:text-ink-700 dark:hover:text-parchment-100 transition-colors"
              >
                <X size={15} />
              </button>
            </div>

            {/* Filter chips — controlled by parent so the choice can
                survive across opens (typeFilter prop) */}
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-parchment-300/50 dark:border-brass-900/20 overflow-x-auto">
              <FilterChip active={!typeFilter} onClick={() => setTypeFilter(null)}>
                {t('shell.search.all')}
              </FilterChip>
              {Object.entries(TYPE_META).map(([key, meta]) => (
                <FilterChip
                  key={key}
                  active={typeFilter === key}
                  onClick={() => setTypeFilter(key)}
                >
                  <meta.icon size={11} /> {typeLabel(t, key)}
                </FilterChip>
              ))}
            </div>

            {/* Body */}
            <div className="max-h-[50vh] overflow-y-auto">
              {/* Empty query → recents (if any) */}
              {!hasQuery && recents.length > 0 && (
                <div>
                  <div className="flex items-center justify-between px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70 bg-parchment-100/60 dark:bg-ink-800/40">
                    <span className="flex items-center gap-1.5">
                      <History size={11} /> {t('shell.search.recent')}
                    </span>
                    <button
                      type="button"
                      onClick={() => { clearRecents(); setRecents([]) }}
                      className="text-[10px] font-medium normal-case tracking-normal text-ink-500 dark:text-parchment-300/70 hover:text-ink-700 dark:hover:text-parchment-100 transition-colors"
                    >
                      {t('shell.search.clear')}
                    </button>
                  </div>
                  <ul>
                    {recents.map(r => (
                      <li key={r}>
                        <button
                          type="button"
                          onClick={() => runRecent(r)}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors text-sm text-ink-700 dark:text-parchment-200"
                        >
                          <Clock size={13} className="text-ink-400 dark:text-parchment-400/60 shrink-0" />
                          <span className="flex-1 truncate">{r}</span>
                          <ArrowRight size={12} className="text-ink-400 dark:text-parchment-400/60" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Empty query, no recents → quiet hint */}
              {!hasQuery && recents.length === 0 && (
                <p className="px-4 py-10 text-center text-sm text-ink-500 dark:text-parchment-300/70">
                  {t('shell.search.hint')}
                </p>
              )}

              {/* A failed read is not "nothing matched". The note follows
                  searchFailed itself, including after the query is shortened,
                  so a stuck failure flag cannot hide behind "not searching". */}
              {!loading && searchFailed && (
                <p role="status" className="px-4 py-10 text-center text-sm text-amber-800 dark:text-amber-300">
                  {t('shell.search.unread')}
                </p>
              )}

              {/* Has query but no results */}
              {hasQuery && !loading && !searchFailed && !hasResults && (
                <p className="px-4 py-10 text-center text-sm text-ink-500 dark:text-parchment-300/70">
                  {t('shell.search.noneBefore')} <span className="font-semibold text-ink-700 dark:text-parchment-100">"{query}"</span>
                  {typeFilter && (
                    <>
                      {' '}{t('shell.search.noneIn', { type: '' }).trim()}{' '}
                      <span className="capitalize">{typeLabel(t, typeFilter).toLocaleLowerCase()}</span>
                    </>
                  )}
                </p>
              )}

              {/* Has results — grouped by type */}
              {hasQuery && hasResults && Object.entries(grouped).map(([type, items]) => {
                const meta = TYPE_META[type]
                if (!meta) return null
                const Icon = meta.icon
                return (
                  <div key={type}>
                    <p className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70 bg-parchment-100/60 dark:bg-ink-800/40">
                      {typeLabel(t, type)}
                    </p>
                    <ul>
                      {items.map(item => (
                        <li key={`${type}-${item.id}`}>
                          <button
                            type="button"
                            onClick={() => selectItem(item)}
                            className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors"
                          >
                            <div className="w-8 h-8 rounded-lg bg-church-50 dark:bg-church-900/40 text-church-800 dark:text-brass-300 flex items-center justify-center shrink-0">
                              <Icon size={14} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">{getTitle(item, t)}</p>
                              <p className="text-xs text-ink-500 dark:text-parchment-300/70 truncate">{getSubtitle(item)}</p>
                            </div>
                            <ArrowRight size={12} className="text-ink-400 dark:text-parchment-400/60 shrink-0" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>

            {/* Footer hint */}
            <div className="px-4 py-2 border-t border-parchment-300/50 dark:border-brass-900/20 bg-parchment-100/40 dark:bg-ink-800/20 text-[10px] font-medium uppercase tracking-wider text-ink-500 dark:text-parchment-300/70 flex items-center justify-between">
              <span>{t('shell.search.footer')}</span>
              <span className="hidden sm:inline">
                <kbd className="px-1.5 py-0.5 rounded border border-parchment-300 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 font-mono text-[10px] normal-case">⌘K</kbd> {t('shell.search.reopen')}
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap transition-colors ${
        active
          ? 'bg-church-900 dark:bg-church-700 text-parchment-50 border border-transparent'
          : 'bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-parchment-200 dark:hover:bg-ink-800/70'
      }`}
    >
      {children}
    </button>
  )
}
