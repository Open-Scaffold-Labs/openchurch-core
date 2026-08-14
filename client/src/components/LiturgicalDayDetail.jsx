import { motion } from 'framer-motion'
import { Church } from 'lucide-react'
import { useLiturgicalToday } from '../hooks/useLiturgicalToday'
import { useLocale } from '../i18n'
import { seasonLabel, colorLabel } from '../i18n/liturgical'
import { LIT_COLOR_DOT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'

// Liturgical day detail — the expanded companion to LiturgicalWidget.
//
// The widget (top-right of the Dashboard) is the compact "what day is
// it liturgically" chip: season + color dot + feast. This panel fills
// the open space under the greeting with the *meaning* — what the
// liturgical color signifies and a short reflection on the season.
//
// Data: GET /api/liturgical?date=<today> → { season, color, feast_name }.
// Same endpoint the widget hits; it's private-cached 1h server-side so
// this second consumer is effectively free.
//
// Everything below the raw season/color/feast is rendered purely
// client-side from canonical liturgical tradition — no extra server
// data needed. Color meanings and season themes are long-settled
// Church teaching, not generated copy.
//
// Self-hides on fetch error so a missing panel never pushes the
// Dashboard layout around (same defensive pattern as the widget).

// Liturgical colour swatches come from utils/liturgicalColors — canonical
// hues, NOT the brand palette. This file used to carry its own copy that
// had already drifted from the shared one (Gold as amber-400 rather than
// yellow-400); "Mirrors LiturgicalWidget" was a comment, not a guarantee.

// Color meanings and season reflections live in the i18n dictionary
// (litd.color.* / litd.season.*) so the meditative copy follows the
// parish's language — long-settled Church teaching in both tongues.
const COLOR_KEYS = { Purple: 'litd.color.purple', White: 'litd.color.white', Green: 'litd.color.green', Red: 'litd.color.red', Gold: 'litd.color.gold' }
const SEASON_KEYS = {
  'Advent': 'litd.season.advent', 'Christmas': 'litd.season.christmas', 'Lent': 'litd.season.lent',
  'Holy Week': 'litd.season.holyweek', 'Easter': 'litd.season.easter', 'Pentecost': 'litd.season.pentecost',
  'Ordinary Time': 'litd.season.ordinary',
}

export default function LiturgicalDayDetail() {
  const { data, error } = useLiturgicalToday()
  const { t } = useLocale()

  if (error || !data) return null

  const swatchCls   = LIT_COLOR_DOT[data.color] ?? LIT_COLOR_DOT_NONE
  const colorMeaning = COLOR_KEYS[data.color] ? t(COLOR_KEYS[data.color]) : null
  const reflection   = SEASON_KEYS[data.season] ? t(SEASON_KEYS[data.season]) : null

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.08 }}
      className="mt-6 bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm p-5"
    >
      {/* Eyebrow */}
      <div className="flex items-center gap-2 mb-3">
        <Church size={13} className="text-brass-600 dark:text-brass-300" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">
          {t('litd.title')}
        </span>
      </div>

      {/* Season + feast */}
      <h3 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 leading-tight">
        {seasonLabel(t, data.season)}
      </h3>
      {data.feast_name && (
        <p className="text-sm font-semibold text-church-800 dark:text-brass-200 mt-0.5">
          {data.feast_name}
        </p>
      )}

      {/* Liturgical colour + its meaning */}
      {colorMeaning && (
        <div className="flex items-start gap-2.5 mt-4">
          <span
            className={`w-3.5 h-3.5 rounded-full shrink-0 mt-0.5 ${swatchCls}`}
            aria-hidden="true"
          />
          <p className="text-sm text-ink-600 dark:text-parchment-200 leading-relaxed">
            <span className="font-semibold text-ink-800 dark:text-parchment-100">{colorLabel(t, data.color)}</span>
            {' — '}{colorMeaning}
          </p>
        </div>
      )}

      {/* Season reflection — set in the display serif, left-ruled in
          brass so it reads as a quiet meditative note rather than UI. */}
      {reflection && (
        <p className="mt-4 pl-3 border-l-2 border-brass-300/70 dark:border-brass-700/50 font-display text-base italic text-ink-700 dark:text-parchment-200/90 leading-snug">
          {reflection}
        </p>
      )}
    </motion.div>
  )
}
