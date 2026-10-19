import { Church } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'

// Seeded Demo Church credentials. Referenced from Login.jsx only inside
//   import.meta.env.DEV && MODE !== 'production' && VITE_ENABLE_DEMO_LOGIN === 'true'
// Production vite build compiles DEV to false and dead-code-eliminates
// this module. Never import this file from a production Login path.
//
// Flag: VITE_ENABLE_DEMO_LOGIN (client/.env.example). Must stay unset in
// client/.env.production and in every production Vite build.
export const DEMO_EMAIL = 'demo@openchurch.app'
export const DEMO_PASSWORD = 'demo1234'

const COPY = {
  en: {
    demo: 'Use demo account',
    demoNote: 'Demo only — loaded with sample data for presentations.',
  },
  es: {
    demo: 'Usar cuenta de demostración',
    demoNote: 'Solo demostración — con datos de ejemplo para presentaciones.',
  },
}

export default function LoginDemoShortcut({
  loading,
  setLoading,
  setError,
  setEmail,
  setPassword,
}) {
  const { login } = useAuth()
  const { locale } = useLocale()
  const navigate = useNavigate()
  const copy = COPY[locale] || COPY.en

  async function onUse() {
    setEmail(DEMO_EMAIL)
    setPassword(DEMO_PASSWORD)
    setError('')
    setLoading(true)
    try {
      await login(DEMO_EMAIL, DEMO_PASSWORD)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-5 pt-5 border-t border-parchment-300/60 dark:border-brass-900/30">
      <button
        type="button"
        onClick={onUse}
        disabled={loading}
        className="tap w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-parchment-50 dark:bg-ink-800 border border-brass-500/40 dark:border-brass-500/30 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-brass-50 dark:hover:bg-ink-800/70 transition-colors disabled:opacity-50"
      >
        <Church size={14} /> {copy.demo}
      </button>
      <p className="mt-2 text-[11px] text-ink-500 dark:text-parchment-300/70 text-center">
        {copy.demoNote}
      </p>
    </div>
  )
}
