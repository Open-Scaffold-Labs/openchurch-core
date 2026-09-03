import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Plus, X, Pencil, Trash2, Feather, CheckCircle2, Clock, Circle, Link2, Users, Upload, AlertCircle, Loader2 } from 'lucide-react'
import PageWrapper, { itemVariants } from '../components/PageWrapper'
import AnimatedButton from '../components/AnimatedButton'
import EmptyState from '../components/EmptyState'
import { EventsIllustration } from '../components/illustrations'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip } from '../components/MobileSheet'
import ImportEventsModal from '../components/ImportEventsModal'
import AttendanceSection from '../components/AttendanceSection'
import MemberPicker from '../components/MemberPicker'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { mutate, loadList } from '../utils/format'
import { apiUrl } from '../api'
import { celebrateFirstAction } from '../utils/firstActionToast'
import { initials } from '../utils/format'
import { formatLocalDate } from '../utils/dates'
import { LIT_COLOR_DOT as COLOR_DOT, LIT_COLOR_TEXT as COLOR_TEXT, LIT_COLOR_STRIPE as COLOR_STRIPE, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { useConfirm } from '../components/ConfirmProvider'

const empty = {
  title: '',
  service_division: '',
  date: '',
  time: '',
  location: '',
  liturgical_season: '',
  liturgical_color: '',
  feast_name: '',
  member_ids: [],
  // Sprint P — public toggle. Default false so every new event is
  // private until the admin explicitly opts in.
  is_public: false,
}

const STATUS_ICON = {
  COMPLETED:   <CheckCircle2 size={14} className="text-brass-500 shrink-0" />,
  IN_PROGRESS: <Clock size={14} className="text-amber-500 shrink-0" />,
  PENDING:     <Circle size={14} className="text-ink-400 shrink-0" />,
}

async function enrichEventWithLiturgical(eventDate) {
  if (!eventDate) return {}
  try {
    const res = await fetch(apiUrl(`/api/liturgical?date=${eventDate}`))
    const data = await res.json()
    return { liturgical_season: data.season ?? '', liturgical_color: data.color ?? '', feast_name: data.feast_name ?? '' }
  } catch {
    return {}
  }
}

// ── Linked Tasks (auto-synced by shared member) ──────────────
function LinkedTasks({ eventId }) {
  const [tasks, setTasks] = useState(null)
  // null = still asking · tasksFailed = we asked and failed · [] = genuinely none.
  const [tasksFailed, setTasksFailed] = useState(false)

  useEffect(() => {
    let alive = true
    if (!eventId) { setTasks([]); return }
    loadList(apiUrl(`/api/events/${eventId}/tasks`)).then(({ ok, data }) => {
      if (!alive) return
      setTasks(data)
      // "No tasks linked to this event" and "we could not find out" are
      // different sentences. console.error was only ever telling the developer.
      setTasksFailed(!ok)
    })
    return () => { alive = false }
  }, [eventId])

  if (tasks === null) {
    return <p className="text-xs text-ink-500 dark:text-parchment-300/70">Loading linked tasks…</p>
  }
  if (tasksFailed) {
    // Without this branch a failed lookup rendered "No tasks are assigned",
    // which is a claim about the parish's data made on the strength of a
    // request that never came back.
    return (
      <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
        Linked tasks didn't load — this isn't a sign there are none.
      </p>
    )
  }
  if (tasks.length === 0) {
    return (
      <p className="text-xs text-ink-500 dark:text-parchment-300/70">
        No tasks are assigned to the members on this event yet.
      </p>
    )
  }
  return (
    <ul className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
      {tasks.map(t => (
        <li key={t.id} className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-parchment-100 dark:bg-ink-800/60 border border-parchment-300/60 dark:border-brass-900/30">
          {STATUS_ICON[t.status] ?? STATUS_ICON.PENDING}
          <div className="flex-1 min-w-0">
            <p className={`text-xs font-medium truncate ${t.status === 'COMPLETED' ? 'line-through text-ink-500 dark:text-parchment-300/70' : 'text-ink-800 dark:text-parchment-100'}`}>
              {t.title}
            </p>
            <p className="text-[10px] text-ink-500 dark:text-parchment-300/70 truncate">
              {t.assigned_member_name ?? 'Unassigned'}
              {t.due_date ? ` · due ${formatLocalDate(t.due_date, { month: 'numeric', day: 'numeric', year: 'numeric' })}` : ''}
              {t.priority ? ` · ${t.priority}` : ''}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function Events() {
  const [events, setEvents] = useState([])
  const [eventsFailed, setEventsFailed] = useState(false)
  // Starts true. Until the first response lands we do not know whether this
  // parish has events, and "No events yet — Add your first event" is a claim
  // we are not yet entitled to make. Tasks and Clients both guarded this;
  // this page did not, so it asserted emptiness for the whole round trip.
  const [initialLoading, setInitialLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(empty)
  const [loading, setLoading] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [members, setMembers] = useState([])
  const [membersFailed, setMembersFailed] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  // Pagination (mirrors Clients). The list fetches a page at a time;
  // "Load more" appends the next page. `hasMore` is derived from whether
  // the last page came back full — a short page means we've hit the end.
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const { canWrite } = useAuth()
  const toast = useToast()
  const ask = useConfirm()

  const PAGE_SIZE = 50

  useEffect(() => { fetchEvents() }, [])
  // An empty picker reads as "this parish has no members". A failed roster
  // call is not that fact, so it is not allowed to look like it.
  //
  // Extracted from the mount effect so the modal can retry: with a `[]`-dep
  // effect the warning was permanent for the life of the page, and nothing
  // ever refetched the roster.
  const loadMembers = useCallback(() => {
    loadList(apiUrl('/api/clients')).then(({ ok, data }) => {
      setMembers(data)
      setMembersFailed(!ok)
    })
  }, [])

  useEffect(() => { loadMembers() }, [loadMembers])

  // Fetch the first page. Replaces the list and recomputes hasMore. The
  // list endpoint clamps to a safety cap, so we page explicitly.
  // Observed 27 Aug: a 500 here assigned the error BODY to `events`, so
  // `events.map` threw and the whole page was replaced by the error
  // boundary reading "events.map is not a function". loadList refuses to
  // hand back a non-array, and the failure becomes a sentence instead.
  async function fetchEvents() {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', '0')
    const { ok, data } = await loadList(apiUrl(`/api/events?${params}`))
    setEvents(data)
    setEventsFailed(!ok)
    setInitialLoading(false)
    // A full page implies there may be more; a short page is the end.
    setHasMore(ok && data.length === PAGE_SIZE)
  }

  // Fetch the next page and APPEND. Offset is the current row count so it
  // stays correct regardless of how many pages we've loaded.
  async function loadMoreEvents() {
    if (loadingMore) return
    setLoadingMore(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(events.length))
    const { ok, data } = await loadList(apiUrl(`/api/events?${params}`))
    // A silent return here is FAILED presented as NONE: the spinner
    // stops, no rows appear, and the person concludes they have reached
    // the end of their own records. Say it instead.
    if (!ok) { toast.error("Couldn't load more events. Nothing was lost — try again."); setLoadingMore(false); return }
    setEvents(prev => [...prev, ...data])
    setHasMore(data.length === PAGE_SIZE)
    setLoadingMore(false)
  }

  useEffect(() => {
    const t = setTimeout(fetchEvents, 300)
    return () => clearTimeout(t)
  }, [search])

  function openAdd() {
    setEditing(null)
    setForm(empty)
    setSaveError('')
    setShowForm(true)
  }

  // Onboarding deep-link (POL.3): /events?new=1 opens the add-event form
  // immediately (from the Dashboard checklist), then clears the param so
  // a refresh doesn't re-open it.
  useEffect(() => {
    if (searchParams.get('new')) {
      openAdd()
      const next = new URLSearchParams(searchParams)
      next.delete('new')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openEdit(event) {
    setEditing(event.id)
    setForm({
      title: event.title,
      service_division: event.service_division || '',
      date: event.date ? event.date.slice(0, 10) : '',
      time: event.time || '',
      location: event.location || '',
      liturgical_season: event.liturgical_season || '',
      liturgical_color: event.liturgical_color || '',
      feast_name: event.feast_name || '',
      member_ids: (event.assigned_members ?? []).map(m => m.id),
      is_public: !!event.is_public,
    })
    setSaveError('')
    setShowForm(true)
  }

  function field(key) {
    return (e) => {
      const val = e.target.value
      setForm(f => ({ ...f, [key]: val }))
      if (key === 'date' && val) {
        enrichEventWithLiturgical(val).then(lit => setForm(f => ({ ...f, ...lit })))
      }
    }
  }

  async function save(e) {
    e.preventDefault()
    setLoading(true)
    setSaveError('')
    const method = editing ? 'PATCH' : 'POST'
    const url = editing ? apiUrl(`/api/events/${editing}`) : apiUrl('/api/events')
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
    } catch (err) {
      setLoading(false)
      setSaveError("That didn't save — nothing was lost. Please check your connection and try again.")
      return
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setLoading(false)
      setSaveError(data.error || `Save failed (${res.status})`)
      return
    }
    setLoading(false)
    setShowForm(false)
    fetchEvents()
    if (!editing) celebrateFirstAction('event', toast)
  }

  async function remove(id) {
    if (!(await ask({ title: 'Remove this event?', confirmLabel: 'Remove event' }))) return
    const { ok, error } = await mutate(apiUrl(`/api/events/${id}`), { method: 'DELETE' })
    if (!ok) { toast.error(error); return }
    fetchEvents()
  }

  const inputCls = 'w-full border border-parchment-300/70 dark:border-brass-900/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-church-500 bg-parchment-50 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50'

  return (
    <PageWrapper>
      <motion.div variants={itemVariants} className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Events</h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">Browse and manage upcoming church events · {events.length} total</p>
        </div>
        {canWrite && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-church-800 dark:text-brass-200 bg-parchment-100 dark:bg-ink-800/80 border border-parchment-300/60 dark:border-brass-900/30 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors"
          >
            <Upload size={15} /> Import CSV
          </button>
          <AnimatedButton onClick={openAdd} className="flex items-center gap-2 bg-church-900 hover:bg-church-700 dark:bg-church-800 dark:hover:bg-church-700 text-parchment-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus size={16} /> Add Event
          </AnimatedButton>
        </div>
        )}
      </motion.div>

      <motion.div variants={itemVariants} className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title, division, location..." className="w-full pl-9 pr-4 py-2 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-church-500 bg-parchment-50 dark:bg-ink-900 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 transition-shadow duration-200 focus:shadow-md" />
      </motion.div>

      {/* Table or empty state — "no matches" during a search stays a
          minimalist row inside the table; truly-empty shows the big card. */}
      {eventsFailed && (
        <motion.div variants={itemVariants} role="status" className="mb-5 flex items-start gap-3 rounded-2xl border border-amber-300/70 dark:border-amber-700/40 bg-amber-50/70 dark:bg-amber-900/15 px-5 py-4">
          <AlertCircle size={18} className="shrink-0 mt-0.5 text-amber-700 dark:text-amber-400" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">Some events didn't load.</p>
            <p className="text-sm text-ink-600 dark:text-parchment-300/80 mt-0.5">
              Nothing was lost — this is a connection problem, not your parish's calendar. What's shown below may be incomplete.
            </p>
          </div>
          <button onClick={fetchEvents} className="shrink-0 text-sm font-medium text-church-700 dark:text-brass-300 underline min-h-[32px]">Try again</button>
        </motion.div>
      )}

      {initialLoading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-brass-600" aria-label="Loading events" /></div>
      ) : !eventsFailed && !search && events.length === 0 ? (
        <EmptyState
          illustration={EventsIllustration}
          title="No events yet"
          body="Events are services, feast days, meetings, and one-offs. Add your first and assign members so everyone knows who's responsible."
          action={canWrite ? { label: 'Add your first event', onClick: openAdd } : null}
        />
      ) : (
      <motion.div variants={itemVariants} className="bg-parchment-50 dark:bg-ink-900 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 overflow-hidden shadow-card">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[52rem]">
          <thead className="bg-parchment-100 dark:bg-ink-800/60 border-b border-parchment-300/60 dark:border-brass-900/30">
            <tr>
              {['Title', 'Service Division', 'Season', 'Date', 'Time', 'Location', 'Members', ''].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-parchment-200/60 dark:divide-brass-900/30">
            {events.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-ink-500 dark:text-parchment-300/70">
                {eventsFailed ? "We couldn't load the calendar just now." : 'No events found.'}
              </td></tr>
            )}
            <AnimatePresence>
              {events.map((ev, i) => {
                const assigned = ev.assigned_members ?? []
                return (
                  <motion.tr
                    key={ev.id}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 6 }}
                    transition={{ delay: i * 0.03, duration: 0.2 }}
                    className={`hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors group border-l-4 ${COLOR_STRIPE[ev.liturgical_color] ?? 'border-l-transparent'}`}
                  >
                    <td className="px-4 py-3 font-medium text-ink-900 dark:text-parchment-50">{ev.title}</td>
                    <td className="px-4 py-3 text-ink-600 dark:text-parchment-300">{ev.service_division || '—'}</td>
                    <td className="px-4 py-3">
                      {ev.liturgical_season ? (
                        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full border ${COLOR_TEXT[ev.liturgical_color] ?? COLOR_TEXT.White}`}>
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${COLOR_DOT[ev.liturgical_color] ?? LIT_COLOR_DOT_NONE}`} />
                          {ev.feast_name || ev.liturgical_season}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-ink-600 dark:text-parchment-300">{ev.date ? formatLocalDate(ev.date, { month: 'numeric', day: 'numeric', year: 'numeric' }) : '—'}</td>
                    <td className="px-4 py-3 text-ink-600 dark:text-parchment-300">{ev.time || '—'}</td>
                    <td className="px-4 py-3 text-ink-600 dark:text-parchment-300">{ev.location || '—'}</td>
                    <td className="px-4 py-3">
                      {assigned.length === 0 ? (
                        <span className="text-ink-300 dark:text-parchment-400/50">—</span>
                      ) : (
                        <div className="flex -space-x-1.5" title={assigned.map(m => m.name).join(', ')}>
                          {assigned.slice(0, 3).map(m => (
                            <span key={m.id} className="w-6 h-6 rounded-full bg-church-900 dark:bg-church-700 flex items-center justify-center text-parchment-50 text-[9px] font-bold ring-2 ring-parchment-50 dark:ring-ink-900">
                              {initials(m.name)}
                            </span>
                          ))}
                          {assigned.length > 3 && (
                            <span className="w-6 h-6 rounded-full bg-parchment-200 dark:bg-ink-700 flex items-center justify-center text-ink-600 dark:text-parchment-200 text-[9px] font-bold ring-2 ring-parchment-50 dark:ring-ink-900">
                              +{assigned.length - 3}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {canWrite && (
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <motion.button onClick={() => openEdit(ev)} aria-label={`Edit event: ${ev.title}`} className="p-1.5 text-ink-400 hover:text-church-700 dark:hover:text-brass-200 rounded transition-colors"><Pencil size={14} aria-hidden="true" /></motion.button>
                          <motion.button onClick={() => remove(ev.id)} aria-label={`Delete event: ${ev.title}`} className="p-1.5 text-ink-400 hover:text-rose-500 rounded transition-colors"><Trash2 size={14} aria-hidden="true" /></motion.button>
                        </div>
                      )}
                    </td>
                  </motion.tr>
                )
              })}
            </AnimatePresence>
          </tbody>
        </table>
        </div>
      </motion.div>
      )}

      {/* Load more — only while the last page came back full. Appends the
          next page rather than replacing (mirrors Clients). */}
      {hasMore && events.length > 0 && (
        <div className="flex justify-center mt-6">
          <button
            onClick={loadMoreEvents}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-church-800 dark:text-brass-200 bg-parchment-100 dark:bg-ink-800/80 border border-parchment-300/60 dark:border-brass-900/30 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      <AnimatePresence>
        {showForm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={sheetOverlayCls}>
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 8 }} transition={{ duration: 0.2, ease: 'easeOut' }} className={sheetPanelCls}>
              <MobileSheetGrip />
              <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
                <h2 className="font-semibold text-ink-900 dark:text-parchment-50">{editing ? 'Edit Event' : 'Add Event'}</h2>
                <motion.button transition={{ duration: 0.15 }} onClick={() => setShowForm(false)} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50"><X size={18} /></motion.button>
              </div>
              <form onSubmit={save} className="p-6 space-y-4 overflow-y-auto">
                <div>
                  <label className="block text-xs font-medium text-ink-700 dark:text-parchment-200 mb-1">Title *</label>
                  <input value={form.title} onChange={field('title')} placeholder="Event title" aria-label="Event title" className={inputCls} required />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-700 dark:text-parchment-200 mb-1">Service Division</label>
                  <input value={form.service_division} onChange={field('service_division')} placeholder="e.g. Youth, Worship, Outreach" aria-label="e.g. Youth, Worship, Outreach" className={inputCls} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-ink-700 dark:text-parchment-200 mb-1">Date</label>
                    <input type="date" value={form.date} onChange={field('date')} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-700 dark:text-parchment-200 mb-1">Time</label>
                    <input type="time" value={form.time} onChange={field('time')} className={inputCls} />
                  </div>
                </div>
                {form.liturgical_season && (
                  <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-xs font-medium ${COLOR_TEXT[form.liturgical_color] ?? COLOR_TEXT.White}`}>
                    <Feather size={13} className="shrink-0 opacity-70" />
                    <div className="flex-1">
                      <span className="font-semibold">{form.liturgical_season}</span>
                      {form.feast_name && <span className="ml-1 opacity-75">· {form.feast_name}</span>}
                    </div>
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${COLOR_DOT[form.liturgical_color] ?? LIT_COLOR_DOT_NONE}`} />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-ink-700 dark:text-parchment-200 mb-1">Location</label>
                  <input value={form.location} onChange={field('location')} placeholder="e.g. Main Hall, Room 3" aria-label="e.g. Main Hall, Room 3" className={inputCls} />
                </div>

                {/* Assigned members */}
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-ink-700 dark:text-parchment-200 mb-1.5">
                    <Users size={12} /> Assigned Members
                  </label>
                  {membersFailed && (
                    <p role="status" className="mb-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                      The member list didn't load, so this may be incomplete. It is not a sign that your parish has no members.{' '}
                      <button type="button" onClick={loadMembers} className="underline font-medium">Try again</button>
                    </p>
                  )}
                  <MemberPicker
                    members={members}
                    failed={membersFailed}
                    value={form.member_ids}
                    onChange={(ids) => setForm(f => ({ ...f, member_ids: ids }))}
                  />
                  <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
                    Tasks assigned to these members will auto-sync to this event.
                  </p>
                </div>

                {/* Public toggle — Sprint P. When on, this event appears
                    on the unauthenticated /p/:slug/events page and ICS
                    feed. Off by default. */}
                <div className="rounded-lg border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-100/60 dark:bg-ink-800/40 p-3">
                  <label className="flex items-start justify-between gap-3 cursor-pointer">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
                        Make public
                      </p>
                      <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 mt-0.5 leading-snug">
                        Show on your church's public events page. Members + assignments stay private either way.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!form.is_public}
                      onClick={() => setForm(f => ({ ...f, is_public: !f.is_public }))}
                      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                        form.is_public
                          ? 'bg-church-900 dark:bg-brass-500'
                          : 'bg-parchment-300 dark:bg-ink-700'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                          form.is_public ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </label>
                </div>

                {/* Linked tasks (only when editing) */}
                {editing && (
                  <div className="pt-2 border-t border-parchment-300/60 dark:border-brass-900/30">
                    <div className="flex items-center gap-1.5 mb-2">
                      <Link2 size={13} className="text-church-700 dark:text-brass-300" />
                      <h3 className="text-xs font-semibold text-ink-700 dark:text-parchment-200">Linked Tasks</h3>
                    </div>
                    <LinkedTasks eventId={editing} />
                  </div>
                )}

                {/* Attendance (only when editing) — Sprint T / T.2.
                    Auto-hides when the event has no assigned members. */}
                {editing && <AttendanceSection eventId={editing} />}

                {saveError && (
                  <div className="text-xs text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2">
                    {saveError}
                  </div>
                )}

                <div className="flex justify-end gap-3 pt-2">
                  <AnimatedButton type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-ink-600 dark:text-parchment-300 hover:text-ink-900 dark:hover:text-parchment-50 transition-colors">Cancel</AnimatedButton>
                  <AnimatedButton type="submit" disabled={loading} className="px-5 py-2 bg-church-900 hover:bg-church-700 dark:bg-church-800 dark:hover:bg-church-700 text-parchment-50 text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                    {loading ? 'Saving...' : editing ? 'Save Changes' : 'Add Event'}
                  </AnimatedButton>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Import CSV modal */}
      <AnimatePresence>
        {showImport && (
          <ImportEventsModal
            onClose={() => setShowImport(false)}
            onImported={fetchEvents}
          />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}
