import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CalendarClock, ChevronRight } from 'lucide-react'
import { useLocale } from '../i18n'

// Next on the Calendar — compact upcoming-events widget for the
// Dashboard's top-right slot. Took over that slot from the Liturgical
// widget once the fuller Liturgical Day Detail panel landed under the
// greeting (the widget had become a smaller copy of the same data).
//
// Prop-driven, NOT self-fetching: the Dashboard loads the calendar
// (/api/calendar, the Schedule's services and events) from today forward
// and passes it in. Renders nothing until that array has arrived
// (events == null), same defensive pattern as the other Dashboard widgets
// so the layout never jumps. A refused read (`failed`) says it did not
// load; it never reads as "Nothing scheduled yet." (SP-059)

// Parse a YYYY-MM-DD into a month-abbrev + day, built from the date
// parts directly so there's no UTC/local off-by-one on the day number.
function monthDay(dateStr, dateLocale) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  return {
    month: dt.toLocaleDateString(dateLocale, { month: 'short' }),
    day:   d || dt.getDate(),
  }
}

// 'HH:MM:SS' (Postgres TIME) → '6:00 PM'. Null when there's no time.
function fmtTime(hms) {
  if (!hms) return null
  const [h, m] = String(hms).split(':').map(Number)
  if (Number.isNaN(h)) return null
  const d = new Date(2000, 0, 1, h, m || 0)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function NextOnCalendar({ events, failed = false }) {
  const { t, dateLocale } = useLocale()
  // Upcoming = dated today or later, soonest first, capped at 3.
  // String comparison on YYYY-MM-DD is correct and timezone-proof.
  const upcoming = useMemo(() => {
    if (!Array.isArray(events)) return []
    const today = todayStr()
    return events
      .filter(e => e.date && String(e.date).slice(0, 10) >= today)
      .sort((a, b) => {
        const ad = String(a.date).slice(0, 10)
        const bd = String(b.date).slice(0, 10)
        if (ad !== bd) return ad < bd ? -1 : 1
        return (a.start_time ?? a.time ?? '').localeCompare(b.start_time ?? b.time ?? '')
      })
      .slice(0, 3)
  }, [events])

  // Not loaded yet — render nothing so the slot doesn't flash an
  // empty state before /api/events resolves.
  if (events == null && !failed) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-sm p-4"
    >
      {/* Eyebrow */}
      <div className="flex items-center gap-2 mb-3">
        <CalendarClock size={13} className="text-brass-600 dark:text-brass-300" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">
          {t('noc.title')}
        </span>
      </div>

      {failed ? (
        <p role="alert" className="text-sm text-ink-500 dark:text-parchment-300/70 py-1">
          {t('noc.unread')}
        </p>
      ) : upcoming.length === 0 ? (
        <p className="text-sm text-ink-500 dark:text-parchment-300/70 py-1">
          {t('noc.empty')}
        </p>
      ) : (
        <ul className="space-y-2.5">
          {upcoming.map(e => {
            const { month, day } = monthDay(e.date, dateLocale)
            const time = fmtTime(e.start_time ?? e.time)
            const sub  = [time, e.service_division || e.location].filter(Boolean).join(' · ')
            return (
              <li key={e.id} className="flex items-center gap-3">
                {/* Date badge */}
                <div className="shrink-0 w-11 text-center rounded-lg bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 py-1">
                  <p className="text-[9px] font-bold uppercase tracking-wide text-brass-700 dark:text-brass-300 leading-none">
                    {month}
                  </p>
                  <p className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50 leading-tight">
                    {day}
                  </p>
                </div>
                {/* Title + meta */}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">
                    {e.title}
                  </p>
                  {sub && (
                    <p className="text-xs text-ink-500 dark:text-parchment-300/70 truncate mt-0.5">
                      {sub}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* Footer link — into the full Schedule. */}
      <Link
        to="/schedule"
        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-church-700 dark:text-brass-300 hover:text-church-900 dark:hover:text-brass-200 transition-colors"
      >
        {t('noc.open')} <ChevronRight size={12} />
      </Link>
    </motion.div>
  )
}
