import { useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Mail, Lock, Loader2, Eye, EyeOff, Church } from 'lucide-react'
import OpenMark from '../components/OpenMark'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import TextField from '../components/TextField'

// Credentials for the seeded Demo Church. Kept in sync with server/migrate.js.
const DEMO_EMAIL    = 'demo@openchurch.app'
const DEMO_PASSWORD = 'demo1234'

export default function Login() {
  const { login } = useAuth()
  const { t, locale, setLocale } = useLocale()
  const navigate  = useNavigate()
  const location  = useLocation()
  const redirectTo = location.state?.from?.pathname || '/'

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPw,   setShowPw]   = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  // ResetPassword nav-state flash. One-shot — cleared after first read
  // so a refresh doesn't re-show the banner.
  const [resetFlash, setResetFlash] = useState(() => location.state?.passwordReset === true)

  async function onSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email.trim(), password)
      navigate(redirectTo, { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function useDemo() {
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
    <div className="min-h-screen grid lg:grid-cols-[1.15fr_1fr] bg-parchment-50 dark:bg-ink-950">

      {/*
        The Narthex — the vestibule between the outside world and the office.
        A quiet manifesto panel that answers "What is OpenChurch?" before the
        visitor ever types a password. Desktop only; below lg it condenses to
        a single line above the sign-in card.
      */}
      <section
        aria-label="About OpenChurch"
        className="hidden lg:flex flex-col justify-center px-16 xl:px-24 py-16
                   border-r border-brass-200/60 dark:border-brass-900/30
                   bg-gradient-to-br from-parchment-50 to-parchment-100
                   dark:from-ink-950 dark:to-ink-900"
      >
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.25, 0.1, 0.25, 1] }}
          className="max-w-xl"
        >
          {/* Wordmark */}
          <div className="flex items-center gap-3 mb-14">
            <div className="w-11 h-11 rounded-xl bg-church-900 dark:bg-brass-200 flex items-center justify-center shadow-warm-md">
              <OpenMark className="h-7 w-auto text-brass-200 dark:text-church-900" />
            </div>
            <span className="font-display text-3xl font-semibold text-church-900 dark:text-parchment-100 leading-none">
              OpenChurch
            </span>
          </div>

          <h1 className="font-display text-4xl xl:text-[2.75rem] font-medium text-ink-900 dark:text-parchment-50 leading-[1.15] tracking-tight mb-8">
            {t('login.h1')}
          </h1>

          <div className="space-y-5 text-[15px] leading-relaxed text-ink-600 dark:text-parchment-300/80">
            <p>{t('login.p1')}</p>
            <p>{t('login.p2')}</p>
            <p>{t('login.p3')}</p>
          </div>

          <div className="mt-14 pt-6 divider-brass text-xs font-semibold uppercase tracking-widest text-ink-400 dark:text-parchment-400/60">
            {t('login.traditions')}
          </div>
        </motion.div>
      </section>

      {/* The door — sign in */}
      <div className="flex items-center justify-center px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
        className="w-full max-w-md"
      >
        {/* Brand mark — shown only when the Narthex panel is hidden */}
        <div className="lg:hidden flex items-center justify-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-xl bg-church-900 dark:bg-brass-200 flex items-center justify-center shadow-warm-md">
            <svg width="18" height="22" viewBox="0 0 14 18" fill="currentColor" className="text-brass-200 dark:text-church-900">
              <rect x="5.5" y="0" width="3" height="18" rx="1" />
              <rect x="0" y="4" width="14" height="3" rx="1" />
            </svg>
          </div>
          <span className="font-display text-3xl font-semibold text-church-900 dark:text-parchment-100 leading-none">
            OpenChurch
          </span>
        </div>
        <p className="lg:hidden text-center text-sm text-ink-500 dark:text-parchment-300/70 leading-relaxed max-w-sm mx-auto mb-8">
          {t('login.mobileBlurb')}
        </p>

        <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm-md p-7">
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            {t('login.welcome')}
          </h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            {t('login.sub')}
          </p>

          {resetFlash && (
            <div className="mt-5 text-xs text-brass-700 dark:text-brass-300 bg-brass-50 dark:bg-brass-900/20 border border-brass-200/70 dark:border-brass-800/30 rounded-lg px-3 py-2">
              {t('login.resetFlash')}
              <button
                type="button"
                onClick={() => setResetFlash(false)}
                className="float-right text-brass-700 dark:text-brass-300 opacity-60 hover:opacity-100 ml-2"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <TextField
              label={t('login.email')}
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@yourchurch.com"
              leadingIcon={Mail}
            />

            <TextField
              label={t('login.password')}
              type={showPw ? 'text' : 'password'}
              required
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              leadingIcon={Lock}
              trailing={
                <button
                  type="button"
                  onClick={() => setShowPw(s => !s)}
                  className="text-ink-400 dark:text-parchment-400/60 hover:text-ink-600 dark:hover:text-parchment-200 transition-colors"
                  tabIndex={-1}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              }
            />

            {error && (
              <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email || !password}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : null}
              {loading ? t('login.signingIn') : t('login.signIn')}
            </button>

            <div className="text-center">
              <Link
                to="/forgot"
                className="text-xs font-medium text-ink-500 hover:text-church-800 dark:text-parchment-300/70 dark:hover:text-brass-200 transition-colors"
              >
                {t('login.forgot')}
              </Link>
            </div>
          </form>

          {/* Demo shortcut */}
          <div className="mt-5 pt-5 border-t border-parchment-300/60 dark:border-brass-900/30">
            <button
              type="button"
              onClick={useDemo}
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-parchment-50 dark:bg-ink-800 border border-brass-500/40 dark:border-brass-500/30 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-brass-50 dark:hover:bg-ink-800/70 transition-colors disabled:opacity-50"
            >
              <Church size={14} /> {t('login.demo')}
            </button>
            <p className="mt-2 text-[11px] text-ink-500 dark:text-parchment-300/70 text-center">
              {t('login.demoNote')}
            </p>
          </div>
        </div>

        <p className="mt-5 text-center text-sm text-ink-500 dark:text-parchment-300/70">
          {t('login.newTo')}{' '}
          <Link
            to="/signup"
            className="font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
          >
            {t('login.start')}
          </Link>
        </p>

        {/* Quiet language switch — a Spanish-speaking secretary should
            be able to enter in her own language before she ever signs in. */}
        <p className="mt-3 text-center text-xs text-ink-400 dark:text-parchment-400/60">
          <button
            type="button"
            onClick={() => setLocale('en')}
            className={`px-1 transition-colors ${locale === 'en' ? 'text-church-800 dark:text-brass-300 font-semibold' : 'hover:text-ink-600 dark:hover:text-parchment-200'}`}
          >
            English
          </button>
          {' · '}
          <button
            type="button"
            onClick={() => setLocale('es')}
            className={`px-1 transition-colors ${locale === 'es' ? 'text-church-800 dark:text-brass-300 font-semibold' : 'hover:text-ink-600 dark:hover:text-parchment-200'}`}
          >
            Español
          </button>
        </p>
      </motion.div>
      </div>
    </div>
  )
}
