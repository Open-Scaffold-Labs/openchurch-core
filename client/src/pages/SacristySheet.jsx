// Weekly sacristy sheet (MI.2) — the printable "intentions for the week"
// list that sits in the sacristy. Print-first: the in-app chrome is
// hidden by print:* rules (same pattern as the sacramental certificate
// and donor statement), so window.print() / "Save as PDF" yields a clean
// sheet readable at arm's length on the altar.
//
// URL: /mass-intentions/print?start=YYYY-MM-DD
// Data: GET /api/mass-intentions/weekly (ochr_sacristy_weekly_manifest)

import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loader2, Printer, ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { seasonLabel, colorLabel } from '../i18n/liturgical'

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// Parse YYYY-MM-DD as a LOCAL date (new Date('YYYY-MM-DD') is UTC and
// shifts a day in western timezones — the exact bug the shared
// local-date helper killed server-side).
function localDate(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function addDays(s, n) {
  const d = localDate(s)
  d.setDate(d.getDate() + n)
  return iso(d)
}

function fmtTime(t) {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  const am = h < 12
  const hh = h % 12 === 0 ? 12 : h % 12
  return `${hh}:${pad(m)} ${am ? 'AM' : 'PM'}`
}

// The traditional † for the departed — normalize any hand-typed "+"
// (or a bare † without spacing) to a clean "† " prefix so the printed
// sheet always carries the tradition's own notation.
function displayIntention(t) {
  if (!t) return t
  return /^\s*[†+]/.test(t) ? `† ${t.replace(/^\s*[†+]\s*/, '')}` : t
}

export default function SacristySheet() {
  const { user } = useAuth()
  const { t, dateLocale, tradition } = useLocale()
  const churchName = user?.organization?.name || 'Our Parish'
  const [params, setParams] = useSearchParams()

  const start = params.get('start') && /^\d{4}-\d{2}-\d{2}$/.test(params.get('start'))
    ? params.get('start')
    : iso(new Date())
  const end = addDays(start, 6)

  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  // The liturgical week for the sheet header — season and color, taken
  // from the Sunday inside the range (the day that names the week),
  // falling back to the range start. Quietly absent if the fetch fails.
  const [liturgical, setLiturgical] = useState(null)
  useEffect(() => {
    let cancelled = false
    let anchor = start
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i)
      if (localDate(d).getDay() === 0) { anchor = d; break }
    }
    fetch(apiUrl(`/api/liturgical?date=${anchor}`))
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setLiturgical(d) })
      .catch(() => { if (!cancelled) setLiturgical(null) })
    return () => { cancelled = true }
  }, [start])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    fetch(apiUrl(`/api/mass-intentions/weekly?start=${start}&end=${end}`))
      .then(async (r) => {
        if (!r.ok) throw new Error("Couldn't load this week's intentions. Nothing was lost — please retry.")
        return r.json()
      })
      .then((d) => { if (!cancelled) setRows(d.intentions ?? []) })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [start, end])

  // Group by mass_date, preserving the server's date+time ordering.
  const days = useMemo(() => {
    const map = new Map()
    for (const r of rows) {
      if (!map.has(r.mass_date)) map.set(r.mass_date, [])
      map.get(r.mass_date).push(r)
    }
    return [...map.entries()]
  }, [rows])

  const rangeLabel = `${localDate(start).toLocaleDateString(dateLocale, { month: 'long', day: 'numeric' })} – ${localDate(end).toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', year: 'numeric' })}`

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Toolbar — hidden on print */}
      <div className="print:hidden mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link to="/mass-intentions" className="inline-flex items-center gap-1.5 text-sm text-church-700 dark:text-brass-300 hover:underline">
          <ArrowLeft size={15} /> {t('sheet.back')}
        </Link>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setParams({ start: addDays(start, -7) })}
            className="p-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800"
            aria-label="Previous week"
          ><ChevronLeft size={16} /></button>
          <span className="text-sm text-ink-600 dark:text-parchment-300/80 min-w-[13rem] text-center">{rangeLabel}</span>
          <button
            onClick={() => setParams({ start: addDays(start, 7) })}
            className="p-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800"
            aria-label="Next week"
          ><ChevronRight size={16} /></button>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-church-800 text-parchment-50 text-sm font-medium hover:bg-church-900"
          ><Printer size={15} /> {t('sheet.print')}</button>
        </div>
      </div>

      {/* The sheet itself */}
      <div className="bg-white text-ink-900 mx-auto p-8 sm:p-10 shadow-warm-lg print:shadow-none print:p-0">
        <header className="text-center border-b-2 border-brass-600/60 pb-4 mb-6">
          <h1 className="font-display text-3xl font-semibold tracking-wide">{churchName}</h1>
          <p className="mt-1 font-display text-lg text-ink-700 italic">{t('sheet.title')}</p>
          {/* The church year on the sheet — the sacristy should never
              have to check the ordo against its own manifest. */}
          {liturgical?.season && (
            <p className="mt-1 font-display text-base text-ink-700">
              {seasonLabel(t, liturgical.season, { tradition, block: liturgical.ordinary_block })}
              {liturgical.feast_name ? ` · ${liturgical.feast_name}` : ''}
              {liturgical.color ? ` · ${colorLabel(t, liturgical.color)}` : ''}
            </p>
          )}
          <p className="mt-0.5 text-sm text-ink-500">{rangeLabel}</p>
        </header>

        {loading ? (
          <div className="flex justify-center py-16 print:hidden"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
        ) : error ? (
          <p className="text-sm text-rose-700 text-center py-10">{error}</p>
        ) : days.length === 0 ? (
          <p className="text-sm text-ink-500 text-center py-10 italic">{t('sheet.empty')}</p>
        ) : (
          days.map(([date, list]) => (
            <section key={date} className="mb-6 break-inside-avoid">
              <h2 className="font-display text-xl font-semibold border-b border-parchment-300 pb-1 mb-2">
                {localDate(date).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' })}
              </h2>
              <ul>
                {list.map((r) => (
                  <li key={r.id} className="py-2 flex items-baseline justify-between gap-6 border-b border-dotted border-parchment-300/70 last:border-0">
                    <div className="min-w-0">
                      <p className="font-display text-lg leading-snug">{displayIntention(r.formatted_intention)}</p>
                      <p className="text-xs text-ink-500 mt-0.5">
                        {[
                          r.mass_title ? `${r.mass_title}${r.mass_time ? `, ${fmtTime(r.mass_time)}` : ''}` : (r.mass_time ? fmtTime(r.mass_time) : null),
                          (r.requester_name || r.requested_by) ? `${t('sheet.requestedBy')} ${r.requester_name || r.requested_by}` : null,
                        ].filter(Boolean).join(' · ') || ' '}
                      </p>
                    </div>
                    <div className="text-right shrink-0 text-xs text-ink-500">
                      {r.stipend != null && <p>${Number(r.stipend).toFixed(2)}</p>}
                      {r.status === 'fulfilled' && <p className="italic">{t('sheet.fulfilled')}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

        <footer className="mt-8 pt-3 border-t border-parchment-300 text-center text-[11px] text-ink-400 print:text-ink-500">
          {t('sheet.printed')} {new Date().toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', year: 'numeric' })} · OpenChurch
        </footer>
      </div>
    </div>
  )
}
