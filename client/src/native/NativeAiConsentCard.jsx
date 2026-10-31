import { useState } from 'react'
import { motion } from 'framer-motion'
import { useLocale } from '../i18n'
import { showConsentWithdrawal } from './aiGate'
import { AiConsentScreen } from './AiConsentScreen'
import { useNativeAi } from './NativeAiContext'

function whenLabel(iso, dateLocale) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })
}

export default function NativeAiConsentCard() {
  const { t, dateLocale } = useLocale()
  const { kind, consent, withdraw } = useNativeAi()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [review, setReview] = useState(false)

  if (!showConsentWithdrawal(kind)) return null

  const agreed = kind === 'open'
  const stamped = whenLabel(consent?.consented_at, dateLocale)
  const withdrawn = whenLabel(consent?.withdrawn_at, dateLocale)

  async function onWithdraw() {
    if (busy) return
    setBusy(true)
    setFailed(false)
    const result = await withdraw()
    setBusy(false)
    if (!result.ok) setFailed(true)
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}>
      <section className="rounded-2xl border border-parchment-300/70 bg-white/70 p-5 shadow-warm dark:border-brass-900/30 dark:bg-ink-800/60">
        <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">{t('ai.prefs.draft')}</p>
        <h2 className="mt-2 font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">{t('ai.prefs.title')}</h2>
        <p className="mt-2 text-sm text-ink-700 dark:text-parchment-200">
          {agreed
            ? (stamped ? t('ai.prefs.active', { date: stamped }) : t('ai.prefs.activeNoDate'))
            : (withdrawn ? t('ai.prefs.withdrawnOn', { date: withdrawn }) : t('ai.prefs.none'))}
        </p>
        {!agreed && withdrawn && (
          <p className="mt-1 text-sm text-ink-600 dark:text-parchment-300/80">{t('ai.prefs.withdrawn')}</p>
        )}
        {failed && (
          <p role="alert" className="mt-2 text-sm text-rose-700 dark:text-rose-300">{t('ai.prefs.withdrawFailed')}</p>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          {agreed ? (
            <button
              type="button"
              data-testid="native-ai-withdraw"
              onClick={onWithdraw}
              disabled={busy}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-church-800 hover:bg-church-900 text-parchment-50 border border-church-800 transition-colors focus:outline-none focus:ring-2 focus:ring-brass-400 disabled:opacity-50"
            >
              {busy ? t('ai.prefs.withdrawing') : t('ai.prefs.withdraw')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="native-ai-review"
              onClick={() => setReview(true)}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-church-800 hover:bg-church-900 text-parchment-50 border border-church-800 transition-colors focus:outline-none focus:ring-2 focus:ring-brass-400"
            >
              {t('ai.prefs.review')}
            </button>
          )}
        </div>
      </section>
      {review && !agreed && (
        <AiConsentScreen variant="dialog" onClose={() => setReview(false)} />
      )}
    </motion.div>
  )
}
