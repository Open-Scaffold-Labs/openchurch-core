import { useState } from 'react'
import { BellRing, Loader2 } from 'lucide-react'
import { useLocale } from '../i18n'
import { isNativeShell } from './nativeShell'

// Permission flow for a later notice. Behind VITE_ENABLE_IOS_PUSH=1
// and the native shell. Nothing is sent. The token is not kept.

const COPY = {
  idle: 'ios.shell.pushBody',
  asking: 'ios.shell.pushAsking',
  granted: 'ios.shell.pushGranted',
  denied: 'ios.shell.pushDenied',
  declined: 'ios.shell.pushDeclined',
  'not-registered': 'ios.shell.pushNotRegistered',
  unavailable: 'ios.shell.pushUnavailable',
}

export default function IosPushFoundation() {
  const { t } = useLocale()
  const [phase, setPhase] = useState('idle')
  const enabled = import.meta.env.VITE_ENABLE_IOS_PUSH === '1'
  if (!enabled || !isNativeShell()) return null

  async function ask() {
    if (phase === 'asking') return
    setPhase('asking')
    try {
      const { requestNativeNoticePermission } = await import('./iosPush')
      const { PushNotifications } = await import('@capacitor/push-notifications')
      const result = await requestNativeNoticePermission(PushNotifications)
      setPhase(COPY[result?.state] ? result.state : 'unavailable')
    } catch {
      setPhase('unavailable')
    }
  }

  const bodyKey = COPY[phase] || COPY.unavailable

  return (
    <section className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 overflow-hidden">
      <div className="px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25 flex items-center gap-2">
        <BellRing size={15} className="text-brass-600 dark:text-brass-300" />
        <h2 className="font-semibold text-ink-900 dark:text-parchment-50">{t('ios.shell.pushTitle')}</h2>
      </div>
      <div className="px-5 py-4">
        <p className="text-sm text-ink-700 dark:text-parchment-200" role="status">{t(bodyKey)}</p>
        {phase !== 'granted' && phase !== 'denied' && (
          <button
            type="button"
            onClick={ask}
            disabled={phase === 'asking'}
            className="mt-4 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-church-800 px-4 text-sm font-semibold text-parchment-50 hover:bg-church-900 focus:outline-none focus:ring-2 focus:ring-brass-400 disabled:opacity-60"
          >
            {phase === 'asking' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            {t('ios.shell.pushAsk')}
          </button>
        )}
      </div>
    </section>
  )
}
