import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Users, Calendar, CheckSquare, Feather, ArrowRight } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

// One-time welcome screen shown immediately after signup. Intentionally
// minimal — no sidebar, no header — so first impression is focus, not
// navigation. Once the user clicks through, they land on the Dashboard
// which has sample rows preloaded so nothing feels empty AND a
// "Get started" checklist at the top driving them through the first
// four actions (Sprint O / O.1).
//
// Not in the sidebar; only reachable via post-signup redirect or a
// direct URL. That's deliberate — it's a moment, not a destination.

const ORIENTATION = [
  { icon: Users,       title: 'Members',   body: 'Your directory of parishioners, volunteers, and staff. Add roles, tags, and contact info.' },
  { icon: Calendar,    title: 'Events',    body: 'Services, feast days, meetings, and one-offs. Assign members so each event knows who’s responsible.' },
  { icon: CheckSquare, title: 'Tasks',     body: 'The rolling checklist of things to do before, during, and after service. Grouped by category.' },
  { icon: Feather,    title: 'AI Studio', body: 'Generate bulletins, newsletters, and announcements from a short prompt — in English or Spanish.' },
]

function firstName(full) {
  if (!full) return 'there'
  return String(full).trim().split(/\s+/)[0]
}

export default function Welcome() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const orgName  = user?.organization?.name || 'your church'

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
            Welcome, {firstName(user?.name)}.
          </h1>
          <p className="mt-4 text-base md:text-lg text-ink-600 dark:text-parchment-300/80 max-w-xl mx-auto leading-relaxed">
            Your workspace for <span className="font-semibold text-church-800 dark:text-brass-200">{orgName}</span> is ready.
            We've filled it with a few sample rows so the pages aren't empty,
            and the Dashboard has a short checklist to guide your first steps.
          </p>
        </div>

        <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm-md p-6 md:p-8">
          <p className="text-xs font-semibold uppercase tracking-wider text-brass-600 dark:text-brass-300 mb-4">
            Here’s what’s inside
          </p>
          <div className="grid sm:grid-cols-2 gap-5">
            {ORIENTATION.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex gap-3">
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
            Go to my dashboard & checklist
            <ArrowRight size={15} />
          </button>
          <Link
            to="/clients?new=1"
            replace
            className="text-xs font-medium text-ink-500 hover:text-church-800 dark:text-parchment-300/60 dark:hover:text-brass-200 transition-colors"
          >
            Or jump straight to adding a member
          </Link>
        </div>
      </motion.div>
    </div>
  )
}
