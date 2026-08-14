import { useEffect, useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { UserCheck, LogOut, Loader2, Plus, X, Printer, Tablet, Copy, RefreshCw, Power } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { apiUrl } from '../api'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../context/AuthContext'
import { LIT_COLOR_TEXT, LIT_COLOR_DOT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { useConfirm, usePrompt } from '../components/ConfirmProvider'

// Kiosk-link card (CHK.7) — admin-only. Mints/copies/revokes the
// capability URL that powers self-serve check-in at /kiosk/:token.
function KioskCard() {
  const toast = useToast()
  const ask = useConfirm()
  const [token,   setToken]   = useState(undefined) // undefined=loading, null=off, string=on
  const [working, setWorking] = useState(false)

  useEffect(() => {
    fetch(apiUrl('/api/kiosk-admin'))
      .then(r => (r.ok ? r.json() : { kiosk_token: null }))
      .then(d => setToken(d.kiosk_token ?? null))
      .catch(() => setToken(null))
  }, [])

  const url = token ? `${window.location.origin}/kiosk/${token}` : ''

  async function rotate() {
    setWorking(true)
    try {
      const res = await fetch(apiUrl('/api/kiosk-admin/rotate'), { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "That didn't save — nothing was lost. Please try again.")
      setToken(d.kiosk_token)
      toast.success(token ? 'New kiosk link generated' : 'Kiosk enabled')
    } catch (err) { toast.error(err.message) }
    finally { setWorking(false) }
  }

  async function disable() {
    if (!(await ask({
      title: 'Turn off the kiosk?',
      body: 'The current kiosk link stops working straight away.',
      confirmLabel: 'Turn off kiosk',
    }))) return
    setWorking(true)
    try {
      const res = await fetch(apiUrl('/api/kiosk-admin'), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error("That didn't delete — nothing was changed. Please try again.")
      setToken(null)
      toast.success('Kiosk disabled')
    } catch (err) { toast.error(err.message) }
    finally { setWorking(false) }
  }

  function copy() {
    navigator.clipboard?.writeText(url).then(
      () => toast.success('Kiosk link copied'),
      () => toast.error('Could not copy'),
    )
  }

  if (token === undefined) return null

  return (
    <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Tablet size={16} className="text-brass-600 dark:text-brass-300" />
        <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">Self-serve kiosk</h2>
      </div>
      <p className="text-xs text-ink-500 dark:text-parchment-300/70 -mt-1">
        Open this link on a tablet at the entrance so people can check themselves in — no login.
      </p>

      {token ? (
        <>
          <div className="flex gap-2">
            <input
              readOnly
              value={url}
              onFocus={e => e.target.select()}
              className="flex-1 min-w-0 px-3 py-2 text-xs rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-700 dark:text-parchment-200 focus:outline-none"
            />
            <button onClick={copy} title="Copy link" className="shrink-0 px-3 py-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
              <Copy size={15} />
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={rotate} disabled={working} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-200 dark:hover:bg-ink-800 disabled:opacity-40 transition-colors">
              <RefreshCw size={13} /> New link
            </button>
            <button onClick={disable} disabled={working} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-300/70 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/20 disabled:opacity-40 transition-colors">
              <Power size={13} /> Turn off
            </button>
          </div>
        </>
      ) : (
        <button onClick={rotate} disabled={working} className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 disabled:opacity-40 transition-opacity">
          <Tablet size={15} /> {working ? 'Enabling…' : 'Enable kiosk'}
        </button>
      )}
    </div>
  )
}

// Check-in kiosk (CHK.2 / Sprint 4). Pick a service, check members and
// guests in, check them out. Reads/writes /api/checkins (CHK.1).

function pad(n) { return String(n).padStart(2, '0') }
function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function fmtTime(hms) {
  if (!hms) return ''
  const [h, m] = String(hms).split(':').map(Number)
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
function fmtDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

// Name-tag printing (CHK.5) — opens a small print window with a tag.
// Child tags carry the pickup code (available only right after check-in).
function printTag({ name, kind, code, room, eventTitle, eventDate }) {
  const w = window.open('', '_blank', 'width=420,height=340')
  if (!w) return
  w.document.write(`<!doctype html><html><head><title>Name tag</title><style>
    @page { margin: 0 }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 28px; text-align: center }
    .kind { font-size: 11px; text-transform: uppercase; letter-spacing: 3px; color: #888 }
    .name { font-size: 30px; font-weight: 800; margin: 6px 0 }
    .room { font-size: 16px; font-weight: 700; color: #333; margin-top: 2px }
    .meta { font-size: 13px; color: #555 }
    .code { font-size: 42px; font-weight: 800; letter-spacing: 10px; font-family: ui-monospace, monospace; margin-top: 14px }
    .codelabel { font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #888 }
  </style></head><body>
    <div class="kind">${escapeHtml(kind)}</div>
    <div class="name">${escapeHtml(name)}</div>
    ${room ? `<div class="room">${escapeHtml(room)}</div>` : ''}
    <div class="meta">${escapeHtml(eventTitle)} &middot; ${escapeHtml(eventDate)}</div>
    ${code ? `<div class="code">${escapeHtml(code)}</div><div class="codelabel">Pickup code</div>` : ''}
    <script>window.onload = function () { window.print() }<\/script>
  </body></html>`)
  w.document.close()
}

export default function Checkin() {
  const toast = useToast()
  const askFor = usePrompt()
  const { isAdmin } = useAuth()
  const [events, setEvents]     = useState([])
  const [members, setMembers]   = useState([])
  const [eventId, setEventId]   = useState('')
  const [checkins, setCheckins] = useState([])
  const [present, setPresent]   = useState(0)
  const [loading, setLoading]   = useState(true)
  const [busy, setBusy]         = useState(false)

  const [recent, setRecent]         = useState([]) // recent services + counts (CHK.4)
  const [memberPick, setMemberPick] = useState('')
  const [guestName, setGuestName]   = useState('')
  const [guestKind, setGuestKind]   = useState('guest') // guest | child
  const [guardian, setGuardian]     = useState('')
  const [lastCode, setLastCode]     = useState(null)     // { name, code } shown once after a child check-in
  const [rooms, setRooms]           = useState([])       // active rooms (CHK.6)
  const [roomPick, setRoomPick]     = useState('')       // room applied to the next check-in
  const [newRoom, setNewRoom]       = useState('')

  // Upcoming events (today → +30d) for the picker, plus members.
  useEffect(() => {
    const start = toISO(new Date())
    const endD = new Date(); endD.setDate(endD.getDate() + 30)
    Promise.all([
      fetch(apiUrl(`/api/calendar?start=${start}&end=${toISO(endD)}`)).then(r => (r.ok ? r.json() : [])),
      fetch(apiUrl('/api/clients')).then(r => (r.ok ? r.json() : [])),
      fetch(apiUrl('/api/rooms?active=true')).then(r => (r.ok ? r.json() : { rooms: [] })),
    ])
      .then(([evs, mem, rms]) => {
        setEvents(Array.isArray(evs) ? evs : [])
        setMembers(Array.isArray(mem) ? mem : (mem.clients ?? []))
        setRooms(rms.rooms ?? [])
        if (Array.isArray(evs) && evs.length) setEventId(String(evs[0].id))
      })
      .finally(() => setLoading(false))
  }, [])

  async function loadCheckins(id) {
    if (!id) { setCheckins([]); setPresent(0); return }
    try {
      const res = await fetch(apiUrl(`/api/checkins?event_id=${id}`))
      const d = res.ok ? await res.json() : { checkins: [], present: 0 }
      setCheckins(d.checkins ?? [])
      setPresent(d.present ?? 0)
    } catch { /* leave as-is */ }
  }
  useEffect(() => { loadCheckins(eventId) }, [eventId])

  // Recent attendance report (CHK.4) — refreshes when check-ins change.
  async function loadRecent() {
    try {
      const res = await fetch(apiUrl('/api/checkins/recent?days=60'))
      const d = res.ok ? await res.json() : { services: [] }
      setRecent(d.services ?? [])
    } catch { /* leave as-is */ }
  }
  useEffect(() => { loadRecent() }, [checkins])

  // Members not already checked in (and present) — keeps the picker tidy.
  const checkedInClientIds = useMemo(
    () => new Set(checkins.filter(c => !c.checked_out_at && c.client_id).map(c => c.client_id)),
    [checkins]
  )

  const selectedEvent = useMemo(() => events.find(e => String(e.id) === eventId), [events, eventId])
  function tagFor(rec, code) {
    printTag({
      name:       rec.person_name,
      kind:       rec.kind,
      code:       code || null,
      room:       rec.room_name || (roomPick ? rooms.find(r => String(r.id) === roomPick)?.name : '') || '',
      eventTitle: selectedEvent?.title || '',
      eventDate:  selectedEvent ? fmtDate(selectedEvent.date) : '',
    })
  }

  async function addRoom() {
    if (!newRoom.trim()) return
    const res = await fetch(apiUrl('/api/rooms'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newRoom.trim() }),
    })
    if (!res.ok) { toast.error('Could not add room'); return }
    const room = await res.json()
    setRooms(rs => [...rs, room])
    setRoomPick(String(room.id))
    setNewRoom('')
  }

  async function checkIn(body) {
    if (!eventId) return null
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/checkins'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendar_event_id: Number(eventId), ...body }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "That didn't save — nothing was lost. Please try again.")
      await loadCheckins(eventId)
      return d
    } catch (err) {
      toast.error(err.message)
      return null
    } finally {
      setBusy(false)
    }
  }

  // A child carries a pickup code; releasing them requires it.
  async function checkOut(c) {
    let code
    if (c.kind === 'child') {
      code = await askFor({
        title: `Release ${c.person_name}`,
        body: 'A child is only released to someone carrying the pickup code.',
        inputLabel: 'Pickup code',
        confirmLabel: 'Release child',
        required: true,
      })
      if (code == null) return // cancelled
    }
    const res = await fetch(apiUrl(`/api/checkins/${c.id}/checkout`), {
      method: 'POST',
      headers: code != null ? { 'Content-Type': 'application/json' } : undefined,
      body: code != null ? JSON.stringify({ code }) : undefined,
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      toast.error(d.error || 'Check-out failed')
      return
    }
    loadCheckins(eventId)
  }

  if (loading) {
    return (
      <PageWrapper>
        <div className="flex items-center justify-center py-24">
          <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      </PageWrapper>
    )
  }

  if (events.length === 0) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState icon={UserCheck} title="No upcoming services"
            body="Add a Schedule event in the next 30 days to check people in." />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper>
      <div className="max-w-2xl mx-auto space-y-5">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          <div className="flex items-center gap-2">
            <UserCheck size={18} className="text-brass-600 dark:text-brass-300" />
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Check-in</h1>
          </div>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">Check members and guests in to a service.</p>
        </motion.div>

        {isAdmin && <KioskCard />}

        {/* Event picker */}
        <select
          value={eventId}
          aria-label="Choose a service"
          onChange={e => setEventId(e.target.value)}
          className="w-full px-3 py-2.5 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
        >
          {events.map(ev => (
            <option key={ev.id} value={ev.id}>
              {ev.title} — {fmtDate(ev.date)} {fmtTime(ev.start_time)}
            </option>
          ))}
        </select>

        {/* Liturgical day for the selected service (LIT.3) — reads the
            season/feast now stored on the event (LIT.1). */}
        {selectedEvent?.liturgical_season && (
          <div className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md border ${LIT_COLOR_TEXT[selectedEvent.liturgical_color] ?? LIT_COLOR_TEXT.White}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${LIT_COLOR_DOT[selectedEvent.liturgical_color] ?? LIT_COLOR_DOT_NONE}`} />
            {selectedEvent.feast_name || selectedEvent.liturgical_season}
          </div>
        )}

        {/* Check-in actions */}
        <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
          {/* Room (CHK.6) — applies to the next check-in. */}
          <div className="flex gap-2">
            <select
              value={roomPick}
              aria-label="Room for the next check-in"
              onChange={e => setRoomPick(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
            >
              <option value="">No room</option>
              {rooms.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <input
              type="text"
              value={newRoom}
              onChange={e => setNewRoom(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRoom() } }}
              placeholder="+ Add room"
              className="w-28 shrink-0 px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-church-500"
            />
          </div>

          <div className="flex gap-2">
            <select
              value={memberPick}
              aria-label="Choose a member to check in"
              onChange={e => setMemberPick(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
            >
              <option value="">Select a member…</option>
              {members.filter(m => !checkedInClientIds.has(m.id)).map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !memberPick}
              onClick={async () => { await checkIn({ client_id: Number(memberPick), kind: 'member', room_id: roomPick ? Number(roomPick) : undefined }); setMemberPick('') }}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              <Plus size={14} /> Check in
            </button>
          </div>
          <div className="space-y-2">
            <div className="flex gap-2">
              {[['guest', 'Guest'], ['child', 'Child']].map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setGuestKind(k)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    guestKind === k
                      ? 'bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 border-transparent'
                      : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={guestName}
                onChange={e => setGuestName(e.target.value)}
                placeholder={guestKind === 'child' ? "Child's name" : 'Guest name'}
                className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-church-500"
              />
              <button
                type="button"
                disabled={busy || !guestName.trim()}
                onClick={async () => {
                  const created = await checkIn({
                    person_name:   guestName.trim(),
                    kind:          guestKind,
                    guardian_name: guestKind === 'child' ? (guardian.trim() || undefined) : undefined,
                    room_id:       roomPick ? Number(roomPick) : undefined,
                  })
                  const roomName = roomPick ? rooms.find(r => String(r.id) === roomPick)?.name : ''
                  setGuestName(''); setGuardian('')
                  if (created?.security_code) setLastCode({ name: created.person_name, code: created.security_code, room: roomName })
                }}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg border border-church-900 dark:border-parchment-100 text-church-900 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800 transition-colors disabled:opacity-40"
              >
                <Plus size={14} /> Check in
              </button>
            </div>
            {guestKind === 'child' && (
              <input
                type="text"
                value={guardian}
                onChange={e => setGuardian(e.target.value)}
                placeholder="Guardian name (optional)"
                className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-church-500"
              />
            )}
          </div>
        </div>

        {/* One-time pickup code (CHK.3) — shown once after a child checks in. */}
        {lastCode && (
          <div className="rounded-2xl border-2 border-brass-500/50 bg-brass-50 dark:bg-brass-900/20 p-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-brass-800 dark:text-brass-200 uppercase tracking-wider">Pickup code — {lastCode.name}</p>
              <p className="text-3xl font-bold tracking-[0.3em] text-brass-700 dark:text-brass-300 font-mono mt-1">{lastCode.code}</p>
              <p className="text-[11px] text-brass-700/80 dark:text-brass-300/70 mt-1">
                Give this to the guardian — it's required at pickup and won't be shown again.
              </p>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-2">
              <button
                type="button"
                onClick={() => printTag({ name: lastCode.name, kind: 'child', code: lastCode.code, room: lastCode.room || '', eventTitle: selectedEvent?.title || '', eventDate: selectedEvent ? fmtDate(selectedEvent.date) : '' })}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-brass-700 text-parchment-50 hover:bg-brass-800 transition-colors"
              >
                <Printer size={13} /> Print tag
              </button>
              <button type="button" onClick={() => setLastCode(null)} className="p-1 text-brass-700 dark:text-brass-300 hover:opacity-70">
                <X size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Present list */}
        <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">Checked in</h2>
            <span className="text-xs font-semibold text-brass-700 dark:text-brass-300">{present} present</span>
          </div>
          {checkins.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-500 dark:text-parchment-300/70">No one checked in yet.</p>
          ) : (
            checkins.map(c => (
              <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-parchment-300/50 dark:border-brass-900/25 first:border-t-0">
                <div className="min-w-0">
                  <p className={`text-sm font-medium truncate ${c.checked_out_at ? 'text-ink-400 dark:text-parchment-300/50 line-through' : 'text-ink-900 dark:text-parchment-50'}`}>
                    {c.person_name}
                    {c.kind !== 'member' && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-ink-400 dark:text-parchment-300/60">{c.kind}</span>}
                  </p>
                  {c.room_name && <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">{c.room_name}</p>}
                </div>
                {c.checked_out_at ? (
                  <span className="text-[11px] text-ink-400 dark:text-parchment-300/60">out</span>
                ) : (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => tagFor(c)}
                      title="Print tag"
                      className="p-1.5 rounded-lg text-ink-400 hover:text-church-900 dark:hover:text-parchment-50 transition-colors"
                    >
                      <Printer size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => checkOut(c)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:text-church-900 dark:hover:text-parchment-50 transition-colors"
                    >
                      <LogOut size={12} /> Out
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Recent attendance report (CHK.4) */}
        {recent.length > 0 && (
          <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
            <div className="px-4 py-3 border-b border-parchment-300/60 dark:border-brass-900/25">
              <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">Recent attendance</h2>
            </div>
            {recent.map(s => (
              <div key={s.event_id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-parchment-300/50 dark:border-brass-900/25 first:border-t-0">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">{s.title}</p>
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">{fmtDate(s.date)}</p>
                </div>
                <span className="shrink-0 text-sm font-bold text-brass-700 dark:text-brass-300 tabular-nums">{s.attendance}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </PageWrapper>
  )
}
