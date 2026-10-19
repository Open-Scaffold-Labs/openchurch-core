import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Printer, ArrowLeft } from 'lucide-react'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'

// The First Parish Setup Record — a printable artifact, not a dashboard.
// Print ≠ emailed (OC-READY-01-023 / STMT-01): screen chrome says this is
// print/PDF only. The paper footer stays a live print marker, not a send.
//
// The case it exists for is a volunteer handing the parish office to the
// next volunteer, often on paper, often years later. So it prints, and
// the print is the point: artifacts outlive dashboards.
//
// THREE SECTIONS AND DELIBERATELY NO FOURTH. What is in place, what was
// left for later, who has access. There is no "outstanding" section,
// because a handover document that opens with a list of failures is one
// the outgoing volunteer quietly does not print. "Left for later" carries
// a name and a date precisely so it reads as a decision the parish made
// rather than a gap it fell into — and if a parish deferred nothing, the
// section says nothing was set aside, which is a fact and not a scold.
//
// What it does not carry: no score, no percentage, no "completion", no
// email addresses (a document that travels should not be a contact list),
// and no source data from any import. The footer says plainly that
// anything unnamed is simply not yet part of the record — which is the
// truthful reading, and the one that lets a parish print this at any
// point in its first year without embarrassment.

const ROLE_KEY = { admin: 'settled.role.admin', staff: 'settled.role.staff', viewer: 'settled.role.viewer' }

export default function SetupRecord() {
  const { t } = useLocale()
  const [data, setData] = useState(null)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/setup/record'))
        if (res.status === 403) { setDenied(true); return }
        if (!res.ok) throw new Error()
        setData(await res.json())
      } catch { setDenied(true) }
    })()
  }, [])

  if (denied) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <p className="text-[15px] text-ink-600 dark:text-parchment-300/85">
          {t('settled.recordTitle')} — {t('vault.adminOnly')}
        </p>
        <Link to="/getting-settled" className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-church-800 dark:text-brass-200 hover:underline">
          <ArrowLeft size={14} aria-hidden="true" /> {t('settled.title')}
        </Link>
      </div>
    )
  }

  if (!data) {
    return <div className="flex justify-center py-20"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
  }

  const plural = (key, count, vars = {}) =>
    (count === 1 ? t(`${key}_one`, { count, ...vars }) : t(key, { count, ...vars }))

  const labelFor = e => {
    const key = e.key.replace('setup.inPlace.', 'settled.inPlace.')
    const v = { parish: data.parish, tradition: e.detail?.tradition ?? '' }
    return e.detail?.count != null ? plural(key, e.detail.count, v) : t(key, v)
  }

  return (
    <div className="min-h-screen bg-parchment-100 dark:bg-ink-950 print:bg-white py-8 px-4 print:p-0">
      <div className="print:hidden mb-6 max-w-3xl mx-auto flex flex-wrap items-center justify-between gap-3">
        <Link to="/getting-settled" className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-church-800 dark:text-brass-200 hover:underline">
          <ArrowLeft size={14} aria-hidden="true" /> {t('settled.title')}
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          className="tap inline-flex items-center gap-2 px-4 py-2 rounded-xl text-[14px] font-semibold text-parchment-50 bg-church-800 hover:bg-church-900 transition-colors"
        >
          <Printer size={15} aria-hidden="true" /> {t('settled.print')}
        </button>
        {/* Print ≠ emailed (OC-READY-01-023 / STMT-01 pattern). Screen
            chrome only — the paper stays a live print marker. */}
        <p data-testid="setup-record-print-not-emailed" className="w-full text-sm text-ink-500 dark:text-parchment-300/70 print:hidden">
          {t('settled.printHonesty')}
        </p>
      </div>

      <article className="bg-white text-ink-900 max-w-3xl mx-auto p-8 sm:p-10 shadow-warm-lg print:shadow-none print:p-0">
        <header className="border-b border-parchment-300 pb-4">
          <h1 className="font-display text-2xl text-church-900">{t('settled.recordTitle')}</h1>
          <p className="mt-1 text-[17px] font-semibold">{data.parish}</p>
          <p className="mt-1 text-[13px] text-ink-500">
            {t('settled.recordEstablished', { date: data.established })}
            {' · '}
            {t('settled.recordPrepared', {
              date: data.prepared_on,
              by: data.prepared_by ? t('settled.recordBy', { name: data.prepared_by }) : '',
            })}
          </p>
        </header>

        <section className="mt-6">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-brass-700">{t('settled.inPlaceTitle')}</h2>
          <ul className="mt-2 space-y-1.5">
            {data.in_place.map(e => (
              <li key={e.key} className="text-[14px] leading-relaxed">
                {labelFor(e)}
                {e.on && <span className="text-ink-500"> · {t('settled.since', { date: e.on })}</span>}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-6">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-brass-700">{t('settled.deferredTitle')}</h2>
          {data.left_for_later.length === 0 ? (
            <p className="mt-2 text-[14px] text-ink-600">{t('settled.recordNothingLater')}</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {data.left_for_later.map(d => (
                <li key={d.item_key} className="text-[14px] leading-relaxed">
                  {t(d.item_key.replace('setup.begin.', 'settled.begin.'))}
                  {d.noted_by && (
                    <span className="text-ink-500"> · {t('settled.deferredBy', { name: d.noted_by, date: d.noted_at })}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-brass-700">{t('settled.recordAccess')}</h2>
          <ul className="mt-2 space-y-1">
            {data.access.map(p => (
              <li key={`${p.role}:${p.name}`} className="text-[14px]">
                {p.name} <span className="text-ink-500">· {t(ROLE_KEY[p.role] ?? 'settled.role.viewer')}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-6">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-brass-700">{t('settled.recordImport')}</h2>
          {data.latest_import ? (
            <>
              {/* A receipt missing its count is a thing we do not know.
                  Printing "0 records" would state something false in the
                  same voice as the true lines beside it. */}
              <p className="mt-2 text-[14px]">
                {data.latest_import.imported == null
                  ? t('settled.recordImportUnknown', {
                      date: data.latest_import.committed_at,
                      source: data.latest_import.source_name || '—',
                    })
                  : plural('settled.recordImportLine', data.latest_import.imported, {
                      date: data.latest_import.committed_at,
                      source: data.latest_import.source_name || '—',
                    })}
              </p>
              {data.latest_import.held_at_the_time > 0 && (
                <p className="text-[14px]">
                  {plural('settled.recordHeld', data.latest_import.held_at_the_time)}
                </p>
              )}
              {/* Straight from the receipt. This document is not the place
                  the promise about the source file quietly changes. */}
              {data.latest_import.source_file && (
                <p className="mt-1 text-[13px] text-ink-500">{data.latest_import.source_file}</p>
              )}
            </>
          ) : (
            <p className="mt-2 text-[14px] text-ink-600">{t('settled.recordNoImport')}</p>
          )}
        </section>

        <footer className="mt-8 pt-3 border-t border-parchment-300 text-[11.5px] leading-relaxed text-ink-500">
          {t('settled.recordFooter')}
        </footer>
      </article>
    </div>
  )
}
