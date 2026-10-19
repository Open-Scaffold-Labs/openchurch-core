import { viewerMayRead } from '../auth/viewerPages'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Users, Clock, Heart, CheckSquare, Calendar, ArrowUpRight,
  DollarSign, Activity, LayoutDashboard, MessageSquare,
  TrendingUp, UserCheck, AlertCircle, ChevronRight, ChevronUp, ChevronDown, Phone, Mail,
  CircleCheck, CircleDot, Circle, AlertTriangle, Flame,
  Info, Loader2, X, Church, Printer, RotateCcw,
} from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import DailyVerseCard from '../components/DailyVerseCard'
import NextOnCalendar from '../components/NextOnCalendar'
import SacramentAnniversaries from '../components/SacramentAnniversaries'
import LiturgicalDayDetail from '../components/LiturgicalDayDetail'
import LiturgicalWidget from '../components/LiturgicalWidget'
import GettingSettledCard from '../components/GettingSettledCard'
import DailyChecklists from '../components/DailyChecklists'
import { useAuth } from '../context/AuthContext'
import { useConfirm } from '../components/ConfirmProvider'
import { useToast } from '../components/ToastProvider'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { todayLocalISO, parseStoredDate, parseLocalDate } from '../utils/dates'

const VIEWER_EVENTS_TASKS = viewerMayRead('/api/events') && viewerMayRead('/api/tasks')
import { initials, loadList, memberRosterUnreadable } from '../utils/format'

// Due copy for a task DATE. `now` is injectable so a US-evening test
// can prove the label is the stored day, not UTC midnight.
export function dueLabelFor(due_date, now = new Date()) {
  if (!due_date) return null
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const d = parseStoredDate(due_date) ?? parseLocalDate(due_date)
  d.setHours(0, 0, 0, 0)
  const diff = Math.round((d - today) / 86400000)
  if (diff < 0)  return { text: `${Math.abs(diff)}d overdue`, cls: 'text-rose-500 dark:text-rose-400' }
  if (diff === 0) return { text: 'Due today',                  cls: 'text-amber-700 dark:text-amber-400' }
  if (diff === 1) return { text: 'Due tomorrow',               cls: 'text-amber-700 dark:text-amber-300' }
  return { text: `Due in ${diff}d`, cls: 'text-ink-500 dark:text-parchment-300/70' }
}

// Upcoming is the event's civil day on or after local today. A DATE
// parsed with new Date() is the previous evening west of UTC, so a
// same-day event would land in the past.
export function splitEventsByDay(events, now = new Date()) {
  const todayLocalMidnight = new Date(now)
  todayLocalMidnight.setHours(0, 0, 0, 0)
  const eventDay = (value) => parseStoredDate(value) ?? parseLocalDate(value)
  const list = events ?? []
  return {
    upcoming: list.filter(e => e.date && eventDay(e.date) >= todayLocalMidnight),
    past: list.filter(e => e.date && eventDay(e.date) < todayLocalMidnight),
  }
}

// ── Shared helpers ────────────────────────────────────────────
const fadeUp = (i = 0) => ({
  hidden: { opacity: 0, y: 16 },
  show:   { opacity: 1, y: 0, transition: { delay: i * 0.055, duration: 0.3, ease: [0.25, 0.1, 0.25, 1] } },
})

// Parchment & Brass: one avatar color for the whole parish — identity
// comes from names and initials, not a hashed rainbow.
function avatarColor() {
  return 'bg-church-800 dark:bg-church-700'
}
function timeAgo(date) {
  if (!date) return '—'
  const s = Math.floor((Date.now() - new Date(date)) / 1000)
  if (s < 86400)  return 'Today'
  if (s < 172800) return 'Yesterday'
  return `${Math.floor(s / 86400)}d ago`
}
// First name out of "Jose Rivera" → "Jose". Trims and tolerates
// blank/missing names so the greeting line never breaks. Returns
// null when there's nothing usable, so the caller can render the
// bare greeting without a comma.
function firstName(fullName) {
  if (!fullName || typeof fullName !== 'string') return null
  const head = fullName.trim().split(/\s+/)[0]
  return head || null
}

// Profile hop from a name the dashboard already has. Only a positive
// integer id becomes a person URL — a missing or garbled id is not a
// member we invent from the label.
export function memberProfileHref(id) {
  const n = typeof id === 'number' ? id : typeof id === 'string' && id.trim() !== '' ? Number(id) : NaN
  if (!Number.isInteger(n) || n <= 0) return null
  return `/clients/${n}`
}

// ── Shared card components ────────────────────────────────────
// The at-a-glance strip — serif figures over hairline dividers. This
// replaced the 4-across KPI StatCard grid (glow blobs, hover lift,
// icon tiles): a parish office reads its numbers like a ledger line,
// not an investor dashboard.
function GlanceStrip({ figures, index = 0 }) {
  return (
    <motion.div
      variants={fadeUp(index)} initial="hidden" animate="show"
      className={`grid rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900/90 shadow-warm divide-x divide-parchment-300/50 dark:divide-brass-900/30 overflow-hidden ${figures.length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}
    >
      {figures.map(f => (
        <div key={f.label} className="px-4 py-4 text-center">
          <p className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
            {f.value ?? <span className="text-ink-300 dark:text-parchment-500/40">—</span>}
          </p>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70 mt-0.5">
            {f.label}
          </p>
          {f.sub && <p className="text-[11px] text-ink-400 dark:text-parchment-400/60 mt-0.5">{f.sub}</p>}
        </div>
      ))}
    </motion.div>
  )
}


// ── Urgent Tasks ─────────────────────────────────────────────
// Categories are named, not color-coded — one quiet chip for all.
const CATEGORY_CHIP = 'bg-parchment-200/80 text-ink-600 dark:bg-ink-800 dark:text-parchment-300'
const CATEGORY_COLORS = {
  OPENING:      CATEGORY_CHIP,
  CLOSING:      CATEGORY_CHIP,
  DAILY_OPS:    CATEGORY_CHIP,
  CLEANING:     CATEGORY_CHIP,
  SERVICE_PREP: CATEGORY_CHIP,
  MAINTENANCE:  CATEGORY_CHIP,
}
const CATEGORY_LABELS = {
  OPENING: 'Opening', CLOSING: 'Closing', DAILY_OPS: 'Daily Ops',
  CLEANING: 'Cleaning', SERVICE_PREP: 'Service Prep', MAINTENANCE: 'Maintenance',
}

function UrgentTasks({ tasks }) {
  const { t } = useLocale()
  const toast = useToast()
  const [doneIds, setDoneIds] = useState(new Set())
  // Collapse state — persisted under the ochr_ key prefix so the
  // admin's show/hide choice survives reloads, same pattern as the
  // sidebar collapse.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('ochr_urgent_collapsed') === '1' } catch { return false }
  })
  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem('ochr_urgent_collapsed', next ? '1' : '0') } catch {}
      return next
    })
  }
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const urgent = (tasks ?? [])
    .filter(t => t.priority === 'HIGH' && t.status !== 'COMPLETED' && !doneIds.has(t.id))
    .slice()
    .sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      return new Date(a.due_date) - new Date(b.due_date)
    })

  // Optimistic, then verified. This used to tick the box and throw the
  // response away — and unlike the Tasks page, nothing here reloads
  // afterwards, so a failed PATCH left the task struck through on the
  // dashboard for the rest of the session while the server still had it
  // open. The person moves on believing it is done. Put it back instead.
  async function complete(id) {
    setDoneIds(prev => new Set([...prev, id]))
    let ok = false
    try {
      const res = await fetch(apiUrl(`/api/tasks/${id}/status`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'COMPLETED' }),
      })
      ok = res.ok
    } catch { ok = false }
    if (!ok) {
      setDoneIds(prev => { const next = new Set(prev); next.delete(id); return next })
      toast.error("That didn't save — the task is still open.")
    }
  }

  function dueLabel(due_date) {
    return dueLabelFor(due_date, today)
  }

  if (urgent.length === 0 && doneIds.size === 0) return null

  return (
    <motion.div variants={fadeUp(1)} initial="hidden" animate="show"
      className="bg-rose-50/60 dark:bg-rose-900/10 border border-rose-100 dark:border-rose-800/30 rounded-2xl p-5"
    >
      {/* Header doubles as the collapse toggle. The count stays
          visible when collapsed so the panel is still informative
          at a glance ("3 high priority") without being expanded. */}
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Show urgent tasks' : 'Hide urgent tasks'}
        className={`flex items-center gap-2 w-full text-left ${collapsed ? '' : 'mb-3'}`}
      >
        <Flame size={15} className="text-rose-500" />
        <span className="text-sm font-bold text-rose-700 dark:text-rose-400">{t('dash.urgent')}</span>
        <span className="ml-auto text-xs text-rose-400 dark:text-rose-500 font-medium">
          {urgent.length > 0 ? t('dash.urgentCount', { n: urgent.length }) : t('dash.allClear')}
        </span>
        {collapsed
          ? <ChevronDown size={15} className="text-rose-400 dark:text-rose-500" />
          : <ChevronUp   size={15} className="text-rose-400 dark:text-rose-500" />}
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="urgent-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <AnimatePresence mode="popLayout">
              {urgent.length === 0 ? (
                <motion.p
                  key="empty"
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="text-xs text-brass-700 dark:text-brass-300 font-medium text-center py-2"
                >
                  {t('dash.urgentDone')}
                </motion.p>
              ) : (
                <ul className="space-y-2">
                  <AnimatePresence mode="popLayout">
                    {urgent.map(t => {
                      const due = dueLabel(t.due_date)
                      return (
                        <motion.li
                          key={t.id}
                          layout
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
                          className="flex items-center gap-3 bg-parchment-50 dark:bg-ink-900/80 rounded-xl px-3 py-2.5 border border-rose-100 dark:border-white/[0.06]"
                        >
                          <button
                            onClick={() => complete(t.id)}
                            title="Mark complete"
                            className="shrink-0 w-5 h-5 box-content p-0.5 -m-0.5 rounded-full border-2 border-rose-300 dark:border-rose-700 hover:border-brass-500 hover:bg-brass-50 dark:hover:bg-brass-900/30 transition-colors flex items-center justify-center group"
                          >
                            <CircleCheck size={12} className="text-transparent group-hover:text-brass-600 transition-colors" />
                          </button>
                          <span className="flex-1 text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">{t.title}</span>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${CATEGORY_COLORS[t.category] ?? 'bg-parchment-200 text-ink-600'}`}>
                            {CATEGORY_LABELS[t.category] ?? t.category}
                          </span>
                          {due && <span className={`text-xs font-semibold shrink-0 ${due.cls}`}>{due.text}</span>}
                        </motion.li>
                      )
                    })}
                  </AnimatePresence>
                </ul>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ── Daily Briefing ────────────────────────────────────────────
export function DailyBriefing({ data }) {
  const { t, dateLocale } = useLocale()
  const today   = new Date()
  // Local day key — toISOString() gives the UTC day, which misclassifies
  // "today's events" near midnight (1.1).
  const todayStr = todayLocalISO()
  // English day name for DATA matching (schedule rows store English
  // day_of_week); the localized name is display-only.
  const dayName  = today.toLocaleDateString('en-US', { weekday: 'long' })
  const dayShown = today.toLocaleDateString(dateLocale, { weekday: 'long' })

  const todayEvents   = (data.calEvents ?? []).filter(e => e.date?.slice(0, 10) === todayStr)
  const todayServices = (data.schedule  ?? []).filter(s => s.day_of_week === dayName)
  const pendingTasks  = (data.tasks     ?? []).filter(t => t.status !== 'COMPLETED')
  const highTasks     = pendingTasks.filter(t => t.priority === 'HIGH')
  const rosterUnreadable = memberRosterUnreadable(data.members, data.membersFailed)
  const memberRows = Array.isArray(data.members) ? data.members : []
  const newMembers = rosterUnreadable ? [] : memberRows.filter(m => {
    return (today - new Date(m.created_at)) / 86400000 <= 7
  })

  const fmt = t => t?.slice(0, 5) ?? ''

  // One icon-tile treatment for every briefing row — the row's meaning
  // is its label, not a hue.
  const ROW_TILE = 'bg-parchment-200 dark:bg-ink-800'

  const rows = [
    {
      id: 'tasks', icon: CheckSquare, color: ROW_TILE, to: '/tasks',
      label: t('dash.row.tasks'),
      summary: data.tasksFailed
        ? t('dash.tasksUnread')
        : pendingTasks.length === 0
          ? t('dash.sum.tasksDone')
          : `${t('dash.sum.pending', { n: pendingTasks.length })}${highTasks.length ? ` · ${t('dash.urgentCount', { n: highTasks.length })}` : ''}`,
      status: data.tasksFailed ? 'warn' : highTasks.length > 0 ? 'warn' : pendingTasks.length > 0 ? 'active' : 'clear',
      items: pendingTasks.slice(0, 3).map(t => ({
        label: t.title,
        sub: t.category.replace(/_/g, ' '),
        dot: t.priority === 'HIGH' ? 'bg-rose-500' : t.priority === 'MEDIUM' ? 'bg-amber-400' : 'bg-ink-300',
      })),
    },
    {
      id: 'cal', icon: Clock, color: ROW_TILE, to: '/schedule',
      label: t('dash.row.events'),
      summary: data.calEventsFailed
        ? t('dash.eventsUnread')
        : todayEvents.length === 0
          ? t('dash.sum.noEvents')
          : todayEvents.length === 1 ? t('dash.sum.events1') : t('dash.sum.eventsN', { n: todayEvents.length }),
      status: data.calEventsFailed ? 'warn' : todayEvents.length > 0 ? 'active' : 'clear',
      items: todayEvents.slice(0, 3).map(e => ({
        label: e.title,
        sub: e.start_time ? `${fmt(e.start_time)} – ${fmt(e.end_time)}` : '',
        dot: 'bg-brass-400',
      })),
    },
    {
      id: 'services', icon: Calendar, color: ROW_TILE, to: '/schedule',
      label: t('dash.row.services', { day: dayShown }),
      summary: data.scheduleFailed
        ? t('dash.servicesUnread', { day: dayShown })
        : todayServices.length === 0
          ? t('dash.sum.noServices', { day: dayShown })
          : todayServices.length === 1 ? t('dash.sum.services1') : t('dash.sum.servicesN', { n: todayServices.length }),
      status: data.scheduleFailed ? 'warn' : todayServices.length > 0 ? 'active' : 'clear',
      items: todayServices.slice(0, 3).map(s => ({
        label: s.title,
        sub: s.start_time ? fmt(s.start_time) : s.service_type ?? '',
        dot: 'bg-brass-400',
      })),
    },
    {
      id: 'members', icon: Users, color: ROW_TILE, to: '/clients',
      label: t('dash.row.members'),
      summary: rosterUnreadable
        ? t('mem.listFailed')
        : newMembers.length === 0
          ? t('dash.sum.noNew')
          : t('dash.sum.new', { n: newMembers.length }),
      status: rosterUnreadable ? 'warn' : newMembers.length > 0 ? 'active' : 'clear',
      items: newMembers.slice(0, 3).map(m => ({
        label: m.name,
        sub: m.role ?? t('dash.member'),
        dot: 'bg-brass-400',
        avatar: initials(m.name),
        avatarColor: avatarColor(m.name),
        href: memberProfileHref(m.id),
      })),
    },
    {
      id: 'payroll', icon: DollarSign, color: ROW_TILE, to: '/payroll',
      label: t('dash.row.payroll'),
      summary: t('dash.sum.payroll'),
      status: 'soon', items: [],
    },
    {
      // Messages was removed as a dashboard tab on purpose (see TABS
      // below). This row stays as an honest "not built" signal — it must
      // not look like an empty inbox, and it must not send anyone to a
      // blank /messages route. Direct /messages is a separate unfinished
      // page; this row does not link there.
      id: 'outreach', icon: MessageSquare, color: ROW_TILE,
      label: t('dash.row.outreach'),
      summary: t('dash.sum.outreach'),
      status: 'soon', items: [],
    },
  ]

  // Attention keeps its muted rose; everything else settles into
  // parchment and brass — "active" is a fact, not a celebration.
  const statusBadge = {
    warn:   'bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-400 border-rose-100 dark:border-rose-800/30',
    active: 'bg-brass-50 dark:bg-brass-900/20 text-brass-700 dark:text-brass-300 border-brass-200/70 dark:border-brass-800/40',
    clear:  'bg-parchment-200 dark:bg-ink-800 text-ink-500 dark:text-parchment-300/70 border-parchment-300/60 dark:border-brass-900/30',
    soon:   'bg-parchment-200 dark:bg-ink-800 text-ink-500 dark:text-parchment-300/70 border-parchment-300/60 dark:border-brass-900/30',
  }
  const statusLabel = {
    warn: t('dash.status.warn'), active: t('dash.status.active'),
    clear: t('dash.status.clear'), soon: t('dash.status.soon'),
  }
  const statusIcon  = { warn: AlertTriangle, active: CircleDot, clear: CircleCheck, soon: Circle }

  return (
    <motion.div variants={fadeUp(1)} initial="hidden" animate="show"
      className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden"
    >
      {/* Card header */}
      <div className="px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
        <h3 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">{t('dash.briefing')}</h3>
        <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
          {today.toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {/* Rows */}
      <div className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
        {rows.map((row, i) => {
          const Icon   = row.icon
          const SIcon  = statusIcon[row.status]
          return (
            <motion.div
              key={row.id}
              variants={fadeUp(i * 0.08)} initial="hidden" animate="show"
              className="px-5 py-3.5 hover:bg-parchment-100/70 dark:hover:bg-ink-800/40 transition-colors"
            >
              <div className="flex items-start gap-3">
                {/* Icon */}
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${row.color}`}>
                  <Icon size={14} className="text-church-700 dark:text-brass-300" />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{row.label}</p>
                    <span className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${statusBadge[row.status]}`}>
                      <SIcon size={9} /> {statusLabel[row.status]}
                    </span>
                  </div>
                  <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">{row.summary}</p>

                  {/* Sub-items */}
                  {row.items.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {row.items.map((item, j) => (
                        <div key={j} className="flex items-center gap-2">
                          {item.avatar ? (
                            <div className={`w-4 h-4 rounded-full flex items-center justify-center text-parchment-50 text-[8px] font-bold shrink-0 ${item.avatarColor}`}>
                              {item.avatar}
                            </div>
                          ) : (
                            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.dot}`} />
                          )}
                          {item.href ? (
                            <Link
                              to={item.href}
                              className="text-xs font-medium text-ink-700 dark:text-parchment-200 truncate hover:text-church-700 dark:hover:text-brass-300"
                            >
                              {item.label}
                            </Link>
                          ) : (
                            <span className="text-xs font-medium text-ink-700 dark:text-parchment-200 truncate">{item.label}</span>
                          )}
                          {item.sub && <span className="text-xs text-ink-500 dark:text-parchment-300/70 shrink-0">{item.sub}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Arrow link */}
                {row.status !== 'soon' && row.to && (
                  <Link to={row.to} aria-label={`Open ${row.label}`}
                    className="shrink-0 mt-1 p-1.5 -m-0.5 text-ink-300 dark:text-parchment-400/50 hover:text-ink-500 dark:hover:text-parchment-200 transition-colors">
                    <ChevronRight size={15} aria-hidden="true" />
                  </Link>
                )}
              </div>
            </motion.div>
          )
        })}
      </div>
    </motion.div>
  )
}

// ── Tab content views ─────────────────────────────────────────

function OverviewTab({ data }) {
  const { user } = useAuth()
  // SP-021: Viewers see only what their role table gives them. Widgets that
  // read events, tasks, the register, checklists or the packet are not shown.
  const isViewer = user?.role === 'viewer'
  // VIEWER_OPTIONS.eventsTasks (server/src/middleware/viewerScope.js).
  const hideET = isViewer && !VIEWER_EVENTS_TASKS
  const { t } = useLocale()
  const name = firstName(user?.name)
  const h = new Date().getHours()
  const greetingKey = h < 12 ? 'dash.morning' : h < 17 ? 'dash.afternoon' : 'dash.evening'
  return (
    <div className="space-y-8">
      {/* Welcome + Verse */}
      <div className="flex flex-col lg:flex-row lg:items-start gap-6">
        <motion.div variants={fadeUp(0)} initial="hidden" animate="show" className="flex-1">
          <h2 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
            {t(greetingKey)}{name ? `, ${name}` : ''}
          </h2>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">{t('dash.sub')}</p>
          {/* Fills the open space under the greeting — the expanded
              companion to the LiturgicalWidget on the right. */}
          <LiturgicalDayDetail />
        </motion.div>
        <div className="lg:w-80 xl:w-96 shrink-0 space-y-3">
          {/* Below lg the LiturgicalDayDetail panel (under the greeting)
              already carries today's season — stacking the compact widget
              directly beneath it duplicated the same data (QA audit M5). */}
          <div className="hidden lg:block"><LiturgicalWidget /></div>
          {/* The Thursday Button (SPK.1) — one click from the morning
              view to the printable Sunday Packet. */}
          {!isViewer && <Link
            to="/packet?from=dashboard"
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl border border-brass-600/40 dark:border-brass-700/40 bg-parchment-50 dark:bg-ink-900 text-sm font-semibold text-church-800 dark:text-brass-300 shadow-warm hover:bg-parchment-100 dark:hover:bg-ink-800/70 transition-colors"
          >
            <Printer size={15} /> {t('dash.packet')}
          </Link>}
          {!hideET && <NextOnCalendar events={data.upcoming} failed={data.upcomingFailed} />}
          {!isViewer && <SacramentAnniversaries days={30} />}
          <DailyVerseCard index={0} />
        </div>
      </div>

      {/* Urgent Tasks */}
      {!hideET && <UrgentTasks tasks={data.tasks} />}

      {/* Daily operational checklists (OPS.1) — self-hides when the org
          has none and the viewer can't create one. */}
      {!isViewer && <DailyChecklists />}

      {/* Daily Briefing */}
      {!hideET && <DailyBriefing data={data} />}

      {/* Church at a glance — one slim totals strip. Replaced the
          old 4 big stat cards + 6 module cards: the stat cards
          duplicated counts already in the Briefing, and the module
          cards just re-listed the sidebar. Each figure here links to
          its full page, so the strip keeps the only genuinely useful
          part of "Quick Access" without the redundancy. */}
      <motion.div
        variants={fadeUp(2)} initial="hidden" animate="show"
        className={`grid ${hideET ? "grid-cols-1" : "grid-cols-3"} rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900/90 shadow-warm divide-x divide-parchment-300/50 dark:divide-brass-900/30 overflow-hidden`}
      >
        {[
          { to: '/clients', label: t('dash.glance.members'), value: data.memberStats?.total },
          { to: '/events',  label: t('dash.glance.events'),  value: data.eventsFailed ? null : (Array.isArray(data.events) ? data.events.length : null) },
          { to: '/tasks',   label: t('dash.glance.tasks'),   value: data.taskStats?.total },
        ].filter(s => !hideET || s.to === '/clients').map(s => (
          <Link
            key={s.to}
            to={s.to}
            className="px-4 py-4 text-center hover:bg-parchment-100 dark:hover:bg-ink-800/50 transition-colors"
          >
            <p className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
              {s.value ?? <span className="text-ink-300 dark:text-parchment-500/40">—</span>}
            </p>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70 mt-0.5">
              {s.label}
            </p>
          </Link>
        ))}
      </motion.div>
    </div>
  )
}

export function MembersTab({ data }) {
  const { t } = useLocale()
  const stats = data.memberStats
  const rosterUnreadable = memberRosterUnreadable(data.members, data.membersFailed)
  const memberRows = Array.isArray(data.members) ? data.members : []
  const members = memberRows.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 6)

  const roles = memberRows.reduce((acc, m) => {
    acc[m.role || 'Member'] = (acc[m.role || 'Member'] || 0) + 1
    return acc
  }, {})
  const totalForRoles = memberRows.length || 1

  return (
    <div className="space-y-6">
      {/* The membership ledger line. The Growth-% KPI was cut in the
          Parchment & Brass pass — a parish is a congregation, not a
          conversion funnel. */}
      <GlanceStrip
        index={0}
        figures={[
          { label: 'Members',       value: stats?.total,   sub: 'All registered' },
          { label: 'Active',        value: stats?.active,  sub: 'Currently active' },
          { label: 'New This Week', value: stats?.newWeek, sub: 'Last 7 days' },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent members */}
        <motion.div variants={fadeUp(4)} initial="hidden" animate="show"
          className="lg:col-span-2 bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
            <h3 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">Recently Added</h3>
            <Link to="/clients" className="text-xs font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 flex items-center gap-1">
              View all <ChevronRight size={12} />
            </Link>
          </div>
          {rosterUnreadable ? (
            <p role="status" className="px-5 py-10 text-center text-sm text-amber-700 dark:text-amber-400">{t('mem.listFailed')}</p>
          ) : members.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-ink-500 dark:text-parchment-300/70">No members yet.</div>
          ) : (
            <div className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
              {members.map((m, i) => {
                const href = memberProfileHref(m.id)
                const rowClass = href
                  ? 'flex items-center gap-3 px-5 py-3 hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors'
                  : 'flex items-center gap-3 px-5 py-3'
                const inner = (
                  <>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-parchment-50 text-xs font-bold shrink-0 ${avatarColor(m.name)}`}>
                      {initials(m.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">{m.name}</p>
                      <p className="text-xs text-ink-500 dark:text-parchment-300/70 truncate">{m.email || m.role || 'Member'}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {m.email && <Mail size={12} className="text-ink-300 dark:text-parchment-400/50" />}
                      {m.phone && <Phone size={12} className="text-ink-300 dark:text-parchment-400/50" />}
                      <span className="text-xs text-ink-500 dark:text-parchment-300/70">{timeAgo(m.created_at)}</span>
                    </div>
                  </>
                )
                return (
                  <motion.div key={m.id ?? `unnamed-${i}`} variants={fadeUp(i * 0.5)} initial="hidden" animate="show">
                    {href
                      ? <Link to={href} className={rowClass}>{inner}</Link>
                      : <div className={rowClass}>{inner}</div>}
                  </motion.div>
                )
              })}
            </div>
          )}
        </motion.div>

        {/* Role breakdown */}
        <motion.div variants={fadeUp(5)} initial="hidden" animate="show"
          className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md p-5"
        >
          <h3 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50 mb-4">By Role</h3>
          {rosterUnreadable ? (
            <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{t('mem.listFailed')}</p>
          ) : Object.entries(roles).length === 0 ? (
            <p className="text-xs text-ink-500 dark:text-parchment-300/70">No data yet.</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(roles).sort(([, a], [, b]) => b - a).map(([role, count]) => (
                <div key={role}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium text-ink-700 dark:text-parchment-200">{role}</span>
                    <span className="text-ink-500 dark:text-parchment-300/70">{count}</span>
                  </div>
                  <div className="h-1.5 bg-parchment-200 dark:bg-ink-800 rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${(count / totalForRoles) * 100}%` }}
                      transition={{ duration: 0.6, delay: 0.1, ease: 'easeOut' }}
                      className="h-full bg-brass-500 dark:bg-brass-400 rounded-full"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}

function EventsTab({ data }) {
  const { t } = useLocale()
  const split = splitEventsByDay(data.eventsFailed ? [] : data.events)
  const scheduleRows = data.scheduleFailed || !Array.isArray(data.schedule) ? [] : data.schedule
  const calendarRows = data.calEventsFailed || !Array.isArray(data.calEvents) ? [] : data.calEvents
  const weekFailed = !!(data.scheduleFailed || data.calEventsFailed)
  const upcoming = split.upcoming.slice(0, 8)
  const past = split.past.slice(-3)

  return (
    <div className="space-y-6">
      <GlanceStrip
        index={0}
        figures={[
          { label: 'Events',    value: data.eventsFailed ? null : (Array.isArray(data.events) ? data.events.length : null), sub: 'All logged' },
          { label: 'Upcoming',  value: data.eventsFailed ? null : upcoming.length, sub: 'Scheduled ahead' },
          { label: 'This Week', value: data.calEventsFailed ? null : calendarRows.length, sub: 'On the calendar' },
          { label: 'Services',  value: data.scheduleFailed ? null : scheduleRows.length, sub: 'Recurring' },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Upcoming events */}
        <motion.div variants={fadeUp(4)} initial="hidden" animate="show"
          className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
            <h3 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">Upcoming Events</h3>
            <Link to="/events" className="text-xs font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 flex items-center gap-1">
              Manage <ChevronRight size={12} />
            </Link>
          </div>
          {data.eventsFailed ? (
            <p role="status" className="px-5 py-10 text-center text-sm text-amber-800 dark:text-amber-300">{t('dash.upcomingUnread')}</p>
          ) : upcoming.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-ink-500 dark:text-parchment-300/70">No upcoming events.</div>
          ) : (
            <div className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
              {upcoming.map((e, i) => (
                <motion.div key={e.id} variants={fadeUp(i * 0.4)} initial="hidden" animate="show"
                  className="flex items-center gap-3 px-5 py-3"
                >
                  <div className="shrink-0 text-center w-10">
                    <p className="text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase">
                      {new Date(e.date).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}
                    </p>
                    <p className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50 leading-none">
                      {new Date(e.date).toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' })}
                    </p>
                  </div>
                  <div className="w-px h-8 bg-parchment-300/70 dark:bg-brass-900/30 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">{e.title}</p>
                    <p className="text-xs text-ink-500 dark:text-parchment-300/70">{e.service_division || e.location || '—'}</p>
                  </div>
                  {e.time && <span className="text-xs text-ink-500 dark:text-parchment-300/70 shrink-0">{e.time?.slice(0, 5)}</span>}
                </motion.div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Schedule preview */}
        <motion.div variants={fadeUp(5)} initial="hidden" animate="show"
          className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
            <h3 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">Weekly Schedule</h3>
            <Link to="/schedule" className="text-xs font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 flex items-center gap-1">
              Open calendar <ChevronRight size={12} />
            </Link>
          </div>
          {weekFailed && scheduleRows.length === 0 ? (
            <p role="status" className="px-5 py-10 text-center text-sm text-amber-800 dark:text-amber-300">{t('dash.weekUnread')}</p>
          ) : scheduleRows.length === 0 && calendarRows.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-ink-500 dark:text-parchment-300/70">No schedule entries yet.</div>
          ) : (
            <div className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
              {scheduleRows.slice(0, 6).map((s, i) => (
                <motion.div key={s.id} variants={fadeUp(i * 0.4)} initial="hidden" animate="show"
                  className="flex items-center gap-3 px-5 py-3"
                >
                  <div className="w-2 h-2 rounded-full bg-brass-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">{s.title}</p>
                    <p className="text-xs text-ink-500 dark:text-parchment-300/70">{s.day_of_week} · {s.recurrence}</p>
                  </div>
                  {s.start_time && (
                    <span className="text-xs text-ink-500 dark:text-parchment-300/70 shrink-0">{s.start_time?.slice(0, 5)}</span>
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}

// ── Tabs config ───────────────────────────────────────────────
// Giving + Messages tabs were removed in the dashboard-tightening
// pass — both were pure "Coming Soon" placeholders, and a shipped
// product showing empty tabs reads as half-built. They come back as
// real tabs when those features exist.
const TABS = [
  { id: 'overview',  label: 'Overview',  icon: LayoutDashboard },
  { id: 'members',   label: 'Members',   icon: Users },
  { id: 'events',    label: 'Events',    icon: Calendar },
]

// ── Dashboard ─────────────────────────────────────────────────
// Banner on the Dashboard that tells new-org admins what the "[Sample]"
// rows are and gives them a one-click way to wipe them. Driven by
// GET /api/onboarding/status; hides itself when the org has no samples.
// `onCleared` is fired after a successful clear so the Dashboard can
// refetch its data and the freshly-empty state renders immediately.

// The seven days the dashboard's "This Week" card is about: today through
// today + 6, in the browser's own timezone. Local, not UTC — a parish in
// California asking at 5pm should get today's events, and toISOString()
// would already have rolled over to tomorrow.
function dayWindow(days) {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = new Date()
  const end   = new Date(today)
  end.setDate(end.getDate() + days)
  return { start: iso(today), end: iso(end) }
}
function weekWindow() { return dayWindow(6) }
// SP-059: "Next on the Calendar" reads the calendar (the Schedule's
// ochr_calendar_events), from today forward, soonest first. It used to read
// /api/events (the separate events log), oldest first and capped at 200, so
// a Sunday Mass on the Schedule could sit beside "Nothing scheduled yet."
// The window only bounds the query; the server orders by date, start_time.
const NEXT_ON_CALENDAR_DAYS = 365
const NEXT_ON_CALENDAR_LIMIT = 3

function SampleDataBanner({ onCleared }) {
  const ask = useConfirm()
  const [status,  setStatus]  = useState(null)   // { hasSamples, counts } | null
  const [clearing, setClearing] = useState(false)
  const [error,   setError]   = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(apiUrl('/api/onboarding/status'))
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (!cancelled) setStatus(s) })
      .catch(() => { /* silent — banner just stays hidden on failure */ })
    return () => { cancelled = true }
  }, [])

  if (!status?.hasSamples) return null

  async function clearSamples() {
    // This button used to fire straight from onClick. It hard-DELETEs every
    // [Sample] row across six tables, it is not undoable, and it sat one
    // stray click away at all times — a single mis-aimed click wiped a
    // workspace's sample members, events, tasks, donations, staff and
    // schedule with no way back. The counts are named in the body because
    // "clear sample data" undersells what is about to go.
    const { members, events, tasks } = status.counts
    const tally = [
      members && `${members} member${members === 1 ? '' : 's'}`,
      events  && `${events} event${events === 1 ? '' : 's'}`,
      tasks   && `${tasks} task${tasks === 1 ? '' : 's'}`,
    ].filter(Boolean).join(', ')
    if (!(await ask({
      title: 'Clear the sample data?',
      body: tally
        ? `This deletes ${tally}, along with any sample donations, staff and schedule. It cannot be undone. Nothing you have added yourself is touched.`
        : 'This deletes every [Sample] row in your workspace. It cannot be undone. Nothing you have added yourself is touched.',
      confirmLabel: 'Clear sample data',
    }))) return

    setClearing(true)
    setError('')
    try {
      const res = await fetch(apiUrl('/api/onboarding/clear-samples'), { method: 'POST' })
      if (!res.ok) throw new Error('Failed to clear sample data')
      setStatus({ hasSamples: false, counts: { members: 0, events: 0, tasks: 0 } })
      onCleared?.()
    } catch (err) {
      setError(err.message || 'Failed to clear sample data')
    } finally {
      setClearing(false)
    }
  }

  const { members, events, tasks } = status.counts
  const parts = [
    members && `${members} member${members === 1 ? '' : 's'}`,
    events  && `${events} event${events === 1 ? '' : 's'}`,
    tasks   && `${tasks} task${tasks === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ')

  // The copy shifts once the admin has clearly transitioned to real
  // data (Sprint O / O.1). Pre-transition: "we added samples so the
  // pages aren't empty" (defensive, welcoming). Post-transition:
  // "you've added real data — want to clear the samples now?"
  // (active, less apologetic — admin is in driver's seat).
  const hasTransitioned = (status.realCounts?.members ?? 0) > 0
                       || (status.realCounts?.events  ?? 0) > 0

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
      className="flex items-start gap-3 p-4 rounded-xl bg-brass-50 dark:bg-brass-900/20 border border-brass-200/70 dark:border-brass-800/40 shadow-warm"
    >
      <div className="shrink-0 w-8 h-8 rounded-lg bg-brass-200/70 dark:bg-brass-800/40 flex items-center justify-center text-brass-700 dark:text-brass-200">
        <Info size={15} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
          {hasTransitioned
            ? 'You\'ve added real data — ready to clear the samples?'
            : 'Your workspace has sample data'}
        </p>
        <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5 leading-relaxed">
          {hasTransitioned
            ? <>The {parts} marked <span className="font-mono">[Sample]</span> are still in your workspace. Clearing them leaves your real data untouched.</>
            : <>We added {parts} so the pages aren't empty. Every sample row starts with <span className="font-mono">[Sample]</span>. Clear them whenever you're ready to start fresh.</>
          }
        </p>
        {error && (
          <p className="text-xs text-rose-700 dark:text-rose-300 mt-1.5">{error}</p>
        )}
      </div>
      <button
        type="button"
        onClick={clearSamples}
        disabled={clearing}
        className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-xs font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
      >
        {clearing ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
        {clearing ? 'Clearing…' : 'Clear sample data'}
      </button>
    </motion.div>
  )
}

export default function Dashboard() {
  const { t } = useLocale()
  // The eyebrow above the page title names the PARISH, not the product. A
  // secretary opening her dashboard should see her own church at the top of
  // it — stamping the vendor's name there is exactly the generic-SaaS voice
  // the Constitution rules out. Falls back to nothing rather than to a
  // placeholder: an absent org name is not worth inventing a label for.
  const { user } = useAuth()
  const isViewer = user?.role === 'viewer'
  // VIEWER_OPTIONS.eventsTasks (server/src/middleware/viewerScope.js).
  const hideET = isViewer && !VIEWER_EVENTS_TASKS
  const parishName = user?.organization?.name || ''
  const [activeTab, setActiveTab] = useState('overview')
  const [data, setData] = useState({
    members: null, membersFailed: false, memberStats: null,
    events: null, eventsFailed: false, schedule: null, scheduleFailed: false,
    tasks: null, tasksFailed: false, taskStats: null, calEvents: null, calEventsFailed: false,
    upcoming: null, upcomingFailed: false,
  })
  // The dashboard load used to end in a bare `catch {}`. When it failed — a
  // parish office on bad wifi, a cold serverless start, a demo run from a
  // cafe — the page rendered permanently half-empty with no message and no
  // way to retry, and an empty dashboard is indistinguishable from a
  // brand-new parish. Silence is not calm; it is Principle 1 anxiety
  // wearing calm's clothes. (QA audit M2.)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloading, setReloading] = useState(false)

  const load = useCallback(async () => {
    // `degraded` catches the quieter failure: an individual endpoint
    // returning non-ok used to fall back to an empty list, so one 500 looked
    // exactly like "this parish has no members yet".
    let degraded = false
    const missed = { events: false, schedule: false, tasks: false, calEvents: false, upcoming: false }
    const get = async (path, fallback, key) => {
      try {
        const r = await fetch(apiUrl(path))
        if (!r.ok) { degraded = true; if (key) missed[key] = true; return fallback }
        const body = await r.json()
        // These four reads are bare arrays. A 200 object is not an empty day.
        if (key && !Array.isArray(body)) { degraded = true; missed[key] = true; return fallback }
        return body
      } catch { degraded = true; if (key) missed[key] = true; return fallback }
    }
    // Computed once, not once per interpolation — two calls could straddle
    // midnight and ask for a window that starts after it ends.
    const week = weekWindow()
    const ahead = dayWindow(NEXT_ON_CALENDAR_DAYS)
    try {
      const [memberRoster, memberStats, events, schedule, tasks, taskStats, calEvents, upcoming] = await Promise.all([
        // Dashboard rollups only need a bounded sample — ask explicitly for
        // the max (200) rather than silently relying on the list endpoints'
        // invisible safety cap. `get` returned a 200 `{}` or `null` as the
        // roster, and `(members ?? [])` then said "No members yet."
        loadList(apiUrl('/api/clients?limit=200')),
        get('/api/clients/stats', null),
        // SP-021: a Viewer's Dashboard reads only what the Help role table
        // gives them; events and tasks are not asked for (they would 403).
        hideET ? [] : get('/api/events?limit=200', [], 'events'),
        get('/api/schedule', [], 'schedule'),
        hideET ? [] : get('/api/tasks?limit=200', [], 'tasks'),
        hideET ? null : get('/api/tasks/stats', null),
        // The calendar call used to have no window, which meant the "This
        // Week" figure below counted every event the parish had ever logged
        // — a number that only agreed with its own label during a parish's
        // first seven days, then drifted upward forever. Ask for the seven
        // days the card claims to be about.
        get(`/api/calendar?start=${week.start}&end=${week.end}`, [], 'calEvents'),
        hideET ? [] : get(`/api/calendar?start=${ahead.start}&end=${ahead.end}&limit=${NEXT_ON_CALENDAR_LIMIT}`, [], 'upcoming'),
      ])
      if (!memberRoster.ok) degraded = true
      setData({
        members: memberRoster.data,
        membersFailed: !memberRoster.ok,
        memberStats, events, eventsFailed: missed.events,
        schedule, scheduleFailed: missed.schedule,
        tasks, tasksFailed: missed.tasks, taskStats,
        calEvents, calEventsFailed: missed.calEvents,
        upcoming, upcomingFailed: missed.upcoming,
      })
      setLoadFailed(degraded)
    } catch {
      setLoadFailed(true)
    }
  }, [hideET])

  const retry = useCallback(async () => {
    setReloading(true)
    await load()
    setReloading(false)
  }, [load])

  useEffect(() => { load() }, [load])

  return (
    <PageWrapper>
      <div className="space-y-6">

        {/* First-run checklist — admin-only, hides when all items
            are done or the admin dismisses. Stays ABOVE the sample-
            data banner so the "what to do next" frame anchors the
            page; the sample data note is informational, not the
            action item. */}
        <GettingSettledCard />

        {/* Sample-data banner — hides itself when the org has none. */}
        {loadFailed && (
          <div role="status" className="flex items-start gap-3 rounded-2xl border border-amber-300/70 dark:border-amber-700/40 bg-amber-50/70 dark:bg-amber-900/15 px-5 py-4">
            <AlertCircle size={18} className="shrink-0 mt-0.5 text-amber-700 dark:text-amber-400" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
                Some of today's information didn't load.
              </p>
              <p className="text-sm text-ink-600 dark:text-parchment-300/80 mt-0.5">
                Nothing was lost — this is a connection problem, not your parish's data.
              </p>
            </div>
            <button
              onClick={retry}
              disabled={reloading}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold text-church-900 dark:text-brass-200 hover:bg-amber-100/70 dark:hover:bg-amber-900/25 transition-colors disabled:opacity-60"
            >
              {reloading
                ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                : <RotateCcw size={14} aria-hidden="true" />}
              {reloading ? 'Retrying' : 'Try again'}
            </button>
          </div>
        )}

        {!isViewer && <SampleDataBanner onCleared={load} />}

        {/* Page header */}
        <motion.div variants={fadeUp(0)} initial="hidden" animate="show" className="flex items-center justify-between">
          <div>
            {parishName && (
              <div className="flex items-center gap-2 mb-0.5">
                <Church size={15} className="text-brass-500 dark:text-brass-400" />
                <span className="text-xs font-semibold text-brass-700 dark:text-brass-300 uppercase tracking-widest">{parishName}</span>
              </div>
            )}
            <h1 className="font-display text-4xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">{t('dash.title')}</h1>
          </div>
        </motion.div>

        {/* Tab bar */}
        <motion.div variants={fadeUp(1)} initial="hidden" animate="show"
          className="flex gap-1 bg-parchment-200 dark:bg-ink-900 rounded-xl p-1 w-fit overflow-x-auto"
        >
          {TABS.filter(tab => !hideET || tab.id !== 'events').map(tab => {
            const Icon = tab.icon
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap"
              >
                {isActive && (
                  <motion.div
                    layoutId="tab-pill"
                    className="absolute inset-0 bg-parchment-50 dark:bg-ink-800 rounded-lg shadow-warm"
                    transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
                  />
                )}
                <Icon size={14} className={`relative z-10 transition-colors ${isActive ? 'text-ink-900 dark:text-parchment-50' : 'text-ink-500 dark:text-parchment-300/70'}`} />
                <span className={`relative z-10 transition-colors ${isActive ? 'text-ink-900 dark:text-parchment-50' : 'text-ink-500 dark:text-parchment-300/70'}`}>
                  {t(`dash.tab.${tab.id}`)}
                </span>
              </button>
            )
          })}
        </motion.div>

        {/* Tab content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            {activeTab === 'overview'  && <OverviewTab  data={data} />}
            {activeTab === 'members'   && <MembersTab   data={data} />}
            {activeTab === 'events'    && <EventsTab    data={data} />}
          </motion.div>
        </AnimatePresence>

      </div>
    </PageWrapper>
  )
}

// Direct /messages used to render the shell with an empty main — there is
// no inbox. This page tells that truth. It is not a feature, and it does
// not pretend the folder is empty.
export function MemberOutreachUnbuilt() {
  const { t } = useLocale()
  const navigate = useNavigate()
  return (
    <PageWrapper>
      <div className="max-w-lg mx-auto py-16">
        <EmptyState
          icon={MessageSquare}
          title={t('dash.outreach.unbuiltTitle')}
          body={t('dash.outreach.unbuiltBody')}
          action={{ label: t('dash.outreach.unbuiltBack'), onClick: () => navigate('/') }}
        />
      </div>
    </PageWrapper>
  )
}
