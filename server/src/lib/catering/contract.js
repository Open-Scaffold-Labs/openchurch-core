// OpenChurch binding of the catering calls Dale named in OC-CAT-1
// (issue #342, comment 6400326354).
//
// Upstream pin: @openscaffold/catering main 6e57328b42da546589916cb0e1555157de5adc97.
// On 2026-10-27 the workspace token received 404 for
// Open-Scaffold-Labs/openscaffold-catering (npm 404 as well). These
// functions are the parish binding of the names in that assignment
// (buildMilestoneScheduleAndContract, buildBanquetEventOrder,
// lockGuaranteedHeadcount). They are not the bytes of that commit.
//
// Payments are on hold. A schedule records an expected amount and a due
// date. Nothing here builds a checkout, a card charge, or a transfer.

import { createHash } from 'node:crypto'
import { civilDateIso } from './conflicts.js'
import { AGREEMENT_TOPICS, counselText } from './counselTerms.js'

export const CATERING_UPSTREAM = Object.freeze({
  name: '@openscaffold/catering',
  commit: '6e57328b42da546589916cb0e1555157de5adc97',
  readable: false,
})

export const VERTICAL_KEY = 'open-church'

export const SPACE_KINDS = Object.freeze([
  'sanctuary', 'fellowship_hall', 'kitchen', 'pavilion',
])

export const EVENT_KINDS = Object.freeze([
  'wedding', 'rehearsal', 'fellowship_dinner', 'funeral_reception', 'quinceanera', 'hall_rental',
])

export const MILESTONE_KINDS = Object.freeze([
  'date_hold',
  'stipend_priest',
  'stipend_organist',
  'stipend_cantor',
  'stipend_altar_server',
  'hall_rental',
  'security_deposit',
])

const MAX_CENTS = 999999999999

// A real amount in integer cents. Booleans, blanks, arrays, objects,
// negatives, and more than two decimal places are refused. Zero is a
// real amount the office typed. A missing field is null, not zero.
export function parseAmountCents(raw) {
  if (typeof raw === 'boolean' || raw == null) return null
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null
    const cents = Math.round(raw * 100)
    if (Math.abs(raw * 100 - cents) > 1e-6) return null
    if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null
    return cents
  }
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null
  return cents
}

export function formatCents(cents) {
  const n = Number(cents)
  if (!Number.isSafeInteger(n) || n < 0) return null
  const whole = Math.floor(n / 100)
  const frac = String(n % 100).padStart(2, '0')
  return `${whole}.${frac}`
}

// amount_cents is already minor units (a JSON integer, or the text a
// BIGINT comes back as). amount is a dollar figure. They are not the
// same scale. A non-integer amount_cents is refused rather than read
// as dollars.
function integerCents(raw) {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > MAX_CENTS) return null
    return raw
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim())
    if (!Number.isSafeInteger(n) || n > MAX_CENTS) return null
    return n
  }
  return null
}

export function lineAmountCents(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.amount_cents != null) return integerCents(raw.amount_cents)
  return parseAmountCents(raw.amount)
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function isIsoInstant(value) {
  if (typeof value !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  const t = Date.parse(value)
  return Number.isFinite(t)
}

export const EVENT_LABELS = Object.freeze({
  en: {
    wedding: 'Wedding', rehearsal: 'Rehearsal', fellowship_dinner: 'Parish supper',
    funeral_reception: 'Funeral reception', quinceanera: 'Quinceañera', hall_rental: 'Hall rental',
  },
  es: {
    wedding: 'Boda', rehearsal: 'Ensayo', fellowship_dinner: 'Cena parroquial',
    funeral_reception: 'Recepción de funeral', quinceanera: 'Quinceañera', hall_rental: 'Alquiler del salón',
  },
})

export const MILESTONE_LABELS = Object.freeze({
  en: {
    date_hold: 'Date hold', stipend_priest: 'Priest stipend', stipend_organist: 'Organist stipend',
    stipend_cantor: 'Cantor stipend', stipend_altar_server: 'Altar server stipend',
    hall_rental: 'Hall rental', security_deposit: 'Security deposit',
  },
  es: {
    date_hold: 'Apartado de la fecha', stipend_priest: 'Estipendio del sacerdote',
    stipend_organist: 'Estipendio del organista', stipend_cantor: 'Estipendio del cantor',
    stipend_altar_server: 'Estipendio del monaguillo', hall_rental: 'Alquiler del salón',
    security_deposit: 'Depósito de garantía',
  },
})


function lineLabel(kind, label) {
  const custom = typeof label === 'string' ? label.trim().slice(0, 120) : ''
  return custom || kind
}

export function formatDollars(cents) {
  const text = formatCents(cents)
  return text == null ? null : `$${text}`
}

function validZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: timeZone.trim() })
    return timeZone.trim()
  } catch {
    return null
  }
}

// Every printed time names the zone it is in. A parish with no usable zone
// is told so; the time is not silently shown as if UTC were the parish's.
export function zoneLabel(timeZone, locale) {
  const zone = validZone(timeZone)
  if (locale === 'es') return zone ? `hora de ${zone}` : 'zona horaria sin fijar; se muestra en UTC'
  return zone ? `${zone} time` : 'time zone not set; shown in UTC'
}

function clock(iso, timeZone, locale) {
  const dt = new Date(iso)
  const zone = validZone(timeZone) || 'UTC'
  const loc = locale === 'es' ? 'es' : 'en'
  return {
    civil: civilDateIso(dt, zone),
    date: new Intl.DateTimeFormat(loc, { timeZone: zone, year: 'numeric', month: 'short', day: 'numeric' }).format(dt),
    time: new Intl.DateTimeFormat(loc, { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(dt),
  }
}

export function formatWindow(startsAt, endsAt, timeZone, locale) {
  const a = clock(startsAt, timeZone, locale)
  const b = clock(endsAt, timeZone, locale)
  const zone = ` (${zoneLabel(timeZone, locale)})`
  if (a.civil === b.civil) return `${a.date}, ${a.time}–${b.time}${zone}`
  return `${a.date}, ${a.time} – ${b.date}, ${b.time}${zone}`
}

// A due date is a calendar day, not an instant: format it without moving it.
export function formatCivilDate(isoDate, locale) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? ''))
  if (!m) return String(isoDate ?? '')
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))
  return new Intl.DateTimeFormat(locale === 'es' ? 'es' : 'en', {
    timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
  }).format(dt)
}

function contractParagraphs(snapshot) {
  const total = snapshot.milestones.reduce((sum, m) => sum + m.amount_cents, 0)
  const lines = (locale) => snapshot.milestones.map(m => {
    const name = MILESTONE_LABELS[locale][m.kind] || m.kind
    const office = m.label && m.label !== m.kind ? ` (${m.label})` : ''
    return locale === 'es'
      ? `${name}${office}: se esperan ${formatDollars(m.amount_cents)}, con vencimiento el ${formatCivilDate(m.due_on, 'es')}.`
      : `${name}${office}: ${formatDollars(m.amount_cents)} expected, due ${formatCivilDate(m.due_on, 'en')}.`
  })
  const parish = snapshot.parish_name ? `, ${snapshot.parish_name}` : ''
  const when = (locale) => formatWindow(snapshot.starts_at, snapshot.ends_at, snapshot.time_zone, locale)
  const counsel = (locale) => AGREEMENT_TOPICS.map(topic => counselText(locale, topic))
  const en = [
    `Parish hall agreement for ${snapshot.host_name}${parish}.`,
    `${EVENT_LABELS.en[snapshot.event_kind] || snapshot.event_kind} in ${snapshot.space_name}, ${when('en')}.`,
    'These amounts are what the parish expects, and when. Nothing is charged by signing.',
    'The sacramental register is a separate book. Signing this page does not enter a marriage, a burial, or any other sacrament.',
    ...counsel('en'),
    ...lines('en'),
    `Total expected: ${formatDollars(total)}.`,
  ].join('\n')
  const es = [
    `Acuerdo del salón parroquial para ${snapshot.host_name}${parish}.`,
    `${EVENT_LABELS.es[snapshot.event_kind] || snapshot.event_kind} en ${snapshot.space_name}, ${when('es')}.`,
    'Estas cantidades son lo que la parroquia espera, y cuándo. Firmar no cobra nada.',
    'El registro sacramental es otro libro. Firmar esta página no asienta un matrimonio, un entierro, ni ningún otro sacramento.',
    ...counsel('es'),
    ...lines('es'),
    `Total esperado: ${formatDollars(total)}.`,
  ].join('\n')
  return { en, es }
}

// The office names every line. This does not invent a fee, a stipend, or a zero.
export function buildMilestoneScheduleAndContract({
  eventKind, hostName, spaceName, startsAt, endsAt, milestones, parishName, timeZone,
}) {
  if (!EVENT_KINDS.includes(eventKind)) return { ok: false, code: 'event_kind' }
  if (typeof hostName !== 'string' || !hostName.trim() || hostName.trim().length > 200) {
    return { ok: false, code: 'host_name' }
  }
  if (typeof spaceName !== 'string' || !spaceName.trim()) return { ok: false, code: 'space' }
  if (!Array.isArray(milestones) || milestones.length === 0 || milestones.length > 12) {
    return { ok: false, code: 'milestones' }
  }
  const seen = new Set()
  const lines = []
  for (const raw of milestones) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'milestones' }
    if (!MILESTONE_KINDS.includes(raw.kind)) return { ok: false, code: 'milestone_kind' }
    if (seen.has(raw.kind)) return { ok: false, code: 'milestone_duplicate' }
    seen.add(raw.kind)
    const amountCents = lineAmountCents(raw)
    if (amountCents == null) return { ok: false, code: 'amount' }
    if (!isIsoDate(raw.due_on)) return { ok: false, code: 'due_on' }
    lines.push({
      kind: raw.kind,
      label: lineLabel(raw.kind, raw.label),
      amount_cents: amountCents,
      due_on: raw.due_on,
    })
  }
  const snapshot = {
    vertical_key: VERTICAL_KEY,
    event_kind: eventKind,
    host_name: hostName.trim(),
    space_name: spaceName.trim(),
    parish_name: typeof parishName === 'string' ? parishName.trim() : '',
    time_zone: validZone(timeZone),
    starts_at: startsAt,
    ends_at: endsAt,
    milestones: lines,
    payments: 'on_hold',
  }
  const contract_sha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  return {
    ok: true,
    schedule: lines,
    snapshot,
    contract: contractParagraphs(snapshot),
    contract_sha256,
    payments: 'on_hold',
  }
}

export function buildBanquetEventOrder({ booking, beo, parishName, timeZone }) {
  const zone = validZone(timeZone) || validZone(booking.time_zone)
  const locked = Boolean(beo.locked_at)
  return {
    vertical_key: VERTICAL_KEY,
    title_en: 'Banquet event order',
    title_es: 'Orden del banquete',
    parish_name: parishName || booking.parish_name || '',
    host_name: booking.host_name,
    event_kind: booking.event_kind,
    event_label_en: EVENT_LABELS.en[booking.event_kind] || booking.event_kind,
    event_label_es: EVENT_LABELS.es[booking.event_kind] || booking.event_kind,
    space_name: booking.space_name,
    when_en: formatWindow(booking.starts_at, booking.ends_at, zone, 'en'),
    when_es: formatWindow(booking.starts_at, booking.ends_at, zone, 'es'),
    time_zone: zone,
    starts_at: booking.starts_at,
    ends_at: booking.ends_at,
    table_count: beo.table_count,
    chair_count: beo.chair_count,
    layout: beo.layout,
    kitchen_notes: beo.kitchen_notes,
    allergen_notes: beo.allergen_notes,
    outside_caterer: beo.outside_caterer,
    guaranteed_count: locked ? beo.guaranteed_count : null,
    guaranteed_locked: locked,
    guaranteed_locked_at: locked ? beo.locked_at : null,
    payments: 'on_hold',
  }
}

// Lock is a fact about the guaranteed count. A second lock of the same
// count is the same fact. A different count is refused and the original stays.
export function lockGuaranteedHeadcount({ lockedAt, currentCount, nextCount }) {
  if (!Number.isSafeInteger(nextCount) || nextCount < 0 || nextCount > 100000) {
    return { ok: false, code: 'guaranteed_count' }
  }
  if (lockedAt) {
    if (currentCount === nextCount) return { ok: true, unchanged: true, guaranteed_count: currentCount }
    return { ok: false, code: 'headcount_locked' }
  }
  return { ok: true, unchanged: false, guaranteed_count: nextCount }
}
