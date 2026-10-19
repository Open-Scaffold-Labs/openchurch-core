import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Loader2, CheckCircle2, Calendar } from 'lucide-react'
import { apiUrl } from '../api'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useLocale } from '../i18n'
import { formatStoredDate, parseStoredDate } from '../utils/dates'

// VS.3 — multi-week schedule conflict view (admin-only).
// Reads /api/calendar/conflicts/scan?weeks=N and lists every same-
// member double-booking grouped by week. Read-only — the "fix it"
// affordance is a link back to /schedule for the affected day.
//
// Primary chrome is conflicts.* in both locales: page title, lead,
// week-range actions, empty state, the known scan-failure banner,
// the count line, each week heading, and "View in Schedule".
// Residual holds, still English: en-US dates, am/pm, and the row
// phrase "— double-booked". Any other API error string is shown
// as the server sent it. Schedule.jsx is out of scope.

const WEEK_OPTIONS = [2, 4, 8, 12]
// API contract for the 500 body. Compared, not rendered — the banner
// uses conflicts.scanFailed so the sentence can follow the locale.
const SCAN_FAILED = 'Failed to scan conflicts'

// ochr_calendar_events.date is a civil day. new Date(iso) reads it as
// UTC midnight, so a Monday renders as Sunday in the US.
export function fmtDate(iso) {
  if (!iso) return ''
  return formatStoredDate(String(iso), { weekday: 'short', month: 'short', day: 'numeric' })
}

function fmtTime(hms) {
  if (!hms) return ''
  const [h, m] = hms.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`
}

// Monday of the civil week containing a stored DATE. The weekday is the
// UTC weekday of the YYYY-MM-DD parts, so the process timezone cannot
// move Monday. A Monday stays in its own week; a Sunday belongs to the
// Monday six days earlier.
export function weekStartOf(iso) {
  const day = parseStoredDate(iso == null ? '' : String(iso))
  if (!day) return ''
  const weekday = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())).getUTCDay()
  const delta = weekday === 0 ? 6 : weekday - 1
  const start = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate() - delta))
  const month = String(start.getUTCMonth() + 1).padStart(2, '0')
  const date = String(start.getUTCDate()).padStart(2, '0')
  return `${start.getUTCFullYear()}-${month}-${date}`
}

export function weekDate(iso) {
  if (!iso) return ''
  return formatStoredDate(String(iso), { month: 'short', day: 'numeric' })
}

function lead(t, weeks) {
  return t(weeks === 1 ? 'conflicts.leadOne' : 'conflicts.leadMany', { n: weeks })
}

function summaryLine(t, conflicts, weeks) {
  if (conflicts === 1 && weeks === 1) return t('conflicts.summary11')
  if (conflicts === 1) return t('conflicts.summary1N', { weeks })
  if (weeks === 1) return t('conflicts.summaryN1', { conflicts })
  return t('conflicts.summaryNN', { conflicts, weeks })
}

function weekHeading(t, date, count) {
  return t(count === 1 ? 'conflicts.weekOfOne' : 'conflicts.weekOfMany', { date, n: count })
}

export default function ScheduleConflicts() {
  const { t } = useLocale()
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
          const message = j.error === SCAN_FAILED
            ? t('conflicts.scanFailed')
            : (j.error || t('conflicts.scanFailedStatus', { status: r.status }))
          throw new Error(message)
        }
        return r.json()
      })
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [weeks, t])

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
              {t('conflicts.title')}
            </h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
              {lead(t, weeks)}
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
                aria-label={t('conflicts.scanAria', { n })}
              >
                {t('conflicts.weekChip', { n })}
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
            title={t('conflicts.emptyTitle')}
            body={t('conflicts.emptyBody', { n: weeks })}
          />
        )}

        {!loading && !error && data && data.conflicts.length > 0 && (
          <div className="space-y-4">
            <p className="text-xs text-ink-500 dark:text-parchment-300/70">
              {summaryLine(t, data.conflicts.length, weekKeys.length)}
            </p>

            {weekKeys.map(weekKey => {
              const list = byWeek.get(weekKey)
              return (
                <section key={weekKey} className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
                  <div className="px-5 py-3 border-b border-parchment-200/60 dark:border-brass-900/20 bg-parchment-100/60 dark:bg-ink-800/40">
                    <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
                      {weekHeading(t, weekDate(weekKey), list.length)}
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
                              {t('conflicts.viewInSchedule')}
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
