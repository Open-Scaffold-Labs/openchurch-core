import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, AlertTriangle, Search, Check, UserPlus, Baby, ArrowLeft, RefreshCw } from 'lucide-react'
import { apiUrl } from '../api'
import { LIT_COLOR_TEXT, LIT_COLOR_DOT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { useLocale } from '../i18n'

// Small liturgical chip — season/feast in its canonical color.
function LitChip({ season, color, feast }) {
  if (!season) return null
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-md border ${LIT_COLOR_TEXT[color] ?? LIT_COLOR_TEXT.White}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${LIT_COLOR_DOT[color] ?? LIT_COLOR_DOT_NONE}`} />
      {feast || season}
    </span>
  )
}

// Self-serve kiosk (CHK.7 / Sprint 4).
//
// A tablet at the church entrance. Reached by /kiosk/:token — no login.
// The token resolves the org server-side; this page only ever sees the
// data a kiosk needs (today's services, active members, active rooms).
//
// Flow, built for a fast repeating line on a touchscreen:
//   1. Pick today's service (auto-skipped when there's only one).
//   2. Search your name and tap it → checked in.
//      Or "I'm a guest" / "Check in a child" (child returns a big
//      pickup code for the guardian).
//   3. Confirmation, then it resets itself for the next person.
//
// Shell matches PublicSwap/PublicForm: parchment background, brand
// wordmark, "Powered by OpenChurch" footer — reads as the church's
// own kiosk, not a SaaS surface.

function fmtTime(hms) {
  if (!hms) return ''
  const [h, m] = hms.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`
}

export default function Kiosk() {
  // Not for t() — these pages are still English (the string pass is
  // separate work). This is the switch that lets the parish's language
  // reach a page nobody signs in to.
  const { setPublicLocale } = useLocale()
  const { token } = useParams()
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  // Whether the token itself is gone, as opposed to us being unable to answer.
  const [linkIsGone, setLinkIsGone] = useState(false)

  const [serviceId, setServiceId] = useState(null)
  const [query,     setQuery]     = useState('')
  // Server-side member search (0.7). The kiosk endpoint no longer ships
  // the full roster; we query /members?q= as the visitor types. Results
  // + whether a search is in flight live here.
  const [matches,   setMatches]   = useState([])
  const [searchFailed, setSearchFailed] = useState(false)
  const [searching, setSearching] = useState(false)
  // Monotonic request id so a slow earlier response can't overwrite a
  // newer one when someone types fast (belt to the AbortController).
  const searchSeq = useRef(0)
  const [roomPick,  setRoomPick]  = useState('')   // '' = no room
  const [mode,      setMode]      = useState('list') // 'list' | 'guest' | 'child'
  const [guestName, setGuestName] = useState('')
  const [childName, setChildName] = useState('')
  const [guardian,  setGuardian]  = useState('')
  const [busy,      setBusy]      = useState(false)
  const [result,    setResult]    = useState(null)  // { name, kind, security_code }
  // Transient check-in error — an inline banner, never a native alert()
  // (jarring, blocks the UI thread, and reads as a system failure to a
  // visitor holding a child's hand).
  const [flash,     setFlash]     = useState(null)
  const resetTimer = useRef(null)

  const load = async () => {
    setError(null)
    try {
      const res = await fetch(apiUrl(`/api/kiosk/${token}`))
      if (!res.ok) {
        // A 404 means this token really is not a kiosk — rotated, mistyped,
        // or retired — and telling a volunteer to get a new link is the right
        // advice. Anything else means WE could not answer, and blaming the
        // link sends someone hunting for a replacement they do not need
        // while a queue builds at the door.
        setLinkIsGone(res.status === 404)
        setError(res.status === 404
          ? "We couldn't find that kiosk. The link may have been rotated."
          : "We couldn't reach the kiosk just now. The link is fine — this is on our side. Try again in a moment.")
        setData(null); setLoading(false); return
      }
      const d = await res.json()
      // The parish's language, from the endpoint. Nobody is signed in
      // here, so this is the only thing that can make the page speak it.
      setPublicLocale(d.org?.locale)
      setData(d)
      // One service → skip the picker.
      if (d.services?.length === 1) setServiceId(d.services[0].id)
    } catch (err) {
      setLinkIsGone(false)
      setError("We couldn't reach the kiosk. Please check the connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [token])
  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const selectedService = useMemo(
    () => data?.services?.find(s => s.id === serviceId) || null,
    [data, serviceId]
  )

  const trimmedQuery = query.trim()
  const queryReady   = trimmedQuery.length >= 2

  // Debounced server-side member search (0.7). Only fires once the
  // visitor has typed ≥2 characters — below that we show a prompt, not
  // a list, so no results flash. Each keystroke bumps searchSeq and
  // aborts the previous request; stale responses are dropped by both
  // the AbortController and the seq check so fast typing never flashes
  // an older result set.
  useEffect(() => {
    if (mode !== 'list') return
    if (!queryReady) { setMatches([]); setSearching(false); return }

    const seq = ++searchSeq.current
    const controller = new AbortController()
    setSearching(true)

    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          apiUrl(`/api/kiosk/${token}/members?q=${encodeURIComponent(trimmedQuery)}`),
          { signal: controller.signal },
        )
        const d = await res.json().catch(() => ({}))
        // Ignore if a newer keystroke has superseded this request.
        if (seq !== searchSeq.current) return
        // A failed search is not an absent member. This used to set [], which
        // renders "No members match — try the guest button below" — steering
        // a volunteer into creating a DUPLICATE record for someone who is on
        // the roster, because a request failed. The duplicate then outlives
        // the outage.
        if (!res.ok) { setSearchFailed(true); return }
        setSearchFailed(false)
        setMatches(d.members ?? [])
      } catch (err) {
        if (err?.name !== 'AbortError' && seq === searchSeq.current) setSearchFailed(true)
        // AbortError (superseded) or network hiccup — leave the last
        // good list alone; a stale empty flash would be worse.
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    }, 250)

    return () => { clearTimeout(t); controller.abort() }
  }, [trimmedQuery, queryReady, mode, token])

  // Reset the transient form back to the search screen for the next
  // person. Keeps the chosen service + room so a volunteer running one
  // room doesn't re-pick every time.
  const softReset = () => {
    setResult(null); setMode('list'); setQuery(''); setFlash(null)
    setMatches([]); setSearching(false)
    setGuestName(''); setChildName(''); setGuardian('')
  }

  const checkIn = async (body, displayName) => {
    if (busy) return
    setBusy(true)
    setFlash(null)
    try {
      const res = await fetch(apiUrl(`/api/kiosk/${token}/checkin`), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          calendar_event_id: serviceId,
          room_id: roomPick ? Number(roomPick) : undefined,
          ...body,
        }),
      })
      const r = await res.json().catch(() => ({}))
      if (!res.ok) { setFlash(r.error || "That check-in didn't go through — please try once more."); return }
      setResult({ name: displayName || r.person_name, kind: r.kind, security_code: r.security_code })
      // Auto-dismiss: a child code lingers longer so a guardian can read it.
      clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(softReset, r.security_code ? 12000 : 5000)
    } catch {
      setFlash("That check-in didn't go through — please check the connection and try once more.")
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-parchment-100 dark:bg-ink-900">
        <Loader2 className="animate-spin text-brass-600" size={36} />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-parchment-100 dark:bg-ink-900 p-6">
        <div className="max-w-md text-center space-y-3">
          <AlertTriangle className="mx-auto text-amber-600" size={40} />
          <h1 className="text-2xl font-bold text-ink-900 dark:text-parchment-50 font-display">Kiosk unavailable</h1>
          <p className="text-sm text-ink-700 dark:text-parchment-200">{error || "We couldn't find that kiosk."}</p>
          {/* The advice has to match the diagnosis. "Ask for a fresh link" is
              right when the token is genuinely gone and actively unhelpful
              when the server simply failed — it sends a volunteer away from a
              queue to solve a problem that is not theirs. */}
          {linkIsGone ? (
            <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-4">Ask a staff member for a fresh kiosk link.</p>
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

  const rooms = data.rooms ?? []

  return (
    <div className="min-h-screen bg-parchment-100 dark:bg-ink-900 py-6 px-4">
      <div className="max-w-2xl mx-auto space-y-5">
        <header className="text-center pb-1">
          <p className="text-[11px] uppercase tracking-widest text-brass-600 dark:text-brass-300 font-semibold">{data.org?.name || 'OpenChurch'}</p>
          <h1 className="text-3xl font-display text-ink-900 dark:text-parchment-50 mt-1">Welcome — check in</h1>
        </header>

        {flash && (
          <div role="alert" className="rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 px-4 py-3 text-sm text-rose-700 dark:text-rose-200 text-center">
            {flash}
          </div>
        )}

        {/* No services today */}
        {data.services.length === 0 && (
          <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-8 text-center">
            <p className="text-lg text-ink-700 dark:text-parchment-200">No services scheduled today.</p>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">Check back before the next gathering.</p>
          </section>
        )}

        {/* Step 1 — pick a service */}
        {data.services.length > 0 && !serviceId && (
          <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">Which service?</h2>
            <div className="grid gap-2">
              {data.services.map(s => (
                <button
                  key={s.id}
                  onClick={() => setServiceId(s.id)}
                  className="w-full text-left rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100/60 dark:bg-ink-800/40 hover:bg-parchment-200 dark:hover:bg-ink-800 px-4 py-4 transition-colors"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-lg font-semibold text-ink-900 dark:text-parchment-50">{s.title}</p>
                    <LitChip season={s.liturgical_season} color={s.liturgical_color} feast={s.feast_name} />
                  </div>
                  {s.start_time && (
                    <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-0.5">{fmtTime(s.start_time)}{s.end_time ? `–${fmtTime(s.end_time)}` : ''}</p>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Step 2 — check in */}
        {serviceId && (
          <>
            {/* Selected service + change affordance (only if >1) */}
            <div className="flex items-center justify-between gap-3 px-1">
              <p className="text-sm text-ink-600 dark:text-parchment-300/80 flex items-center gap-2 flex-wrap">
                <span>
                  Checking in to <span className="font-semibold text-ink-900 dark:text-parchment-50">{selectedService?.title}</span>
                  {selectedService?.start_time ? ` · ${fmtTime(selectedService.start_time)}` : ''}
                </span>
                <LitChip season={selectedService?.liturgical_season} color={selectedService?.liturgical_color} feast={selectedService?.feast_name} />
              </p>
              {data.services.length > 1 && (
                <button
                  onClick={() => { setServiceId(null); softReset() }}
                  className="text-xs font-semibold text-brass-700 dark:text-brass-300 hover:underline shrink-0"
                >
                  Change
                </button>
              )}
            </div>

            {/* Optional room chips */}
            {rooms.length > 0 && (
              <div className="flex flex-wrap gap-2 px-1">
                <button
                  onClick={() => setRoomPick('')}
                  className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${roomPick === '' ? 'bg-church-900 text-parchment-50 border-church-900' : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-200 dark:hover:bg-ink-800'}`}
                >
                  No room
                </button>
                {rooms.map(r => (
                  <button
                    key={r.id}
                    onClick={() => setRoomPick(String(r.id))}
                    className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${roomPick === String(r.id) ? 'bg-church-900 text-parchment-50 border-church-900' : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-200 dark:hover:bg-ink-800'}`}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}

            {/* Member search + list */}
            {mode === 'list' && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
                <div className="relative">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                  <input
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Type your name…"
                    autoFocus
                    className="w-full pl-10 pr-3 py-3 text-base rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-church-500"
                  />
                </div>

                <div className="grid gap-1.5 max-h-72 overflow-y-auto">
                  {!queryReady ? (
                    // Below the 2-char threshold the server won't search,
                    // so nudge rather than render an empty/stale list.
                    <p className="text-sm text-ink-500 dark:text-parchment-300/70 py-3 text-center">Type at least 2 letters of your name.</p>
                  ) : searching && matches.length === 0 ? (
                    <p className="text-sm text-ink-500 dark:text-parchment-300/70 py-3 text-center">Searching…</p>
                  ) : searchFailed ? (
                    <p role="status" className="text-sm text-amber-700 dark:text-amber-400 py-3 text-center px-4 leading-relaxed">
                      We couldn&apos;t search the roster just now — that&apos;s our side, not a
                      missing name. Try again in a moment before checking anyone in as a guest.
                    </p>
                  ) : matches.length === 0 ? (
                    <p className="text-sm text-ink-500 dark:text-parchment-300/70 py-3 text-center">No members match — try the guest button below.</p>
                  ) : matches.map(m => (
                    <button
                      key={m.id}
                      disabled={busy}
                      onClick={() => checkIn({ client_id: m.id, kind: 'member' }, m.name)}
                      className="w-full text-left rounded-xl px-4 py-3 text-base font-medium text-ink-900 dark:text-parchment-50 bg-parchment-100/50 dark:bg-ink-800/40 hover:bg-church-900 hover:text-parchment-50 disabled:opacity-50 transition-colors"
                    >
                      {m.name}
                    </button>
                  ))}
                </div>

                <div className="flex flex-col sm:flex-row gap-2 pt-1">
                  <button
                    onClick={() => setMode('guest')}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-church-900 dark:border-parchment-100 text-church-900 dark:text-parchment-100 hover:bg-church-900 hover:text-parchment-50 dark:hover:bg-parchment-100 dark:hover:text-church-900 font-semibold transition-colors"
                  >
                    <UserPlus size={18} /> I'm a guest
                  </button>
                  <button
                    onClick={() => setMode('child')}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-brass-700/70 dark:border-brass-300/50 text-brass-800 dark:text-brass-200 hover:bg-brass-700 hover:text-parchment-50 font-semibold transition-colors"
                  >
                    <Baby size={18} /> Check in a child
                  </button>
                </div>
              </section>
            )}

            {/* Guest form */}
            {mode === 'guest' && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
                <button onClick={() => setMode('list')} className="flex items-center gap-1 text-xs font-semibold text-brass-700 dark:text-brass-300 hover:underline">
                  <ArrowLeft size={13} /> Back
                </button>
                <h2 className="text-base font-semibold text-ink-900 dark:text-parchment-50">Welcome! What's your name?</h2>
                <input
                  type="text"
                  value={guestName}
                  onChange={e => setGuestName(e.target.value)}
                  placeholder="Your name"
                  autoFocus
                  className="w-full px-4 py-3 text-base rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
                />
                <button
                  disabled={busy || !guestName.trim()}
                  onClick={() => checkIn({ person_name: guestName.trim(), kind: 'guest' }, guestName.trim())}
                  className="w-full px-4 py-3 rounded-xl bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  {busy ? 'Checking in…' : 'Check in'}
                </button>
              </section>
            )}

            {/* Child form */}
            {mode === 'child' && (
              <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-brass-300/50 dark:border-brass-800/40 shadow-warm p-5 space-y-3">
                <button onClick={() => setMode('list')} className="flex items-center gap-1 text-xs font-semibold text-brass-700 dark:text-brass-300 hover:underline">
                  <ArrowLeft size={13} /> Back
                </button>
                <h2 className="text-base font-semibold text-ink-900 dark:text-parchment-50">Check in a child</h2>
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 -mt-1">You'll get a pickup code — keep it to collect your child.</p>
                <input
                  type="text"
                  value={childName}
                  onChange={e => setChildName(e.target.value)}
                  placeholder="Child's name"
                  autoFocus
                  className="w-full px-4 py-3 text-base rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
                />
                <input
                  type="text"
                  value={guardian}
                  onChange={e => setGuardian(e.target.value)}
                  placeholder="Parent / guardian name (optional)"
                  className="w-full px-4 py-3 text-base rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
                />
                <button
                  disabled={busy || !childName.trim()}
                  onClick={() => checkIn({ person_name: childName.trim(), kind: 'child', guardian_name: guardian.trim() || undefined }, childName.trim())}
                  className="w-full px-4 py-3 rounded-xl bg-brass-700 text-parchment-50 font-semibold hover:bg-brass-800 disabled:opacity-40 transition-colors"
                >
                  {busy ? 'Checking in…' : 'Check in child'}
                </button>
              </section>
            )}
          </>
        )}

        <footer className="text-center text-[11px] text-ink-500 dark:text-parchment-300/60 pt-3 pb-6">
          Powered by OpenChurch
        </footer>
      </div>

      {/* Confirmation overlay */}
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-church-900/95 flex items-center justify-center p-6"
            onClick={softReset}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="text-center max-w-md"
            >
              <div className="mx-auto w-20 h-20 rounded-full bg-brass-500 flex items-center justify-center mb-5">
                <Check size={44} className="text-parchment-50" strokeWidth={3} />
              </div>
              <h2 className="text-3xl font-display text-parchment-50">You're checked in!</h2>
              <p className="text-lg text-parchment-200 mt-1">{result.name}</p>

              {result.security_code && (
                <div className="mt-6 rounded-2xl bg-parchment-50 px-6 py-5">
                  <p className="text-xs uppercase tracking-widest text-ink-500 font-semibold">Pickup code</p>
                  <p className="text-5xl font-bold tracking-[0.3em] text-church-900 mt-1">{result.security_code}</p>
                  <p className="text-xs text-ink-500 mt-2">Keep this to collect your child.</p>
                </div>
              )}

              <button
                onClick={softReset}
                className="mt-7 px-8 py-3 rounded-xl bg-parchment-50 text-church-900 font-semibold hover:opacity-90 transition-opacity"
              >
                Done
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
