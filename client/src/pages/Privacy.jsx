import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ShieldAlert } from 'lucide-react'
import OpenMark from '../components/OpenMark'
import { useLocale } from '../i18n'
import { publicSupportEmail } from './Contact'

// Public /privacy route SHELL (P1 lane B, TARS #62 6380348243).
//
// DRAFT. This is the route and link a reviewer can reach logged out. It is
// NOT the privacy policy. The consolidated draft notice lives in
// docs/app-store/P1-PRIVACY-NOTICE-DRAFT.md and is not final wording; do not
// import it here. Replace the body only with approved wording, through the
// existing approval gates. Until then the page says plainly that the policy
// is not published.

export const PRIVACY_DRAFT_MARKER = 'privacy-shell-draft'

export default function Privacy() {
  const { t, locale, setLocale } = useLocale()
  const email = publicSupportEmail()

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-10 bg-parchment-50 dark:bg-ink-950"
      data-privacy-shell={PRIVACY_DRAFT_MARKER}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
        className="w-full max-w-lg"
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
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-amber-800 dark:text-amber-300/90">
            <ShieldAlert size={14} aria-hidden="true" />
            {t('privacyPage.draftMarker')}
          </p>
          <h1 className="mt-2 font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            {t('privacyPage.title')}
          </h1>
          <p role="status" className="mt-4 text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">
            {t('privacyPage.notPublished')}
          </p>
          <p className="mt-3 text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">
            {t('privacyPage.body')}
          </p>
          <p className="mt-4 text-sm text-ink-600 dark:text-parchment-300/80">
            <a
              href={`mailto:${email}`}
              className="tap-reach inline-block font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors focus:outline-none focus:ring-2 focus:ring-brass-400 rounded-sm"
            >
              {t('privacyPage.questions', { email })}
            </a>
          </p>
        </div>

        <p className="mt-5 text-center text-sm text-ink-500 dark:text-parchment-300/70">
          <Link
            to="/login"
            className="tap-reach inline-block font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
          >
            {t('privacyPage.backLogin')}
          </Link>
          {' · '}
          <Link
            to="/contact"
            className="tap-reach inline-block font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
          >
            {t('privacyPage.contact')}
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
