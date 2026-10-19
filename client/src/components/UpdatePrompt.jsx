import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { RefreshCw, X } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useLocale } from '../i18n'

// Update-available banner (Sprint PWA / PWA.6).
//
// Pairs with vite.config.js `registerType: 'prompt'` and the
// SKIP_WAITING listener in sw.js. Flow:
//   1. Vite plugin registers the SW. When a new build is detected,
//      `needRefresh` flips true.
//   2. We surface the banner. Clicking Refresh calls
//      updateServiceWorker(true), which posts SKIP_WAITING to the
//      waiting SW. The new worker takes control and the plugin
//      reloads the page (`window.location.reload()`). Unsaved
//      page state is discarded. The banner must say so.
//      Claiming in-progress work is unaffected is a lie.
//   3. Clicking X dismisses for the session only (no localStorage,
//      unlike InstallPrompt). A long-running tab that reloads with
//      a still-newer build pending will see the banner again — that
//      is the point: we only suppress within a single session.
//
// Copy lives in strings.js / t() (OC-READY-01-025). This file does
// not change when the SW activates or how it reloads.

export default function UpdatePrompt() {
  const { t } = useLocale()
  const [dismissed, setDismissed] = useState(false)

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    // onRegisteredSW lets the plugin schedule periodic update checks
    // here later if we want; the default registration suffices.
  })

  function dismiss() {
    setDismissed(true)
    setNeedRefresh(false)
  }

  const show = needRefresh && !dismissed

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
          role="dialog"
          aria-label={t('update.title')}
          className="safe-mb fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:bottom-6 md:max-w-sm z-40 rounded-2xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 shadow-warm-lg p-4"
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 rounded-xl bg-church-50 dark:bg-church-900/40 flex items-center justify-center text-church-800 dark:text-brass-300">
              <RefreshCw size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
                {t('update.title')}
              </p>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-1 leading-snug">
                {t('update.body')}
              </p>
              <button
                type="button"
                onClick={() => updateServiceWorker(true)}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-xs font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
              >
                <RefreshCw size={13} /> {t('update.refresh')}
              </button>
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label={t('update.dismiss')}
              className="shrink-0 -m-2 p-2 text-ink-400 dark:text-parchment-400/60 hover:text-ink-700 dark:hover:text-parchment-100 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
