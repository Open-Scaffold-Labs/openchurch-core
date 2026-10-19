import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Church } from 'lucide-react'
import { apiUrl } from '../api'
import { formatStoredDate } from '../utils/dates'
import { useLocale } from '../i18n'

// Sacrament anniversaries (SAC.4) — a quiet daily nudge: "5 years since
// Maria's Baptism, Sunday." Self-fetching card; renders NOTHING when there
// are none, so it never adds empty chrome to the dashboard. Reads
// GET /api/sacraments/anniversaries?days=N.

export default function SacramentAnniversaries({ days = 30, max = 6 }) {
  const { t } = useLocale()
  const [list, setList] = useState(null) // null = loading/unknown
  const [failed, setFailed] = useState(false)
  // Sacrament names come from the shared sac.* dictionary so the register
  // and this card always agree on the words.
  const typeLabel = (type) => t(`sac.${type}`)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    setList(null)
    fetch(apiUrl(`/api/sacraments/anniversaries?days=${days}`))
      .then(r => {
        if (!r.ok) throw new Error('unread')
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        const rows = d?.anniversaries
        if (!Array.isArray(rows)) throw new Error('shape')
        setList(rows)
      })
      .catch(() => { if (!cancelled) { setFailed(true); setList(null) } })
    return () => { cancelled = true }
  }, [days])

  // A failed read is not a quiet week. The card stays off the dashboard
  // only when the week genuinely has nothing to mark.
  if (failed) {
    return (
      <section role="status" className="rounded-2xl border border-amber-300/70 dark:border-amber-700/40 bg-amber-50/70 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
        {t('anniv.unread')}
      </section>
    )
  }

  // Quietly absent while loading or when there's nothing to celebrate.
  if (!list || list.length === 0) return null

  const shown = list.slice(0, max)
  const extra = list.length - shown.length

  return (
    <section className="rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900/90 shadow-warm p-4">
      <div className="flex items-center gap-2 mb-3">
        <Church size={15} className="text-brass-700 dark:text-brass-300" />
        <h3 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
          {t('anniv.title')}
        </h3>
      </div>

      <ul className="space-y-2">
        {shown.map(a => {
          const recorded = typeof a.member_name === 'string' ? a.member_name.trim() : ''
          return (
          <li key={a.id} className="text-sm">
            <Link
              to={a.member_id ? `/clients/${a.member_id}` : '/register'}
              className="font-medium text-ink-800 dark:text-parchment-100 hover:text-church-700 dark:hover:text-brass-300"
            >
              {recorded || t('anniv.nameUnavailable')}
            </Link>
            <span className="text-ink-600 dark:text-parchment-300/80">
              {' — '}{t(a.years === 1 ? 'anniv.since1' : 'anniv.sinceN', { n: a.years, type: typeLabel(a.type) })}
            </span>
            <span className="block text-[11px] text-ink-500 dark:text-parchment-300/70">
              {formatStoredDate(a.next_date, { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
          </li>
          )
        })}
      </ul>

      {extra > 0 && (
        <Link to="/register" className="mt-3 inline-block text-[12px] font-semibold text-church-700 dark:text-brass-300 hover:underline">
          {t('anniv.more', { n: extra })}
        </Link>
      )}
    </section>
  )
}
