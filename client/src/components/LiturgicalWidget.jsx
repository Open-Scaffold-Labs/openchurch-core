import { motion } from 'framer-motion'
import { Cross } from 'lucide-react'
import { useLiturgicalToday } from '../hooks/useLiturgicalToday'
import { useLocale } from '../i18n'
import { seasonLabel, colorLabel } from '../i18n/liturgical'
import { LIT_COLOR_DOT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'

// Today's liturgical day — surfaces the season, color, and feast name
// for the current date. Reads /api/liturgical?date=<today>, which
// computes the season server-side (Anonymous Gregorian Easter algo +
// liturgical calendar rules) and overlays any user-defined feasts
// from ochr_liturgical_calendar.
//
// Self-hides on fetch error so a missing widget never pushes the
// Dashboard layout around.

// Liturgical colour chips come from utils/liturgicalColors — the single
// canonical set. This file used to keep its own copy, and the copies had
// already drifted: the local map said Gold is amber-400 and White is
// stone-100/300, while the shared one says yellow-400 and gray-100/300.
// Three components, three slightly different Ordinary Times. That is
// exactly the drift the shared module was hoisted out to prevent.

function formatDateLong(isoYmd, dateLocale) {
  const [y, m, d] = isoYmd.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(dateLocale, {
    weekday: 'long', month: 'long', day: 'numeric',
  })
}

export default function LiturgicalWidget() {
  const { data, today, error } = useLiturgicalToday()
  const { t, dateLocale } = useLocale()

  if (error || !data) return null

  const chipCls = LIT_COLOR_DOT[data.color] ?? LIT_COLOR_DOT_NONE

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-sm p-4"
    >
      <div className="flex items-center gap-2 mb-2">
        <Cross size={13} className="text-brass-600 dark:text-brass-300" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">
          {t('lw.title')}
        </span>
      </div>

      <div className="flex items-baseline gap-3">
        <span
          role="img"
          className={`w-3 h-3 rounded-full shrink-0 ${chipCls}`}
          aria-label={t('lw.color', { color: colorLabel(t, data.color) })}
          title={t('lw.color', { color: colorLabel(t, data.color) })}
        />
        <div className="min-w-0">
          <h3 className="font-display text-xl font-semibold text-ink-900 dark:text-parchment-50 leading-tight">
            {seasonLabel(t, data.season)}
          </h3>
          {data.feast_name && (
            <p className="text-sm text-church-800 dark:text-brass-200 italic mt-0.5">
              {data.feast_name}
            </p>
          )}
        </div>
      </div>

      <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-2">
        {formatDateLong(today, dateLocale)}
      </p>
    </motion.div>
  )
}
