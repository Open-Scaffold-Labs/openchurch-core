import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Church } from 'lucide-react'
import { apiUrl } from '../api'
import { formatLocalDate } from '../utils/dates'
import { useLocale } from '../i18n'

// Sacrament anniversaries (SAC.4) — a quiet daily nudge: "5 years since
// Maria's Baptism, Sunday." Self-fetching card; renders NOTHING when there
// are none, so it never adds empty chrome to the dashboard. Reads
// GET /api/sacraments/anniversaries?days=N.

export default function SacramentAnniversaries({ days = 30, max = 6 }) {
  const { t } = useLocale()
  const [list, setList] = useState(null) // null = loading/unknown
  // Sacrament names come from the shared sac.* dictionary so the register
  // and this card always agree on the words.
  const typeLabel = (type) => t(`sac.${type}`)

  useEffect(() => {
    let cancelled = false
    fetch(apiUrl(`/api/sacraments/anniversaries?days=${days}`))
      .then(r => (r.ok ? r.json() : { anniversaries: [] }))
      .then(d => { if (!cancelled) setList(d.anniversaries ?? []) })
      .catch(() => { if (!cancelled) setList([]) })
    return () => { cancelled = true }
  }, [days])

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
        {shown.map(a => (
          <li key={a.id} className="text-sm">
            <Link
              to={a.member_id ? `/clients/${a.member_id}` : '/register'}
              className="font-medium text-ink-800 dark:text-parchment-100 hover:text-church-700 dark:hover:text-brass-300"
            >
              {a.member_name}
            </Link>
            <span className="text-ink-600 dark:text-parchment-300/80">
              {' — '}{t(a.years === 1 ? 'anniv.since1' : 'anniv.sinceN', { n: a.years, type: typeLabel(a.type) })}
            </span>
            <span className="block text-[11px] text-ink-500 dark:text-parchment-300/70">
              {formatLocalDate(a.next_date, { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
          </li>
        ))}
      </ul>

      {extra > 0 && (
        <Link to="/register" className="mt-3 inline-block text-[12px] font-semibold text-church-700 dark:text-brass-300 hover:underline">
          {t('anniv.more', { n: extra })}
        </Link>
      )}
    </section>
  )
}
