import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Download, X, Share } from 'lucide-react'
import { useLocale } from '../i18n'

// Install-to-home-screen prompt (Sprint PWA / PWA.1b).
//
// Two install paths, two UI variants:
//   1. Chrome / Edge / Android — fires the `beforeinstallprompt`
//      event. We capture it and surface a small "Install OpenChurch"
//      banner. Clicking the button calls prompt() on the saved
//      event; the OS handles the actual install dialog.
//   2. iOS Safari — does NOT fire beforeinstallprompt. The user has
//      to tap the Share icon and choose 'Add to Home Screen'
//      manually. We detect iOS Safari and show a quick instructional
//      banner pointing at the Share icon. No programmatic install
//      is possible on iOS.
//
// Dismiss model:
//   - X button hides the banner for the session.
//   - localStorage flag ochr_install_dismissed persists across
//     visits so we don't nag every load. Cleared if the user
//     successfully installs (the event-fired path) so we don't
//     re-show after they're already installed.
//
// Hidden entirely when:
//   - Running in standalone mode (already installed).
//   - User dismissed this session OR persistently.
//   - Browser doesn't support PWA install AND device isn't iOS.
//
// Copy lives in strings.js / t() (OC-READY-01-026). This file does
// not change when the banner is shown, dismissed, or how install
// is offered. {share} and {add} in install.iosBody are JSX slots
// for the Share icon and the bold Add-to-Home-Screen phrase.

const DISMISS_KEY = 'ochr_install_dismissed'

function isStandalone() {
  // Both checks needed — Android uses display-mode, iOS uses the
  // legacy navigator.standalone bool.
  if (typeof window === 'undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true
}

function isIOSSafari() {
  if (typeof window === 'undefined') return false
  const ua = window.navigator.userAgent
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream
  // Webkit-but-not-Chrome-iOS is roughly "Safari on iOS." Chrome on
  // iOS reports CriOS in the UA.
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
  return isIOS && isSafari
}

function IosInstallBody({ t }) {
  const add = t('install.iosAdd')
  const [beforeShare, afterShare = ''] = t('install.iosBody').split('{share}')
  const [beforeAdd, afterAdd = ''] = afterShare.split('{add}')
  return (
    <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-1 leading-snug">
      {beforeShare}
      <Share size={11} className="inline mx-0.5 align-text-bottom" aria-hidden="true" />
      {beforeAdd}
      <span className="font-semibold">{add}</span>
      {afterAdd}
    </p>
  )
}

export default function InstallPrompt() {
  const { t } = useLocale()
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [showIOS, setShowIOS] = useState(false)
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })

  useEffect(() => {
    if (dismissed || isStandalone()) return

    function onBeforeInstall(e) {
      // Prevent the auto banner — we render our own
      e.preventDefault()
      setDeferredPrompt(e)
    }
    function onInstalled() {
      // OS confirmed install — clear the dismiss flag (so if they
      // ever uninstall + revisit, the banner can show again) and
      // hide.
      try { localStorage.removeItem(DISMISS_KEY) } catch {}
      setDeferredPrompt(null)
      setShowIOS(false)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)

    // iOS path — no event ever fires, so we surface the manual
    // instructions after a short delay (so the user sees the app
    // first, not an install nag).
    let iosTimer
    if (isIOSSafari()) {
      iosTimer = setTimeout(() => setShowIOS(true), 4000)
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      if (iosTimer) clearTimeout(iosTimer)
    }
  }, [dismissed])

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch {}
    setDismissed(true)
    setDeferredPrompt(null)
    setShowIOS(false)
  }

  async function install() {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice
    setDeferredPrompt(null)
    if (choice?.outcome !== 'accepted') {
      // User cancelled — don't nag them again this session, but
      // don't write the persistent dismiss flag either (they may
      // change their mind later).
      setShowIOS(false)
    }
    // 'accepted' path: 'appinstalled' fires separately + clears flag.
  }

  const show = !dismissed && !isStandalone() && (deferredPrompt || showIOS)

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
          role="dialog"
          aria-label={t('install.title')}
          className="safe-mb fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:bottom-6 md:max-w-sm z-40 rounded-2xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 shadow-warm-lg p-4"
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 rounded-xl bg-church-50 dark:bg-church-900/40 flex items-center justify-center text-church-800 dark:text-brass-300">
              {deferredPrompt ? <Download size={16} /> : <Share size={16} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
                {t('install.title')}
              </p>
              {deferredPrompt ? (
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-1 leading-snug">
                  {t('install.body')}
                </p>
              ) : (
                <IosInstallBody t={t} />
              )}
              {deferredPrompt && (
                <button
                  type="button"
                  onClick={install}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-xs font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
                >
                  <Download size={13} /> {t('install.cta')}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label={t('install.dismiss')}
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
