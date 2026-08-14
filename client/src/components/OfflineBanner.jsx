import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WifiOff } from 'lucide-react'

// Offline indicator (Sprint PWA / PWA.3).
//
// Shows a thin parchment-tone bar at the top of the viewport when
// the browser reports we're offline. The data the user sees stays
// rendered because Workbox is serving from the runtime cache
// (PWA.2) — this just makes the state visible so the admin knows
// the timestamps + counts they're looking at may be older than
// reality.
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

export default function OfflineBanner() {
  const [online, setOnline] = useState(getInitialOnline)

  useEffect(() => {
    function handleOnline()  { setOnline(true) }
    function handleOffline() { setOnline(false) }
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
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
          className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-2 bg-brass-100 dark:bg-brass-900/40 text-brass-900 dark:text-brass-200 text-xs font-semibold border-b border-brass-200/70 dark:border-brass-800/40 shadow-warm-sm"
        >
          <WifiOff size={13} />
          <span>You're offline — showing cached data from your last visit.</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
