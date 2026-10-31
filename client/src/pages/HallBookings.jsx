// Parish hall holds, expected amounts, and the banquet order.
// Payments are on hold: the page says so, and it never starts a charge.
import { useCallback, useEffect, useState } from 'react'
import { Church } from 'lucide-react'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadFailure from '../components/LoadFailure'
import AnimatedButton from '../components/AnimatedButton'
import { SkeletonBlock } from '../components/Skeleton'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'

const SPACE_KINDS = ['sanctuary', 'fellowship_hall', 'kitchen', 'pavilion']
const EVENT_KINDS = ['wedding', 'rehearsal', 'fellowship_dinner', 'funeral_reception', 'quinceanera', 'hall_rental']
const MILESTONE_KINDS = [
  'date_hold', 'stipend_priest', 'stipend_organist', 'stipend_cantor',
  'stipend_altar_server', 'hall_rental', 'security_deposit',
]

const fieldCls = 'w-full rounded-lg border border-parchment-300 bg-parchment-50 px-3 py-2 text-sm text-ink-900 focus:ring-2 focus:ring-brass-400'
const primaryCls = 'rounded-lg bg-church-800 px-4 py-2 text-sm text-parchment-50 hover:bg-church-900 focus:ring-2 focus:ring-brass-400 disabled:opacity-60'

function money(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return ''
  return `$${n.toFixed(2)}`
}

function usableZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return timeZone
  } catch {
    return null
  }
}

// Every time on this page names the parish zone. With no usable zone the
// page says so rather than passing UTC off as the parish clock.
function zoneNote(timeZone, t) {
  const zone = usableZone(timeZone)
  return zone ? t('hall.zone', { zone }) : t('hall.zoneUnset')
}

function formatWhen(start, end, timeZone, locale, t) {
  const zone = usableZone(timeZone) || 'UTC'
  const loc = locale === 'es' ? 'es' : 'en'
  const a = new Date(start)
  const b = new Date(end)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${start} – ${end}`
  const day = (d) => new Intl.DateTimeFormat(loc, { timeZone: zone, year: 'numeric', month: 'short', day: 'numeric' }).format(d)
  const time = (d) => new Intl.DateTimeFormat(loc, { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(d)
  const key = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const note = t ? ` (${zoneNote(timeZone, t)})` : ''
  if (key(a) === key(b)) return `${day(a)}, ${time(a)}–${time(b)}${note}`
  return `${day(a)}, ${time(a)} – ${day(b)}, ${time(b)}${note}`
}

// A civil day (YYYY-MM-DD) in the reader's language, without moving it.
function formatDay(iso, locale) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''))
  if (!m) return String(iso ?? '')
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))
  return new Intl.DateTimeFormat(locale === 'es' ? 'es' : 'en', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(d)
}

// SP-227: say what holds the room, in the reader's language, with its
// time when there is one, and how to clear the couple's own marriage.
function conflictText(c, timeZone, locale, t) {
  const source = t(`hall.conflictSource.${c.source}`)
  const what = c.source === 'sacrament' ? t(`hall.sacrament.${c.title}`) : c.title
  const when = c.starts_at && c.ends_at
    ? formatWhen(c.starts_at, c.ends_at, timeZone, locale, t)
    : c.date ? formatDay(c.date, locale) : ''
  return [source, what, when].filter(Boolean).join(' · ')
}

async function readJson(path, options) {
  let res
  try {
    res = await fetch(apiUrl(path), options)
  } catch {
    return { ok: false, status: 0, data: null }
  }
  let data = null
  try { data = await res.json() } catch { data = null }
  return { ok: res.ok, status: res.status, data }
}

function isSpaceList(data) {
  return !!data && data.payments === 'on_hold' && Array.isArray(data.spaces)
}
function isBookingList(data) {
  return !!data && data.payments === 'on_hold' && Array.isArray(data.bookings)
}

export default function HallBookings() {
  const { t, locale } = useLocale()
  const { user } = useAuth()
  const [spaces, setSpaces] = useState(null)
  const [bookings, setBookings] = useState(null)
  const [marriages, setMarriages] = useState(null)
  const [marriagesFailed, setMarriagesFailed] = useState(false)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(null)
  // SP-237: the Sunday warning belongs to the booking that raised it.
  const [warned, setWarned] = useState({ id: null, list: [] })
  const [openId, setOpenId] = useState(null)
  const admin = user?.role === 'admin'

  const load = useCallback(async () => {
    setFailed(false)
    const [s, b, m] = await Promise.all([
      readJson('/api/catering/spaces'),
      readJson('/api/catering/bookings'),
      readJson('/api/sacraments?type=marriage'),
    ])
    if (!m.ok || !Array.isArray(m.data?.records)) {
      setMarriages(null)
      setMarriagesFailed(true)
    } else {
      setMarriages(m.data.records)
      setMarriagesFailed(false)
    }
    if (!s.ok || !isSpaceList(s.data) || !b.ok || !isBookingList(b.data)) {
      setSpaces(null)
      setBookings(null)
      setFailed(true)
      return
    }
    setSpaces(s.data.spaces)
    setBookings(b.data.bookings)
  }, [])

  useEffect(() => { load() }, [load])

  async function addSpace(event) {
    event.preventDefault()
    const formEl = event.currentTarget
    const form = new FormData(formEl)
    const result = await readJson('/api/catering/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.get('name'), space_kind: form.get('space_kind') }),
    })
    if (!result.ok) { setNotice(t('hall.saveFailed')); return }
    setNotice(t('hall.spaceSaved'))
    formEl.reset()
    await load()
  }

  async function addBooking(event) {
    event.preventDefault()
    setConflict(null)
    const formEl = event.currentTarget
    const form = new FormData(formEl)
    const starts = new Date(form.get('starts_at'))
    const ends = new Date(form.get('ends_at'))
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
      setNotice(t('hall.saveFailed'))
      return
    }
    const result = await readJson('/api/catering/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        space_id: Number(form.get('space_id')),
        event_kind: form.get('event_kind'),
        host_name: form.get('host_name'),
        occasion: form.get('occasion') || null,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        marriage_record_id: form.get('marriage_record_id') || null,
      }),
    })
    if (result.status === 409 && result.data?.code === 'conflict') {
      setConflict(result.data)
      setNotice(t('hall.conflictTitle'))
      return
    }
    if (!result.ok || result.data?.payments !== 'on_hold') {
      setNotice(t('hall.saveFailed'))
      return
    }
    setWarned({ id: result.data?.id ?? null, list: Array.isArray(result.data?.warnings) ? result.data.warnings : [] })
    setNotice(t('hall.booked'))
    formEl.reset()
    await load()
  }

  return (
    <PageWrapper type="list">
      <header className="mb-6">
        <PageHeader title={t('hall.title')} />
        <p className="mt-2 max-w-2xl text-sm text-ink-700">{t('hall.lead')}</p>
        <p className="mt-3 rounded-lg border border-brass-400/60 bg-parchment-100 px-4 py-3 text-sm text-ink-800" role="note">
          {t('hall.paymentsHold')}
        </p>
      </header>

      {notice && <p className="mb-4 text-sm text-ink-800" role="status">{notice}</p>}
      {conflict && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-ink-900" role="alert">
          <p>{t('hall.conflictTitle')}</p>
          <ul className="mt-2 list-disc pl-5">
            {(conflict.conflicts || []).map((c, i) => (
              <li key={`${c.source}-${c.title}-${i}`}>{conflictText(c, conflict.time_zone, locale, t)}</li>
            ))}
          </ul>
          {(conflict.conflicts || []).some(c => c.source === 'sacrament' && c.title === 'marriage') && (
            <p className="mt-2">{t('hall.conflictMarriageHint')}</p>
          )}
        </div>
      )}

      {failed && (
        <LoadFailure title={t('hall.loadFailed')} body={t('hall.saveFailed')} onRetry={load} />
      )}

      {spaces == null && !failed && (
        <div aria-busy="true" aria-label={t('hall.loading')}>
          <SkeletonBlock className="mb-3 h-8 w-48" />
          <SkeletonBlock className="h-24 w-full" />
        </div>
      )}

      {spaces && bookings && (
        <>
          <form onSubmit={addSpace} className="mb-8 grid gap-3 rounded-2xl border border-parchment-300 bg-parchment-100 p-4 print:hidden sm:grid-cols-3">
            <label className="text-sm text-ink-800">
              {t('hall.spaceName')}
              <input name="name" required className={`${fieldCls} mt-1`} />
            </label>
            <label className="text-sm text-ink-800">
              {t('hall.spaceKind')}
              <select name="space_kind" className={`${fieldCls} mt-1`}>
                {SPACE_KINDS.map(kind => <option key={kind} value={kind}>{t(`hall.spaceKind.${kind}`)}</option>)}
              </select>
            </label>
            <div className="flex items-end">
              <AnimatedButton type="submit" className={primaryCls}>{t('hall.addSpace')}</AnimatedButton>
            </div>
          </form>

          {spaces.length > 0 && (
            <form onSubmit={addBooking} className="mb-8 grid gap-3 rounded-2xl border border-parchment-300 bg-parchment-100 p-4 print:hidden sm:grid-cols-2">
              <label className="text-sm text-ink-800">
                {t('hall.space')}
                <select name="space_id" className={`${fieldCls} mt-1`}>
                  {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="text-sm text-ink-800">
                {t('hall.eventKind')}
                <select name="event_kind" className={`${fieldCls} mt-1`}>
                  {EVENT_KINDS.map(kind => <option key={kind} value={kind}>{t(`hall.kind.${kind}`)}</option>)}
                </select>
              </label>
              <label className="text-sm text-ink-800">
                {t('hall.host')}
                <input name="host_name" required className={`${fieldCls} mt-1`} />
              </label>
              <label className="text-sm text-ink-800">
                {t('hall.occasion')}
                <input name="occasion" className={`${fieldCls} mt-1`} />
              </label>
              <label className="text-sm text-ink-800">
                {t('hall.starts')}
                <input name="starts_at" type="datetime-local" required className={`${fieldCls} mt-1`} />
              </label>
              <label className="text-sm text-ink-800">
                {t('hall.ends')}
                <input name="ends_at" type="datetime-local" required className={`${fieldCls} mt-1`} />
              </label>
              <div className="sm:col-span-2">
                <MarriageField t={t} marriages={marriages} failed={marriagesFailed} />
              </div>
              <div className="sm:col-span-2">
                <AnimatedButton type="submit" className={primaryCls}>{t('hall.book')}</AnimatedButton>
              </div>
            </form>
          )}

          {bookings.length === 0 ? (
            <EmptyState icon={Church} title={t('hall.emptyTitle')} body={t('hall.emptyBody')} />
          ) : (
            <ul className="space-y-4">
              {bookings.map(b => (
                <li key={b.id} className={openId != null && openId !== b.id ? 'print:hidden' : ''}>
                  <BookingCard
                    booking={b}
                    admin={admin}
                    t={t}
                    locale={locale}
                    marriages={marriages}
                    marriagesFailed={marriagesFailed}
                    onChanged={load}
                    onNotice={setNotice}
                    onOpen={() => setOpenId(b.id)}
                    warnings={warned.id === b.id ? warned.list : []}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PageWrapper>
  )
}

function MarriageField({ t, marriages, failed, name = 'marriage_record_id' }) {
  return (
    <div className="text-sm text-ink-800">
      <label>
        {t('hall.marriage')}
        {failed ? (
          <p className="mt-1 text-ink-800" role="alert">{t('hall.marriagesFailed')}</p>
        ) : (
          <select name={name} className={`${fieldCls} mt-1`}>
            <option value="">{t('hall.marriageNone')}</option>
            {(marriages || []).map(record => (
              <option key={record.id} value={record.id}>{record.member_name} · {record.date}</option>
            ))}
          </select>
        )}
      </label>
    </div>
  )
}

function BookingCard({ booking, admin, t, locale, marriages, marriagesFailed, onChanged, onNotice, onOpen, warnings = [] }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailFailed, setDetailFailed] = useState(false)

  async function openDetail() {
    setOpen(true)
    onOpen?.()
    setDetailFailed(false)
    const result = await readJson(`/api/catering/bookings/${booking.id}`)
    if (!result.ok || result.data?.payments !== 'on_hold' || !Array.isArray(result.data?.milestones)) {
      setDetail(null)
      setDetailFailed(true)
      return
    }
    setDetail(result.data)
  }

  const [confirmRelease, setConfirmRelease] = useState(false)

  async function cancel(confirm) {
    const result = await readJson(`/api/catering/bookings/${booking.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirm ? { confirm_signed: true } : {}),
    })
    if (result.status === 409 && result.data?.code === 'confirm_signed') {
      setConfirmRelease(true)
      onNotice(t('hall.voidSigned'))
      return
    }
    // SP-234: say why, instead of "try again" on a refusal that will repeat.
    if (result.status === 403 && result.data?.code === 'admin') { onNotice(t('hall.cancelAdminOnly')); return }
    if (!result.ok) { onNotice(t('hall.saveFailed')); return }
    setConfirmRelease(false)
    onNotice(t('hall.cancelled'))
    await onChanged()
  }

  return (
    <article className="rounded-2xl border border-parchment-300 bg-parchment-50 p-4 shadow-warm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl text-ink-900">{booking.host_name}</h2>
        <p className="text-sm text-ink-700">{t(`hall.kind.${booking.event_kind}`)} · {booking.space_name}</p>
      </div>
      {booking.parish_name ? <p className="mt-1 text-sm text-ink-800">{booking.parish_name}</p> : null}
      <p className="mt-1 text-sm text-ink-700">{formatWhen(booking.starts_at, booking.ends_at, booking.time_zone, locale, t)}</p>
      {warnings.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-ink-900 print:hidden" role="status" data-testid="sunday-warning">
          <p>{t('hall.sundayMass')}</p>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((w, i) => <li key={`${w.title}-${i}`}>{w.title}{w.date ? ` · ${formatDay(w.date, locale)}` : ''}</li>)}
          </ul>
        </div>
      )}
      <p className="mt-1 text-xs text-ink-600">{booking.status === 'cancelled' ? t('hall.cancelled') : t('hall.paymentsHold')}</p>
      <div className="mt-3 flex flex-wrap gap-3 print:hidden">
        <button type="button" className="inline-flex min-h-[24px] min-w-[24px] items-center text-sm text-church-800 underline" onClick={openDetail}>{t('hall.beoTitle')}</button>
        {booking.status === 'held' && (
          <button type="button" className="inline-flex min-h-[24px] min-w-[24px] items-center text-sm text-ink-700 underline" onClick={() => cancel(false)}>{t('hall.cancelHold')}</button>
        )}
        {confirmRelease && booking.status === 'held' && (
          <button type="button" className="inline-flex min-h-[24px] min-w-[24px] items-center text-sm text-ink-800 underline" onClick={() => cancel(true)}>{t('hall.voidConfirm')}</button>
        )}
      </div>
      {open && detailFailed && <LoadFailure variant="strip" title={t('hall.loadFailed')} onRetry={openDetail} />}
      {open && detail && (
        <Detail
          detail={detail}
          admin={admin}
          t={t}
          locale={locale}
          marriages={marriages}
          marriagesFailed={marriagesFailed}
          onNotice={onNotice}
          onChanged={onChanged}
          reload={openDetail}
        />
      )}
    </article>
  )
}

function Detail({ detail, admin, t, locale, marriages, marriagesFailed, onNotice, onChanged, reload }) {
  const [lines, setLines] = useState(() => MILESTONE_KINDS.map(kind => {
    const found = detail.milestones.find(m => m.kind === kind)
    return {
      kind,
      on: !!found,
      amount: found?.amount || '',
      due_on: found?.due_on || '',
      id: found?.id || null,
    }
  }))

  async function saveAmounts(event) {
    event.preventDefault()
    const milestones = lines.filter(l => l.on).map(l => ({ kind: l.kind, amount: l.amount, due_on: l.due_on }))
    const result = await readJson(`/api/catering/bookings/${detail.id}/milestones`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestones }),
    })
    if (result.status === 409) { onNotice(t('hall.frozen')); return }
    if (!result.ok) { onNotice(t('hall.saveFailed')); return }
    onNotice(t('hall.amountsSaved'))
    await reload()
  }

  async function saveBeo(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const result = await readJson(`/api/catering/bookings/${detail.id}/beo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table_count: form.get('table_count'),
        chair_count: form.get('chair_count'),
        layout: form.get('layout'),
        kitchen_notes: form.get('kitchen_notes'),
        allergen_notes: form.get('allergen_notes'),
        outside_caterer: form.get('outside_caterer'),
        guaranteed_count: form.get('guaranteed_count') || null,
      }),
    })
    if (!result.ok) { onNotice(t('hall.saveFailed')); return }
    onNotice(t('hall.beoTitle'))
    await reload()
  }

  async function lockHeadcount(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const result = await readJson(`/api/catering/bookings/${detail.id}/beo/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guaranteed_count: form.get('guaranteed_count') }),
    })
    if (result.status === 409) { onNotice(t('hall.lockRefused')); return }
    if (!result.ok) { onNotice(t('hall.saveFailed')); return }
    onNotice(t('hall.locked'))
    await reload()
  }

  async function linkMarriage(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const result = await readJson(`/api/catering/bookings/${detail.id}/marriage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: Number(form.get('record_id')) }),
    })
    if (!result.ok || result.data?.register_unchanged === false) { onNotice(t('hall.saveFailed')); return }
    onNotice(t('hall.marriageSaved'))
    await onChanged()
  }

  const [preview, setPreview] = useState(null)
  const [voidSigned, setVoidSigned] = useState(false)

  async function prepare() {
    const result = await readJson(`/api/catering/bookings/${detail.id}/agreement`, { method: 'POST' })
    if (!result.ok || typeof result.data?.contract_en !== 'string') { onNotice(t('hall.saveFailed')); return }
    setPreview(result.data)
    onNotice(t('hall.preview'))
    await reload()
  }

  async function send() {
    if (!preview?.contract_sha256) { onNotice(t('hall.preview')); return }
    const result = await readJson(`/api/catering/bookings/${detail.id}/agreement/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract_sha256: preview.contract_sha256 }),
    })
    if (result.status === 409 && result.data?.code === 'counsel_pending') { onNotice(t('hall.counselPending')); return }
    if (!result.ok || result.data?.deposit_link != null || result.data?.payments !== 'on_hold' || !result.data?.copy_path) {
      onNotice(t('hall.saveFailed'))
      return
    }
    // "Approve and copy" copies. If the browser refuses the clipboard the
    // link is still issued, and the Copy link button below has it.
    const copied = await writeLink(result.data.copy_path)
    // SP-241: an expired link renewed here is new; the family needs it.
    if (result.data.renewed) onNotice(t(copied ? 'hall.renewedCopied' : 'hall.replacedNotCopied'))
    else if (result.data.already_issued) onNotice(t(copied ? 'hall.alreadyIssued' : 'hall.sentNotCopied'))
    else onNotice(t(copied ? 'hall.sentCopied' : 'hall.sentNotCopied'))
    setPreview(null)
    await reload()
  }

  async function writeLink(path) {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href)
      return true
    } catch {
      return false
    }
  }

  async function copyLink(path) {
    onNotice(t((await writeLink(path)) ? 'hall.copied' : 'hall.copyFailed'))
  }

  const [replacing, setReplacing] = useState(false)

  // Vesper R1: replacing the link stops the one the family has. The office
  // is told that first, and the server refuses without confirm_replace.
  // TARS r5: an expired link no longer works, so renewing it needs no
  // warning; it is one step, and the new link is copied.
  async function replaceLink(expired = false) {
    if (!expired && !replacing) { setReplacing(true); onNotice(t('hall.replaceWarn')); return }
    const result = await readJson(`/api/catering/bookings/${detail.id}/agreement/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm_replace: true }),
    })
    setReplacing(false)
    if (result.status === 409 && result.data?.code === 'counsel_pending') { onNotice(t('hall.replaceCounsel')); return }
    if (!result.ok || !result.data?.copy_path) { onNotice(t('hall.saveFailed')); return }
    const copied = await writeLink(result.data.copy_path)
    if (expired) onNotice(t(copied ? 'hall.renewedCopied' : 'hall.replacedNotCopied'))
    else onNotice(t(copied ? 'hall.replaced' : 'hall.replacedNotCopied'))
    await reload()
  }

  async function voidAgreement(signed) {
    if (signed && !voidSigned) { onNotice(t('hall.voidSigned')); return }
    const result = await readJson(`/api/catering/bookings/${detail.id}/agreement/void`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Withdrawn by the office', confirm_signed: signed ? true : undefined }),
    })
    if (result.status === 409 && result.data?.code === 'confirm_signed') {
      onNotice(t('hall.voidSigned'))
      return
    }
    if (!result.ok) { onNotice(t('hall.saveFailed')); return }
    setPreview(null)
    onNotice(t(signed ? 'hall.status.voided' : 'hall.status.voidedUnsigned'))
    await reload()
  }

  const beo = detail.beo
  const agreements = detail.agreements || []
  const issued = agreements.some(a => a.status === 'sent' || a.status === 'signed')
  const counselPending = preview?.counsel_pending === true
    || agreements.some(a => a.status !== 'voided' && a.status !== 'declined' && a.counsel_pending === true)
  // SP-240: "No link was issued" is said only when none was. An issued
  // agreement opens for reading or declining; a signed one keeps its record.
  // TARS r5: an expired sent link is not live; its note says it expired.
  const pendingIssued = agreements.filter(a => a.counsel_pending === true && (a.status === 'sent' || a.status === 'signed'))
  const counselNoteKey = pendingIssued.some(a => a.status === 'signed') ? 'hall.counselPendingSigned'
    : pendingIssued.some(a => !a.link_expired) ? 'hall.counselPendingSent'
      : pendingIssued.length > 0 ? 'hall.counselPendingExpired'
        : 'hall.counselPending'
  const savedTotal = (detail.milestones || []).reduce((sum, line) => sum + (Number(line.amount) || 0), 0)

  return (
    <div className="mt-4 space-y-4 border-t border-parchment-300 pt-4">
      <p className="text-sm text-ink-700" role="note">{t('hall.paymentsHold')}</p>
      {detail.liturgical_status === 'unknown' && <p className="text-sm text-ink-700">{t('hall.feastUnknown')}</p>}
      {detail.liturgical_status === 'known' && detail.liturgical?.length > 0 && (
        <p className="text-sm text-ink-800">{t('hall.feast')}: {detail.liturgical.map(d => d.feast_name || d.season).filter(Boolean).join(', ') || t('hall.noFeast')}</p>
      )}
      {detail.liturgical_status === 'known' && detail.liturgical?.length === 0 && (
        <p className="text-sm text-ink-700">{t('hall.noFeast')}</p>
      )}
      {detail.unplaced?.length > 0 && (
        <div className="text-sm text-ink-700">
          <p>{t('hall.unplaced')}</p>
          <ul className="mt-1 list-disc pl-5">
            {detail.unplaced.map((u, i) => <li key={`${u.source}-${i}`}>{u.source === 'sacrament' ? t(`hall.sacrament.${u.title}`) : u.title}{u.date ? ` · ${formatDay(u.date, locale)}` : ''}</li>)}
          </ul>
        </div>
      )}

      <form onSubmit={saveAmounts} className="print:hidden">
        <h3 className="font-display text-lg text-ink-900">{t('hall.milestones')}</h3>
        <ul className="mt-2 space-y-2">
          {lines.map((line, index) => (
            <li key={line.kind} className="grid items-center gap-2 sm:grid-cols-4">
              <label className="flex items-center gap-2 text-sm text-ink-800">
                <input type="checkbox" checked={line.on} onChange={e => {
                  const next = lines.slice()
                  next[index] = { ...line, on: e.target.checked }
                  setLines(next)
                }} />
                {t(`hall.mk.${line.kind}`)}
              </label>
              <input aria-label={t('hall.amount')} value={line.amount} onChange={e => {
                const next = lines.slice()
                next[index] = { ...line, amount: e.target.value }
                setLines(next)
              }} className={fieldCls} />
              <input aria-label={t('hall.due')} type="date" value={line.due_on} onChange={e => {
                const next = lines.slice()
                next[index] = { ...line, due_on: e.target.value }
                setLines(next)
              }} className={fieldCls} />
            </li>
          ))}
        </ul>
        <AnimatedButton type="submit" className={`${primaryCls} mt-3`}>{t('hall.saveAmounts')}</AnimatedButton>
        {detail.milestones?.length > 0 && (
          <p className="mt-2 text-sm text-ink-800">{t('hall.total')}: {money(savedTotal)}</p>
        )}
      </form>

      <form onSubmit={linkMarriage} className="flex flex-wrap items-end gap-2 print:hidden">
        <MarriageField t={t} marriages={marriages} failed={marriagesFailed} name="record_id" />
        {!marriagesFailed && <AnimatedButton type="submit" className={primaryCls}>{t('hall.marriage')}</AnimatedButton>}
      </form>

      <div data-testid="beo-print" className="hidden print:block">
        <h3 className="font-display text-lg text-ink-900">{t('hall.beoTitle')}</h3>
        {detail.parish_name ? <p>{detail.parish_name}</p> : null}
        <p>{t(`hall.kind.${detail.event_kind}`)} · {detail.space_name}</p>
        <p>{(locale === 'es' ? beo?.when_es : beo?.when_en) || formatWhen(detail.starts_at, detail.ends_at, detail.time_zone, locale, t)}</p>
        {beo && (
          <>
            <p>{t('hall.tables')}: {beo.table_count}</p>
            <p>{t('hall.chairs')}: {beo.chair_count}</p>
            {beo.layout ? <p>{t('hall.layout')}: {beo.layout}</p> : null}
            {beo.kitchen_notes ? <p>{t('hall.kitchen')}: {beo.kitchen_notes}</p> : null}
            {beo.allergen_notes ? <p>{t('hall.allergens')}: {beo.allergen_notes}</p> : null}
            {beo.outside_caterer ? <p>{t('hall.outside')}: {beo.outside_caterer}</p> : null}
            {beo.guaranteed_locked ? <p>{t('hall.guaranteed')}: {beo.guaranteed_count}</p> : null}
          </>
        )}
        {detail.milestones?.length > 0 && <p>{t('hall.total')}: {money(savedTotal)}</p>}
      </div>

      <form onSubmit={saveBeo} className="grid gap-2 print:hidden sm:grid-cols-2">
        <h3 className="font-display text-lg text-ink-900 sm:col-span-2">{t('hall.beoTitle')}</h3>
        <label className="text-sm text-ink-800">{t('hall.tables')}<input name="table_count" defaultValue={beo?.table_count ?? ''} required className={`${fieldCls} mt-1`} /></label>
        <label className="text-sm text-ink-800">{t('hall.chairs')}<input name="chair_count" defaultValue={beo?.chair_count ?? ''} required className={`${fieldCls} mt-1`} /></label>
        <label className="text-sm text-ink-800 sm:col-span-2">{t('hall.layout')}<input name="layout" defaultValue={beo?.layout || ''} className={`${fieldCls} mt-1`} /></label>
        <label className="text-sm text-ink-800">{t('hall.kitchen')}<input name="kitchen_notes" defaultValue={beo?.kitchen_notes || ''} className={`${fieldCls} mt-1`} /></label>
        <label className="text-sm text-ink-800">{t('hall.allergens')}<input name="allergen_notes" defaultValue={beo?.allergen_notes || ''} className={`${fieldCls} mt-1`} /></label>
        <label className="text-sm text-ink-800">{t('hall.guaranteed')}<input name="guaranteed_count" defaultValue={beo?.guaranteed_count ?? ''} className={`${fieldCls} mt-1`} /></label>
        <label className="text-sm text-ink-800">{t('hall.outside')}<input name="outside_caterer" defaultValue={beo?.outside_caterer || ''} className={`${fieldCls} mt-1`} /></label>
        <div className="flex flex-wrap gap-2 print:hidden sm:col-span-2">
          <AnimatedButton type="submit" className={primaryCls}>{t('hall.saveBeo')}</AnimatedButton>
          <button type="button" className="text-sm text-church-800 underline" onClick={() => window.print()}>{t('hall.print')}</button>
        </div>
      </form>
      <form onSubmit={lockHeadcount} className="flex flex-wrap items-end gap-2 print:hidden">
        <label className="text-sm text-ink-800">
          {t('hall.lock')}
          <input name="guaranteed_count" defaultValue={beo?.guaranteed_count ?? ''} required className={`${fieldCls} mt-1`} />
        </label>
        <AnimatedButton type="submit" className={primaryCls}>{t('hall.lock')}</AnimatedButton>
        {beo?.guaranteed_locked_at && <p className="text-sm text-ink-700">{t('hall.locked')}</p>}
      </form>

      {detail.warnings?.some(w => w.during === 'sunday_mass') && (
        <p className="text-sm text-ink-800" role="status">{t('hall.sundayMass')}</p>
      )}

      <section className="print:hidden">
        <h3 className="font-display text-lg text-ink-900">{t('hall.agreement')}</h3>
        <p className="mt-1 text-sm text-ink-700">{t('hall.notEmail')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {!issued && <AnimatedButton type="button" onClick={prepare} className={primaryCls}>{t('hall.prepare')}</AnimatedButton>}
          {admin && preview && !issued && (
            <AnimatedButton type="button" onClick={send} disabled={counselPending} className={primaryCls}>{t('hall.send')}</AnimatedButton>
          )}
        </div>
        {counselPending && (
          <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-ink-900" role="status" aria-live="polite" data-testid="counsel-pending">
            {t(counselNoteKey)}
          </p>
        )}
        {preview && (
          <div className="mt-3 rounded-lg border border-parchment-300 bg-parchment-100 p-3">
            <p className="text-sm text-ink-800">{t('hall.preview')}</p>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-ink-900">{locale === 'es' ? preview.contract_es : preview.contract_en}</pre>
          </div>
        )}
        {(detail.agreements || []).map(a => (
          <div key={a.id} className="mt-2 text-sm text-ink-800">
            <p>{t(
              a.status === 'voided' && !a.signed_at ? 'hall.status.voidedUnsigned'
                : a.status === 'sent' && a.link_expired ? 'hall.status.sentExpired'
                  : `hall.status.${a.status}`,
            )}</p>
            {admin && a.copy_path && (
              <button type="button" className="mt-1 inline-flex min-h-[24px] min-w-[24px] items-center text-church-800 underline" onClick={() => copyLink(a.copy_path)}>{t('hall.copyLink')}</button>
            )}
            {a.status === 'sent' && a.link_expired && !a.counsel_pending && (
              <p className="mt-1 text-ink-700" role="status" aria-live="polite" data-testid="hall-link-expired">{t('hall.linkExpired')}</p>
            )}
            {/* TARS r5: no new link while counsel's wording is missing; the
                family's current link still opens to read or decline. */}
            {admin && a.status === 'sent' && !a.counsel_pending && (
              a.link_expired ? (
                <button type="button" className="mt-1 inline-flex min-h-[24px] min-w-[24px] items-center text-church-800 underline" onClick={() => replaceLink(true)}>
                  {t('hall.renewLink')}
                </button>
              ) : (
                <button type="button" className="mt-1 inline-flex min-h-[24px] min-w-[24px] items-center text-ink-800 underline" onClick={() => replaceLink(false)}>
                  {t(replacing ? 'hall.replaceConfirm' : 'hall.replaceLink')}
                </button>
              )
            )}
            {a.status !== 'voided' && admin && (
              a.status === 'signed' ? (
                <div className="mt-2">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={voidSigned} onChange={e => setVoidSigned(e.target.checked)} />
                    <span>{t('hall.voidConfirm')}</span>
                  </label>
                  <button type="button" className="mt-1 text-ink-800 underline" onClick={() => voidAgreement(true)}>{t('hall.voidSigned')}</button>
                </div>
              ) : (
                <button type="button" className="mt-1 block text-ink-800 underline" onClick={() => voidAgreement(false)}>{t('hall.voidUnsigned')}</button>
              )
            )}
            {a.status === 'voided' && !issued && (
              <button type="button" className="mt-1 block text-church-800 underline" onClick={prepare}>{t('hall.redo')}</button>
            )}
          </div>
        ))}
      </section>
    </div>
  )
}
