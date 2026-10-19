import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WifiOff } from 'lucide-react'
import { useLocale } from '../i18n'

// Offline indicator (Sprint PWA / PWA.3).
//
// Shows a thin parchment-tone bar at the top of the viewport when
// the browser reports we're offline. Offline is the only fact this
// chrome can establish. Workbox may answer /api/* from the runtime
// cache while offline (`onlyWhenOffline`) — or it may miss, and the
// page's own FAILED state is then the truth. The banner must not
// claim cached data is on screen. Page-level loading/failure copy
// says what happened to a given fetch.
//
// Implementation notes:
//   - navigator.onLine is the source of truth, listened via
//     'online' / 'offline' events. Modern browsers fire these
//     reliably; older mobile Safari can be flaky but for our use
//     case (pastor on church-basement wifi) the signal is good
//     enough.
//   - Renders OUTSIDE the page chrome so it works on every route,
//     including the parishioner /p/:slug/events page where someone
//     might be offline reading the bulletin.
//   - No client-side network test (no fetch ping) — the browser's
//     own connectivity state is what apps should defer to. Custom
//     network tests are how you end up with false-positives during
//     captive-portal redirects.

function getInitialOnline() {
  // SSR-safe default — assume online if window isn't there yet.
  if (typeof navigator === 'undefined') return true
  return navigator.onLine
}

// Tell the service worker what this banner is about to say. The worker
// serves a cached /api/* answer ONLY while it believes the browser is
// offline (sw.js, `onlyWhenOffline`). Banner visible and cache-eligible
// must come from the same signal — that is the ONLINE_STATE agreement.
// A miss is still FAILED, so the words on the bar stay offline-honest
// and never claim a cache hit. The worker has its own navigator.onLine
// as a belt; this is the braces, and it is also the path a test harness
// can drive.
function tellServiceWorker(online) {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'ONLINE_STATE', online })
  } catch { /* no worker, nothing to tell */ }
}

export default function OfflineBanner() {
  const { t } = useLocale()
  const [online, setOnline] = useState(getInitialOnline)

  useEffect(() => {
    function handleOnline()  { setOnline(true);  tellServiceWorker(true) }
    function handleOffline() { setOnline(false); tellServiceWorker(false) }
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    tellServiceWorker(getInitialOnline())
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return (
    <AnimatePresence>
      {!online && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
          className="safe-pt fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-2 bg-brass-100 dark:bg-brass-900/40 text-brass-900 dark:text-brass-200 text-xs font-semibold border-b border-brass-200/70 dark:border-brass-800/40 shadow-warm-sm"
        >
          <WifiOff size={13} />
          <span>{t('offline.banner')}</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
