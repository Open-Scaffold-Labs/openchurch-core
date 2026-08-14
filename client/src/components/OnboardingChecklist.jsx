import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, Circle, X, ArrowRight, Feather } from 'lucide-react'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'

// "Get started" checklist card on the Dashboard. Surfaces the four
// or five first actions that take a brand-new church admin from
// "I just signed up" to "I've actually wired this up to my church."
//
// Data: GET /api/onboarding/status returns has_real_members /
// has_real_events / has_letterhead / has_team_invited as booleans
// (Sprint O / O.1 server extension). The checklist computes the
// 'done' state directly from those flags rather than relying on
// the admin to manually check items off.
//
// Dismiss model:
//   - Auto-hides when ALL items are done (the admin has clearly
//     transitioned out of first-run).
//   - Hides when admin clicks the × — flag stored in localStorage
//     under `ochr_onboarding_dismissed` so refresh respects the
//     choice. Per-browser, not per-org — by design; the next teammate
//     who logs in sees it fresh.
//
// Quiet by default: skipped entirely for non-admins (the items they
// can't act on would just be a wall of frustration). Hidden during
// the initial fetch so the layout doesn't jump.

const DISMISS_KEY = 'ochr_onboarding_dismissed'

function isDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1' }
  catch { return false }
}

function setDismissed() {
  try { localStorage.setItem(DISMISS_KEY, '1') } catch {}
}

// Each item: a 'done' predicate over the status payload + the page
// it links to + the copy. Order matters — the admin sees this top
// to bottom, so the first item should be the most-likely first move.
const CHECKLIST = [
  {
    key:  'real_members',
    done: s => s.has_real_members,
    to:   '/clients?new=1',
    label: 'Add your first member',
    body:  'A real parishioner, staff member, or volunteer — not the [Sample] ones.',
  },
  {
    key:  'real_events',
    done: s => s.has_real_events,
    to:   '/events?new=1',
    label: 'Add your first event',
    body:  'A service, feast day, meeting, or one-off. Assign members so everyone knows who is responsible.',
  },
  {
    key:  'letterhead',
    done: s => s.has_letterhead,
    to:   '/settings',
    label: 'Set your church letterhead',
    body:  'EIN and signatory name — powers year-end giving statements.',
  },
  {
    key:  'team',
    done: s => s.has_team_invited,
    to:   '/team',
    label: 'Invite a teammate',
    body:  'Share the workload — pastors, staff, or volunteer coordinators.',
  },
  {
    key:  'published_page',
    done: s => s.has_published_page,
    to:   '/settings',
    label: 'Publish your church page',
    body:  'A public homepage at /p/your-church — service times, a welcome, and how to find you.',
  },
]

export default function OnboardingChecklist() {
  const { user } = useAuth()
  const isAdmin  = user?.role === 'admin'

  const [status, setStatus]   = useState(null)
  const [dismissed, setDis]   = useState(() => isDismissed())

  useEffect(() => {
    if (!isAdmin || dismissed) return
    let cancelled = false
    fetch(apiUrl('/api/onboarding/status'))
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (!cancelled) setStatus(s) })
      .catch(() => { /* silent — banner just stays hidden on failure */ })
    return () => { cancelled = true }
  }, [isAdmin, dismissed])

  if (!isAdmin || dismissed || !status) return null

  const items = CHECKLIST.map(item => ({ ...item, isDone: item.done(status) }))
  const doneCount  = items.filter(i => i.isDone).length
  const totalCount = items.length

  // All done → don't show the card at all. Admin doesn't need a
  // congratulations banner taking up Dashboard real estate forever.
  if (doneCount === totalCount) return null

  function dismiss() {
    setDismissed()
    setDis(true)
  }

  return (
    <AnimatePresence>
      <motion.section
        key="onboarding-checklist"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.25 }}
        aria-label="Onboarding checklist"
        className="rounded-2xl border border-brass-200/70 dark:border-brass-900/40 bg-gradient-to-br from-brass-50 to-parchment-50 dark:from-ink-900 dark:to-ink-900/80 shadow-warm p-5"
      >
        {/* Header — progress label + dismiss */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Feather size={14} className="text-brass-700 dark:text-brass-300" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">
              Get started
            </h2>
            <span className="text-[11px] font-medium text-ink-500 dark:text-parchment-300/70">
              {doneCount} of {totalCount} done
            </span>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss onboarding checklist"
            className="-m-2 p-2 text-ink-400 dark:text-parchment-400/60 hover:text-ink-700 dark:hover:text-parchment-100 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Progress bar — tiny, animated. Brass fills as items complete. */}
        <div className="h-1 rounded-full bg-parchment-200/80 dark:bg-ink-800 overflow-hidden mb-4">
          <motion.div
            className="h-full bg-brass-500 dark:bg-brass-400"
            initial={{ width: 0 }}
            animate={{ width: `${(doneCount / totalCount) * 100}%` }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          />
        </div>

        {/* Items */}
        <ul className="space-y-1">
          {items.map(item => (
            <li key={item.key}>
              <Link
                to={item.to}
                className={`group flex items-start gap-3 px-3 py-2 rounded-lg transition-colors ${
                  item.isDone
                    ? 'opacity-60 hover:opacity-100 hover:bg-parchment-100/60 dark:hover:bg-ink-800/40'
                    : 'hover:bg-parchment-100/80 dark:hover:bg-ink-800/60'
                }`}
              >
                <span className="shrink-0 mt-0.5">
                  {item.isDone
                    ? <CheckCircle2 size={16} className="text-brass-600 dark:text-brass-400" />
                    : <Circle size={16} className="text-ink-400 dark:text-parchment-400/60 group-hover:text-brass-600 dark:group-hover:text-brass-400 transition-colors" />
                  }
                </span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-semibold ${
                    item.isDone
                      ? 'text-ink-500 dark:text-parchment-300/60 line-through decoration-1'
                      : 'text-ink-900 dark:text-parchment-50'
                  }`}>
                    {item.label}
                  </p>
                  {!item.isDone && (
                    <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5 leading-snug">
                      {item.body}
                    </p>
                  )}
                </div>
                {!item.isDone && (
                  <ArrowRight size={14} className="shrink-0 mt-1 text-ink-400 dark:text-parchment-400/60 group-hover:text-church-700 dark:group-hover:text-brass-200 transition-colors" />
                )}
              </Link>
            </li>
          ))}
        </ul>
      </motion.section>
    </AnimatePresence>
  )
}
