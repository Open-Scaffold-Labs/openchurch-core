import { useState } from 'react'
import { UserX } from 'lucide-react'
import { apiUrl } from '../api'
import { useAuth } from '../authContext'
import { useConfirm } from '../components/ConfirmProvider'
import { STRINGS } from '../i18n/strings'

// Device override only. Do not import parish useLocale / LocaleProvider.
function t(key) {
  let locale = 'en'
  try {
    const stored = localStorage.getItem('ochr_locale')
    if (stored && STRINGS[stored]) locale = stored
  } catch { /* private mode — stay on English */ }
  return STRINGS[locale]?.[key] ?? STRINGS.en[key] ?? key
}

// Turns this login off. The row stays. An administrator turns it back on.
// This is the signed-in person only — never someone else's login.
//
// The confirm dialog is required: one click must not sign the person out.
// The words say the login is turned off, never that the account, the row,
// or the organization is deleted.
// A 409 proves this login stays on. A 200 whose body says deactivated
// proves it is off, and this device signs out through the existing shell
// logout. A lost response, a network throw, a 401, a 500, a 200 without
// deactivated: true, or a body that is not JSON does not prove whether
// the login is on or off. Those stay on this page. The words are ours —
// the server's English sentence is not shown.
export function DeactivateLoginCard() {
  const { logout } = useAuth()
  const ask = useConfirm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function handleDeactivate() {
    setError('')
    const ok = await ask({
      title: t('account.deactivate.confirmTitle'),
      body: t('account.deactivate.confirmBody'),
      confirmLabel: t('account.deactivate.confirm'),
      cancelLabel: t('account.deactivate.cancel'),
      tone: 'destructive',
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/auth/deactivate'), { method: 'POST' })
      if (res.status === 409) {
        setError(t('account.deactivate.lastAdmin'))
        return
      }
      let body = null
      try { body = await res.json() } catch { body = null }
      if (res.status === 200 && body?.deactivated === true) {
        logout()
        return
      }
      setError(t('account.deactivate.failed'))
    } catch {
      setError(t('account.deactivate.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-parchment-300/70 bg-parchment-50 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <UserX size={15} className="text-brass-600" aria-hidden="true" />
        <h2 className="font-semibold text-ink-900">{t('account.deactivate.title')}</h2>
      </div>
      <p className="text-sm text-ink-600 leading-relaxed">
        {t('account.deactivate.help')}
      </p>
      {error && (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={handleDeactivate}
        disabled={busy}
        aria-busy={busy || undefined}
        className="px-4 py-2 min-h-[44px] rounded-lg text-sm font-semibold bg-church-600 text-parchment-50 hover:bg-church-700 disabled:opacity-60"
      >
        {busy ? t('account.deactivate.saving') : t('account.deactivate.submit')}
      </button>
    </section>
  )
}

// Permanent closure. Distinct from turning the login off.
// A 409 proves the login stays open. A 200 whose body says closed
// proves it is closed, and this device signs out. Anything else is
// unknown and stays on this page.
export function CloseLoginCard() {
  const { logout } = useAuth()
  const ask = useConfirm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function handleClose() {
    setError('')
    const ok = await ask({
      title: t('account.close.confirmTitle'),
      body: t('account.close.confirmBody'),
      confirmLabel: t('account.close.confirm'),
      cancelLabel: t('account.close.cancel'),
      tone: 'destructive',
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/auth/close'), { method: 'POST' })
      if (res.status === 409) {
        setError(t('account.close.lastAdmin'))
        return
      }
      let body = null
      try { body = await res.json() } catch { body = null }
      if (res.status === 200 && body?.closed === true) {
        logout()
        return
      }
      setError(t('account.close.failed'))
    } catch {
      setError(t('account.close.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-parchment-300/70 bg-parchment-50 p-5 space-y-4 mt-4">
      <div className="flex items-center gap-2">
        <UserX size={15} className="text-brass-600" aria-hidden="true" />
        <h2 className="font-semibold text-ink-900">{t('account.close.title')}</h2>
      </div>
      <p className="text-sm text-ink-600 leading-relaxed">
        {t('account.close.help')}
      </p>
      {error && (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={handleClose}
        disabled={busy}
        aria-busy={busy || undefined}
        className="px-4 py-2 min-h-[44px] rounded-lg text-sm font-semibold bg-church-600 text-parchment-50 hover:bg-church-700 disabled:opacity-60"
      >
        {busy ? t('account.close.saving') : t('account.close.submit')}
      </button>
    </section>
  )
}

export default function Account() {
  return (
    <div className="max-w-3xl">
      <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">{t('account.title')}</h1>
      <p className="text-sm text-ink-500 mb-7">{t('account.sub')}</p>
      <DeactivateLoginCard />
      <CloseLoginCard />
    </div>
  )
}
