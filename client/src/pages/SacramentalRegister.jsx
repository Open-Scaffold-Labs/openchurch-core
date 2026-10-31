import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Church, ClipboardPaste, Loader2, Printer, Search } from 'lucide-react'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'
import { apiUrl } from '../api'
import { formatStoredDate } from '../utils/dates'
import { useLocale } from '../i18n'
import SacramentAnniversaries from '../components/SacramentAnniversaries'
import { consumeJustEntered } from '../utils/justEntered'

// Sacramental Register (SAC.2) — the parish-wide book of sacraments, the
// canonical record a parish secretary keeps. Reads GET /api/sacraments
// (org-scoped, paginated) with an optional type filter, and prints cleanly.

const SACRAMENT_TYPES = ['baptism', 'reconciliation', 'first_communion', 'confirmation', 'marriage', 'holy_orders', 'anointing', 'burial']

const PAGE_SIZE = 50

// App Review R2 finding 7 (Beacon): at 300% zoom the sticky actions column
// sat over the Place column and clipped it; at 200-250% (Beacon R3) the
// table still clipped Place / Member. On a narrow screen (below 1280 CSS
// px — the `reflow` screen in tailwind.config.js, never in print) the register reflows:
// each row becomes a stacked card and every cell carries its column name
// (data-label) so nothing is hidden behind the pinned actions. At 1280px and up
// it is the same ledger table as before. The actions cell keeps pr-16 so
// its Certificate link sits left of the floating assistant button instead
// of under it when a row scrolls past the button (the FAB is right-5 +
// w-12; the page gutter is p-4/sm:p-6).
const REFLOW_TD = 'reflow:flex reflow:gap-3 reflow:px-0 reflow:py-0.5 reflow:whitespace-normal reflow:before:w-28 reflow:before:shrink-0 reflow:before:content-[attr(data-label)] reflow:before:pt-0.5 reflow:before:font-sans reflow:before:text-[11px] reflow:before:font-bold reflow:before:uppercase reflow:before:tracking-widest reflow:before:text-brass-700 dark:reflow:before:text-brass-300'

export default function SacramentalRegister() {
  const { t, dateLocale } = useLocale()
  const [records, setRecords] = useState([])
  const [type,    setType]    = useState('')
  const [q,       setQ]       = useState('')
  const [loading, setLoading] = useState(true)
  const [more,    setMore]    = useState(false)
  const [done,    setDone]    = useState(false)
  const [error,   setError]   = useState(null)
  const [retryTick, setRetryTick] = useState(0)

  const fetchPage = useCallback(async (offset, currentType, currentQ) => {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (currentType) qs.set('type', currentType)
    if (currentQ)    qs.set('q', currentQ)
    const res = await fetch(apiUrl(`/api/sacraments?${qs.toString()}`))
    if (!res.ok) throw new Error(`Failed (${res.status})`)
    const data = await res.json()
    // `data.records ?? []` treated a 200 with missing/null records as an
    // empty parish book ("No sacraments recorded yet"). Mirror the member
    // profile sacraments read: a non-array is UNREAD, not empty.
    if (!data || !Array.isArray(data.records)) {
      throw new Error('Failed (malformed)')
    }
    return data.records
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
  }, [type, q, fetchPage, retryTick])

  // "Open: Baptism, Maria Ruiz, May 10, 2020" — unique per row, visible
  // word first. A missing piece is left out rather than read as a dash.
  const rowActionLabel = (action, r) => t('register.rowAction', {
    action,
    entry: [
      SACRAMENT_TYPES.includes(r.type) ? t(`sac.${r.type}`) : r.type,
      r.member_name,
      r.date ? formatStoredDate(r.date, undefined, dateLocale) : null,
    ].filter(Boolean).join(', '),
  })

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

  // A record committed moments ago settles like fresh ink, once (V1.2).
  const inked = useMemo(
    () => new Set(records.filter(r => consumeJustEntered(r.id)).map(r => String(r.id))),
    [records],
  )

  return (
    <PageWrapper type="list">
      <div className="flex items-center justify-between gap-3 mb-5 print:mb-2">
        <PageHeader title={t('register.title')} subtitle={t('register.sub')} leading={<Church size={20} />} />
        <div className="print:hidden flex items-center gap-2">
          <Link
            to="/register/drafts"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800"
          >
            <ClipboardPaste size={15} /> {t('register.digitize')}
          </Link>
          {/* Prints the working register — which excludes voided entries,
              because the list this page reads never sends include_voided.
              That is the decision, not an accident: an ordinary parish-office
              printout must not quietly acquire retired entries.
              There is no archival print context yet. If one is ever built,
              voided entries may appear in it only if they are marked VOID on
              the page in a way that cannot be mistaken for an active record —
              and it must be a separate, deliberate view, not this button with
              a query parameter bolted on. */}
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
        <label className="sr-only" htmlFor="sac-type">{t('reg.filterSac')}</label>
        <select
          id="sac-type"
          value={type}
          onChange={e => setType(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
        >
          <option value="">{t('register.allSacraments')}</option>
          {SACRAMENT_TYPES.map(v => <option key={v} value={v}>{t(`sac.${v}`)}</option>)}
        </select>
        {/* App Review R4 (Beacon): on the narrow `reflow` screen the search
            takes its own full row instead of sharing it with the select, so
            the placeholder is not cut off at 250-300% zoom. */}
        <div className="relative flex-1 min-w-[12rem] reflow:basis-full">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder={t('register.searchPlaceholder')}
            aria-label={t('register.search')}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
          />
        </div>
      </div>

      {/* A failed first read is already said, once, by the empty-state card
          below. This line is only for a failure while rows are on screen
          (Load more), and it never shows a status code (OPERATOR P1). */}
      {error && records.length > 0 && (
        <p role="status" className="mb-3 text-sm text-amber-700 dark:text-amber-400">
          {t('register.loadFailedBody')}{' '}
          <button type="button" onClick={() => setRetryTick(n => n + 1)} className="underline font-medium">
            {t('error.tryAgain')}
          </button>
        </p>
      )}

      {loading ? (
        <div className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
          <SkeletonRowList count={6} withAvatar={false} />
        </div>
      ) : error ? (
        /* The register could not be read, so it is UNREAD — not empty.
           Observed 27 Aug: a 500, a malformed body, an aborted request and a
           403 all rendered "No sacraments recorded yet" beneath a raw
           "Failed (500)". A parish with a baptism on file was told its
           register was empty. NO RECORD and COULD NOT LOAD RECORD are
           different sentences and this page was saying the wrong one. */
        <EmptyState
          icon={Church}
          title={t('register.loadFailedTitle')}
          body={t('register.loadFailedBody')}
          action={{ label: t('error.tryAgain'), onClick: () => setRetryTick(n => n + 1) }}
        />
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
          <table className="w-full text-sm reflow:block">
            <thead className="reflow:sr-only">
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
                {/* Actions stay pinned to the right edge of the scroller. At 200%
                    zoom or a narrow window the table scrolls sideways and the
                    Open / Certificate links sat off-screen or under the
                    assistant button (App Review finding 7). */}
                <th className="sticky right-0 pl-4 pr-16 py-3 font-bold print:hidden bg-parchment-100 dark:bg-ink-800"><span className="sr-only">{t('register.actions')}</span></th>
              </tr>
            </thead>
            <tbody className="reflow:block">
              {records.map(r => (
                <tr key={r.id} className={`border-t border-parchment-300/50 dark:border-brass-900/25 text-ink-800 dark:text-parchment-100 reflow:block reflow:px-4 reflow:py-3 reflow:first:border-t-0${inked.has(String(r.id)) ? ' ink-settle' : ''}`}>
                  {/* Ledger typography — dates and names in the display
                      serif, rows given room. This is the parish's book,
                      not a data grid; it should read like the sibling of
                      its own certificates. */}
                  <td data-label={t('register.date')} className={`px-4 py-3.5 whitespace-nowrap font-display text-[15px] ${REFLOW_TD}`}>{r.date ? formatStoredDate(r.date, undefined, dateLocale) : '—'}</td>
                  <td data-label={t('register.sacrament')} className={`px-4 py-3.5 font-medium ${REFLOW_TD}`}>{SACRAMENT_TYPES.includes(r.type) ? t(`sac.${r.type}`) : r.type}</td>
                  <td data-label={t('register.member')} className={`px-4 py-3.5 font-display text-[15px] ${REFLOW_TD}`}>
                    {r.client_id && r.member_name ? (
                      <Link to={`/clients/${r.client_id}`} className="text-church-700 dark:text-brass-300 hover:underline print:no-underline print:text-inherit">
                        {r.member_name}
                      </Link>
                    ) : (
                      /* An unlinked subject is not a lesser entry — it is
                         most of a digitised register. It reads as ordinary
                         text, not as missing data. */
                      <span>{r.member_name || '—'}</span>
                    )}
                  </td>
                  <td data-label={t('register.minister')} className={`px-4 py-3.5 ${REFLOW_TD}`}>{r.minister || '—'}</td>
                  <td data-label={t('register.place')} className={`px-4 py-3.5 break-words ${REFLOW_TD}`}>{r.place || '—'}</td>
                  <td data-label={t('register.certNo')} className={`px-4 py-3.5 whitespace-nowrap ${REFLOW_TD}`}>{r.certificate_no || '—'}</td>
                  <td className="sticky right-0 pl-4 pr-16 py-3.5 whitespace-nowrap print:hidden bg-parchment-50 dark:bg-ink-950 shadow-[-6px_0_6px_-6px_rgba(0,0,0,0.15)] reflow:static reflow:block reflow:px-0 reflow:pt-2 reflow:pb-0 reflow:bg-transparent reflow:shadow-none reflow:dark:bg-transparent">
                    {/* Every row used to say just "Open" and "Certificate" to a
                        screen reader. The name keeps the visible word first
                        (label-in-name) and adds which entry it opens. */}
                    <Link
                      to={`/register/${r.id}`}
                      aria-label={rowActionLabel(t('register.open'), r)}
                      className="tap text-church-700 dark:text-brass-300 hover:underline text-[13px] font-semibold mr-3"
                    >
                      {t('register.open')}
                    </Link>
                    <Link
                      to={`/register/${r.id}/certificate`}
                      aria-label={rowActionLabel(t('register.certificate'), r)}
                      className="tap text-church-700 dark:text-brass-300 hover:underline text-[13px] font-semibold"
                    >
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
