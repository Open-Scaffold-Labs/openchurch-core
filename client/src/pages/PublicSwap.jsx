import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, AlertTriangle, X, Calendar, Send, Inbox, Clock, RefreshCw } from 'lucide-react'
import { apiUrl } from '../api'
import { parseLocalDate } from '../utils/dates'
import { useLocale } from '../i18n'

// VS.2 — Public parishioner swap-request page.
//
// Token-gated; no login. The admin generates a per-member swap_token
// from the member-detail page, sends the resulting /p/swap/:token
// link to the member (email, SMS, paper). The member opens the link,
// sees their upcoming assignments + active swap requests, and acts:
//   - "Request swap" on an assignment → opens a modal to pick a
//     target from the roster + leave a short note.
//   - Incoming pending → Accept (executes the swap) / Decline.
//   - Outgoing pending → Cancel.
//
// Layout matches the PublicForm / PublicEvents shell: same parchment
// background, same brand wordmark + "Powered by OpenChurch" footer,
// so the page reads as a church-handed-out link, not a SaaS surface.

function fmtDate(iso) {
  if (!iso) return ''
  // Shift dates are bare 'YYYY-MM-DD'. new Date(str) parses as UTC and
  // renders a day early in negative-offset zones; parseLocalDate keeps
  // it on the intended local day (1.1).
  const d = parseLocalDate(iso)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function fmtTime(hms) {
  if (!hms) return ''
  const [h, m] = hms.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`
}

export default function PublicSwap() {
  // Remaining chrome (greeting, serving reminders on/off, toggle aria,
  // request button, request-a-swap sheet, Close aria, name/note
  // placeholders) goes through t(). Member names, event titles, and
  // request notes stay API data. setPublicLocale is the switch that
  // lets the parish's language reach a page nobody signs in to.
  const { t, setPublicLocale } = useLocale()
  const { token } = useParams()
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  // busy is the action key ('accept-123' / 'decline-123' / 'cancel-123'
  // / 'submit-request') so the corresponding button shows a spinner-y
  // label and other buttons disable while one action is in flight.
  const [busy,         setBusy]         = useState(null)
  const [requestModal, setRequestModal] = useState(null)
  const [requestForm,  setRequestForm]  = useState({ targetId: '', targetName: '', note: '' })
  // The swap link used to arrive with the whole parish directory attached, so
  // this was a <select>. It isn't any more: a forwarded link should not be a
  // copy of the roster. You type the name of the person you already have in
  // mind — which is how choosing a swap partner actually works.
  const [memberQuery,   setMemberQuery]   = useState('')
  const [memberResults, setMemberResults] = useState([])
  const [searching,     setSearching]     = useState(false)
  const [savingPref,   setSavingPref]   = useState(false)
  // Whether the token is genuinely gone, as opposed to us being unable to answer.
  const [linkIsGone,   setLinkIsGone]   = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)

  const load = async () => {
    setError(null)
    try {
      const res = await fetch(apiUrl(`/api/swap/by-token/${token}`))
      if (!res.ok) {
        // Same split as the kiosk, for the same reason: only a 404 means the
        // link is gone. Anything else means we could not answer, and telling
        // a volunteer their link is dead sends them to an admin to solve a
        // problem that is not theirs.
        setLinkIsGone(res.status === 404)
        setError(res.status === 404
          ? "We couldn't find that link. It may have been rotated or never existed."
          : "We couldn't reach the server just now. Your link is fine — this is on our side.")
        setData(null); setLoading(false); return
      }
      const body = await res.json()
      // The parish's language, from the endpoint. Nobody is signed in
      // here, so this is the only thing that can make the page speak it.
      setPublicLocale(body.org?.locale)
      setData(body)
    } catch {
      setLinkIsGone(false)
      setError("We couldn't reach the server. Please check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [token])

  // Transient action error — an inline banner, never a native alert().
  const [flash, setFlash] = useState(null)

  // Debounced so a name typed at speed is one request, not eight. Two
  // characters minimum, matching what the server will answer.
  useEffect(() => {
    const q = memberQuery.trim()
    // Clear the spinner on the way out, not only in the fetch's finally —
    // the previous effect's cleanup has already run by now, so deleting a
    // query back to empty inside the debounce window left "Looking…" under
    // an empty box forever.
    if (q.length < 2) { setMemberResults([]); setSearching(false); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(apiUrl(`/api/swap/by-token/${token}/members?q=${encodeURIComponent(q)}`))
        if (!res.ok) { if (!cancelled) setSearchFailed(true); return }
        const d = await res.json()
        if (!cancelled) { setSearchFailed(false); setMemberResults(d.members ?? []) }
      } catch {
        if (!cancelled) setSearchFailed(true)
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [memberQuery, token])

  const act = async (key, url, body) => {
    setBusy(key)
    setFlash(null)
    try {
      const res = await fetch(apiUrl(url), {
        method:  'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body:    body ? JSON.stringify(body) : undefined,
      })
      const r = await res.json().catch(() => ({}))
      if (!res.ok) { setFlash(r.error || "That didn't go through — nothing was changed. Please try again."); return }
      await load()
    } catch {
      setFlash("That didn't go through — nothing was changed. Please check your connection and try again.")
    } finally {
      setBusy(null)
    }
  }

  // Flip serving-reminder opt-out (RM.2). reminders_opt_out === true
  // means the member is opted OUT, so the visible toggle shows the
  // inverse.
  const toggleReminders = async () => {
    if (!data?.me) return
    setSavingPref(true)
    try {
      const res = await fetch(apiUrl(`/api/swap/by-token/${token}/reminders`), {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ opt_out: !data.me.reminders_opt_out }),
      })
      const r = await res.json().catch(() => ({}))
      if (!res.ok) { setFlash(r.error || "That didn't save — your preference is unchanged. Please try again."); return }
      await load()
    } catch {
      setFlash("That didn't save — your preference is unchanged. Please check your connection and try again.")
    } finally {
      setSavingPref(false)
    }
  }

  const onSubmitRequest = async () => {
    if (!requestModal || !requestForm.targetId) return
    await act(
      'submit-request',
      `/api/swap/by-token/${token}/request`,
      {
        calendar_event_id: requestModal.event.id,
        target_client_id:  Number(requestForm.targetId),
        note:              requestForm.note.trim(),
      },
    )
    setRequestModal(null)
    setRequestForm({ targetId: '', note: '' })
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-parchment-100 dark:bg-ink-900">
        <Loader2 className="animate-spin text-brass-600" size={32} />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-parchment-100 dark:bg-ink-900 p-6">
        <div className="max-w-md text-center space-y-3">
          <AlertTriangle className="mx-auto text-amber-600" size={36} />
          {/* The heading used to read "Link not found" above a body that
              said "We couldn't reach the server" — a page contradicting
              itself, with advice that matched neither. */}
          <h1 className="text-xl font-bold text-ink-900 dark:text-parchment-50 font-display">
            {linkIsGone ? 'Link not found' : "We couldn't open your swap link"}
          </h1>
          <p role="status" className="text-sm text-ink-700 dark:text-parchment-200">
            {error || "We couldn't find that link."}
          </p>
          {linkIsGone ? (
            <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-4">
              Ask your church admin for a fresh swap link.
            </p>
          ) : (
            <button
              type="button"
              onClick={() => { setLoading(true); load() }}
              className="tap mt-4 inline-flex items-center justify-center gap-1.5 px-5 py-2.5 text-sm font-semibold rounded-lg bg-church-900 text-parchment-50 hover:bg-church-800"
            >
              <RefreshCw size={15} aria-hidden="true" /> Try again
            </button>
          )}
        </div>
      </div>
    )
  }

  const incoming = data.swap_requests.filter(r => r.target_client_id    === data.me.id && r.status === 'pending')
  const outgoing = data.swap_requests.filter(r => r.requester_client_id === data.me.id && r.status === 'pending')
  const history  = data.swap_requests.filter(r => r.status !== 'pending')

  return (
    <div className="min-h-screen bg-parchment-100 dark:bg-ink-900 py-6 px-4">
      <div className="max-w-2xl mx-auto space-y-5">
        <header className="text-center pb-2">
          <p className="text-[11px] uppercase tracking-widest text-brass-600 dark:text-brass-300 font-semibold">OpenChurch</p>
          <h1 className="text-2xl font-display text-ink-900 dark:text-parchment-50 mt-1">
            {t('swap.hello', { name: data.me.name })}
          </h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            Your upcoming events and swap requests
          </p>
        </header>

        {flash && (
          <div role="alert" className="rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 px-4 py-3 text-sm text-rose-700 dark:text-rose-200 text-center">
            {flash}
          </div>
        )}

        {/* Serving reminders preference (RM.2). */}
        <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm px-5 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('swap.reminders')}</p>
            <p className="text-xs text-ink-500 dark:text-parchment-300/70">
              {data.me.reminders_opt_out
                ? t('swap.remindersOff')
                : t('swap.remindersOn')}
            </p>
          </div>
          <button
            type="button"
            onClick={toggleReminders}
            disabled={savingPref}
            aria-pressed={!data.me.reminders_opt_out}
            aria-label={t('swap.toggleReminders')}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${
              !data.me.reminders_opt_out ? 'bg-church-700' : 'bg-parchment-300 dark:bg-ink-700'
            }`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
              !data.me.reminders_opt_out ? 'translate-x-5' : ''
            }`} />
          </button>
        </section>

        {/* Incoming pending — top priority, emerald accent. */}
        {incoming.length > 0 && (
          <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border-2 border-brass-500/40 shadow-warm p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Inbox size={16} className="text-brass-700 dark:text-brass-300" />
              <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
                Action needed — {incoming.length} swap request{incoming.length === 1 ? '' : 's'}
              </h2>
            </div>
            {incoming.map(r => (
              <div key={r.id} className="rounded-xl border border-brass-200/60 dark:border-brass-800/30 bg-brass-50/40 dark:bg-brass-900/15 p-3">
                <p className="text-sm text-ink-900 dark:text-parchment-50">
                  <span className="font-semibold">{r.requester_name}</span> is asking you to take their slot for
                </p>
                <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 mt-1">
                  {r.event_title} · {fmtDate(r.event_date)} at {fmtTime(r.event_start_time)}
                </p>
                {r.note && (
                  <p className="text-xs italic text-ink-600 dark:text-parchment-300 mt-2 leading-snug">"{r.note}"</p>
                )}
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => act(`accept-${r.id}`, `/api/swap/by-token/${token}/accept`, { request_id: r.id })}
                    disabled={busy !== null}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-brass-700 hover:bg-brass-800 text-parchment-50 disabled:opacity-40 transition-colors"
                  >
                    {busy === `accept-${r.id}` ? 'Accepting…' : 'Accept'}
                  </button>
                  <button
                    onClick={() => act(`decline-${r.id}`, `/api/swap/by-token/${token}/decline`, { request_id: r.id })}
                    disabled={busy !== null}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-ink-300 dark:border-parchment-300/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-200 dark:hover:bg-ink-800 disabled:opacity-40 transition-colors"
                  >
                    {busy === `decline-${r.id}` ? 'Declining…' : 'Decline'}
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* Upcoming assignments */}
        <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Calendar size={16} className="text-brass-700 dark:text-brass-300" />
            <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
              Your upcoming events
            </h2>
          </div>
          {data.upcoming_assignments.length === 0 ? (
            <p className="text-sm text-ink-500 dark:text-parchment-300/70">
              You don't have any upcoming events on the schedule.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.upcoming_assignments.map(e => {
                const alreadyRequested = outgoing.some(r => r.calendar_event_id === e.id)
                return (
                  <li key={e.id} className="flex items-center justify-between gap-3 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-100/60 dark:bg-ink-800/40 p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">{e.title}</p>
                      <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
                        {fmtDate(e.date)} · {fmtTime(e.start_time)}–{fmtTime(e.end_time)}
                      </p>
                    </div>
                    {alreadyRequested ? (
                      <span className="text-[11px] text-amber-700 dark:text-amber-300 italic shrink-0">Swap pending</span>
                    ) : (
                      <button
                        onClick={() => {
                          setRequestModal({ event: e })
                          setRequestForm({ targetId: '', note: '' })
                        }}
                        className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-church-900 dark:border-parchment-100 text-church-900 dark:text-parchment-100 hover:bg-church-900 hover:text-parchment-50 dark:hover:bg-parchment-100 dark:hover:text-church-900 transition-colors shrink-0"
                      >
                        {t('swap.request')}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* Outgoing pending — amber "waiting" */}
        {outgoing.length > 0 && (
          <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-amber-300/60 dark:border-amber-800/30 shadow-warm p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Clock size={16} className="text-amber-700 dark:text-amber-300" />
              <h2 className="text-sm font-bold uppercase tracking-widest text-amber-700 dark:text-amber-300">
                Waiting for {outgoing.length === 1 ? 'a reply' : 'replies'}
              </h2>
            </div>
            {outgoing.map(r => (
              <div key={r.id} className="rounded-xl border border-amber-200/60 dark:border-amber-800/30 bg-amber-50/40 dark:bg-amber-900/15 p-3">
                <p className="text-sm text-ink-900 dark:text-parchment-50">
                  Asked <span className="font-semibold">{r.target_name}</span> to take
                </p>
                <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 mt-1">
                  {r.event_title} · {fmtDate(r.event_date)} at {fmtTime(r.event_start_time)}
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => act(`cancel-${r.id}`, `/api/swap/by-token/${token}/cancel`, { request_id: r.id })}
                    disabled={busy !== null}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-ink-300 dark:border-parchment-300/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-200 dark:hover:bg-ink-800 disabled:opacity-40 transition-colors"
                  >
                    {busy === `cancel-${r.id}` ? 'Cancelling…' : 'Cancel request'}
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* History — last 10 resolved requests, muted. */}
        {history.length > 0 && (
          <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-2">
            <h2 className="text-sm font-bold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">
              Recent
            </h2>
            <ul className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
              {history.slice(0, 10).map(r => {
                const isMineOutgoing = r.requester_client_id === data.me.id
                return (
                  <li key={r.id} className="py-2 text-xs text-ink-600 dark:text-parchment-300/80 flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {isMineOutgoing
                        ? `You asked ${r.target_name} · ${r.event_title}`
                        : `${r.requester_name} asked you · ${r.event_title}`}
                    </span>
                    <span className={`shrink-0 capitalize ${
                      r.status === 'accepted' ? 'text-brass-700 dark:text-brass-300' :
                      r.status === 'declined' ? 'text-rose-700 dark:text-rose-300'      :
                                                'text-ink-500 dark:text-parchment-300/70'
                    }`}>{r.status}</span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <footer className="text-center text-[11px] text-ink-500 dark:text-parchment-300/60 pt-3 pb-6">
          Powered by OpenChurch
        </footer>
      </div>

      {/* Request swap modal — bottom-sheet on mobile, centered on desktop */}
      <AnimatePresence>
        {requestModal && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center p-0 md:p-6">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 30 }}
              transition={{ duration: 0.18 }}
              className="w-full md:max-w-md bg-parchment-50 dark:bg-ink-900 rounded-t-2xl md:rounded-2xl shadow-warm border border-parchment-300/60 dark:border-brass-900/30 p-5 space-y-3"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-ink-900 dark:text-parchment-50">{t('swap.requestTitle')}</h2>
                <button
                  onClick={() => setRequestModal(null)}
                  className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50"
                  aria-label={t('swap.close')}
                >
                  <X size={18} />
                </button>
              </div>
              <p className="text-sm text-ink-700 dark:text-parchment-200">
                <span className="font-semibold">{requestModal.event.title}</span> · {fmtDate(requestModal.event.date)} at {fmtTime(requestModal.event.start_time)}
              </p>
              <div>
                <label htmlFor="swap-ask" className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">
                  Ask
                </label>
                {requestForm.targetId ? (
                  <div className="flex items-center justify-between gap-2 w-full px-3 py-2 text-sm rounded-lg border border-church-400/60 dark:border-brass-700/50 bg-parchment-100 dark:bg-ink-800">
                    <span className="font-semibold text-ink-900 dark:text-parchment-50 truncate">
                      {requestForm.targetName}
                    </span>
                    <button
                      type="button"
                      onClick={() => { setRequestForm(f => ({ ...f, targetId: '', targetName: '' })); setMemberQuery('') }}
                      className="text-xs font-semibold text-church-800 dark:text-brass-300 hover:text-church-900 dark:hover:text-parchment-50 shrink-0"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      id="swap-ask"
                      type="text"
                      value={memberQuery}
                      onChange={e => setMemberQuery(e.target.value)}
                      placeholder={t('swap.namePh')}
                      autoComplete="off"
                      aria-describedby="swap-ask-help"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-church-500"
                    />
                    <p id="swap-ask-help" className="mt-1 text-[11px] text-ink-500 dark:text-parchment-300/70">
                      {memberQuery.trim().length > 0 && memberQuery.trim().length < 2
                        ? 'Two letters or more.'
                        : searching ? 'Looking…'
                        // "Nobody by that name" is a statement about the
                        // roster. It must not be made on the strength of a
                        // request that failed.
                        : searchFailed ? "We couldn't search just now — that's our side, not a missing name."
                        : memberQuery.trim().length >= 2 && memberResults.length === 0
                          ? 'Nobody by that name.'
                          : 'Type part of their name.'}
                    </p>
                    {memberResults.length > 0 && (
                      <ul className="mt-1.5 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 divide-y divide-parchment-200/60 dark:divide-brass-900/25 overflow-hidden">
                        {memberResults.map(m => (
                          <li key={m.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setRequestForm(f => ({ ...f, targetId: String(m.id), targetName: m.name }))
                                setMemberResults([])
                              }}
                              className="w-full text-left px-3 py-2 text-sm text-ink-900 dark:text-parchment-50 hover:bg-parchment-200/50 dark:hover:bg-ink-700/50 transition-colors"
                            >
                              {m.name}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">
                  Message (optional)
                </label>
                <textarea
                  value={requestForm.note}
                  onChange={e => setRequestForm(f => ({ ...f, note: e.target.value }))}
                  rows={3}
                  maxLength={500}
                  placeholder={t('swap.notePh')}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setRequestModal(null)}
                  className="px-3 py-2 text-sm text-ink-500 hover:text-ink-700 dark:hover:text-parchment-50"
                >
                  Cancel
                </button>
                <button
                  onClick={onSubmitRequest}
                  disabled={busy !== null || !requestForm.targetId}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 disabled:opacity-40 transition-opacity flex items-center gap-1.5"
                >
                  <Send size={13} />
                  {busy === 'submit-request' ? 'Sending…' : 'Send request'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}
