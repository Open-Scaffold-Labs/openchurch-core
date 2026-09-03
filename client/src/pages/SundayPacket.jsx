// The Sunday Packet (SPK.1) — "the Thursday Button."
//
// One printable sheet that replaces the Thursday-afternoon assembly job:
// liturgical day + lectionary designation, the order of worship with
// assignments, the serving schedule, the week's Mass intentions, and the
// bulletin announcements — compiled by the server (GET /api/packet),
// never copy-pasted. Print-first, same chrome-hiding pattern as the
// sacristy sheet and certificates.
//
// URL: /packet?date=YYYY-MM-DD   (default: next Sunday)

import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loader2, Printer, ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { seasonLabel, colorLabel } from '../i18n/liturgical'

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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

// Kind labels come from the shared kind.* dictionary; 'other' prints
// nothing (a blank eyebrow beats the word "Other" on a formal sheet).

export default function SundayPacket() {
  const { t, dateLocale, tradition } = useLocale()
  const [params, setParams] = useSearchParams()
  const dateParam = params.get('date') && /^\d{4}-\d{2}-\d{2}$/.test(params.get('date'))
    ? params.get('date') : null

  const [packet, setPacket] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    fetch(apiUrl(`/api/packet${dateParam ? `?date=${dateParam}` : ''}`))
      .then(r => { if (!r.ok) throw new Error(t('pkt.loadError')); return r.json() })
      .then(d => { if (!cancelled) setPacket(d) })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [dateParam]) // eslint-disable-line react-hooks/exhaustive-deps

  const date = packet?.date ?? dateParam
  const intentionDays = (() => {
    const map = new Map()
    for (const r of packet?.intentions ?? []) {
      if (!map.has(r.mass_date)) map.set(r.mass_date, [])
      map.get(r.mass_date).push(r)
    }
    return [...map.entries()]
  })()

  const litLine = packet && [
    packet.lectionary?.designation,
    packet.lectionary?.proper ? `Proper ${packet.lectionary.proper}` : null,
    packet.lectionary?.year_label,
  ].filter(Boolean).join(' · ')

  const seasonLine = packet && [
    packet.liturgical?.feast_name,
    packet.liturgical?.season ? seasonLabel(t, packet.liturgical.season, { tradition, block: packet.liturgical.ordinary_block }) : null,
    packet.liturgical?.color ? colorLabel(t, packet.liturgical.color) : null,
  ].filter(Boolean).join(' · ')

  const SectionTitle = ({ children }) => (
    <h2 className="font-display text-lg font-semibold uppercase tracking-widest text-church-800 border-b border-brass-600/40 pb-1 mb-3">
      {children}
    </h2>
  )

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Toolbar — hidden on print */}
      <div className="print:hidden mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link to="/service-planner" className="inline-flex items-center gap-1.5 text-sm text-church-700 dark:text-brass-300 hover:underline">
          <ArrowLeft size={15} /> {t('pkt.back')}
        </Link>
        <div className="flex items-center gap-2">
          {date && (
            <>
              <button onClick={() => setParams({ date: addDays(date, -7) })} aria-label={t('pkt.prevWeek')}
                className="tap shrink-0 inline-flex items-center justify-center p-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800">
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm text-ink-600 dark:text-parchment-300/80 min-w-[11rem] text-center">
                {localDate(date).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' })}
              </span>
              <button onClick={() => setParams({ date: addDays(date, 7) })} aria-label={t('pkt.nextWeek')}
                className="tap shrink-0 inline-flex items-center justify-center p-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800">
                <ChevronRight size={16} />
              </button>
            </>
          )}
          <button onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-church-800 text-parchment-50 text-sm font-medium hover:bg-church-900">
            <Printer size={15} /> {t('pkt.print')}
          </button>
        </div>
      </div>

      {/* The packet itself */}
      <div className="bg-white text-ink-900 mx-auto p-8 sm:p-10 shadow-warm-lg print:shadow-none print:p-0">
        {loading ? (
          <div className="flex justify-center py-16 print:hidden"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
        ) : error ? (
          <p className="text-sm text-rose-700 text-center py-10">{error}</p>
        ) : packet && (
          <>
            <header className="text-center border-b-2 border-brass-600/60 pb-4 mb-6">
              <h1 className="font-display text-3xl font-semibold tracking-wide">{packet.parish}</h1>
              <p className="mt-1 font-display text-lg text-ink-700 italic">{t('pkt.title')}</p>
              <p className="mt-1 text-sm text-ink-600">
                {localDate(packet.date).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
              {litLine && <p className="mt-1.5 font-display text-base text-church-800">{litLine}</p>}
              {seasonLine && <p className="mt-0.5 text-sm text-ink-500">{seasonLine}</p>}
            </header>

            {/* Order of worship */}
            {packet.plan?.elements?.length > 0 && (
              <section className="mb-7 break-inside-avoid">
                <SectionTitle>{t('pkt.order')}{packet.plan.title ? ` — ${packet.plan.title}` : ''}</SectionTitle>
                <ol>
                  {packet.plan.elements.map((el, i) => (
                    <li key={i} className="py-1.5 flex items-baseline gap-3 border-b border-dotted border-parchment-300/70 last:border-0">
                      <span className="text-[10px] uppercase tracking-wider text-ink-400 w-20 shrink-0">
                        {el.kind === 'other' ? '' : t(`kind.${el.kind}`)}
                      </span>
                      <span className="font-display text-base leading-snug flex-1 min-w-0">
                        {el.title}
                        {el.reference && <span className="text-ink-500 italic"> · {el.reference}</span>}
                      </span>
                      {el.assigned_name && <span className="text-xs text-ink-500 shrink-0">{el.assigned_name}</span>}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {/* Serving schedule */}
            {packet.serving?.length > 0 && (
              <section className="mb-7 break-inside-avoid">
                <SectionTitle>{t('pkt.serving')}</SectionTitle>
                <ul>
                  {packet.serving.map((s, i) => (
                    <li key={i} className="py-1.5 flex items-baseline justify-between gap-4 border-b border-dotted border-parchment-300/70 last:border-0">
                      <span className="font-display text-base">
                        {s.title}
                        {s.start_time && <span className="text-ink-500 text-sm"> · {fmtTime(s.start_time)}</span>}
                      </span>
                      <span className="text-xs text-ink-600 text-right">
                        {(s.assigned ?? []).join(', ') || <span className="italic text-ink-400">{t('pkt.unassigned')}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Mass intentions for the week */}
            {intentionDays.length > 0 && (
              <section className="mb-7 break-inside-avoid">
                <SectionTitle>{t('pkt.intentions')}</SectionTitle>
                {intentionDays.map(([d, list]) => (
                  <div key={d} className="mb-3">
                    <h3 className="font-display text-base font-semibold text-ink-800 mb-1">
                      {localDate(d).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' })}
                    </h3>
                    <ul>
                      {list.map((r, i) => (
                        <li key={i} className="py-1 pl-3 flex items-baseline justify-between gap-4">
                          <span className="font-display text-base leading-snug">
                            {r.formatted_intention}
                            {(r.requester_name || r.requested_by) && (
                              <span className="text-xs text-ink-500"> — {t('pkt.requestedBy')} {r.requester_name || r.requested_by}</span>
                            )}
                          </span>
                          {r.status === 'fulfilled' && <span className="text-xs italic text-ink-400">{t('pkt.fulfilled')}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            )}

            {/* Announcements */}
            {(packet.bulletin?.announcements || packet.bulletin?.pastor_note) && (
              <section className="mb-7 break-inside-avoid">
                <SectionTitle>{t('pkt.announcements')}</SectionTitle>
                {packet.bulletin.announcements && (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{packet.bulletin.announcements}</p>
                )}
                {packet.bulletin.pastor_note && (
                  <p className="mt-3 text-sm leading-relaxed italic text-ink-700 whitespace-pre-wrap">{packet.bulletin.pastor_note}</p>
                )}
              </section>
            )}

            {/* Nothing at all yet — say so kindly, never a blank page. */}
            {!packet.plan?.elements?.length && !packet.serving?.length && intentionDays.length === 0 && !packet.bulletin && (
              <p className="text-sm text-ink-500 text-center py-10 italic">{t('pkt.empty')}</p>
            )}

            <footer className="mt-8 pt-3 border-t border-parchment-300 text-center text-[11px] text-ink-500">
              {t('pkt.printed')} {new Date().toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', year: 'numeric' })} · OpenChurch
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
