import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertCircle, AlertTriangle, Calendar, CheckCircle2, CheckSquare, ChevronDown, ChevronUp, Circle, Clock, Link2, Plus, RotateCcw, Trash2, User, X } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { TasksIllustration } from '../components/illustrations'
import { SkeletonRowList } from '../components/Skeleton'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip } from '../components/MobileSheet'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { mutate, loadList, loadOne } from '../utils/format'
import { apiUrl } from '../api'
import { initials } from '../utils/format'
import { celebrateFirstAction } from '../utils/firstActionToast'
import { useConfirm } from '../components/ConfirmProvider'
import { formatStoredDate } from '../utils/dates'
import { useLocale } from '../i18n'

// ── Constants ────────────────────────────────────────────────
const CATEGORIES = ['OPENING', 'CLOSING', 'DAILY_OPS', 'CLEANING', 'SERVICE_PREP', 'MAINTENANCE', 'COMMUNICATIONS']
const PRIORITIES  = ['LOW', 'MEDIUM', 'HIGH']
const STATUSES    = ['PENDING', 'IN_PROGRESS', 'COMPLETED']
const RECURRING   = ['DAILY', 'WEEKLY', 'SUNDAY_ONLY']

// Parchment & Brass: categories are named, not color-coded. One brass
// dot marks a group heading; chips are quiet parchment. A parish task
// list should read like a well-kept checklist, not a kanban rainbow.
const CATEGORY_CHIP = 'bg-parchment-200/80 text-ink-600 dark:bg-ink-800 dark:text-parchment-300'
const CATEGORY_META = {
  OPENING:      { label: 'Opening',       color: 'bg-brass-500', light: CATEGORY_CHIP },
  CLOSING:      { label: 'Closing',       color: 'bg-brass-500', light: CATEGORY_CHIP },
  DAILY_OPS:    { label: 'Daily Ops',     color: 'bg-brass-500', light: CATEGORY_CHIP },
  CLEANING:     { label: 'Cleaning',      color: 'bg-brass-500', light: CATEGORY_CHIP },
  SERVICE_PREP: { label: 'Service Prep',  color: 'bg-brass-500', light: CATEGORY_CHIP },
  MAINTENANCE:  { label: 'Maintenance',   color: 'bg-brass-500', light: CATEGORY_CHIP },
  // Shipped in every sample org since onboarding's seeder was written, and
  // missing from here the whole time — so "[Sample] Send weekly newsletter"
  // rendered through the unknown-category fallback and could not be filtered.
  COMMUNICATIONS: { label: 'Communications', color: 'bg-brass-500', light: CATEGORY_CHIP },
}

const PRIORITY_META = {
  LOW:    { label: 'Low',    cls: 'text-ink-500 dark:text-parchment-300/70' },
  MEDIUM: { label: 'Medium', cls: 'text-amber-700 dark:text-amber-400' },
  HIGH:   { label: 'High',   cls: 'text-rose-500 dark:text-rose-400' },
}

const RECURRING_META = {
  DAILY:       'Daily',
  WEEKLY:      'Weekly',
  SUNDAY_ONLY: 'Sunday Only',
}

const STATUS_NEXT = { PENDING: 'IN_PROGRESS', IN_PROGRESS: 'COMPLETED', COMPLETED: 'PENDING' }

const EMPTY_FORM = {
  title: '', description: '', category: 'DAILY_OPS', priority: 'MEDIUM',
  status: 'PENDING', recurring_freq: 'DAILY', checklist: [], due_date: '', assigned_member_id: null,
}

// ── Stat pill ────────────────────────────────────────────────
function StatPill({ label, value, accent }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl px-6 py-4 border shadow-sm ${accent}`}>
      <span className="font-display text-2xl font-semibold">{value ?? '—'}</span>
      <span className="text-xs font-medium mt-0.5 opacity-[0.88]">{label}</span>
    </div>
  )
}

// Normalize checklist items — old data is plain strings, new data is {label, done}
function normalizeChecklist(items) {
  return (items ?? []).map(item =>
    typeof item === 'string' ? { label: item, done: false } : item
  )
}

// ── Task card ────────────────────────────────────────────────
// canWrite flips off all interactive controls — viewers see a
// read-only card. Server enforces the underlying permission; this
// is just UX hygiene.
function TaskCard({ task, onStatusChange, onDelete, onEdit, canWrite }) {
  const [open, setOpen] = useState(false)
  const [checklist, setChecklist] = useState(() => normalizeChecklist(task.checklist))
  const toast = useToast()
  const cat  = CATEGORY_META[task.category]  ?? { label: task.category, light: 'bg-parchment-200 text-ink-600' }
  const pri  = PRIORITY_META[task.priority]  ?? PRIORITY_META.MEDIUM
  const done = task.status === 'COMPLETED'
  const inProg = task.status === 'IN_PROGRESS'

  async function toggleItem(i) {
    const prev = checklist
    const updated = checklist.map((item, idx) =>
      idx === i ? { ...item, done: !item.done } : item
    )
    setChecklist(updated)   // optimistic
    // Use the narrow checklist-only endpoint so we don't resend
    // assigned_member_id (which would otherwise risk re-triggering
    // assignment notifications) or any other task field. Revert the
    // optimistic toggle and surface an error if the write fails, so the
    // checkbox never lies about what's persisted.
    try {
      const res = await fetch(apiUrl(`/api/tasks/${task.id}/checklist`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checklist: updated }),
      })
      if (!res.ok) {
        setChecklist(prev)
        const d = await res.json().catch(() => ({}))
        toast.error(d.error || `Couldn't save checklist (${res.status})`)
      }
    } catch (err) {
      setChecklist(prev)
      toast.error("That didn't save — nothing was lost. Please try again.")
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className={`bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border shadow-sm overflow-hidden transition-opacity ${
        done ? 'opacity-60' : 'border-parchment-300/50 dark:border-brass-900/30'
      }`}
    >
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3.5">
        {/* Status indicator — clickable for writers, static for viewers */}
        {canWrite ? (
          <button
            onClick={() => onStatusChange(task.id, STATUS_NEXT[task.status])}
            aria-label={`Mark "${task.title}" as ${STATUS_NEXT[task.status].toLowerCase().replace('_', ' ')}`}
            /* `.tap`, not `.tap-reach`. Measured on a 390px viewport 27 Aug:
               row 1 reached 79x79 and every row after it collapsed to the
               32x32 visual box. tap-reach centres a 48px pseudo-element on
               the control, which at iPhone row pitch is TALLER THAN THE ROW —
               so vertically adjacent rows overlap and the later painter wins.
               The primitive is not broken; it is documented for isolated
               inline links, and a dense action row is not that.
               `.tap` only applies under (pointer: coarse), so desktop density
               is untouched — measured 63x63 there either way. */
            className="tap shrink-0 inline-flex items-center justify-center p-1.5 text-ink-300 dark:text-parchment-400/50 hover:text-church-900 dark:hover:text-parchment-50 transition-colors"
          >
            {done
              ? <CheckCircle2 size={20} className="text-brass-600 dark:text-brass-400" />
              : inProg
                ? <Clock size={20} className="text-amber-400" />
                : <Circle size={20} />
            }
          </button>
        ) : (
          <span className="shrink-0 text-ink-300 dark:text-parchment-400/50">
            {done
              ? <CheckCircle2 size={20} className="text-brass-600 dark:text-brass-400" />
              : inProg
                ? <Clock size={20} className="text-amber-400" />
                : <Circle size={20} />
            }
          </span>
        )}

        {/* Title + badges */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-sm font-semibold truncate ${done ? 'line-through text-ink-500 dark:text-parchment-300/70' : 'text-ink-900 dark:text-parchment-50'}`}>
              {task.title}
            </span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${cat.light}`}>{cat.label}</span>
            {task.recurring_freq && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-parchment-200 dark:bg-ink-800 text-ink-500 dark:text-parchment-300/70">
                {RECURRING_META[task.recurring_freq]}
              </span>
            )}
          </div>
          {task.description && (
            <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5 truncate">{task.description}</p>
          )}
          {task.assigned_member_name && (
            <p className="flex items-center gap-1 text-xs text-church-700 dark:text-brass-300 mt-0.5 font-medium"><User size={11} className="shrink-0 text-ink-400 dark:text-parchment-400/60" /> {task.assigned_member_name}</p>
          )}
        </div>

        {/* Priority + expand */}
        <div className="flex items-center gap-2 shrink-0">
          <AlertTriangle size={13} className={pri.cls} />
          {task.checklist?.length > 0 && (
            <button onClick={() => setOpen(o => !o)} aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} checklist for "${task.title}"`}
              className="p-1.5 -m-1.5 text-ink-500 dark:text-parchment-300/70 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors">
              {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          )}
          {canWrite && (
            <>
              {/* Same reasoning as Mark above: 45x24 hittable from row 2 down. */}
              <button onClick={() => onEdit(task)} className="tap inline-flex items-center justify-center text-ink-500 dark:text-parchment-300/70 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors text-xs font-medium px-3 py-1 rounded">
                Edit
              </button>
              {/* `.tap`, not `.tap-reach`. Hit-tested on a 390px viewport on
                  27 Aug: tap-reach's ::after reach is position-dependent —
                  adjacent controls in a dense row overlap and the later
                  painter wins, so THIS button's effective target collapsed
                  to its 26x26 visual box while its neighbour measured
                  77x71. A destructive control is the wrong place to rely on
                  a reach that a sibling can take away. The CSS comment on
                  .tap-reach already warned that "a neighbour paints into
                  the top of the reach"; this row is where that happens. */}
              <button onClick={() => onDelete(task.id)} aria-label={`Delete task "${task.title}"`}
                className="tap inline-flex items-center justify-center p-1.5 text-ink-300 hover:text-rose-400 transition-colors">
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Checklist */}
      <AnimatePresence>
        {open && checklist.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3.5 pt-0 border-t border-parchment-300/50 dark:border-brass-900/25">
              <ul className="space-y-1.5 mt-3">
                {checklist.map((item, i) => (
                  <li key={i}>
                    <button
                      onClick={() => canWrite && toggleItem(i)}
                      disabled={!canWrite}
                      className={`flex items-center gap-2 w-full text-left group ${canWrite ? '' : 'cursor-default'}`}
                    >
                      {item.done
                        ? <CheckCircle2 size={14} className="shrink-0 text-brass-600 dark:text-brass-400" />
                        : <Circle size={14} className={`shrink-0 text-ink-300 dark:text-parchment-400/50 ${canWrite ? 'group-hover:text-ink-400' : ''} transition-colors`} />
                      }
                      <span className={`text-xs transition-colors ${item.done ? 'line-through text-ink-300 dark:text-parchment-400/50' : `text-ink-500 dark:text-parchment-300/70 ${canWrite ? 'group-hover:text-ink-700 dark:group-hover:text-parchment-100' : ''}`}`}>
                        {item.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ── Linked Events (auto-synced by shared member) ─────────────
// Mirrors LinkedTasks in Events.jsx: shows events whose assigned members
// include this task's assigned_member_id. Re-fetches whenever the assignee
// changes in the open modal.
// Mirrors LinkedTasks in Events.jsx, and must keep mirroring it: three
// states, not two. "isn't on any events yet" is a claim about the parish's
// calendar; a failed request is not entitled to make it.
export function LinkedEvents({ taskId, assignedMemberId }) {
  const { t } = useLocale()
  const [events, setEvents] = useState(null)
  const [eventsFailed, setEventsFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setEventsFailed(false)
    if (!taskId) { setEvents([]); return }
    if (!assignedMemberId) { setEvents([]); return }
    setEvents(null)
    loadList(apiUrl(`/api/tasks/${taskId}/events`)).then(({ ok, data }) => {
      if (!alive) return
      setEvents(data)
      setEventsFailed(!ok)
    })
    return () => { alive = false }
  }, [taskId, assignedMemberId])

  if (!assignedMemberId) {
    return (
      <p className="text-xs text-ink-500 dark:text-parchment-300/70">
        Assign this task to a member to see linked events.
      </p>
    )
  }
  if (events === null) {
    return <p className="text-xs text-ink-500 dark:text-parchment-300/70">Loading linked events…</p>
  }
  if (eventsFailed) {
    return (
      <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
        {t('dash.upcomingUnread')}
      </p>
    )
  }
  if (events.length === 0) {
    return (
      <p className="text-xs text-ink-500 dark:text-parchment-300/70">
        This task's assignee isn't on any events yet.
      </p>
    )
  }
  return (
    <ul className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
      {events.map(e => {
        const when = e.date
          ? formatStoredDate(e.date, { month: 'numeric', day: 'numeric', year: 'numeric' })
          : null
        return (
          <li key={e.id} className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-parchment-100 dark:bg-ink-800/60 border border-parchment-300/60 dark:border-brass-900/30">
            <Calendar size={14} className="shrink-0 text-church-700 dark:text-brass-300 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate text-ink-800 dark:text-parchment-100">
                {e.title}
              </p>
              <p className="text-[10px] text-ink-500 dark:text-parchment-300/70 truncate">
                {e.service_division || 'Event'}
                {when ? ` · ${when}` : ''}
                {e.time ? ` · ${e.time}` : ''}
                {e.location ? ` · ${e.location}` : ''}
              </p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ── Modal form ───────────────────────────────────────────────
function TaskModal({ task, onClose, onSave }) {
  const { t } = useLocale()
  const [form, setForm] = useState(() => {
    const base = task ?? EMPTY_FORM
    return { ...base, checklist: normalizeChecklist(base.checklist) }
  })
  const [checklistInput, setChecklistInput] = useState('')
  const [members, setMembers] = useState([])
  const [memberSearch, setMemberSearch] = useState('')
  const [membersFailed, setMembersFailed] = useState(false)
  const field = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  useEffect(() => {
    // An empty picker reads as "this parish has no members". If the roster
    // call failed we do not know that, so the field says so instead.
    loadList(apiUrl('/api/clients')).then(({ ok, data }) => {
      setMembers(data)
      setMembersFailed(!ok)
    })
  }, [])

  const selectedMember = members.find(m => String(m.id) === String(form.assigned_member_id))
  const filteredMembers = members.filter(m =>
    m.name.toLowerCase().includes(memberSearch.toLowerCase()) ||
    (m.role ?? '').toLowerCase().includes(memberSearch.toLowerCase())
  )

  const addItem = () => {
    if (!checklistInput.trim()) return
    setForm(f => ({ ...f, checklist: [...(f.checklist || []), { label: checklistInput.trim(), done: false }] }))
    setChecklistInput('')
  }

  const removeItem = i => setForm(f => ({ ...f, checklist: f.checklist.filter((_, idx) => idx !== i) }))

  return (
    <div className={sheetOverlayCls}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
          <h2 className="font-bold text-ink-900 dark:text-parchment-50">{task ? 'Edit Task' : 'New Task'}</h2>
          <button onClick={onClose} aria-label="Close" className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Title *</label>
            <input value={form.title} onChange={field('title')} placeholder="Task title" aria-label="Task title"
              className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Description</label>
            <textarea value={form.description} onChange={field('description')} rows={2} placeholder="Optional details" aria-label="Optional details"
              className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500 resize-none" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Due Date</label>
            <input type="date" value={form.due_date ?? ''} onChange={field('due_date')}
              className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500" />
          </div>

          {/* Assign to member */}
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Assign To</label>
            {membersFailed && (
              <p role="status" className="mb-2 text-xs text-amber-700 dark:text-amber-400">
                {t('mem.listFailed')}
              </p>
            )}
            {selectedMember ? (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40">
                <div className="w-7 h-7 rounded-full bg-church-900 dark:bg-church-700 flex items-center justify-center text-parchment-50 text-[10px] font-bold shrink-0">
                  {initials(selectedMember.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">{selectedMember.name}</p>
                  <p className="text-xs text-ink-500 dark:text-parchment-300/70">{selectedMember.role ?? 'Member'}</p>
                </div>
                <button
                  type="button"
                  onClick={() => { setForm(f => ({ ...f, assigned_member_id: null })); setMemberSearch('') }}
                  className="text-ink-300 hover:text-rose-400 transition-colors shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  placeholder="Search members…" aria-label="Search members…"
                  value={memberSearch}
                  onChange={e => setMemberSearch(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
                />
                {memberSearch && (
                  <ul className="max-h-40 overflow-y-auto rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 divide-y divide-parchment-200/60 dark:divide-brass-900/25">
                    {filteredMembers.length === 0 && (
                      <li className="px-3 py-2 text-xs text-ink-500 dark:text-parchment-300/70">No members found</li>
                    )}
                    {filteredMembers.map(m => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => { setForm(f => ({ ...f, assigned_member_id: m.id })); setMemberSearch('') }}
                          className="flex items-center gap-3 w-full px-3 py-2 text-left hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors"
                        >
                          <div className="w-6 h-6 rounded-full bg-church-900 dark:bg-church-700 flex items-center justify-center text-parchment-50 text-[9px] font-bold shrink-0">
                            {initials(m.name)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">{m.name}</p>
                            <p className="text-xs text-ink-500 dark:text-parchment-300/70">{m.role ?? 'Member'}</p>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Category</label>
              <select value={form.category} onChange={field('category')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500">
                {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_META[c]?.label ?? c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Priority</label>
              <select value={form.priority} onChange={field('priority')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500">
                {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Status</label>
              <select value={form.status} onChange={field('status')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500">
                {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Recurring</label>
              <select value={form.recurring_freq ?? ''} onChange={field('recurring_freq')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500">
                <option value="">None</option>
                {RECURRING.map(r => <option key={r} value={r}>{RECURRING_META[r]}</option>)}
              </select>
            </div>
          </div>

          {/* Checklist builder */}
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Checklist</label>
            <div className="flex gap-2 mb-2">
              <input value={checklistInput} onChange={e => setChecklistInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addItem())}
                placeholder="Add item, press Enter"
                className="flex-1 px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500" />
              <button onClick={addItem} className="px-3 py-2 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-medium hover:opacity-90 transition-opacity">
                Add
              </button>
            </div>
            {form.checklist?.length > 0 && (
              <ul className="space-y-1">
                {form.checklist.map((item, i) => (
                  <li key={i} className="flex items-center justify-between text-xs text-ink-600 dark:text-parchment-200 bg-parchment-100 dark:bg-ink-800/60 px-3 py-1.5 rounded-lg">
                    <span>{item.label}</span>
                    <button onClick={() => removeItem(i)} aria-label="Remove checklist item" className="text-ink-300 hover:text-rose-400 transition-colors ml-2"><X size={12} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Linked events (only when editing an existing task) */}
          {task && (
            <div className="pt-2 border-t border-parchment-300/50 dark:border-brass-900/25">
              <div className="flex items-center gap-1.5 mb-2">
                <Link2 size={13} className="text-church-700 dark:text-brass-300" />
                <h3 className="text-xs font-semibold text-ink-700 dark:text-parchment-200">Linked Events</h3>
              </div>
              <LinkedEvents taskId={task.id} assignedMemberId={form.assigned_member_id} />
              <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
                Events whose assigned members include this task's assignee.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-parchment-300/50 dark:border-brass-900/25">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-ink-500 hover:text-ink-800 dark:text-parchment-300/70 dark:hover:text-parchment-50 transition-colors">
            Cancel
          </button>
          <button onClick={() => onSave(form)} disabled={!form.title.trim()}
            className="px-5 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-white text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40">
            {task ? 'Save Changes' : 'Create Task'}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────
export default function Tasks() {
  const [tasks, setTasks]       = useState([])
  const [stats, setStats]       = useState(null)
  const [filter, setFilter]     = useState({ category: '', status: '', priority: '' })
  const [modal, setModal]       = useState(null)   // null | 'new' | task object
  const [groupBy, setGroupBy]   = useState('category')
  // Loading guard for the very first fetch only — refilters keep
  // existing data visible to avoid flicker between filter clicks.
  const [initialLoading, setInitialLoading] = useState(true)
  // Distinct from "no tasks": we asked and did not get an answer.
  const [loadFailed, setLoadFailed] = useState(false)
  // Pagination (mirrors Clients). "Load more" appends the next page;
  // `hasMore` is derived from whether the last page came back full.
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const { canWrite } = useAuth()
  const toast = useToast()
  const ask = useConfirm()
  const { t } = useLocale()

  const PAGE_SIZE = 50

  // Fetch the first page (with the active filters). Any filter change
  // resets paging and refetches from the top. The list endpoint clamps to
  // a safety cap, so we page explicitly.
  const load = async () => {
    const params = new URLSearchParams(Object.fromEntries(Object.entries(filter).filter(([,v]) => v)))
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', '0')

    // This used to be two bare `.then(r => r.json())` calls inside a
    // Promise.all with no catch anywhere. A 500 returns HTML, r.json() throws
    // a SyntaxError, the Promise.all rejects — and setInitialLoading(false)
    // never runs. The page did not show an error or an empty list. It showed
    // the loading skeleton, forever, with an unhandled rejection in a console
    // nobody has open. Same family as the Dashboard's M2 fix; it never
    // travelled here.
    const [t, s] = await Promise.all([
      loadList(apiUrl(`/api/tasks?${params}`)),
      loadOne(apiUrl('/api/tasks/stats')),
    ])

    setTasks(t.data)
    // A full page implies there may be more; a short page is the end. A failed
    // page is neither — and must not be read as "you have reached the end".
    setHasMore(t.ok && t.data.length === PAGE_SIZE)
    setStats(s.data)
    setLoadFailed(!t.ok || !s.ok)
    setInitialLoading(false)
  }

  useEffect(() => { load() }, [filter])

  // Fetch the next page and APPEND. Offset is the current row count so it
  // stays correct regardless of how many pages we've loaded.
  const loadMoreTasks = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    const params = new URLSearchParams(Object.fromEntries(Object.entries(filter).filter(([,v]) => v)))
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(tasks.length))
    const { ok, data } = await loadList(apiUrl(`/api/tasks?${params}`))
    // A silent return here is FAILED presented as NONE: the spinner
    // stops, no rows appear, and the person concludes they have reached
    // the end of their own records. Say it instead.
    if (!ok) { toast.error(t('np.loadFailed')); setLoadingMore(false); return }
    setTasks(prev => [...prev, ...data])
    setHasMore(data.length === PAGE_SIZE)
    setLoadingMore(false)
  }

  const handleStatusChange = async (id, status) => {
    const { ok, error } = await mutate(apiUrl(`/api/tasks/${id}/status`),
      { method: 'PATCH', body: { status } })
    if (!ok) { toast.error(error); return }
    load()
  }

  const handleDelete = async (id) => {
    if (!(await ask({
      title: 'Delete this task?',
      body: 'This cannot be undone.',
      confirmLabel: 'Delete task',
    }))) return
    const { ok, error } = await mutate(apiUrl(`/api/tasks/${id}`), { method: 'DELETE' })
    if (!ok) { toast.error(error); return }
    load()
  }

  const handleSave = async (form) => {
    const isEdit = modal && modal !== 'new'
    const url    = isEdit ? apiUrl(`/api/tasks/${modal.id}`) : apiUrl('/api/tasks')
    let res
    try {
      res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
    } catch (err) {
      toast.error("That didn't save — nothing was lost. Please try again.")
      return
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || `Save failed (${res.status})`)
      return
    }
    setModal(null)
    load()
    if (!isEdit) celebrateFirstAction('task', toast, stats?.total)
  }

  // Group tasks
  const grouped = groupBy === 'category'
    ? CATEGORIES.reduce((acc, cat) => {
        const items = tasks.filter(t => t.category === cat)
        if (items.length) acc[cat] = items
        return acc
      }, {})
    : { ALL: tasks }

  const progress = stats ? Math.round((parseInt(stats.completed) / Math.max(parseInt(stats.total), 1)) * 100) : 0

  return (
    <PageWrapper>
      <div className="space-y-8">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Daily Tasks</h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">Track and complete church operations.</p>
          </div>
          {canWrite && (
            <button onClick={() => setModal('new')}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-church-900 dark:bg-white text-parchment-50 dark:text-church-900 text-sm font-semibold shadow hover:opacity-90 transition-opacity shrink-0">
              <Plus size={15} /> New Task
            </button>
          )}
        </div>

        {/* Stats */}
        {stats && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatPill label="Total"       value={stats.total}       accent="bg-parchment-50 dark:bg-ink-900/90 border-parchment-300/50 dark:border-brass-900/30 text-ink-900 dark:text-parchment-50" />
              <StatPill label="Completed"   value={stats.completed}   accent="bg-parchment-50 dark:bg-ink-900/90 border-parchment-300/50 dark:border-brass-900/30 text-brass-700 dark:text-brass-300" />
              <StatPill label="In Progress" value={stats.in_progress} accent="bg-parchment-50 dark:bg-ink-900/90 border-parchment-300/50 dark:border-brass-900/30 text-ink-700 dark:text-parchment-200" />
              <StatPill label="High Priority Pending" value={stats.high_pending} accent="bg-parchment-50 dark:bg-ink-900/90 border-parchment-300/50 dark:border-brass-900/30 text-rose-700 dark:text-rose-300" />
            </div>
            {/* Progress bar */}
            <div className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 px-5 py-4 shadow-sm">
              <div className="flex justify-between text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-2">
                <span>Today's Progress</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 bg-parchment-200 dark:bg-ink-800 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.6, ease: 'easeOut' }}
                  className="h-full bg-brass-500 dark:bg-brass-400 rounded-full"
                />
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3 items-center">
          {[
            { key: 'category', options: CATEGORIES, labels: CATEGORY_META, placeholder: 'All Categories' },
            { key: 'status',   options: STATUSES,   labels: null,          placeholder: 'All Statuses' },
            { key: 'priority', options: PRIORITIES, labels: null,          placeholder: 'All Priorities' },
          ].map(({ key, options, labels, placeholder }) => (
            <select key={key} value={filter[key]} aria-label={placeholder}
              onChange={e => setFilter(f => ({ ...f, [key]: e.target.value }))}
              className="px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-ink-700 dark:text-parchment-100 focus:outline-none focus:ring-2 focus:ring-church-500">
              <option value="">{placeholder}</option>
              {options.map(o => <option key={o} value={o}>{labels ? labels[o]?.label : o.replace('_', ' ')}</option>)}
            </select>
          ))}
          <button onClick={() => setFilter({ category: '', status: '', priority: '' })}
            className="flex items-center gap-1.5 text-xs text-ink-500 dark:text-parchment-300/70 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors px-2 py-1">
            <RotateCcw size={12} /> Reset
          </button>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-ink-500 dark:text-parchment-300/70">Group:</span>
            {['category', 'none'].map(g => (
              <button key={g} onClick={() => setGroupBy(g)}
                className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
                  groupBy === g
                    ? 'bg-church-900 dark:bg-white text-parchment-50 dark:text-church-900'
                    : 'bg-parchment-200 dark:bg-ink-800 text-ink-500 dark:text-parchment-300/70 hover:text-ink-800 dark:hover:text-parchment-50'
                }`}>
                {g === 'category' ? 'Category' : 'All'}
              </button>
            ))}
          </div>
        </div>

        {/* Task groups */}
        <div className="space-y-8">
          {loadFailed && !initialLoading && (
            <div role="status" className="mb-5 flex items-start gap-3 rounded-2xl border border-amber-300/70 dark:border-amber-700/40 bg-amber-50/70 dark:bg-amber-900/15 px-5 py-4">
              <AlertCircle size={18} className="shrink-0 mt-0.5 text-amber-700 dark:text-amber-400" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
                  {t('load.failedTitle')}
                </p>
                <p className="text-sm text-ink-600 dark:text-parchment-300/80 mt-0.5">
                  {t('load.failedBody')}
                </p>
              </div>
              <button
                type="button"
                onClick={load}
                className="shrink-0 text-sm font-semibold text-church-700 dark:text-brass-300 hover:underline focus:outline-none focus:ring-2 focus:ring-church-500 rounded px-2 py-1"
              >
                {t('error.tryAgain')}
              </button>
            </div>
          )}
          {initialLoading ? (
            <SkeletonRowList count={6} />
          ) : (<>
          {Object.entries(grouped).map(([group, items]) => {
            const meta = CATEGORY_META[group]
            return (
              <div key={group}>
                {groupBy === 'category' && meta && (
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-2.5 h-2.5 rounded-full ${meta.color}`} />
                    <h3 className="text-sm font-bold text-ink-700 dark:text-parchment-100">{meta.label}</h3>
                    <span className="text-xs text-ink-500 dark:text-parchment-300/70">({items.length})</span>
                  </div>
                )}
                <div className="space-y-2">
                  <AnimatePresence mode="popLayout">
                    {items.map(task => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onStatusChange={handleStatusChange}
                        onDelete={handleDelete}
                        onEdit={t => setModal(t)}
                        canWrite={canWrite}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )
          })}

          {/* An empty list is only allowed to speak when the load succeeded.
              `loadFailed` means we do not know what this parish has, and
              "No tasks yet / Add your first task" is a claim about their
              data that we are in no position to make. Observed 27 Aug: a
              parish with 14 tasks was shown the first-run card. */}
          {!loadFailed && tasks.length === 0 && (
            !filter.category && !filter.status && !filter.priority ? (
              <EmptyState
                illustration={TasksIllustration}
                title="No tasks yet"
                body="Tasks are the recurring and one-off checklist items your staff runs before, during, and after service."
                action={canWrite ? { label: 'Add your first task', onClick: () => setModal('new') } : null}
              />
            ) : (
              <div className="text-center py-16 text-ink-500 dark:text-parchment-300/70">
                <CheckSquare size={32} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">No tasks found</p>
              </div>
            )
          )}

          {/* Load more — only while the last page came back full. Appends
              the next page rather than replacing (mirrors Clients). */}
          {hasMore && tasks.length > 0 && (
            <div className="flex justify-center">
              <button
                onClick={loadMoreTasks}
                disabled={loadingMore}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-church-800 dark:text-brass-200 bg-parchment-100 dark:bg-ink-800/80 border border-parchment-300/60 dark:border-brass-900/30 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors disabled:opacity-50"
              >
                {loadingMore ? t('mem.loading') : t('mem.loadMore')}
              </button>
            </div>
          )}
          </>)}
        </div>
      </div>

      {/* Modal */}
      <AnimatePresence>
        {modal && (
          <TaskModal
            task={modal === 'new' ? null : modal}
            onClose={() => setModal(null)}
            onSave={handleSave}
          />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}
