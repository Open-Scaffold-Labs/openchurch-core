import { useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Mail, Lock, Loader2, Eye, EyeOff } from 'lucide-react'
import OpenMark from '../components/OpenMark'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import TextField from '../components/TextField'
import LoginDemoShortcut from './loginDemo'

// Demo helper is imported only for the compile-time gate below.
// Production `vite build` sets DEV to false, so the ternary is dropped
// and this module is tree-shaken — password literals never reach dist.
// MODE !== 'production' keeps it out even when a production build runs
// with a non-production NODE_ENV (which makes Vite compile DEV as true).
// Dot access only: bracket access makes Vite inline the whole env object.
// VITE_ENABLE_DEMO_LOGIN must stay unset in client/.env.production.

// Server refusals that arrive as English sentences, mapped to locale keys.
// Only shown after the password matched (server contract).
const SERVER_SENTENCES = {
  'This login is deactivated. An admin can turn it back on.': 'login.deactivated',
  'This login is closed. It cannot be turned back on.': 'login.closed',
  'This organization is on hold. Access is stopped; parish history remains.': 'login.held',
}

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
      // The server sentence is English. Show the same fact in the person's language.
      setError(SERVER_SENTENCES[err.message] ? t(SERVER_SENTENCES[err.message]) : err.message)
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
        aria-label={t('login.about')}
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

          {/* Slogan for the narthex copy, not a second page title.
              The sign-in card is the only h1 (visible at every breakpoint). */}
          <p className="font-display text-4xl xl:text-[2.75rem] font-medium text-ink-900 dark:text-parchment-50 leading-[1.15] tracking-tight mb-8">
            {t('login.h1')}
          </p>

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
                aria-label={t('login.dismiss')}
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
              placeholder={t('login.emailPh')}
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
                  className="tap-auth text-ink-400 dark:text-parchment-400/60 hover:text-ink-600 dark:hover:text-parchment-200 transition-colors"
                  aria-label={showPw ? t('login.hidePassword') : t('login.showPassword')}
                >
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              }
            />

            {error && (
              <div role="alert" className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email || !password}
              className="tap w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : null}
              {loading ? t('login.signingIn') : t('login.signIn')}
            </button>

            <div className="text-center">
              <Link
                to="/forgot"
                className="tap-auth inline-flex text-xs font-medium text-ink-500 hover:text-church-800 dark:text-parchment-300/70 dark:hover:text-brass-200 transition-colors"
              >
                {t('login.forgot')}
              </Link>
            </div>
          </form>

          {import.meta.env.DEV && import.meta.env.MODE !== 'production' && import.meta.env.VITE_ENABLE_DEMO_LOGIN === 'true' ? (
            <LoginDemoShortcut
              loading={loading}
              setLoading={setLoading}
              setError={setError}
              setEmail={setEmail}
              setPassword={setPassword}
            />
          ) : null}
        </div>

        <p className="mt-5 text-center text-sm text-ink-500 dark:text-parchment-300/70">
          {t('login.newTo')}{' '}
          <Link
            to="/signup"
            className="tap-auth font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
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
            className={`tap-auth px-1 transition-colors ${locale === 'en' ? 'text-church-800 dark:text-brass-300 font-semibold' : 'hover:text-ink-600 dark:hover:text-parchment-200'}`}
          >
            English
          </button>
          {' · '}
          <button
            type="button"
            onClick={() => setLocale('es')}
            className={`tap-auth px-1 transition-colors ${locale === 'es' ? 'text-church-800 dark:text-brass-300 font-semibold' : 'hover:text-ink-600 dark:hover:text-parchment-200'}`}
          >
            Español
          </button>
        </p>
      </motion.div>
      </div>
    </div>
  )
}
