// One in-progress intention, held while Schedule creates the Mass for that day.
// The nonce leaves with the return URL. A later ?resume= restores this draft
// only when it carries that same nonce and the draft has not expired.

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
    return draft
  } catch {
    return null
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
