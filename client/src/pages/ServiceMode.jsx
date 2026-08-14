import { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { X, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'

// Service Mode (OPS.2) — the run-sheet, full screen, for the sound desk
// or the sacristy counter during the liturgy itself. One element at a
// time in large serif type, what's next in the margin, nothing that
// blinks. Arrow keys / taps advance; Esc leaves. A read surface: the
// plan is edited in the Worship planner, never here.

export default function ServiceMode() {
  const { planId } = useParams()
  const { t } = useLocale()
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState('')
  const [idx, setIdx] = useState(0)
  const [clock, setClock] = useState(() => new Date())

  useEffect(() => {
    fetch(apiUrl(`/api/service-plans/${planId}`))
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(setPlan)
      .catch(() => setError(t('svc.loadError')))
  }, [planId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const tick = setInterval(() => setClock(new Date()), 30_000)
    return () => clearInterval(tick)
  }, [])

  const total = plan?.elements?.length ?? 0
  const next = useCallback(() => setIdx(i => Math.min(i + 1, Math.max(total - 1, 0))), [total])
  const prev = useCallback(() => setIdx(i => Math.max(i - 1, 0)), [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); next() }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev() }
      else if (e.key === 'Escape') { window.history.back() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev])

  if (error) {
    return (
      <div className="fixed inset-0 z-50 bg-parchment-50 dark:bg-ink-950 flex items-center justify-center p-8 text-center">
        <div>
          <p className="text-ink-700 dark:text-parchment-200">{error}</p>
          <Link to="/service-planner" className="mt-3 inline-block text-sm font-semibold text-church-700 dark:text-brass-300 hover:underline">{t('svc.back')}</Link>
        </div>
      </div>
    )
  }
  if (!plan) {
    return <div className="fixed inset-0 z-50 bg-parchment-50 dark:bg-ink-950 flex items-center justify-center"><Loader2 size={26} className="animate-spin text-brass-600" /></div>
  }

  const el = plan.elements[idx]
  const upcoming = plan.elements.slice(idx + 1, idx + 4)

  return (
    <div className="fixed inset-0 z-50 bg-parchment-50 dark:bg-ink-950 flex flex-col select-none">
      {/* Header — quiet: plan title, date, clock, exit. */}
      <div className="flex items-center justify-between px-8 py-5 border-b border-parchment-300/60 dark:border-brass-900/30">
        <div>
          <p className="font-display text-xl font-bold text-church-800 dark:text-parchment-50">{plan.title}</p>
          <p className="text-xs text-ink-500 dark:text-parchment-300/70">{plan.date}</p>
        </div>
        <div className="flex items-center gap-6">
          <p className="font-display text-2xl text-brass-700 dark:text-brass-300">
            {clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </p>
          <Link to="/service-planner" aria-label={t('svc.exit')}
            className="p-2 rounded-lg text-ink-400 hover:text-church-700 dark:hover:text-brass-300">
            <X size={22} />
          </Link>
        </div>
      </div>

      {/* Current element — the only loud thing on the screen. */}
      <div className="flex-1 flex items-center justify-center px-8 cursor-pointer" onClick={next}>
        {total === 0 ? (
          <p className="text-ink-500 dark:text-parchment-300/70">{t('svc.empty')}</p>
        ) : (
          <div className="max-w-3xl text-center">
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-brass-700 dark:text-brass-300 mb-4">
              {el.kind} · {idx + 1} / {total}
            </p>
            <h1 className="font-display text-5xl md:text-6xl font-bold text-ink-900 dark:text-parchment-50 leading-tight">
              {el.title}
            </h1>
            {el.reference && (
              <p className="mt-4 font-display text-2xl italic text-church-700 dark:text-brass-200">{el.reference}</p>
            )}
            {el.assigned_name && (
              <p className="mt-5 text-lg text-ink-600 dark:text-parchment-300">{el.assigned_name}</p>
            )}
            {el.notes && (
              <p className="mt-4 text-sm text-ink-500 dark:text-parchment-300/70 max-w-xl mx-auto">{el.notes}</p>
            )}
          </div>
        )}
      </div>

      {/* Footer — controls + what's next. */}
      <div className="px-8 py-5 border-t border-parchment-300/60 dark:border-brass-900/30 flex items-center justify-between gap-6">
        <div className="flex items-center gap-2">
          <button type="button" onClick={prev} disabled={idx === 0} aria-label={t('svc.prev')}
            className="p-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 disabled:opacity-30">
            <ChevronLeft size={18} />
          </button>
          <button type="button" onClick={next} disabled={idx >= total - 1} aria-label={t('svc.next')}
            className="p-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 disabled:opacity-30">
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="flex-1 min-w-0 flex items-center justify-end gap-6">
          {upcoming.map(u => (
            <p key={u.id} className="text-sm text-ink-500 dark:text-parchment-300/60 truncate">
              <span className="text-[10px] uppercase tracking-wider mr-1.5">{u.kind}</span>{u.title}
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}
