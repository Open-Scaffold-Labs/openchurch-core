// One in-progress intention, held while Schedule creates the Mass for that day.
// The nonce leaves with the return URL. A later ?resume= restores this draft
// only when it carries that same nonce and the draft has not expired.
// createdMass is the Mass the server just confirmed, so the book can name it
// on the first paint. It is never trusted unless its id is the id on the URL.

import { calendarDay } from './dates'

export const INTENTION_DRAFT_KEY = 'ochr:intention-draft'
export const INTENTION_DRAFT_TTL_MS = 30 * 60 * 1000

const DRAFT_KEYS = ['intention', 'requested_by', 'mass_date', 'stipend', 'status', 'note', 'calendar_event_id', 'departed']

export function isIntentionDraftNonce(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function newIntentionDraftNonce() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return '00000000-0000-4000-8000-000000000000'
}

// A created Mass id is a positive safe integer, or the canonical decimal
// string of one. Arrays, booleans, objects, fractions, and unsafe
// magnitudes are not ids — String([80]) is "80", and that is not a type check.
export function parseCreatedMassId(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  }
  if (typeof raw === 'string' && /^[1-9]\d*$/.test(raw)) {
    const n = Number(raw)
    return Number.isSafeInteger(n) && String(n) === raw ? n : null
  }
  return null
}

function readCreatedMass(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = parseCreatedMassId(raw.id)
  if (id == null) return null
  const text = (value) => (typeof value === 'string' ? value : '')
  return {
    id,
    title: text(raw.title),
    date: text(raw.date),
    start_time: text(raw.start_time),
    end_time: text(raw.end_time),
    type: text(raw.type),
  }
}

function draftFromForm(form, editingId) {
  const safe = {}
  for (const k of DRAFT_KEYS) {
    if (form && Object.prototype.hasOwnProperty.call(form, k)) safe[k] = form[k]
  }
  const id = editingId == null ? null : Number(editingId)
  return {
    form: safe,
    editingId: Number.isInteger(id) && id > 0 ? id : null,
  }
}

export function stashIntentionDraft({ form, editingId, nonce, now = Date.now() } = {}) {
  if (!isIntentionDraftNonce(nonce)) return false
  try {
    const draft = draftFromForm(form, editingId)
    draft.nonce = nonce
    draft.expiresAt = now + INTENTION_DRAFT_TTL_MS
    sessionStorage.setItem(INTENTION_DRAFT_KEY, JSON.stringify(draft))
    return true
  } catch {
    return false
  }
}

export function peekIntentionDraft() {
  try {
    const raw = sessionStorage.getItem(INTENTION_DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.form || typeof parsed.form !== 'object') return null
    const draft = draftFromForm(parsed.form, parsed.editingId)
    draft.nonce = isIntentionDraftNonce(parsed.nonce) ? parsed.nonce : null
    draft.expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0
    const created = readCreatedMass(parsed.createdMass)
    if (created) draft.createdMass = created
    return draft
  } catch {
    return null
  }
}

// The write already landed. Remember that Mass on the open draft so the
// book can select it before the next calendar read. A missing or expired
// draft is left alone — the URL still carries the id.
export function attachCreatedMass(nonce, mass, now = Date.now()) {
  const draft = peekIntentionDraft()
  if (!draftMatchesResume(draft, nonce, now)) return false
  const created = readCreatedMass(mass)
  if (!created) return false
  const civil = calendarDay(created.date)
  const previous = draft.form.status
  const status = previous === 'open' || previous == null || previous === '' ? 'scheduled' : previous
  try {
    sessionStorage.setItem(INTENTION_DRAFT_KEY, JSON.stringify({
      form: {
        ...draft.form,
        calendar_event_id: String(created.id),
        mass_date: civil || draft.form.mass_date || '',
        status,
      },
      editingId: draft.editingId,
      nonce: draft.nonce,
      expiresAt: draft.expiresAt,
      createdMass: created,
    }))
    return true
  } catch {
    return false
  }
}

export function draftMatchesResume(draft, resume, now = Date.now()) {
  if (!draft || !isIntentionDraftNonce(resume) || draft.nonce !== resume) return false
  return typeof draft.expiresAt === 'number' && draft.expiresAt > now
}

export function takeIntentionDraft() {
  const draft = peekIntentionDraft()
  clearIntentionDraft()
  return draft
}

export function clearIntentionDraft() {
  try { sessionStorage.removeItem(INTENTION_DRAFT_KEY) } catch { /* already gone */ }
}
