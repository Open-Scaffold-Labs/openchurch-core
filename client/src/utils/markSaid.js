// D-1 — which book rows a secretary may choose to mark said, and the day
// the confirmation offers. The day is the linked Mass's stored day.
// A row with no Mass contributes no day: the secretary types one, or
// the row is left out. Today is never the default.

export function intentionMayBeMarkedSaid(row) {
  if (!row || row.voided_at) return false
  if (row.status === 'fulfilled' || row.status === 'cancelled') return false
  if (row.fulfilment_label) return false
  // A reasoned correction latches the row. Mark said is not that path.
  if (row.entered_history === true) return false
  return true
}

export function linkedMassId(row) {
  const n = Number(row?.calendar_event_id)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function defaultSaidDate(row) {
  if (!linkedMassId(row)) return ''
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(row?.mass_date ?? ''))
  return match ? match[1] : ''
}

export function newMarkRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return '00000000-0000-4000-8000-000000000001'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BOOK_ID = /^[1-9][0-9]{0,18}$/

// Codes the mark-said route can return. A reply that invents one is not
// a confirmation.
export const MARK_SAID_EXCLUSION_CODES = new Set([
  'already_fulfilled',
  'already_recorded',
  'voided',
  'cancelled',
  'needs_date',
  'not_found',
  'conflict',
  'history_locked',
  'future_mass',
])

export function canonicalIntentionId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return String(value)
  if (typeof value === 'string' && BOOK_ID.test(value)) return value
  return null
}

export function canonicalFulfilmentDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return value
}

function sameBatch(sent, received) {
  return typeof received === 'string' && UUID.test(received)
    && typeof sent === 'string' && received.toLowerCase() === sent.toLowerCase()
}

// The book sends BIGSERIAL ids as text. A number, a blank object, or a
// null entry is not that id. The marked and excluded ids must be the
// submitted set, each once.
export function readMarkSaidResponse(body, { requestId, submittedIds }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (!sameBatch(requestId, body.batch_id)) return null
  if (!Array.isArray(body.marked) || !Array.isArray(body.excluded)) return null
  const submitted = []
  for (const raw of submittedIds) {
    const id = canonicalIntentionId(raw)
    if (!id || submitted.includes(id)) return null
    submitted.push(id)
  }
  const seen = new Set()
  const marked = []
  for (const entry of body.marked) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    if (typeof entry.id !== 'string') return null
    const id = canonicalIntentionId(entry.id)
    const date = canonicalFulfilmentDate(entry.fulfilled_date)
    if (!id || !date || seen.has(id) || !submitted.includes(id)) return null
    seen.add(id)
    marked.push({ id, fulfilled_date: date })
  }
  const excluded = []
  for (const entry of body.excluded) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    if (typeof entry.id !== 'string' || typeof entry.code !== 'string') return null
    const id = canonicalIntentionId(entry.id)
    if (!id || seen.has(id) || !submitted.includes(id) || !MARK_SAID_EXCLUSION_CODES.has(entry.code)) return null
    seen.add(id)
    excluded.push({ id, code: entry.code })
  }
  if (seen.size !== submitted.length) return null
  return { batchId: body.batch_id.toLowerCase(), marked, excluded }
}

// restored must be exactly the intentions this visit marked, as text ids.
export function readUndoResponse(body, { batchId, markedIds }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (!sameBatch(batchId, body.batch_id)) return null
  if (!Array.isArray(body.restored)) return null
  const expected = []
  for (const raw of markedIds) {
    const id = canonicalIntentionId(raw)
    if (!id || expected.includes(id)) return null
    expected.push(id)
  }
  const seen = new Set()
  const restored = []
  for (const entry of body.restored) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    if (typeof entry.id !== 'string') return null
    const id = canonicalIntentionId(entry.id)
    if (!id || seen.has(id) || !expected.includes(id)) return null
    seen.add(id)
    restored.push({ id })
  }
  if (seen.size !== expected.length) return null
  return { batchId: body.batch_id.toLowerCase(), restored }
}

// SP-160: civil today in the parish zone (YYYY-MM-DD). Only an upper bound
// for the review; it is never offered as the said day.
export function parishTodayIso(timeZone, now = new Date()) {
  let zone = 'UTC'
  if (typeof timeZone === 'string' && timeZone.trim()) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }); zone = timeZone.trim() } catch { zone = 'UTC' }
  }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const pick = type => parts.find(p => p.type === type)?.value
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

// A review row may be confirmed only with a day that is not in the future,
// and never for a linked Mass whose own day is still ahead.
export function saidRowFuture(row, todayIso) {
  if (!todayIso) return true
  const day = row?.date || ''
  const massDay = row?.massDay || ''
  return Boolean((day && day > todayIso) || (massDay && massDay > todayIso))
}
