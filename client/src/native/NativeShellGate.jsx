import { useLocale } from '../i18n'
import { sessionCookieCanRide } from './sessionOrigin'

// Shown only inside a Capacitor build whose page is not the parish
// address. The session cookie cannot ride along from here. The screen
// says that, and nothing else — it does not guess why the address is
// wrong and it does not offer a retry that would land in the same place.

export default function NativeShellGate() {
  const { t } = useLocale()
  if (import.meta.env.VITE_CAPACITOR !== '1') return null
  if (typeof window === 'undefined') return null
  const verdict = sessionCookieCanRide({
    documentUrl: window.location.href,
    apiBase: import.meta.env.VITE_API_URL || '',
  })
  if (verdict.ok) return null

  return (
    <div
      role="status"
      className="safe-pt safe-pb fixed inset-0 z-[80] flex items-center justify-center bg-parchment-50 px-6 print:hidden"
    >
      <div className="max-w-md text-center">
        <h1 className="font-display text-3xl text-church-800">{t('ios.shell.signInTitle')}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-700">{t('ios.shell.signInBody')}</p>
      </div>
    </div>
  )
}
