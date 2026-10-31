// SP-185 (Saint, 2026-10-25): after Sunday Mass the Dashboard said nothing
// about this morning's intentions. A calm prompt — not an alert, not a
// count of anything "missed" — appears for the parish secretary and the
// administrator (the roles that may mark said) when today's Masses have
// begun and intentions on them have no fulfilment recorded yet.
//
// Read-only. It never marks anything said; it opens the intention book on
// the "Past scheduled — fulfilment not recorded" filter, where the operator
// confirms each one. The server decides which rows count (parish clock,
// linked Mass start time); this only keeps those dated today.
// A failed read shows nothing: the prompt is a convenience, and its
// absence is not a statement that nothing is waiting.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { parishTodayIso } from '../utils/markSaid'

const MAY_MARK_SAID = new Set(['admin', 'staff'])

export default function AfterMassIntentionsPrompt() {
  const { user } = useAuth()
  const { t } = useLocale()
  const [count, setCount] = useState(0)
  const allowed = MAY_MARK_SAID.has(user?.role)
  const tz = user?.organization?.timezone

  useEffect(() => {
    if (!allowed) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(apiUrl('/api/mass-intentions?view=past_scheduled'))
        if (!res.ok) return
        const body = await res.json()
        if (cancelled || !Array.isArray(body?.intentions)) return
        const today = parishTodayIso(tz)
        setCount(body.intentions.filter(r => r.past_scheduled === true && r.mass_date === today).length)
      } catch {
        // Unread: show nothing rather than a guess.
      }
    })()
    return () => { cancelled = true }
  }, [allowed, tz])

  if (!allowed || count < 1) return null
  return (
    <section
      data-testid="after-mass-prompt"
      aria-labelledby="after-mass-prompt-title"
      className="flex items-start gap-3 rounded-2xl border border-brass-200/70 dark:border-brass-800/40 bg-parchment-50 dark:bg-ink-900 px-5 py-4 shadow-warm"
    >
      <BookOpen size={18} className="shrink-0 mt-0.5 text-brass-600 dark:text-brass-300" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <h2 id="after-mass-prompt-title" className="font-display text-base font-semibold text-ink-900 dark:text-parchment-50">
          {t('dash.miPromptTitle')}
        </h2>
        <p className="text-sm text-ink-600 dark:text-parchment-300/80 mt-0.5">
          {t('dash.miPromptBody', { count })}
        </p>
      </div>
      <Link
        to="/mass-intentions?view=past_scheduled"
        className="shrink-0 self-center px-3 py-1.5 rounded-lg text-sm font-semibold text-church-900 dark:text-brass-200 hover:bg-parchment-100 dark:hover:bg-ink-800 transition-colors"
      >
        {t('dash.miPromptAction')}
      </Link>
    </section>
  )
}
