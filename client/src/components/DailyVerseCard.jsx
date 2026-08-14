import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { BookOpen, RefreshCw } from 'lucide-react'
import { getDailyVerse } from '../services/verseService'
import { useLocale } from '../i18n'

export default function DailyVerseCard({ index = 0 }) {
  const { t } = useLocale()
  const [verse, setVerse] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = async (force = false) => {
    setLoading(true)
    const data = await getDailyVerse({ force })
    setVerse(data)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.065, duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
      className="relative overflow-hidden rounded-2xl p-7 border border-parchment-300/60 dark:border-brass-900/30 shadow-warm-md
        bg-parchment-100 dark:bg-ink-900/80
        text-ink-800 dark:text-parchment-100"
    >
      {/* Illuminated-capital accent — a quiet brass bar on the left edge. */}
      <div className="absolute left-0 top-6 bottom-6 w-[3px] rounded-r-full bg-brass-500/70 dark:bg-brass-400/60" />

      <div className="relative pl-3">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-church-900/[0.06] dark:bg-brass-500/10 border border-church-900/10 dark:border-brass-500/20 flex items-center justify-center">
              <BookOpen size={15} className="text-church-700 dark:text-brass-200" />
            </div>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-500 dark:text-parchment-300/70">
              {t('verse.title')}
            </span>
          </div>
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="p-1.5 rounded-lg hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors text-ink-400 dark:text-parchment-300/60 hover:text-church-700 dark:hover:text-brass-200 disabled:opacity-40"
            title={t('verse.refresh')}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {loading ? (
          <div className="space-y-2.5 animate-pulse">
            <div className="h-4 bg-parchment-300/50 dark:bg-parchment-100/10 rounded w-full" />
            <div className="h-4 bg-parchment-300/50 dark:bg-parchment-100/10 rounded w-5/6" />
            <div className="h-4 bg-parchment-300/50 dark:bg-parchment-100/10 rounded w-4/6" />
          </div>
        ) : (
          <>
            <p className="font-display text-xl leading-relaxed mb-4 text-church-900 dark:text-parchment-50 italic">
              &ldquo;{verse?.text}&rdquo;
            </p>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-parchment-300/70">
              — {verse?.reference}
            </p>
          </>
        )}
      </div>
    </motion.div>
  )
}
