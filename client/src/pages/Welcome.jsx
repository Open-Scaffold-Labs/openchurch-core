import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Users, Calendar, CheckSquare, Feather, ArrowRight } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'

// One-time welcome screen shown immediately after signup. Intentionally
// minimal — no sidebar, no header — so first impression is focus, not
// navigation. Once the user clicks through, they land on the Dashboard
// which has sample rows preloaded so nothing feels empty AND a
// "Get started" checklist at the top driving them through the first
// four actions (Sprint O / O.1).
//
// Not in the sidebar; only reachable via post-signup redirect or a
// direct URL. That's deliberate — it's a moment, not a destination.
//
// Card titles and bodies go through t(). The four modules and their
// destinations are unchanged: Dashboard `/` and add-member `/clients?new=1`.

function orientation(t) {
  return [
    { id: 'members', icon: Users,       title: t('welcome.members'), body: t('welcome.membersBody') },
    { id: 'events',  icon: Calendar,    title: t('welcome.events'),  body: t('welcome.eventsBody') },
    { id: 'tasks',   icon: CheckSquare, title: t('welcome.tasks'),   body: t('welcome.tasksBody') },
    { id: 'studio',  icon: Feather,     title: t('welcome.studio'),  body: t('welcome.studioBody') },
  ]
}

function firstName(full) {
  if (!full) return ''
  return String(full).trim().split(/\s+/)[0]
}

export default function Welcome() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { t } = useLocale()
  const orgName  = user?.organization?.name || t('welcome.orgFallback')
  const name = firstName(user?.name)

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-parchment-50 dark:bg-ink-950">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.25, 0.1, 0.25, 1] }}
        className="w-full max-w-2xl"
      >
        <div className="flex items-center justify-center gap-3 mb-10">
          <div className="w-11 h-11 rounded-xl bg-church-900 dark:bg-brass-200 flex items-center justify-center shadow-warm-md">
            <svg width="18" height="22" viewBox="0 0 14 18" fill="currentColor" className="text-brass-200 dark:text-church-900">
              <rect x="5.5" y="0"  width="3"  height="18" rx="1" />
              <rect x="0"   y="4"  width="14" height="3"  rx="1" />
            </svg>
          </div>
          <span className="font-display text-3xl font-semibold text-church-900 dark:text-parchment-100 leading-none">
            OpenChurch
          </span>
        </div>

        <div className="text-center mb-10">
          <h1 className="font-display text-4xl md:text-5xl font-semibold text-ink-900 dark:text-parchment-50 leading-tight">
            {name ? t('welcome.hello', { name }) : t('welcome.helloAnon')}
          </h1>
          <p className="mt-4 text-base md:text-lg text-ink-600 dark:text-parchment-300/80 max-w-xl mx-auto leading-relaxed">
            {t('welcome.bodyBefore')}
            <span className="font-semibold text-church-800 dark:text-brass-200">{orgName}</span>
            {t('welcome.bodyAfter')}
            {' '}
            {t('welcome.bodyHelp')}
          </p>
        </div>

        <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm-md p-6 md:p-8">
          <p className="text-xs font-semibold uppercase tracking-wider text-brass-600 dark:text-brass-300 mb-4">
            {t('welcome.inside')}
          </p>
          <div className="grid sm:grid-cols-2 gap-5">
            {orientation(t).map(({ id, icon: Icon, title, body }) => (
              <div key={id} className="flex gap-3">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-church-50 dark:bg-church-900/40 flex items-center justify-center text-church-800 dark:text-brass-300">
                  <Icon size={17} />
                </div>
                <div>
                  <h3 className="font-display text-base font-semibold text-ink-900 dark:text-parchment-50">
                    {title}
                  </h3>
                  <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70 leading-relaxed">
                    {body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/', { replace: true })}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
          >
            {t('welcome.cta')}
            <ArrowRight size={15} />
          </button>
          <Link
            to="/clients?new=1"
            replace
            className="text-xs font-medium text-ink-500 hover:text-church-800 dark:text-parchment-300/60 dark:hover:text-brass-200 transition-colors"
          >
            {t('welcome.addMember')}
          </Link>
        </div>
      </motion.div>
    </div>
  )
}
