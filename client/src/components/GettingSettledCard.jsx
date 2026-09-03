import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { X, Compass, ArrowRight } from 'lucide-react'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { mutate } from '../utils/format'

// The Dashboard's quiet route into Getting settled.
//
// This replaces OnboardingChecklist, which filled a bar to
// doneCount/totalCount and struck through what was done. Everything that
// made that card a source of pressure is gone: no bar, no count, no
// fraction, no empty circles waiting to be filled. One line and a link.
//
// It hides itself in exactly one case — the person said "come back to
// this later" — and that dismissal is stored per person on the server,
// not in this browser's localStorage, because a treasurer who reads it on
// her phone and then opens her desktop should not be greeted by a card
// she already put away. The page stays reachable from Admin either way;
// dismissing hides a suggestion, never a destination.

export default function GettingSettledCard() {
  const { t } = useLocale()
  const [state, setState] = useState(null)

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/setup'))
        if (!res.ok) return
        setState(await res.json())
      } catch { /* a dashboard card is never worth an error banner */ }
    })()
  }, [])

  if (!state || state.dismissed_at) return null

  // The card goes away at once, and comes back if the dismissal did not
  // reach the server — better a card that reappears than one the person
  // believes they have put away for good.
  async function putAway() {
    const prior = state.dismissed_at ?? null
    setState(s => ({ ...s, dismissed_at: new Date().toISOString() }))
    const { ok } = await mutate(apiUrl('/api/setup/dismiss'))
    if (!ok) setState(s => ({ ...s, dismissed_at: prior }))
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      aria-label={t('settled.cardTitle')}
      className="rounded-2xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100/60 dark:bg-ink-900/60 p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Compass size={14} className="text-brass-700 dark:text-brass-300" aria-hidden="true" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">
              {t('settled.cardTitle')}
            </h2>
          </div>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-600 dark:text-parchment-300/85">
            {t('settled.cardBody')}
          </p>
          <Link
            to="/getting-settled"
            className="group mt-2 inline-flex items-center gap-1.5 text-[14px] font-semibold text-church-800 dark:text-brass-200 hover:underline"
          >
            {t('settled.cardOpen')}
            <ArrowRight size={14} className="opacity-60 group-hover:translate-x-0.5 transition-transform" aria-hidden="true" />
          </Link>
        </div>
        <button
          type="button"
          onClick={putAway}
          aria-label={t('settled.comeBack')}
          className="tap-reach -m-2 p-2 text-ink-400 dark:text-parchment-400/60 hover:text-ink-700 dark:hover:text-parchment-100 transition-colors"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </motion.section>
  )
}
