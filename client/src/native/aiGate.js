// Pure decisions for a kind the provider already resolved. The kind is the
// build ceiling intersected with the server's answer, not the server alone.
//
// web            — ordinary browser. Unchanged.
// pending        — native, the answer has not arrived. Closed.
// unavailable    — native, the answer could not be read. Closed.
// excluded       — native, AI is not in this build, or the server tightened it. Closed.
// disclosure-stale — native, this build's agreement text is not the one the server will record. Closed.
// consent        — native, agreement required and not yet active. No send.
// open           — native, this person has an active agreement.

export const AI_PATHS = ['/ai', '/library']
export const AI_HELP_MODULE_IDS = new Set(['ai-studio', 'library'])
export const AI_FAQ_QUESTION = 'Does the AI assistant answer canon-law questions?'
export const AI_ROLE_AREA = 'Report a problem; use the Assistant'

export function aiSurfacesClosed(kind) {
  return kind === 'pending' || kind === 'unavailable' || kind === 'excluded' || kind === 'disclosure-stale'
}

export function allowsAiSend(kind) {
  return kind === 'web' || kind === 'open'
}

export function isAiPath(pathname) {
  const p = (String(pathname || '/').replace(/\/+$/, '') || '/').toLowerCase()
  return AI_PATHS.includes(p)
}

export function navItemVisible(item, kind) {
  if (!item) return false
  if (aiSurfacesClosed(kind) && isAiPath(item.to)) return false
  return true
}

export function filterAiCommands(commands, kind) {
  const list = Array.isArray(commands) ? commands : []
  if (!aiSurfacesClosed(kind)) return list
  return list.filter(cmd => !isAiPath(cmd?.to))
}

export function helpModuleVisible(id, kind) {
  if (!aiSurfacesClosed(kind)) return true
  return !AI_HELP_MODULE_IDS.has(id)
}

export function helpSearchRowVisible(row, kind) {
  if (!row) return false
  if (!aiSurfacesClosed(kind)) return true
  if (AI_HELP_MODULE_IDS.has(row.id)) return false
  if (row.kind === 'faq' && row.title === AI_FAQ_QUESTION) return false
  return true
}

export function helpFaqVisible(question, kind) {
  if (!aiSurfacesClosed(kind)) return true
  return question !== AI_FAQ_QUESTION
}

export function showParishAiKey(kind) {
  return kind === 'web' || kind === 'open' || kind === 'consent'
}

export function showWelcomeStudio(kind) {
  return kind === 'web' || kind === 'open' || kind === 'consent'
}

export function showConsentWithdrawal(kind) {
  return kind === 'consent' || kind === 'open'
}
