import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Mail, Lock, Loader2, Eye, EyeOff, Church, User } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import TextField from '../components/TextField'

const MIN_PW = 8

// The parish clock for the sample Sundays seeded at signup. Staff can
// change it later in Org details. A runtime that cannot name a zone
// omits the field; the server then stores UTC.
function browserTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone.trim() ? zone.trim() : undefined
  } catch {
    return undefined
  }
}

export default function Signup() {
  const { signup } = useAuth()
  const { t, locale, setLocale } = useLocale()
  const navigate   = useNavigate()

  const [organizationName, setOrganizationName] = useState('')
  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPw,   setShowPw]   = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  // TRAD.1/TRAD.2 — asked BEFORE the account exists, because the sample
  // data is seeded the moment signup commits. Getting this after the fact
  // means a Catholic parish's first screen says "Fellowship Hall".
  const [tradition, setTradition] = useState('')

  async function onSubmit(e) {
    e.preventDefault()
    setError('')
    if (password.length < MIN_PW) {
      return setError(t('signup.passwordMin', { min: MIN_PW }))
    }
    setLoading(true)
    try {
      await signup({
        organizationName: organizationName.trim(),
        name: name.trim(),
        email: email.trim(),
        password,
        // Unset means 'general' server-side — a real tier with neutral
        // vocabulary and no lectionary, not a hole. Nobody is forced to
        // classify their congregation to create an account.
        tradition: tradition || undefined,
        timezone: browserTimeZone(),
      })
      // Land on the welcome screen first — the dashboard is one click away
      // but the first impression should be focused, not noisy.
      navigate('/welcome', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-parchment-50 dark:bg-ink-950">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
        className="w-full max-w-md"
      >
        <div className="flex items-center justify-center gap-3 mb-8">
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

        <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm-md p-7">
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            {t('signup.title')}
          </h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            {t('signup.sub')}
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <TextField
              label={t('signup.churchName')}
              required
              autoComplete="organization"
              value={organizationName}
              onChange={e => setOrganizationName(e.target.value)}
              placeholder={t('signup.churchNamePh')}
              leadingIcon={Church}
            />

            <div>
              <label htmlFor="signup-tradition" className="block text-sm font-medium text-ink-700 dark:text-parchment-200 mb-1.5">
                {t('signup.tradition')} <span className="font-normal text-ink-400 dark:text-parchment-400">{t('signup.traditionOptional')}</span>
              </label>
              <select
                id="signup-tradition"
                value={tradition}
                onChange={e => setTradition(e.target.value)}
                className="w-full rounded-lg border border-parchment-300 dark:border-ink-600 bg-parchment-50 dark:bg-ink-800 px-3 py-2.5 text-sm text-ink-900 dark:text-parchment-100 focus:outline-none focus:ring-2 focus:ring-brass-400"
              >
                <option value="">{t('signup.traditionLater')}</option>
                <option value="catholic">{t('signup.traditionCatholic')}</option>
                <option value="episcopal">{t('signup.traditionEpiscopal')}</option>
                <option value="lutheran">{t('signup.traditionLutheran')}</option>
                <option value="anglican">{t('signup.traditionAnglican')}</option>
                <option value="general">{t('signup.traditionOther')}</option>
              </select>
              <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">
                {t('signup.traditionHelp')}
              </p>
            </div>

            <TextField
              label={t('signup.yourName')}
              required
              autoComplete="name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('signup.yourNamePh')}
              leadingIcon={User}
            />

            <TextField
              label={t('login.email')}
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={t('signup.emailPh')}
              leadingIcon={Mail}
            />

            <TextField
              label={t('login.password')}
              type={showPw ? 'text' : 'password'}
              required
              minLength={MIN_PW}
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('signup.passwordPh', { min: MIN_PW })}
              leadingIcon={Lock}
              trailing={
                <button
                  type="button"
                  onClick={() => setShowPw(s => !s)}
                  className="tap-auth text-ink-400 dark:text-parchment-400/60 hover:text-ink-600 dark:hover:text-parchment-200 transition-colors"
                  aria-label={showPw ? t('signup.hidePassword') : t('signup.showPassword')}
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
              disabled={loading}
              className="tap w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : null}
              {loading ? t('signup.submitting') : t('signup.submit')}
            </button>
          </form>
        </div>

        <p className="mt-5 text-center text-sm text-ink-500 dark:text-parchment-300/70">
          {t('signup.haveAccount')}{' '}
          <Link
            to="/login"
            className="tap-auth font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
          >
            {t('login.signIn')}
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
  )
}
