import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Loader2, CheckCircle2, Calendar } from 'lucide-react'
import { apiUrl } from '../api'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { toLocalISO } from '../utils/dates'

// VS.3 — multi-week schedule conflict view (admin-only).
// Reads /api/calendar/conflicts/scan?weeks=N and lists every same-
// member double-booking grouped by week. Read-only — the "fix it"
// affordance is a link back to /schedule for the affected day.

const WEEK_OPTIONS = [2, 4, 8, 12]

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function fmtTime(hms) {
  if (!hms) return ''
  const [h, m] = hms.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`
}

// Monday-of for the calendar week containing a date string.
function weekStartOf(iso) {
  const d = new Date(iso)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  // Local calendar day — toISOString() here would shift to the UTC day and
  // misgroup events near midnight for far-from-UTC timezones.
  return toLocalISO(d)
}

function weekLabel(iso) {
  const d = new Date(iso)
  return `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

export default function ScheduleConflicts() {
  const [weeks,   setWeeks]   = useState(4)
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    fetch(apiUrl(`/api/calendar/conflicts/scan?weeks=${weeks}`))
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error || `Scan failed (${r.status})`)
        }
        return r.json()
      })
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [weeks])

  // Group conflicts by week-of-Monday so the list reads as a planner.
  const byWeek = new Map()
  if (data?.conflicts) {
    for (const c of data.conflicts) {
      const key = weekStartOf(c.date)
      if (!byWeek.has(key)) byWeek.set(key, [])
      byWeek.get(key).push(c)
    }
  }
  const weekKeys = Array.from(byWeek.keys()).sort()

  return (
    <PageWrapper>
      <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-display text-ink-900 dark:text-parchment-50">
              Schedule conflicts
            </h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
              Same member on two overlapping events. Scanning the next {weeks} week{weeks === 1 ? '' : 's'}.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {WEEK_OPTIONS.map(n => (
              <button
                key={n}
                type="button"
                onClick={() => setWeeks(n)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors ${
                  weeks === n
                    ? 'bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900'
                    : 'text-ink-500 dark:text-parchment-300/70 hover:bg-parchment-200/60 dark:hover:bg-ink-800/60'
                }`}
                aria-label={`Scan ${n} weeks`}
              >
                {n}w
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="animate-spin text-brass-600" size={28} />
          </div>
        )}

        {!loading && error && (
          <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-200/60 dark:border-rose-800/40 rounded-2xl p-4">
            <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>
          </div>
        )}

        {!loading && !error && data && data.conflicts.length === 0 && (
          <EmptyState
            icon={CheckCircle2}
            title="No conflicts"
            body={`Every scheduled slot for the next ${weeks} weeks is clear — no member is double-booked.`}
          />
        )}

        {!loading && !error && data && data.conflicts.length > 0 && (
          <div className="space-y-4">
            <p className="text-xs text-ink-500 dark:text-parchment-300/70">
              {data.conflicts.length} conflict{data.conflicts.length === 1 ? '' : 's'} across {weekKeys.length} week{weekKeys.length === 1 ? '' : 's'}.
            </p>

            {weekKeys.map(weekKey => {
              const list = byWeek.get(weekKey)
              return (
                <section key={weekKey} className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
                  <div className="px-5 py-3 border-b border-parchment-200/60 dark:border-brass-900/20 bg-parchment-100/60 dark:bg-ink-800/40">
                    <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
                      {weekLabel(weekKey)} · {list.length} conflict{list.length === 1 ? '' : 's'}
                    </h2>
                  </div>
                  <ul className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
                    {list.map((c, i) => (
                      <li key={`${weekKey}-${i}`} className="p-4">
                        <div className="flex items-start gap-2.5">
                          <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs text-ink-500 dark:text-parchment-300/70">{fmtDate(c.date)}</p>
                            <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 mt-0.5">
                              {c.members.map(m => m.name).join(', ')}
                              <span className="font-normal text-ink-500 dark:text-parchment-300/70">
                                {' '}— double-booked
                              </span>
                            </p>
                            <ul className="mt-2 space-y-1">
                              {c.events.map(e => (
                                <li key={e.id} className="text-xs text-ink-700 dark:text-parchment-200">
                                  <span className="font-semibold">{e.title}</span>
                                  <span className="text-ink-500 dark:text-parchment-300/70">
                                    {' '}({fmtTime(e.start_time)}–{fmtTime(e.end_time)})
                                  </span>
                                </li>
                              ))}
                            </ul>
                            <Link
                              to="/schedule"
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-church-900 dark:text-parchment-200 hover:underline mt-2"
                            >
                              <Calendar size={11} />
                              View in Schedule
                            </Link>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </PageWrapper>
  )
}
