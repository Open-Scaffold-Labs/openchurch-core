import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Calendar, MapPin, Clock, Loader2, AlertTriangle, ExternalLink } from 'lucide-react'
import { apiUrl } from '../api'
import { LIT_COLOR_DOT, LIT_COLOR_TEXT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { useLocale } from '../i18n'

// Parishioner-facing public events page (Sprint P / P.2). Unauthenticated —
// anyone with the URL sees the church's public events. The route is
// outside the app shell (no sidebar / no auth) so the page reads as a
// church bulletin, not a SaaS dashboard.
//
// URL shape: /p/:slug/events
// Data sources:
//   GET /api/public/:slug          → org name + counts
//   GET /api/public/:slug/events   → upcoming public events
//
// Subscribe-to-calendar button uses webcal:// so calendar apps pick
// it up natively. Falls back to http:// for browsers that don't
// support the webcal scheme — they'll see a download prompt instead
// of a subscribe handoff.

function fmtDate(iso) {
  if (!iso) return null
  const [y, m, d] = iso.split('T')[0].split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  })
}

function fmtTime(hms) {
  if (!hms) return null
  const [h, m] = String(hms).split(':').map(Number)
  const date = new Date(2000, 0, 1, h, m)
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// Group events by date so the page reads like a printed bulletin —
// one date heading, all events for that day stacked below.
function groupByDate(events) {
  const groups = []
  const indexByDate = new Map()
  for (const ev of events) {
    const key = ev.date?.slice(0, 10) ?? 'tbd'
    if (!indexByDate.has(key)) {
      const group = { date: key, items: [] }
      groups.push(group)
      indexByDate.set(key, group)
    }
    indexByDate.get(key).items.push(ev)
  }
  return groups
}

export default function PublicEvents() {
  const { setPublicLocale } = useLocale()
  const { slug } = useParams()
  const [data, setData]     = useState(null)
  const [loading, setLoad]  = useState(true)
  const [err, setErr]       = useState('')

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    fetch(apiUrl(`/api/public/${slug}/events`))
      .then(r => {
        if (r.status === 404) throw new Error('not-found')
        if (!r.ok) throw new Error(`Failed (${r.status})`)
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        // The parish's language, from the endpoint — nobody is signed in here.
        setPublicLocale(d.church?.locale)
        setData(d)
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [slug])

  const icsHttpUrl = `${window.location.origin}/api/public/${slug}/events.ics`
  // webcal:// triggers the OS calendar app on most platforms. Strip
  // the scheme from the http URL and prefix with webcal://.
  const webcalUrl  = icsHttpUrl.replace(/^https?:\/\//, 'webcal://')

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-parchment-50 dark:bg-ink-950">
        <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
      </div>
    )
  }

  if (err === 'not-found') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-parchment-50 dark:bg-ink-950">
        <div className="text-center max-w-md">
          <AlertTriangle size={28} className="mx-auto text-amber-600 dark:text-amber-300 mb-3" />
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            Church not found
          </h1>
          <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70">
            We couldn't find a church at <span className="font-mono">/{slug}</span>. Double-check the link from your bulletin.
          </p>
        </div>
      </div>
    )
  }

  if (err || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-parchment-50 dark:bg-ink-950">
        <div className="text-center max-w-md">
          <AlertTriangle size={28} className="mx-auto text-rose-700 dark:text-rose-300 mb-3" />
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            Couldn't load events
          </h1>
          <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70">{err}</p>
        </div>
      </div>
    )
  }

  const groups = groupByDate(data.events)

  return (
    <div className="min-h-screen bg-parchment-50 dark:bg-ink-950 px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
        className="w-full max-w-2xl mx-auto"
      >
        {/* Brand mark — same one used on auth pages, gives parishioners
            a quiet 'powered by OpenChurch' confidence cue without
            screaming SaaS. */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-church-900 dark:bg-brass-200 flex items-center justify-center shadow-warm">
            <svg width="16" height="20" viewBox="0 0 14 18" fill="currentColor" className="text-brass-200 dark:text-church-900">
              <rect x="5.5" y="0" width="3" height="18" rx="1" />
              <rect x="0" y="4" width="14" height="3" rx="1" />
            </svg>
          </div>
        </div>

        {/* Church header */}
        <div className="text-center mb-10">
          <h1 className="font-display text-4xl md:text-5xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
            {data.church.name}
          </h1>
          <p className="mt-3 text-sm md:text-base text-ink-500 dark:text-parchment-300/70">
            Upcoming events
          </p>
        </div>

        {/* Subscribe CTA — webcal subscribe link + plain download */}
        {data.events.length > 0 && (
          <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 mb-8 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
                Add to your calendar
              </p>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
                Sync with Apple Calendar, Google Calendar, or Outlook.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href={webcalUrl}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
              >
                Subscribe
              </a>
              <a
                href={icsHttpUrl}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 text-sm font-semibold hover:bg-parchment-200/60 dark:hover:bg-ink-800/70 transition-colors"
              >
                <ExternalLink size={13} /> .ics
              </a>
            </div>
          </div>
        )}

        {/* Events list grouped by date */}
        {data.events.length === 0 ? (
          <div className="text-center py-16">
            <Calendar size={28} className="mx-auto text-brass-600 dark:text-brass-300 mb-4 opacity-60" />
            <p className="text-sm text-ink-500 dark:text-parchment-300/70">
              No upcoming public events scheduled.
            </p>
            <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-1">
              Check back soon, or contact the church for the latest schedule.
            </p>
          </div>
        ) : (
          <ul className="space-y-8">
            {groups.map(group => (
              <li key={group.date}>
                <h2 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50 mb-3">
                  {fmtDate(group.date)}
                </h2>
                <ul className="space-y-3">
                  {group.items.map(ev => (
                    <li
                      key={ev.id}
                      className={`bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 ${ev.liturgical_color ? `border-l-4 ${LIT_COLOR_TEXT[ev.liturgical_color]?.match(/border-[\w-]+/)?.[0] ?? ''}` : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <h3 className="font-display text-xl font-semibold text-ink-900 dark:text-parchment-50">
                            {ev.title}
                          </h3>
                          {ev.service_division && (
                            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-0.5">
                              {ev.service_division}
                            </p>
                          )}
                        </div>
                        {ev.liturgical_season && (
                          <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-md border shrink-0 ${LIT_COLOR_TEXT[ev.liturgical_color] ?? LIT_COLOR_TEXT.White}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${LIT_COLOR_DOT[ev.liturgical_color] ?? LIT_COLOR_DOT_NONE}`} />
                            {ev.feast_name || ev.liturgical_season}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-sm text-ink-600 dark:text-parchment-200">
                        {ev.time && (
                          <span className="inline-flex items-center gap-1.5">
                            <Clock size={13} className="text-ink-400 dark:text-parchment-400/60" />
                            {fmtTime(ev.time)}
                          </span>
                        )}
                        {ev.location && (
                          <span className="inline-flex items-center gap-1.5">
                            <MapPin size={13} className="text-ink-400 dark:text-parchment-400/60" />
                            {ev.location}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        {/* Footer attribution — quiet */}
        <p className="mt-12 text-center text-[11px] text-ink-500 dark:text-parchment-300/70">
          Powered by OpenChurch
        </p>
      </motion.div>
    </div>
  )
}
