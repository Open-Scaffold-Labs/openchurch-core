import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { RefreshCw, X } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'

// Update-available banner (Sprint PWA / PWA.6).
//
// Pairs with vite.config.js `registerType: 'prompt'` and the
// SKIP_WAITING listener in sw.js. Flow:
//   1. Vite plugin registers the SW. When a new build is detected,
//      `needRefresh` flips true.
//   2. We surface the banner. Clicking Refresh calls
//      updateServiceWorker(true), which posts SKIP_WAITING to the
//      waiting SW and reloads — the user lands on the new bundle.
//   3. Clicking X dismisses for the session only (no localStorage,
//      unlike InstallPrompt). A long-running tab that reloads with
//      a still-newer build pending will see the banner again — that
//      is the point: we only suppress within a single session.

export default function UpdatePrompt() {
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
          aria-label="Update available"
          className="fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:bottom-6 md:max-w-sm z-40 rounded-2xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 shadow-warm-lg p-4"
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 rounded-xl bg-church-50 dark:bg-church-900/40 flex items-center justify-center text-church-800 dark:text-brass-300">
              <RefreshCw size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
                Update available
              </p>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-1 leading-snug">
                A new version of OpenChurch is ready. Refresh to load it —
                your in-progress work isn't affected.
              </p>
              <button
                type="button"
                onClick={() => updateServiceWorker(true)}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-xs font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
              >
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss update prompt"
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
