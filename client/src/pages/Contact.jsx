import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Mail } from 'lucide-react'
import OpenMark from '../components/OpenMark'
import { useLocale } from '../i18n'

// Public Support / contact (OC-READY-01-007). Logged-out reviewers and
// parishioners need a human without an account. This is NOT the
// authenticated admin ticket queue at /support.

export const DEFAULT_PUBLIC_SUPPORT_EMAIL = 'support@openscaffoldlabs.com'

export function publicSupportEmail(env = import.meta.env) {
  const raw = env?.VITE_PUBLIC_SUPPORT_EMAIL
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return DEFAULT_PUBLIC_SUPPORT_EMAIL
}

export default function Contact() {
  const { t, locale, setLocale } = useLocale()
  const email = publicSupportEmail()
  const mailto = `mailto:${email}`

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-parchment-50 dark:bg-ink-950">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
        className="w-full max-w-md"
      >
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-xl bg-church-900 dark:bg-brass-200 flex items-center justify-center shadow-warm-md">
            <OpenMark className="h-7 w-auto text-brass-200 dark:text-church-900" />
          </div>
          <span className="font-display text-3xl font-semibold text-church-900 dark:text-parchment-100 leading-none">
            OpenChurch
          </span>
        </div>

        <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm-md p-7">
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            {t('supportPage.title')}
          </h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            {t('supportPage.sub')}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">
            {t('supportPage.body')}
          </p>

          <a
            href={mailto}
            className="tap mt-6 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-church-800 hover:bg-church-900 text-parchment-50 text-sm font-semibold shadow-warm transition-colors focus:outline-none focus:ring-2 focus:ring-brass-400"
          >
            <Mail size={15} aria-hidden="true" />
            {t('supportPage.write', { email })}
          </a>

          <p className="mt-4 text-xs text-ink-500 dark:text-parchment-300/70 text-center">
            {t('supportPage.address')}
          </p>
          <p className="mt-1 text-center">
            <a
              href={mailto}
              className="tap-reach inline-block text-sm font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors focus:outline-none focus:ring-2 focus:ring-brass-400 rounded-sm"
            >
              {email}
            </a>
          </p>
        </div>

        <p className="mt-5 text-center text-sm text-ink-500 dark:text-parchment-300/70">
          <Link
            to="/login"
            className="tap-reach inline-block font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
          >
            {t('supportPage.backLogin')}
          </Link>
          {' · '}
          <Link
            to="/signup"
            className="tap-reach inline-block font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
          >
            {t('supportPage.backSignup')}
          </Link>
          {' · '}
          <Link
            to="/privacy"
            className="tap-reach inline-block font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
          >
            {t('privacyPage.link')}
          </Link>
        </p>

        <p className="mt-3 text-center text-xs text-ink-400 dark:text-parchment-400/60">
          <button
            type="button"
            onClick={() => setLocale('en')}
            className={`tap-reach inline-block px-1 transition-colors ${locale === 'en' ? 'text-church-800 dark:text-brass-300 font-semibold' : 'hover:text-ink-600 dark:hover:text-parchment-200'}`}
          >
            English
          </button>
          {' · '}
          <button
            type="button"
            onClick={() => setLocale('es')}
            className={`tap-reach inline-block px-1 transition-colors ${locale === 'es' ? 'text-church-800 dark:text-brass-300 font-semibold' : 'hover:text-ink-600 dark:hover:text-parchment-200'}`}
          >
            Español
          </button>
        </p>
      </motion.div>
    </div>
  )
}
