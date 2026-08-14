import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Users, Calendar, CheckSquare, DollarSign, Heart,
  Loader2, X, Clock, ArrowRight, History,
} from 'lucide-react'
import { apiUrl } from '../api'
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
  member:   { icon: Users,       label: 'Members',   path: '/clients' },
  event:    { icon: Calendar,    label: 'Events',    path: '/events' },
  task:     { icon: CheckSquare, label: 'Tasks',     path: '/tasks' },
  staff:    { icon: DollarSign,  label: 'Staff',     path: '/payroll' },
  donation: { icon: Heart,       label: 'Donations', path: '/donations' },
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
function getTitle(item) {
  if (item.type === 'member')   return item.name
  if (item.type === 'event')    return item.title
  if (item.type === 'task')     return item.title
  if (item.type === 'staff')    return item.name
  if (item.type === 'donation') return item.donor_name
  return item.name || item.title || 'Unknown'
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
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
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
    setRecents(readRecents())
    // Focus on the next frame — the input mounts after the AnimatePresence
    // resolves, so a same-tick focus() races with React.
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
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
  // Skip queries shorter than 2 chars to avoid the noisy single-letter
  // result deluge.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.trim().length < 2) { setResults([]); setLoading(false); return }

    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(query.trim())}`))
        if (!r.ok) { setResults([]); return }
        const data = await r.json()
        setResults(Array.isArray(data) ? data : [])
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)

    return () => clearTimeout(debounceRef.current)
  }, [query])

  const selectItem = useCallback((item) => {
    pushRecent(query)
    setRecents(readRecents())
    const meta = TYPE_META[item.type]
    if (meta) navigate(meta.path)
    onClose()
  }, [query, navigate, onClose])

  const runRecent = useCallback((q) => {
    setQuery(q)
    inputRef.current?.focus()
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
            aria-label="Search"
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
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search members, events, tasks, donations…"
                aria-label="Search query"
                className="w-full pl-11 pr-12 py-3.5 text-sm bg-transparent text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none"
              />
              {loading && <Loader2 size={15} className="absolute right-12 top-1/2 -translate-y-1/2 text-ink-400 animate-spin" />}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close search"
                className="absolute right-3 top-1/2 -translate-y-1/2 -m-1 p-1 text-ink-400 dark:text-parchment-400/60 hover:text-ink-700 dark:hover:text-parchment-100 transition-colors"
              >
                <X size={15} />
              </button>
            </div>

            {/* Filter chips — controlled by parent so the choice can
                survive across opens (typeFilter prop) */}
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-parchment-300/50 dark:border-brass-900/20 overflow-x-auto">
              <FilterChip active={!typeFilter} onClick={() => setTypeFilter(null)}>
                All
              </FilterChip>
              {Object.entries(TYPE_META).map(([key, meta]) => (
                <FilterChip
                  key={key}
                  active={typeFilter === key}
                  onClick={() => setTypeFilter(key)}
                >
                  <meta.icon size={11} /> {meta.label}
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
                      <History size={11} /> Recent
                    </span>
                    <button
                      type="button"
                      onClick={() => { clearRecents(); setRecents([]) }}
                      className="text-[10px] font-medium normal-case tracking-normal text-ink-500 dark:text-parchment-300/70 hover:text-ink-700 dark:hover:text-parchment-100 transition-colors"
                    >
                      Clear
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
                  Type to search across your church.
                </p>
              )}

              {/* Has query but no results */}
              {hasQuery && !loading && !hasResults && (
                <p className="px-4 py-10 text-center text-sm text-ink-500 dark:text-parchment-300/70">
                  No results for <span className="font-semibold text-ink-700 dark:text-parchment-100">"{query}"</span>
                  {typeFilter && <> in <span className="capitalize">{TYPE_META[typeFilter].label.toLowerCase()}</span></>}
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
                      {meta.label}
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
                              <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">{getTitle(item)}</p>
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
              <span>↵ to open · Esc to close</span>
              <span className="hidden sm:inline">
                <kbd className="px-1.5 py-0.5 rounded border border-parchment-300 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 font-mono text-[10px] normal-case">⌘K</kbd> to reopen anywhere
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
