// Offer an intention at the Mass the secretary has open (MI.4).
// The book stays the editor for text, requester, and offering; this
// panel carries the one trusted fact — which Mass offers it — so the
// week, the weekly sheet, and the Sunday Packet stay in agreement.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { useToast } from './ToastProvider'
import { mutate } from '../utils/format'
import { isMassCalendarEvent } from '../utils/massEvent'
import { splitDeathMark } from '../utils/deathMark'


// Continuity: the Mass drawer already knows which calendar event and date
// are open. The book hop must carry those ids — never invent a Mass from
// a title, and never drop a Mass the secretary was already preparing.
export function intentionBookHref(event) {
  const qs = new URLSearchParams()
  const rawId = event?.id
  const n = Number(rawId)
  const hasEvent = Number.isInteger(n) && n > 0 && String(n) === String(rawId).trim()
  if (hasEvent) qs.set('event', String(n))
  const date = event?.date != null ? String(event.date).slice(0, 10) : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) qs.set('date', date)
  // One-shot form open is separate from the durable Mass id. Schedule→book
  // adds compose=1 only when a real event is known. Date-only hops stay
  // date context and do not auto-open.
  if (hasEvent) qs.set('compose', '1')
  const q = qs.toString()
  return q ? `/mass-intentions?${q}` : '/mass-intentions'
}

// SP-158: † only for an intention for the departed (same rule as the book).
function DeathMarkedText({ text }) {
  const { departed, text: body } = splitDeathMark(text)
  return <>{departed && <><span className="font-display">†</span>{' '}</>}{body}</>
}

function displayIntention(t) {
  if (!t) return t
  return /^\s*[†+]/.test(t) ? `† ${t.replace(/^\s*[†+]\s*/, '')}` : t
}

export default function MassIntentionAssign({
  event,
  assigned = [],
  assignedFailed = false,
  onChanged,
}) {
  const { canWrite } = useAuth()
  const { t } = useLocale()
  const toast = useToast()
  const eventDate = event?.date ? String(event.date).slice(0, 10) : ''

  const [awaiting, setAwaiting] = useState([])
  const [awaitingState, setAwaitingState] = useState(isMassCalendarEvent(event) ? 'loading' : 'ok') // loading | ok | failed
  const [busyId, setBusyId] = useState(null)
  // The intention just assigned arrives in this Mass's list with a brief
  // brass glow, so staff see exactly where it went (V1.5, study #8).
  const [justAssignedId, setJustAssignedId] = useState(null)
  const glowTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(glowTimerRef.current), [])
  const busyRef = useRef(false)
  const [actionError, setActionError] = useState(null)
  // SP-159: Release asks first. Nothing is sent until the second click.
  const [confirmReleaseId, setConfirmReleaseId] = useState(null)

  const loadAwaiting = useCallback(() => {
    if (!isMassCalendarEvent(event)) return () => {}
    // Viewers only see assigned intentions; awaiting is a write lane.
    if (!canWrite) { setAwaitingState('ok'); setAwaiting([]); return () => {} }
    if (!eventDate) { setAwaitingState('ok'); setAwaiting([]); return () => {} }
    let cancelled = false
    setAwaitingState('loading')
    fetch(apiUrl(`/api/mass-intentions/awaiting?date=${eventDate}`))
      .then(async (r) => {
        if (!r.ok) throw new Error('awaiting')
        return r.json()
      })
      .then((d) => {
        if (cancelled) return
        setAwaiting(Array.isArray(d.intentions) ? d.intentions : [])
        setAwaitingState('ok')
      })
      .catch(() => {
        if (cancelled) return
        setAwaitingState('failed')
      })
    return () => { cancelled = true }
  }, [event, eventDate, canWrite])

  useEffect(() => {
    const cancel = loadAwaiting()
    return cancel
  }, [loadAwaiting])

  // SP-078: assigning moves an Open intention to Scheduled, and releasing
  // moves a Scheduled one back to Open, on the server. Say so — but only
  // when the confirmed row's status actually differs from what we showed.
  const run = async (intentionId, path, body, successKey, priorStatus) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyId(intentionId)
    setActionError(null)
    const { ok, data, error } = await mutate(apiUrl(`/api/mass-intentions/${intentionId}/${path}`), {
      method: 'POST',
      body,
    })
    busyRef.current = false
    setBusyId(null)
    if (!ok) {
      const code = data && typeof data.code === 'string' ? data.code : ''
      setActionError(code === 'stamped_history'
        ? t('mi.stampedHistory')
        : code === 'stamp_conflict'
          ? t('mi.stampConflict')
          : (error || t('sched.assignFailed')))
      loadAwaiting()
      onChanged?.()
      return
    }
    const nextStatus = data && typeof data.status === 'string' ? data.status : null
    const changed = nextStatus && priorStatus && nextStatus !== priorStatus
      && ['open', 'scheduled'].includes(nextStatus)
    toast.success(changed
      ? `${t(successKey)} ${t('mi.status')}: ${nextStatus === 'scheduled' ? t('mi.scheduled') : t('mi.open')}.`
      : t(successKey))
    if (path === 'assign') {
      setJustAssignedId(intentionId)
      clearTimeout(glowTimerRef.current)
      glowTimerRef.current = setTimeout(() => setJustAssignedId(null), 4000) // outlasts the refetch; animates once
    }
    loadAwaiting()
    onChanged?.(data)
  }

  const offer = (mi) => run(mi.id, 'assign', {
    calendar_event_id: event.id,
    expected_calendar_event_id: mi.calendar_event_id ?? null,
  }, 'sched.assignedToast', mi.status)

  const release = (mi) => { setConfirmReleaseId(null); return run(mi.id, 'unassign', {
    expected_calendar_event_id: event.id,
  }, 'sched.releasedToast', mi.status) }

  if (!isMassCalendarEvent(event)) return null

  return (
    <div className="px-2.5 py-2 rounded-md border border-brass-200/70 dark:border-brass-800/40 bg-brass-50 dark:bg-brass-900/20">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300 mb-1">
        {t('sched.intentions')}
      </p>

      {assignedFailed ? (
        <p role="status" className="text-xs text-amber-800 dark:text-amber-300 mb-2">
          {t('sched.intentionsFailed')}
        </p>
      ) : assigned.length > 0 ? (
        <ul className="space-y-1 mb-2">
          {assigned.map(mi => (
            <li key={mi.id} className={`flex items-start justify-between gap-2 text-xs text-ink-800 dark:text-parchment-100 rounded${mi.id === justAssignedId ? ' row-arrive slot-glow' : ''}`}>
              <span className="min-w-0">
                <DeathMarkedText text={mi.formatted_intention || mi.intention} />
                {mi.requester_name || mi.requested_by ? (
                  <span className="text-ink-500 dark:text-parchment-300/70"> — {mi.requester_name || mi.requested_by}</span>
                ) : null}
              </span>
              {/* SP-182: a fulfilled intention stays with the Mass that offered
                  it (the server refuses release too), so no Release is offered. */}
              {mi.status === 'fulfilled' && (
                <span data-testid="mi-said-badge" className="shrink-0 text-[11px] font-semibold text-brass-700 dark:text-brass-300">
                  {t('sched.saidBadge')}
                </span>
              )}
              {canWrite && mi.status !== 'fulfilled' && confirmReleaseId === mi.id && (
                <span role="group" aria-label={t('sched.releaseConfirmTitle')} className="shrink-0 flex flex-col items-end gap-1 max-w-[14rem]">
                  <span className="text-[11px] text-ink-600 dark:text-parchment-300/80 text-right">{t('sched.releaseConfirmBody')}</span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmReleaseId(null)}
                      className="text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 hover:underline"
                    >
                      {t('sched.releaseKeep')}
                    </button>
                    <button
                      type="button"
                      data-testid="mi-release-confirm"
                      disabled={busyId != null}
                      onClick={() => release(mi)}
                      className="text-[11px] font-semibold text-church-800 dark:text-brass-300 hover:underline disabled:opacity-60"
                    >
                      {busyId === mi.id ? <Loader2 size={12} className="animate-spin" /> : t('sched.releaseConfirm')}
                    </button>
                  </span>
                </span>
              )}
              {canWrite && mi.status !== 'fulfilled' && confirmReleaseId !== mi.id && (
                <button
                  type="button"
                  disabled={busyId != null}
                  onClick={() => setConfirmReleaseId(mi.id)}
                  aria-label={`${t('sched.release')}: ${displayIntention(mi.formatted_intention || mi.intention)}`}
                  className="shrink-0 text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 hover:text-church-800 dark:hover:text-brass-300 disabled:opacity-60"
                >
                  {busyId === mi.id ? <Loader2 size={12} className="animate-spin" /> : t('sched.release')}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-500 dark:text-parchment-300/70 mb-2">{t('sched.noneOnMass')}</p>
      )}

      {canWrite && (
        <div className="pt-1.5 border-t border-brass-200/50 dark:border-brass-800/30">
          <p className="text-[11px] font-semibold text-ink-600 dark:text-parchment-200 mb-1">
            {t('sched.awaiting')}
          </p>
          {awaitingState === 'loading' && (
            <p role="status" className="text-xs text-ink-500 dark:text-parchment-300/70 italic">
              {t('sched.awaitingLoading')}
            </p>
          )}
          {awaitingState === 'failed' && (
            <div role="status">
              <p className="text-xs text-amber-800 dark:text-amber-300">{t('sched.awaitingFailed')}</p>
              <button
                type="button"
                onClick={loadAwaiting}
                className="mt-1 text-[11px] font-semibold text-brass-700 dark:text-brass-300 hover:underline"
              >
                {t('sched.awaitingRetry')}
              </button>
            </div>
          )}
          {awaitingState === 'ok' && awaiting.length === 0 && (
            <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('sched.awaitingEmpty')}</p>
          )}
          {awaitingState === 'ok' && awaiting.length > 0 && (
            <ul className="space-y-1">
              {awaiting.map(mi => (
                <li key={mi.id} className="flex items-start justify-between gap-2 text-xs text-ink-800 dark:text-parchment-100">
                  <span className="min-w-0">
                    <DeathMarkedText text={mi.intention} />
                    {mi.requester_name || mi.requested_by ? (
                      <span className="text-ink-500 dark:text-parchment-300/70"> — {mi.requester_name || mi.requested_by}</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    disabled={busyId != null}
                    onClick={() => offer(mi)}
                    aria-label={`${t('sched.offerHere')}: ${displayIntention(mi.intention)}`}
                    className="shrink-0 inline-flex items-center px-2 py-1 rounded-lg bg-church-800 text-parchment-50 text-[11px] font-semibold hover:bg-church-900 disabled:opacity-60"
                  >
                    {busyId === mi.id ? <Loader2 size={12} className="animate-spin" /> : t('sched.offerHere')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {actionError && (
        <p role="status" className="mt-2 text-xs text-rose-700 dark:text-rose-300">{actionError}</p>
      )}

      {canWrite ? (
        <Link to={intentionBookHref(event)} className="mt-2 inline-block text-[11px] font-semibold text-brass-700 dark:text-brass-300 hover:underline">
          {t('sched.openBook')}
        </Link>
      ) : (
        <Link to="/mass-intentions/print" className="mt-2 inline-block text-[11px] font-semibold text-brass-700 dark:text-brass-300 hover:underline">
          {t('sched.openWeeklySheet')}
        </Link>
      )}
    </div>
  )
}
