import { useEffect, useState } from 'react'
import { Feather, Infinity as InfinityIcon } from 'lucide-react'
import { apiUrl } from '../api'
import { useToast } from './ToastProvider'
import { useLocale } from '../i18n'

// Compact AI quota meter for the AI Studio header. Reads
// /api/ai/quota and renders "X / Y this month" with a colored bar.
// Unlimited plans render an "Unlimited" pill with no bar.
//
// Re-fetches whenever `refreshKey` changes — the parent (AI.jsx)
// bumps it after a successful generation so the meter ticks up.

function colorFor(ratio) {
  if (ratio >= 0.9) return { bar: 'bg-rose-500',    text: 'text-rose-700 dark:text-rose-300' }
  if (ratio >= 0.7) return { bar: 'bg-amber-500',   text: 'text-amber-700 dark:text-amber-300' }
  return                   { bar: 'bg-brass-500', text: 'text-brass-700 dark:text-brass-300' }
}

function fmtPeriodEnd(iso, dateLocale) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })
}

// Threshold at which the heads-up toast fires. We picked 80% so
// admins still have meaningful runway (4 generations on free, 100
// on pro) before they hit the 429 wall.
const WARN_AT_RATIO = 0.8

// Per-period localStorage key. The period_start changes when the
// month rolls, so the flag naturally invalidates and a new month
// at >=80% will warn again. Plan changes that lower the limit
// mid-period will also re-fire because the period_start is the
// same but the user newly crossed the threshold from below.
function warnFlagKey(periodStart) {
  return `ochr_ai_quota_warned_${periodStart}`
}

export default function AiQuotaMeter({ refreshKey = 0 }) {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState(false)
  const toast = useToast()
  const { t, dateLocale } = useLocale()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(apiUrl('/api/ai/quota'))
      .then(async r => {
        if (!r.ok) throw new Error()
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        setData(d)
        setErr(false)
        // Heads-up warning at first crossing of WARN_AT_RATIO. We
        // skip when the plan is unlimited (limit === null) and when
        // the user is already exceeded — they get the 429 toast on
        // the next /generate, which is a louder signal than this.
        if (d.limit !== null && !d.exceeded) {
          const ratio = d.used / d.limit
          if (ratio >= WARN_AT_RATIO) {
            try {
              const key = warnFlagKey(d.period_start)
              if (!localStorage.getItem(key)) {
                localStorage.setItem(key, '1')
                const reset = fmtPeriodEnd(d.period_end, dateLocale)
                const left  = d.limit - d.used
                toast.info(
                  t('quota.warn', { used: d.used, limit: d.limit, left }) +
                  (reset ? ` ${t('quota.resets', { date: reset })}` : '')
                )
              }
            } catch {
              // localStorage disabled — degrade silently. The user
              // gets the warning on this load (and possibly future
              // loads); not great but not harmful.
            }
          }
        }
      })
      .catch(()  => { if (!cancelled) setErr(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refreshKey, toast])

  // Don't render anything while we're still loading or if the call
  // failed — the meter is decorative; a missing one shouldn't push
  // the layout around or imply an error.
  if (loading || err || !data) return null

  // Unlimited plan — short pill, no bar.
  if (data.limit === null) {
    return (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-brass-50 dark:bg-brass-900/20 border border-brass-200/70 dark:border-brass-800/40 text-xs">
        <InfinityIcon size={12} className="text-brass-700 dark:text-brass-300" />
        <span className="font-semibold text-brass-700 dark:text-brass-300">{t('quota.unlimited')}</span>
        <span className="text-brass-700/70 dark:text-brass-300/70 capitalize">· {data.plan}</span>
      </div>
    )
  }

  const ratio   = Math.min(data.used / data.limit, 1)
  const c       = colorFor(ratio)
  const reset   = fmtPeriodEnd(data.period_end, dateLocale)
  const left    = Math.max(0, data.limit - data.used)
  const warning = ratio >= WARN_AT_RATIO

  // Diagonal stripe overlay at warning threshold — adds visual urgency
  // without changing the semantic color (still rose/amber for screen
  // readers via the count text). Repeating-linear-gradient at 45deg
  // with 4px stripes reads as 'caution tape' at the meter's small
  // size without becoming busy.
  const barStyle = {
    width: `${ratio * 100}%`,
    ...(warning && {
      backgroundImage:
        'repeating-linear-gradient(45deg, transparent 0, transparent 4px, rgba(0,0,0,0.18) 4px, rgba(0,0,0,0.18) 8px)',
    }),
  }

  return (
    <div
      className="inline-flex flex-col gap-1 px-3 py-1.5 rounded-xl bg-parchment-50 dark:bg-ink-900 border border-parchment-300/60 dark:border-brass-900/30 min-w-[180px]"
      title={reset ? t('quota.resets', { date: reset }) : undefined}
    >
      <div className="flex items-center gap-2 text-xs">
        <Feather size={12} className={c.text} />
        <span className={`font-semibold ${c.text}`}>
          {data.used} / {data.limit}
        </span>
        <span className="text-ink-500 dark:text-parchment-300/70">{t('quota.thisMonth')}</span>
      </div>
      <div className="h-1 rounded-full bg-parchment-200 dark:bg-ink-700 overflow-hidden">
        <div
          className={`h-full ${c.bar} transition-all duration-300`}
          style={barStyle}
        />
      </div>
      {/* Persistent remaining-count line at warning threshold. The
          one-shot toast in the fetch effect fires once per period
          (localStorage flag) — this keeps the signal visible every
          time the user looks at the meter after that. */}
      {warning && (
        <p className={`text-[10px] font-medium leading-tight ${c.text}`}>
          {data.exceeded
            ? `${t('quota.reached')}${reset ? ` · ${t('quota.resets', { date: reset })}` : ''}`
            : `${t('quota.left', { n: left })}${reset ? ` · ${t('quota.resets', { date: reset })}` : ''}`}
        </p>
      )}
    </div>
  )
}
