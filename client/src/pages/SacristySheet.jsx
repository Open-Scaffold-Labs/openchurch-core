// Weekly sacristy sheet (MI.2) — the printable "intentions for the week"
// list that sits in the sacristy. Print-first: the in-app chrome is
// hidden by print:* rules (same pattern as the sacramental certificate
// and donor statement), so window.print() / "Save as PDF" yields a clean
// sheet readable at arm's length on the altar.
//
// Print ≠ emailed (OC-READY-01-021 / STMT-01): screen chrome says this is
// print/PDF only. The paper footer is a generation stamp — when this
// sheet was built, which week it covers, and how many intentions are
// on it. It does not claim the sheet was printed, issued, emailed, or
// archived. A later reprint is a new generation.
//
// URL: /mass-intentions/print?start=YYYY-MM-DD
// Data: GET /api/mass-intentions/weekly (ochr_sacristy_weekly_manifest)
//
// The sheet is Saturday through Friday. A Sunday-to-Saturday window
// cannot hold a Saturday vigil and the Sunday it serves: Saturday is
// the last day, and that Sunday opens the next window. With no ?start,
// the window is the coming Sunday's weekend (Monday–Saturday look
// forward; Sunday stays on the weekend underway), opened on the vigil
// Saturday, using the parish's civil today. An explicit ?start stays
// a literal 7-day window. The week arrows move that window by 7 days.

import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loader2, Printer, ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { seasonLabel, colorLabel } from '../i18n/liturgical'
import { priorFulfilmentText } from '../utils/priorFulfilment'
import { canonicalIsoDate, orgTodayIso, sheetWeekEnd, sheetWeekStart, vigilWeekStart } from '../../../server/src/utils/sheetWeek.js'

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// Parse YYYY-MM-DD as a LOCAL date (new Date('YYYY-MM-DD') is UTC and
// shifts a day in western timezones — the exact bug the shared
// local-date helper killed server-side).
function localDate(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// As-offered date groups the sheet. Fulfilled rows with NULL stamps have
// no offered date — unknown, not empty. Never hand null to localDate.
export function groupSheetIntentions(rows) {
  const dated = new Map()
  const unknown = []
  for (const r of rows ?? []) {
    if (r.mass_date == null || r.mass_date === '') unknown.push(r)
    else {
      if (!dated.has(r.mass_date)) dated.set(r.mass_date, [])
      dated.get(r.mass_date).push(r)
    }
  }
  const days = [...dated.entries()]
  if (unknown.length) days.push([null, unknown])
  return days
}

function addDays(s, n) {
  const d = localDate(s)
  d.setDate(d.getDate() + n)
  return iso(d)
}

// Sunday that names the liturgical week containing `input`.
// The printed sheet no longer opens on this Sunday — see vigilWeekStart.
// Kept for callers that still need the Sunday itself.
export function sundayStartOf(input) {
  const d = input instanceof Date
    ? new Date(input.getFullYear(), input.getMonth(), input.getDate())
    : localDate(String(input).slice(0, 10))
  d.setDate(d.getDate() - d.getDay())
  return iso(d)
}

// Listing date for the week window — same rule as week_date on the
// sacristy view: the book's mass_date (fulfilled stamp, else working date).
export function listingDate(row) {
  const raw = row?.mass_date
  if (raw == null || raw === '') return null
  const s = String(raw).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

// Closest dated, non-cancelled book row outside [start, end]. Undated
// rows have no week to jump to; cancelled rows are not on the sheet.
export function nearestOutOfWindowDate(bookRows, start, end) {
  if (!start || !end) return null
  let best = null
  let bestDist = Infinity
  const mid = Date.parse(`${start}T00:00:00`)
  for (const row of bookRows ?? []) {
    if (row?.status === 'cancelled') continue
    const date = listingDate(row)
    if (!date) continue
    if (date >= start && date <= end) continue
    const dist = Math.abs(Date.parse(`${date}T00:00:00`) - mid)
    if (dist < bestDist || (dist === bestDist && date < best)) {
      best = date
      bestDist = dist
    }
  }
  return best
}

// Mass clock on the sheet follows the active language — hard-coded
// AM/PM printed English on a Spanish week (GJ1-L2-05).
export function fmtTime(t, dateLocale) {
  if (!t) return null
  const [h, m] = String(t).split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(dateLocale || 'en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

// IANA zone for the generation stamp. A missing or unknown zone is
// labeled UTC — the column default — never the browser's zone.
export function resolvedSheetTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return 'UTC'
  const zone = timeZone.trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return 'UTC'
  }
}

// Date, clock, and short zone name for one instant, in the parish zone
// and the active language (LOCALE-L1-12). The clock is not hard-coded
// English AM/PM.
export function generationClock(instant, timeZone, dateLocale) {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(date.getTime())) return null
  const zone = resolvedSheetTimeZone(timeZone)
  const locale = dateLocale || 'en-US'
  const dateLabel = date.toLocaleDateString(locale, {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: zone,
  })
  const timeLabel = date.toLocaleTimeString(locale, {
    hour: 'numeric', minute: '2-digit', timeZone: zone,
  })
  const tz = new Intl.DateTimeFormat(locale, {
    timeZone: zone, timeZoneName: 'short',
  }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || zone
  return { date: dateLabel, time: timeLabel, tz }
}

// Offering on the printed sheet. Accept the database's plain decimal
// shape, plus finite nonnegative numeric fixtures, without coercing a
// malformed value into plausible money. Missing or blank stays off the line;
// an unreadable value shows a dash rather than inventing zero or `$NaN`.
export function fmtSheetStipend(v) {
  if (v == null || v === '') return null
  if (typeof v === 'string' && v.trim() === '') return null
  // NUMERIC(10,2) comes from node-pg as a plain decimal string. Refuse
  // coercions such as true, [], whitespace-padded, negative or exponent
  // strings: none is an honest offering to print as currency.
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(v))) return '—'
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 99999999.99) return '—'
  return `$${n.toFixed(2)}`
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

  const requested = params.get('start')
  // Shape alone is not a day: 2026-02-31, 2026-13-01, and 0050-01-01 match
  // YYYY-MM-DD and then sheetWeekEnd returns null. A real day can still
  // be unrepresentable as a week: 9999-12-26 through 9999-12-31 end in
  // year 10000, which is not a 4-digit civil date, so sheetWeekEnd
  // returns null and localDate would throw. Either case is the same as
  // leaving ?start off.
  const canonicalStart = canonicalIsoDate(requested)
  const requestedEnd = canonicalStart ? sheetWeekEnd(canonicalStart) : null
  const ignoredStart = Boolean(requested) && !requestedEnd
  const start = requestedEnd
    ? canonicalStart
    : vigilWeekStart(orgTodayIso(new Date(), user?.organization?.timezone))
  const end = sheetWeekEnd(start)
  const canStepWeek = (delta) => {
    const next = addDays(start, delta)
    return Boolean(canonicalIsoDate(next) && sheetWeekEnd(next))
  }

  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  // Request-time facts for the generation stamp. Cleared while a new
  // week is loading so the previous count cannot sit under a spinner.
  const [generatedAt, setGeneratedAt] = useState(null)
  const [orgTimeZone, setOrgTimeZone] = useState(null)
  // The stamp counts the week, not only the rows that fit under the cap.
  const [intentionTotal, setIntentionTotal] = useState(null)
  const [truncated, setTruncated] = useState(false)
  // Book peek only when this week is empty — never rendered as sheet rows.
  // 'failed' stays unknown: we do not invent "the book is empty."
  const [bookPeek, setBookPeek] = useState('idle')
  const [outsideDate, setOutsideDate] = useState(null)
  const [undatedWaiting, setUndatedWaiting] = useState(false)

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
    setGeneratedAt(null); setOrgTimeZone(null)
    setIntentionTotal(null); setTruncated(false)
    fetch(apiUrl(`/api/mass-intentions/weekly?start=${start}&end=${end}`))
      .then(async (r) => {
        if (!r.ok) throw new Error('weekly')
        const d = await r.json()
        // A 200 without an intentions array is unread. `?? []` painted
        // "No intentions are scheduled" and offered Print.
        if (!d || !Array.isArray(d.intentions)) throw new Error('weekly')
        return d
      })
      .then((d) => {
        if (cancelled) return
        const when = typeof d.generated_at === 'string' && !Number.isNaN(new Date(d.generated_at).getTime())
          ? d.generated_at
          : new Date().toISOString()
        const zone = typeof d.timezone === 'string' && d.timezone.trim() ? d.timezone.trim() : 'UTC'
        const total = Number(d.intention_total)
        setRows(d.intentions)
        setGeneratedAt(when)
        setOrgTimeZone(zone)
        setIntentionTotal(Number.isFinite(total) ? total : null)
        setTruncated(d.truncated === true)
      })
      .catch(() => { if (!cancelled) setError(t('sheet.loadFailed')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [start, end, t])

  // Group by as-offered mass_date. Unknown-stamp fulfilled rows stay
  // visible under sheet.massUnknown — they are not omitted.
  const days = useMemo(() => groupSheetIntentions(rows), [rows])

  useEffect(() => {
    if (loading || error || days.length > 0) {
      setBookPeek('idle')
      setOutsideDate(null)
      setUndatedWaiting(false)
      return
    }
    let cancelled = false
    setBookPeek('loading')
    setOutsideDate(null)
    setUndatedWaiting(false)
    fetch(apiUrl(`/api/mass-intentions/nearest-outside?start=${start}&end=${end}`))
      .then(async (r) => {
        if (!r.ok) throw new Error("Couldn't check the rest of the book.")
        return r.json()
      })
      .then((d) => {
        if (cancelled) return
        const date = typeof d?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null
        const count = Number(d?.undated_waiting_count)
        const waiting = d?.undated_waiting === true || (Number.isFinite(count) && count > 0)
        setOutsideDate(date)
        setUndatedWaiting(waiting)
        setBookPeek('ok')
      })
      .catch(() => {
        if (!cancelled) {
          setOutsideDate(null)
          setUndatedWaiting(false)
          setBookPeek('failed')
        }
      })
    return () => { cancelled = true }
  }, [loading, error, days.length, start, end])

  const rangeLabel = `${localDate(start).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' })} – ${localDate(end).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`
  const clock = !loading && !error && generatedAt
    ? generationClock(generatedAt, orgTimeZone, dateLocale)
    : null
  const countCutOff = truncated && intentionTotal != null && intentionTotal > rows.length
  const intentionCount = countCutOff
    ? t('sheet.intentionCountTruncated', { shown: rows.length, n: intentionTotal })
    : rows.length === 1
      ? t('sheet.intentionCount_one')
      : t('sheet.intentionCount', { n: rows.length })

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Toolbar — hidden on print */}
      <div className="print:hidden mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link to="/mass-intentions" className="inline-flex items-center gap-1.5 text-sm text-church-700 dark:text-brass-300 hover:underline">
          <ArrowLeft size={15} /> {t('sheet.back')}
        </Link>
        {/* Phone 390: a non-wrapping row + min-w-[13rem] overflowed the
            content column (~326px after main p-4 + page px-4) and clipped
            Print to "Pri…". Wrap the cluster; let the range shrink; never
            shrink Print. sm: keeps the desktop week label's 13rem floor. */}
        <div data-testid="sheet-week-chrome" className="flex flex-wrap items-center justify-end gap-2 min-w-0 max-w-full">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => { if (canStepWeek(-7)) setParams({ start: addDays(start, -7) }) }}
              disabled={!canStepWeek(-7)}
              className="shrink-0 p-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800 disabled:opacity-40"
              aria-label={t('sheet.prevWeek')}
            ><ChevronLeft size={16} /></button>
            <span data-testid="sheet-week-range" className="text-sm text-ink-600 dark:text-parchment-300/80 min-w-0 sm:min-w-[13rem] text-center">{rangeLabel}</span>
            <button
              onClick={() => { if (canStepWeek(7)) setParams({ start: addDays(start, 7) }) }}
              disabled={!canStepWeek(7)}
              className="shrink-0 p-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800 disabled:opacity-40"
              aria-label={t('sheet.nextWeek')}
            ><ChevronRight size={16} /></button>
          </div>
          {!error && !loading && (
            <button
              onClick={() => window.print()}
              className="inline-flex shrink-0 items-center gap-2 px-3.5 py-2 rounded-lg bg-church-800 text-parchment-50 text-sm font-medium hover:bg-church-900"
            ><Printer size={15} /> {t('sheet.print')}</button>
          )}
        </div>
        {/* Print ≠ emailed (OC-READY-01-021 / STMT-01 pattern). Screen
            chrome only — the paper carries a generation stamp. */}
        <p data-testid="sheet-print-not-emailed" className="w-full text-sm text-ink-500 dark:text-parchment-300/70 print:hidden">
          {t('sheet.printHonesty')}
        </p>
        {ignoredStart && (
          <p data-testid="sheet-ignored-start" className="w-full text-sm text-ink-500 dark:text-parchment-300/70 print:hidden">
            {t('sheet.ignoredStart')}
          </p>
        )}
      </div>

      {/* The sheet itself */}
      <div
        data-testid="sheet-paper"
        className={`bg-white text-ink-900 mx-auto p-8 sm:p-10 shadow-warm-lg print:shadow-none print:p-0${error || loading ? ' print:hidden' : ''}`}
      >
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
          <p data-testid="sheet-load-failed" className="text-sm text-rose-700 text-center py-10 print:hidden">{error}</p>
        ) : days.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-ink-500 italic">{t('sheet.empty', { range: rangeLabel })}</p>
            {bookPeek === 'ok' && outsideDate && (
              <div className="print:hidden mt-3">
                <p className="text-sm text-ink-600">{t('sheet.emptyOutside')}</p>
                <button
                  type="button"
                  onClick={() => setParams({ start: sheetWeekStart(outsideDate) })}
                  className="mt-2 text-sm font-medium text-church-700 dark:text-brass-300 hover:underline"
                >
                  {t('sheet.showWeek', {
                    date: localDate(outsideDate).toLocaleDateString(dateLocale, {
                      month: 'long', day: 'numeric', year: 'numeric',
                    }),
                  })}
                </button>
              </div>
            )}
            {bookPeek === 'ok' && undatedWaiting && (
              <div className="print:hidden mt-3">
                <p className="text-sm text-ink-600">{t('sheet.emptyUndated')}</p>
                <Link
                  to="/mass-intentions"
                  className="mt-2 inline-block text-sm font-medium text-church-700 dark:text-brass-300 hover:underline"
                >
                  {t('sheet.openBook')}
                </Link>
              </div>
            )}
          </div>
        ) : (
          days.map(([date, list]) => (
            <section key={date ?? 'unknown-mass'} className="mb-6 break-inside-avoid">
              <h2 className="font-display text-xl font-semibold border-b border-parchment-300 pb-1 mb-2">
                {date == null
                  ? t('sheet.massUnknown')
                  : localDate(date).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' })}
              </h2>
              <ul>
                {list.map((r) => {
                  const stipendLabel = fmtSheetStipend(r.stipend)
                  return (
                    <li key={r.id} className="py-2 flex items-baseline justify-between gap-6 border-b border-dotted border-parchment-300/70 last:border-0">
                      <div className="min-w-0">
                        <p className="font-display text-lg leading-snug">{displayIntention(r.formatted_intention)}</p>
                        <p className="text-xs text-ink-500 mt-0.5">
                          {[
                            r.status === 'fulfilled' && !r.mass_title && !r.mass_time
                              ? t('sheet.massUnknown')
                              : (r.mass_title ? `${r.mass_title}${r.mass_time ? `, ${fmtTime(r.mass_time, dateLocale)}` : ''}` : (r.mass_time ? fmtTime(r.mass_time, dateLocale) : null)),
                            (r.requester_name || r.requested_by) ? `${t('sheet.requestedBy')} ${r.requester_name || r.requested_by}` : null,
                          ].filter(Boolean).join(' · ') || ' '}
                        </p>
                      </div>
                      <div className="text-right shrink-0 text-xs text-ink-500">
                        {stipendLabel && <p data-testid="sheet-stipend">{stipendLabel}</p>}
                        {/* SP-066: the status word used to inherit this column's
                            ink-500. Name a darker ink on screen and in print so
                            the same word, in the same place, clears WCAG AA on
                            the white sheet. */}
                        {r.status === 'fulfilled' && (
                          <p data-testid="sheet-fulfilled" className="italic text-ink-800 print:text-ink-900">{t('sheet.fulfilled')}</p>
                        )}
                        {priorFulfilmentText(t, r, 'sheet.previouslyRecorded') && (
                          <p className="italic">{priorFulfilmentText(t, r, 'sheet.previouslyRecorded')}</p>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}

        {clock && (
          <footer
            data-testid="sheet-generation-stamp"
            className="mt-8 pt-3 border-t border-parchment-300 text-center text-[11px] text-ink-400 print:text-ink-500"
          >
            {t('sheet.generated', clock)} · {rangeLabel} · {intentionCount} · OpenChurch
          </footer>
        )}
      </div>
    </div>
  )
}
