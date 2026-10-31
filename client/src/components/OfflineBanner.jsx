import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Wifi, WifiOff } from 'lucide-react'
import { EASE_SETTLE } from '../utils/motion'
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

const BACK_ONLINE_MS = 2000

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
  // After an outage the bar turns sage, says so, and leaves on its own
  // (V1.5, study #13). Only a real offline → online change earns it; a
  // page that loads online never shows it.
  const [backOnline, setBackOnline] = useState(false)
  const wasOfflineRef = useRef(!getInitialOnline())
  const backTimerRef = useRef(null)

  useEffect(() => {
    function handleOnline() {
      setOnline(true); tellServiceWorker(true)
      if (wasOfflineRef.current) {
        wasOfflineRef.current = false
        setBackOnline(true)
        clearTimeout(backTimerRef.current)
        backTimerRef.current = setTimeout(() => setBackOnline(false), BACK_ONLINE_MS)
      }
    }
    function handleOffline() {
      wasOfflineRef.current = true
      clearTimeout(backTimerRef.current); setBackOnline(false)
      setOnline(false); tellServiceWorker(false)
    }
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    tellServiceWorker(getInitialOnline())
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
      clearTimeout(backTimerRef.current)
    }
  }, [])

  return (
    <AnimatePresence>
      {(!online || backOnline) && (
        <motion.div
          key="offline-bar"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.26, ease: EASE_SETTLE } }}
          exit={{ opacity: 0, y: -20, transition: { duration: 0.2, ease: 'easeIn' } }}
          className={`safe-pt fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold border-b shadow-warm-sm transition-colors duration-300 ${
            online
              ? 'bg-sage-50 dark:bg-sage-900/40 text-sage-800 dark:text-sage-200 border-sage-200/70 dark:border-sage-800/40'
              : 'bg-brass-100 dark:bg-brass-900/40 text-brass-900 dark:text-brass-200 border-brass-200/70 dark:border-brass-800/40'
          }`}
        >
          {online ? <Wifi size={13} /> : <WifiOff size={13} />}
          <span>{online ? t('offline.back') : t('offline.banner')}</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
