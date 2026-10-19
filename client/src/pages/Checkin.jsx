import { useEffect, useState, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { UserCheck, LogOut, Loader2, Plus, X, Printer, Tablet, Copy, RefreshCw, Power, Search, ChevronLeft } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadFailure from '../components/LoadFailure'
import { apiUrl } from '../api'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../context/AuthContext'
import { initials, loadList } from '../utils/format'
import { LIT_COLOR_TEXT, LIT_COLOR_DOT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { useConfirm, usePrompt } from '../components/ConfirmProvider'
import { useLocale } from '../i18n'

// Positive integer IDs only. Labels, titles, and dates never invent a
// Mass or a person — the same rule as the roster's client_id gate and
// the intention book's ?event= reader.
export function parsePositiveIntId(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isInteger(n) || n <= 0 || String(n) !== s) return null
  return n
}

// Roster → profile. The Mass this desk is working travels with the
// person so "back" can reopen this service, not the Members roll.
export function rosterPersonHref(clientId, eventId) {
  const person = parsePositiveIntId(clientId)
  if (!person) return null
  const event = parsePositiveIntId(eventId)
  return event
    ? `/clients/${person}?from=checkin&event=${event}`
    : `/clients/${person}`
}

// Profile → this desk. Only from=member plus a live member id; a name
// in the URL is never a person.
export function checkinReturnHome(searchParams, members) {
  const from = searchParams?.get?.('from')
  const client = parsePositiveIntId(searchParams?.get?.('client'))
  if (from !== 'member' || !client) return null
  const live = Array.isArray(members)
    ? members.find(m => parsePositiveIntId(m?.id) === client)
    : null
  const name = typeof live?.name === 'string' ? live.name.trim() : ''
  return {
    to: `/clients/${client}`,
    labelKey: name ? 'member.backNamed' : 'member.backProfile',
    name: name || undefined,
  }
}

// Keep the person thread when the secretary opens another Mass from
// this desk (picker, recent panel). Drop it when there is no person.
export function checkinServiceHref(eventId, searchParams) {
  const event = parsePositiveIntId(eventId)
  if (!event) return '/checkin'
  const from = searchParams?.get?.('from')
  const client = parsePositiveIntId(searchParams?.get?.('client'))
  if (from === 'member' && client) {
    return `/checkin?event=${event}&from=member&client=${client}`
  }
  return `/checkin?event=${event}`
}

// Kiosk-link card (CHK.7) — admin-only. Mints/copies/revokes the
// capability URL that powers self-serve check-in at /kiosk/:token.
function KioskCard() {
  const toast = useToast()
  const ask = useConfirm()
  const { t } = useLocale()
  const [token,   setToken]   = useState(undefined) // undefined=loading, null=off, string=on
  const [working, setWorking] = useState(false)
  // A refused or dropped read of the kiosk setting is not "the kiosk is
  // off". It used to fold into `null`, which rendered "Enable kiosk" — and
  // that button mints a NEW token, so pressing it on a parish whose kiosk
  // was live would silently break the link already open on the entrance
  // tablet. Unknown stays unknown: say it did not load, offer a retry, and
  // offer no enable/rotate/turn-off control until we actually know.
  const [readFailed, setReadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setReadFailed(false)
    fetch(apiUrl('/api/kiosk-admin'))
      .then(async r => {
        if (!r.ok) throw new Error('kiosk-admin')
        const d = await r.json()
        if (!d || typeof d !== 'object' || !('kiosk_token' in d)) throw new Error('kiosk-admin')
        // R310-1: only the documented off sentinel (null) or a nonblank
        // string token is a real answer. false / 0 / '' / objects / arrays
        // are a malformed read, not "off" — treat them as a load failure so
        // no Enable (mint) or live-link control is offered.
        const tok = d.kiosk_token
        if (tok !== null && !(typeof tok === 'string' && tok.trim())) throw new Error('kiosk-admin')
        return tok
      })
      .then(tok => { if (!cancelled) setToken(tok) })
      .catch(() => { if (!cancelled) { setToken(undefined); setReadFailed(true) } })
    return () => { cancelled = true }
  }, [attempt])

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

  if (token === undefined && !readFailed) return null

  return (
    <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Tablet size={16} className="text-brass-600 dark:text-brass-300" />
        <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">Self-serve kiosk</h2>
      </div>
      <p className="text-xs text-ink-500 dark:text-parchment-300/70 -mt-1">
        Open this link on a tablet at the entrance so people can check themselves in — no login.
      </p>

      {readFailed ? (
        <LoadFailure
          variant="strip"
          title={t('load.failedTitle')}
          body={t('load.failedBody')}
          onRetry={() => setAttempt(a => a + 1)}
        />
      ) : token ? (
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

// Historical attendance labels. Stamps are canonical; a missing stamp is
// unknown — never the live Mass currently on the picker.
export function attendedServiceLabel(service, t) {
  const title = typeof service?.title === 'string' ? service.title.trim() : ''
  return title || t('checkin.attendedUnknown')
}

export function attendedServiceDateLabel(service, t) {
  if (!service?.date) return t('checkin.attendedDateUnknown')
  return fmtDate(service.date)
}

export function recentServiceKey(service) {
  return `${service?.event_id ?? ''}:${service?.date ?? ''}:${service?.title ?? ''}:${service?.time ?? ''}`
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
  const { t } = useLocale()
  const { isAdmin } = useAuth()
  const [events, setEvents]     = useState([])
  const [members, setMembers]   = useState([])
  // THE SERVICE IS CARRIED, NOT RE-CHOSEN.
  //
  // `?event=` is the source of truth for which service this desk is working.
  // The Schedule links here with the service already named, a member's
  // attendance row opens the Mass they were at, and a reload or a shared link
  // lands on the same service instead of on whatever happens to be next.
  //
  // The picker still exists and still works; choosing in it rewrites the URL,
  // so the address bar and the header can never disagree about which service
  // a check-in will be written to.
  const [searchParams, setSearchParams] = useSearchParams()
  const askedEventId = searchParams.get('event') ?? ''
  const [eventId, setEventId]   = useState('')
  // Bumped on every roster fetch so a late Mass-A response cannot paint under Mass B.
  const checkinsLoadGen = useRef(0)
  const recentLoadGen = useRef(0)
  // A service named in the URL that this parish cannot see. Held rather than
  // swallowed: the old page had no URL to be wrong about, but the moment one
  // exists, silently falling back to a different service would check people
  // into the wrong Mass and say nothing. UNKNOWN is not "the default one".
  const [unresolved, setUnresolved] = useState(null)
  const [checkins, setCheckins] = useState([])
  const [present, setPresent]   = useState(0)
  const [loading, setLoading]   = useState(true)
  const [busy, setBusy]         = useState(false)

  const [recent, setRecent]         = useState([]) // recent services + counts (CHK.4)
  const [memberPick, setMemberPick] = useState('')
  const [memberQuery, setMemberQuery] = useState('')
  const [membersFailed, setMembersFailed] = useState(false)
  const [guestName, setGuestName]   = useState('')
  const [guestKind, setGuestKind]   = useState('guest') // guest | child
  const [guardian, setGuardian]     = useState('')
  const [lastCode, setLastCode]     = useState(null)     // { name, code } shown once after a child check-in
  const [rooms, setRooms]           = useState([])       // active rooms (CHK.6)
  const [roomPick, setRoomPick]     = useState('')       // room applied to the next check-in
  const [newRoom, setNewRoom]       = useState('')
  // A refused window, roster, room list, or recent report must not wear
  // the sentence for a real empty one.
  const [servicesFailed, setServicesFailed] = useState(false)
  const [roomsFailed, setRoomsFailed]       = useState(false)
  const [checkinsFailed, setCheckinsFailed] = useState(false)
  const [recentFailed, setRecentFailed]     = useState(false)

  // Services for the picker, plus members.
  //
  // The window now reaches BACKWARDS as well: −30d → +30d. Attendance is
  // finished work as often as it is work in progress — "who was at last
  // Sunday's 10:30" was simply unreachable here, because a picker that starts
  // today cannot name a Mass that has already happened. The check-in API has
  // always accepted any event id; only this list refused to offer one.
  //
  // Widening the window moves what evs[0] is, so the default is chosen by
  // meaning rather than by position below — the first UPCOMING service, which
  // is what the desk wants when nobody named one.
  useEffect(() => {
    const startD = new Date(); startD.setDate(startD.getDate() - 30)
    const start = toISO(startD)
    const endD = new Date(); endD.setDate(endD.getDate() + 30)
    Promise.all([
      // `r.ok ? r.json() : []` painted "No services in this window".
      fetch(apiUrl(`/api/calendar?start=${start}&end=${toISO(endD)}`)).then(async r => {
        if (!r.ok) return { ok: false, events: [] }
        const body = await r.json()
        if (!Array.isArray(body)) return { ok: false, events: [] }
        return { ok: true, events: body }
      }).catch(() => ({ ok: false, events: [] })),
      // `mem.clients ?? []` accepted HTTP 200 `{}` as an empty roll and
      // set ok: true. loadList keeps that body a failed read.
      loadList(apiUrl('/api/clients')).then(roster => ({ ok: roster.ok, members: roster.data })),
      // `{ rooms: [] }` on a 500 painted a church with no rooms.
      fetch(apiUrl('/api/rooms?active=true')).then(async r => {
        if (!r.ok) return { ok: false, rooms: [] }
        const body = await r.json()
        const rooms = body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.rooms)
          ? body.rooms
          : null
        if (!rooms) return { ok: false, rooms: [] }
        return { ok: true, rooms }
      }).catch(() => ({ ok: false, rooms: [] })),
    ])
      .then(async ([evs, mem, rms]) => {
        const list = evs.events
        setMembers(mem.members)
        setMembersFailed(!mem.ok)
        setRooms(rms.rooms)
        setRoomsFailed(!rms.ok)

        // The window itself did not load, and nobody named a service.
        // That is not "No services in this window".
        if (!evs.ok && !askedEventId) {
          setServicesFailed(true)
          setEvents([])
          return
        }
        setServicesFailed(false)

        // A service named in the URL wins over any default.
        if (askedEventId) {
          if (list.some(e => String(e.id) === askedEventId)) {
            setEvents(list); setEventId(askedEventId); return
          }
          // Outside the window — a Mass from March, opened from a member's
          // attendance. Ask the server for that one service rather than
          // widening the window until it happens to be included.
          const res = await fetch(apiUrl(`/api/calendar/${encodeURIComponent(askedEventId)}`))
            .catch(() => null)
          if (res?.ok) {
            const ev = await res.json().catch(() => null)
            if (ev?.id != null) {
              setEvents([ev, ...list.filter(e => String(e.id) !== String(ev.id))])
              setEventId(String(ev.id))
              return
            }
          }
          // 404 (not this parish's, or gone), 500, or offline. Every one of
          // those means the same thing to the desk: we cannot say which
          // service this is. So say that, and check nobody in — rather than
          // quietly selecting a different Mass and taking attendance for it.
          setEvents(list)
          setUnresolved({ id: askedEventId, reason: res ? res.status : 'offline' })
          return
        }

        setEvents(list)
        // No service named: the first one still to come, not the first row.
        const today = toISO(new Date())
        const upcoming = list.find(e => String(e.date).slice(0, 10) >= today)
        if (upcoming) setEventId(String(upcoming.id))
        else if (list.length) setEventId(String(list[list.length - 1].id))
      })
      .finally(() => setLoading(false))
  }, [askedEventId])

  async function loadCheckins(id) {
    if (!id) { setCheckins([]); setPresent(0); setCheckinsFailed(false); return }
    // Each call claims a generation. Only the latest claim may write roster
    // state — otherwise a delayed response for Mass A can replace Mass B's
    // roster while the picker already shows B (wrong people at the wrong Mass).
    const gen = ++checkinsLoadGen.current
    try {
      const res = await fetch(apiUrl(`/api/checkins?event_id=${id}`))
      if (gen !== checkinsLoadGen.current) return
      // `{ checkins: [], present: 0 }` on a 500 painted "No one checked in yet."
      if (!res.ok) throw new Error('unread')
      const d = await res.json()
      if (gen !== checkinsLoadGen.current) return
      const rows = d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.checkins) ? d.checkins : null
      if (!rows) throw new Error('shape')
      const presentN = Number(d.present)
      setCheckins(rows)
      setPresent(Number.isFinite(presentN) ? presentN : rows.filter(c => !c.checked_out_at).length)
      setCheckinsFailed(false)
    } catch {
      if (gen !== checkinsLoadGen.current) return
      setCheckins([])
      setPresent(0)
      setCheckinsFailed(true)
    }
  }
  useEffect(() => { loadCheckins(eventId) }, [eventId])

  // Recent attendance report (CHK.4) — refreshes when check-ins change.
  async function loadRecent() {
    // R300-1: same latest-request guard as loadCheckins. Only the newest
    // call may write rows or the failure flag, so an older request that
    // fails (or succeeds) late cannot overwrite a newer result.
    const gen = ++recentLoadGen.current
    try {
      const res = await fetch(apiUrl('/api/checkins/recent?days=60'))
      if (gen !== recentLoadGen.current) return
      // `{ services: [] }` on a 500 hid the panel, the same as no attendance.
      if (!res.ok) throw new Error('unread')
      const d = await res.json()
      if (gen !== recentLoadGen.current) return
      const rows = d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.services) ? d.services : null
      if (!rows) throw new Error('shape')
      setRecent(rows)
      setRecentFailed(false)
    } catch {
      if (gen !== recentLoadGen.current) return
      setRecent([])
      setRecentFailed(true)
    }
  }
  useEffect(() => { loadRecent() }, [checkins])

  // Members not already checked in (and present) — keeps the picker tidy.
  const checkedInClientIds = useMemo(
    () => new Set(checkins.filter(c => !c.checked_out_at && c.client_id).map(c => c.client_id)),
    [checkins]
  )

  const memberQueryReady = memberQuery.trim().length >= 2
  const pickedMember = members.find(m => String(m.id) === String(memberPick))
  const memberMatches = useMemo(() => {
    const q = memberQuery.trim().toLowerCase()
    if (q.length < 2) return []
    return members.filter(m =>
      !checkedInClientIds.has(m.id) &&
      (m.name || '').toLowerCase().includes(q)
    )
  }, [members, memberQuery, checkedInClientIds])
  const visibleMemberMatches = memberMatches.slice(0, 12)

  function pickMember(m) {
    setMemberPick(String(m.id))
    setMemberQuery('')
  }

  const selectedEvent = useMemo(() => events.find(e => String(e.id) === eventId), [events, eventId])
  const serviceIdForHops = parsePositiveIntId(eventId) ?? parsePositiveIntId(askedEventId)
  const personHome = checkinReturnHome(searchParams, members)
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
    // No service, or a service we could not identify: write nothing. A
    // check-in is a claim about WHO was at WHICH Mass; without the second
    // half it is not a weaker record, it is a wrong one.
    if (unresolved) return null
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
        title: t('checkin.release.title', { name: c.person_name }),
        body: t('checkin.release.body'),
        inputLabel: t('checkin.release.codeLabel'),
        confirmLabel: t('checkin.release.confirm'),
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
      // Status, not the server's English sentence, picks the copy.
      toast.error(t(
        res.status === 400 ? 'checkin.release.codeRequired'
          : res.status === 403 ? 'checkin.release.codeMismatch'
            : 'checkin.release.failed'))
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

  // A link named a service this parish cannot open. Refuse the desk rather
  // than quietly serving a different Mass: the danger here is not an empty
  // screen, it is a full one that looks right and is about the wrong service.
  if (unresolved) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16 space-y-4">
          <EmptyState
            icon={UserCheck}
            title={unresolved.reason === 404
              ? "That service isn't on this church's schedule"
              : "We couldn't open that service"}
            body={unresolved.reason === 404
              ? 'The link points to a service this church does not have — it may have been deleted, or the link may belong to another church. Nobody has been checked in. Choose a service from the Schedule to continue.'
              : 'Something went wrong loading that service, so we cannot say which one this is. Nobody has been checked in. Try again, or choose a service from the Schedule.'}
          />
          {personHome && (
            <Link
              to={personHome.to}
              className="tap inline-flex items-center gap-1.5 text-sm font-semibold text-church-700 dark:text-brass-300 hover:underline"
            >
              <ChevronLeft size={15} />
              {personHome.name ? t(personHome.labelKey, { name: personHome.name }) : t(personHome.labelKey)}
            </Link>
          )}
        </div>
      </PageWrapper>
    )
  }

  if (servicesFailed) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState icon={UserCheck} title={t('checkin.servicesUnread')}
            body={t('checkin.servicesUnreadBody')} />
        </div>
      </PageWrapper>
    )
  }

  if (events.length === 0) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState icon={UserCheck} title="No services in this window"
            body="Add a Schedule event within the last or next 30 days to check people in." />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper>
      <div className="max-w-2xl mx-auto space-y-5">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          {personHome && (
            <Link
              to={personHome.to}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-church-700 dark:text-brass-300 hover:underline mb-3"
            >
              <ChevronLeft size={15} />
              {personHome.name ? t(personHome.labelKey, { name: personHome.name }) : t(personHome.labelKey)}
            </Link>
          )}
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
          onChange={e => {
            // Rewrite the URL rather than only local state: the address bar is
            // what the next reload, the back button and a shared link read.
            setUnresolved(null)
            setEventId(e.target.value)
            setSearchParams(prev => {
              const next = new URLSearchParams(prev)
              next.set('event', e.target.value)
              return next
            }, { replace: true })
          }}
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
          {roomsFailed && (
            <p role="status" className="text-xs text-amber-800 dark:text-amber-300">{t('checkin.roomsUnread')}</p>
          )}
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

          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="flex-1 min-w-0">
                {pickedMember ? (
                  <div className="flex items-center gap-2 min-h-[42px] px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50">
                    <span className="w-6 h-6 rounded-full bg-church-900 dark:bg-church-700 flex items-center justify-center text-parchment-50 text-[9px] font-bold shrink-0">
                      {initials(pickedMember.name)}
                    </span>
                    <span className="truncate flex-1 font-medium">{pickedMember.name}</span>
                    <button
                      type="button"
                      onClick={() => setMemberPick('')}
                      aria-label="Clear selected member"
                      className="p-1 -mr-1 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 dark:text-parchment-400/60 pointer-events-none" />
                    <input
                      type="search"
                      value={memberQuery}
                      onChange={e => { setMemberQuery(e.target.value); setMemberPick('') }}
                      onKeyDown={e => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        if (memberMatches.length === 1) pickMember(memberMatches[0])
                      }}
                      placeholder="Type a name to find them…"
                      aria-label="Search a member to check in"
                      autoComplete="off"
                      className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-church-500"
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={busy || !memberPick}
                onClick={async () => { await checkIn({ client_id: Number(memberPick), kind: 'member', room_id: roomPick ? Number(roomPick) : undefined }); setMemberPick('') }}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                <Plus size={14} /> Check in
              </button>
            </div>
            {!pickedMember && memberQueryReady && (
              <ul className="max-h-56 overflow-y-auto rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 divide-y divide-parchment-200/60 dark:divide-brass-900/25">
                {membersFailed ? (
                  <li className="px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
                    {t('mem.listFailed')}
                  </li>
                ) : visibleMemberMatches.length === 0 ? (
                  <li className="px-3 py-2.5 text-xs text-ink-500 dark:text-parchment-300/70">No matching members</li>
                ) : (
                  <>
                    {visibleMemberMatches.map(m => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => pickMember(m)}
                          aria-label={m.name}
                          className="flex items-center gap-3 w-full px-3 py-3 text-left hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors"
                        >
                          <div className="w-7 h-7 rounded-full bg-church-900 dark:bg-church-700 flex items-center justify-center text-parchment-50 text-[9px] font-bold shrink-0">
                            {initials(m.name)}
                          </div>
                          <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">{m.name}</p>
                        </button>
                      </li>
                    ))}
                    {memberMatches.length > 12 && (
                      <li className="px-3 py-2 text-[11px] text-ink-500 dark:text-parchment-300/70">Keep typing to narrow the list.</li>
                    )}
                  </>
                )}
              </ul>
            )}
            {membersFailed && !pickedMember && !memberQueryReady && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                {t('mem.listFailed')}
              </p>
            )}
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
            {!checkinsFailed && (
              <span className="text-xs font-semibold text-brass-700 dark:text-brass-300">{present} present</span>
            )}
          </div>
          {checkinsFailed ? (
            <p role="status" className="px-4 py-6 text-center text-xs text-amber-800 dark:text-amber-300">{t('checkin.rosterUnread')}</p>
          ) : checkins.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-500 dark:text-parchment-300/70">No one checked in yet.</p>
          ) : (
            checkins.map(c => {
              const personHref = rosterPersonHref(c.client_id, serviceIdForHops)
              return (
              <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-parchment-300/50 dark:border-brass-900/25 first:border-t-0">
                <div className="min-w-0">
                  {/* THE ROSTER CARRIES WHO, THE WAY THE HEADER CARRIES WHICH
                      SERVICE. The row already holds client_id; it was rendered
                      as dead text, so "open the person I just checked in" meant
                      going to Members and searching for a name that is on
                      screen.

                      LINKED ON IDENTITY, NEVER ON THE NAME OR THE LABEL.
                      person_name is a historical snapshot — what this person
                      was called at this service. client_id is who they are.
                      They come apart in two ordinary ways:
                        · a guest has no member record at all;
                        · a deleted member leaves the row intact and nulls
                          client_id (ON DELETE SET NULL (client_id)), so the
                          roster still reads 'Cecilia Moreno' with kind
                          'member' and no member to open.
                      So the link is gated on client_id and nothing else.
                      Linking on kind === 'member' would send staff to a
                      profile that is not there; matching on the name would be
                      a guess about identity, which is how the wrong person
                      ends up on screen looking entirely correct.

                      The Mass travels with the person (?from=checkin&event=)
                      so the profile can return to this service, not the
                      Members roll. event is the id on this desk, never a title. */}
                  <p className={`text-sm font-medium truncate ${c.checked_out_at ? 'text-ink-400 dark:text-parchment-300/70 line-through' : 'text-ink-900 dark:text-parchment-50'}`}>
                    {personHref ? (
                      <Link
                        to={personHref}
                        className="tap-line hover:text-church-800 dark:hover:text-brass-200 hover:underline"
                        title={`Open ${c.person_name}'s profile`}
                      >
                        {c.person_name}
                      </Link>
                    ) : (
                      c.person_name
                    )}
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
                      <LogOut size={12} /> {t('checkin.release.out')}
                    </button>
                  </div>
                )}
              </div>
              )
            })
          )}
        </div>

        {/* Recent attendance report (CHK.4) */}
        {(recentFailed || recent.length > 0) && (
          <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
            <div className="px-4 py-3 border-b border-parchment-300/60 dark:border-brass-900/25">
              <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">Recent attendance</h2>
            </div>
            {recentFailed && (
              <p role="status" className="px-4 py-6 text-center text-xs text-amber-800 dark:text-amber-300">{t('checkin.recentUnread')}</p>
            )}
            {/* "Sunday Mass 10:30am — 4" answers how many. The next question is
                always WHO, and the roster for that service is on this very
                page, behind a picker holding thirty days of services whose
                titles repeat: two Sunday 10:30 Masses a fortnight apart read
                identically and are told apart only by a date. So the row opens
                itself.

                BY event_id, NEVER BY TITLE OR DATE. The panel routinely lists
                the same title twice — the service's identity is its id, the
                way a person's is client_id and not person_name. Keying this on
                what the row displays would open the wrong Mass on exactly the
                repeated titles this is meant to disambiguate.

                A Link, not a click handler: it carries the same `?event=`
                contract every other entry point uses, so back, refresh,
                open-in-new-tab and the refusal path for a service that has
                since been deleted all behave the way they already do. */}
            {recent.map(s => (
              <Link
                key={recentServiceKey(s)}
                to={checkinServiceHref(s.event_id, searchParams)}
                className={`flex items-center justify-between gap-3 px-4 py-2.5 border-t border-parchment-300/50 dark:border-brass-900/25 first:border-t-0 transition-colors hover:bg-parchment-100/70 dark:hover:bg-ink-800/60 ${String(s.event_id) === String(eventId) ? 'bg-parchment-100 dark:bg-ink-800' : ''}`}
                aria-current={String(s.event_id) === String(eventId) ? 'true' : undefined}
                title={s.title
                  ? `Show who attended ${s.title}`
                  : t('checkin.attendedUnknown')}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">{attendedServiceLabel(s, t)}</p>
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">{attendedServiceDateLabel(s, t)}</p>
                </div>
                {/* people, not check-in rows — DISTINCT_PEOPLE in
                    reporting/definitions.js. Unchanged, and not restated. */}
                <span className="shrink-0 text-sm font-bold text-brass-700 dark:text-brass-300 tabular-nums">{s.attendance}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </PageWrapper>
  )
}
