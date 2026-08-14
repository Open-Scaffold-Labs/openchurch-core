import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Church, ClipboardPaste, Loader2, Printer, Search } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'
import { apiUrl } from '../api'
import { formatLocalDate } from '../utils/dates'
import { useLocale } from '../i18n'
import SacramentAnniversaries from '../components/SacramentAnniversaries'

// Sacramental Register (SAC.2) — the parish-wide book of sacraments, the
// canonical record a parish secretary keeps. Reads GET /api/sacraments
// (org-scoped, paginated) with an optional type filter, and prints cleanly.

const SACRAMENT_TYPES = ['baptism', 'reconciliation', 'first_communion', 'confirmation', 'marriage', 'holy_orders', 'anointing', 'burial']

const PAGE_SIZE = 50

export default function SacramentalRegister() {
  const { t, dateLocale } = useLocale()
  const [records, setRecords] = useState([])
  const [type,    setType]    = useState('')
  const [q,       setQ]       = useState('')
  const [loading, setLoading] = useState(true)
  const [more,    setMore]    = useState(false)
  const [done,    setDone]    = useState(false)
  const [error,   setError]   = useState(null)

  const fetchPage = useCallback(async (offset, currentType, currentQ) => {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (currentType) qs.set('type', currentType)
    if (currentQ)    qs.set('q', currentQ)
    const res = await fetch(apiUrl(`/api/sacraments?${qs.toString()}`))
    if (!res.ok) throw new Error(`Failed (${res.status})`)
    const data = await res.json()
    return data.records ?? []
  }, [])

  // Reload from the top when the filter or search changes; debounced so
  // typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setDone(false)
    const timer = setTimeout(() => {
      fetchPage(0, type, q.trim())
        .then(rows => {
          if (cancelled) return
          setRecords(rows)
          setDone(rows.length < PAGE_SIZE)
        })
        .catch(err => { if (!cancelled) setError(err.message) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [type, q, fetchPage])

  const loadMore = async () => {
    setMore(true); setError(null)
    try {
      const rows = await fetchPage(records.length, type, q.trim())
      setRecords(prev => [...prev, ...rows])
      if (rows.length < PAGE_SIZE) setDone(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setMore(false)
    }
  }

  return (
    <PageWrapper>
      <div className="flex items-center justify-between gap-3 mb-5 print:mb-2">
        <div className="flex items-center gap-2">
          <Church size={20} className="text-church-700 dark:text-brass-300" />
          <div>
            <h1 className="text-2xl font-display font-bold text-ink-900 dark:text-parchment-50">{t('register.title')}</h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70">{t('register.sub')}</p>
          </div>
        </div>
        <div className="print:hidden flex items-center gap-2">
          <Link
            to="/register/drafts"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800"
          >
            <ClipboardPaste size={15} /> {t('register.digitize')}
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800"
          >
            <Printer size={15} /> {t('register.print')}
          </button>
        </div>
      </div>

      <div className="mb-4 print:hidden">
        <SacramentAnniversaries days={60} />
      </div>

      <div className="mb-4 print:hidden flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="sac-type">Filter by sacrament</label>
        <select
          id="sac-type"
          value={type}
          onChange={e => setType(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
        >
          <option value="">{t('register.allSacraments')}</option>
          {SACRAMENT_TYPES.map(v => <option key={v} value={v}>{t(`sac.${v}`)}</option>)}
        </select>
        <div className="relative flex-1 min-w-[12rem]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder={t('register.search')}
            aria-label={t('register.search')}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
          />
        </div>
      </div>

      {error && (
        <p className="mb-3 text-sm text-rose-700 dark:text-rose-300">{error}</p>
      )}

      {loading ? (
        <div className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
          <SkeletonRowList count={6} withAvatar={false} />
        </div>
      ) : records.length === 0 ? (
        <EmptyState
          icon={Church}
          title={t('register.emptyTitle')}
          body={t('register.emptyBody')}
        />
      ) : (
        <div
          // `relative` is load-bearing, not decorative. The table is wider than
          // a phone, so it scrolls inside this card — but a static wrapper is
          // not a containing block, so an absolutely positioned descendant
          // (the sr-only header cell, whose static position sits ~677px into
          // the table) escaped this scroller entirely and stretched the ROOT
          // scrollWidth. At 390px the whole page panned sideways under a thumb
          // while the table itself looked innocent. (QA audit M1.)
          //
          // tabIndex/role/aria-label: once a region genuinely scrolls it has to
          // be reachable by keyboard, or a keyboard-only user can never see the
          // columns that sit off-screen.
          className="relative overflow-x-auto rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm"
          tabIndex={0}
          role="region"
          aria-label={t('register.title')}
        >
          <table className="w-full text-sm">
            <thead>
              {/* brass-700, not -600: at 11px on parchment-100 the -600 step measures
                4.47:1 and misses AA by 0.03. -700 is 6.20:1 and still
                unmistakably brass. The brand token itself is untouched. */}
              <tr className="text-left text-[11px] uppercase tracking-widest text-brass-700 dark:text-brass-300 bg-parchment-100 dark:bg-ink-800">
                <th className="px-4 py-3 font-bold">{t('register.date')}</th>
                <th className="px-4 py-3 font-bold">{t('register.sacrament')}</th>
                <th className="px-4 py-3 font-bold">{t('register.member')}</th>
                <th className="px-4 py-3 font-bold">{t('register.minister')}</th>
                <th className="px-4 py-3 font-bold">{t('register.place')}</th>
                <th className="px-4 py-3 font-bold">{t('register.certNo')}</th>
                <th className="px-4 py-3 font-bold print:hidden"><span className="sr-only">{t('register.certificate')}</span></th>
              </tr>
            </thead>
            <tbody>
              {records.map(r => (
                <tr key={r.id} className="border-t border-parchment-300/50 dark:border-brass-900/25 text-ink-800 dark:text-parchment-100">
                  {/* Ledger typography — dates and names in the display
                      serif, rows given room. This is the parish's book,
                      not a data grid; it should read like the sibling of
                      its own certificates. */}
                  <td className="px-4 py-3.5 whitespace-nowrap font-display text-[15px]">{r.date ? formatLocalDate(r.date, undefined, dateLocale) : '—'}</td>
                  <td className="px-4 py-3.5 font-medium">{SACRAMENT_TYPES.includes(r.type) ? t(`sac.${r.type}`) : r.type}</td>
                  <td className="px-4 py-3.5 font-display text-[15px]">
                    {r.client_id && r.member_name ? (
                      <Link to={`/clients/${r.client_id}`} className="text-church-700 dark:text-brass-300 hover:underline print:no-underline print:text-inherit">
                        {r.member_name}
                      </Link>
                    ) : (
                      <span className="text-ink-400 dark:text-parchment-300/60">{r.member_name || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3.5">{r.minister || '—'}</td>
                  <td className="px-4 py-3.5">{r.place || '—'}</td>
                  <td className="px-4 py-3.5 whitespace-nowrap">{r.certificate_no || '—'}</td>
                  <td className="px-4 py-3.5 whitespace-nowrap print:hidden">
                    <Link to={`/register/${r.id}/certificate`} className="text-church-700 dark:text-brass-300 hover:underline text-[13px] font-semibold">
                      {t('register.certificate')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !done && records.length > 0 && (
        <div className="flex justify-center mt-4 print:hidden">
          <button
            type="button"
            onClick={loadMore}
            disabled={more}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800 disabled:opacity-60"
          >
            {more ? <Loader2 size={15} className="animate-spin" /> : null} {t('register.loadMore')}
          </button>
        </div>
      )}
    </PageWrapper>
  )
}
