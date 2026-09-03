import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'

// Shown when we hold a credential nobody has rejected and cannot currently
// confirm — a 5xx from the auth check, a dropped connection, a body that is
// not JSON.
//
// The screen this replaces was /login. Sending someone there says "your
// session is invalid", which the app did not know and which was usually
// false: the token was fine and the database had hiccuped. It also cost the
// secretary her password, mid-task, for a server problem.
//
// Voice matches LoadError in the diocese app: name the failure, say what it
// is NOT, offer the way forward. Nothing here apologises for her session,
// because her session is fine.
export default function SessionUnconfirmed() {
  const { retryAuth, logout } = useAuth()
  const { t } = useLocale()
  const [retrying, setRetrying] = useState(false)

  const retry = async () => {
    setRetrying(true)
    try { await retryAuth() } finally { setRetrying(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-parchment-50 dark:bg-ink-950">
      <div role="status" className="max-w-md text-center space-y-4">
        <AlertCircle size={26} className="mx-auto text-amber-700 dark:text-amber-400" aria-hidden="true" />
        <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
          {t('session.unconfirmedTitle')}
        </h1>
        <p className="text-sm leading-relaxed text-ink-600 dark:text-parchment-300">
          {t('session.unconfirmedBody')}
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-1">
          <button
            type="button"
            onClick={retry}
            disabled={retrying}
            className="tap inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60"
          >
            {retrying
              ? <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              : <RefreshCw size={15} aria-hidden="true" />}
            {t('session.tryAgain')}
          </button>
          <button
            type="button"
            onClick={logout}
            className="tap inline-flex items-center justify-center px-4 py-2.5 text-sm font-medium text-ink-600 dark:text-parchment-300 hover:underline"
          >
            {t('session.signInAgain')}
          </button>
        </div>
      </div>
    </div>
  )
}
