// helpGuide — which Help-panel guide entry belongs to the page in view,
// and that entry as plain text.
//
// Shared by the assistant widget (client) and routes/assistant.js
// (server, imported the same way utils/timezone.js imports
// parishTimeZone.js) so the two cannot disagree about which page maps to
// which guide. The text itself is OpenChurch's own static product
// documentation (data/helpContent.js MODULE_HELP). It is never parish
// data and never anything the user typed.
//
// The server does not take guide TEXT from the client. It takes, at most,
// a key, checks it against MODULE_HELP's own keys, and builds the text
// itself. An unknown key is ignored, not echoed anywhere.
import { MODULE_HELP } from '../data/helpContent.js'

// Route → MODULE_HELP key. Tested against App.jsx's routes; a route with
// no guide entry maps to null (the widget then says so; it does not borrow
// another page's guide).
const ROUTE_HELP = [
  [/^\/schedule\/conflicts(\/|$)/, 'conflicts'],
  [/^\/schedule(\/|$)/, 'schedule'],
  [/^\/clients(\/|$)/, 'members'],
  [/^\/groups(\/|$)/, 'groups'],
  [/^\/checkin(\/|$)/, 'checkin'],
  [/^\/register(\/|$)/, 'register'],
  [/^\/mass-intentions(\/|$)/, 'intentions'],
  [/^\/(service-planner|service-mode)(\/|$)/, 'worship'],
  [/^\/events(\/|$)/, 'events'],
  [/^\/tasks(\/|$)/, 'tasks'],
  [/^\/forms(\/|$)/, 'forms'],
  [/^\/bulletin(\/|$)/, 'bulletin'],
  [/^\/donations(\/|$)/, 'donations'],
  [/^\/pledges(\/|$)/, 'pledges'],
  [/^\/payroll(\/|$)/, 'payroll'],
  [/^\/finance(\/|$)/, 'finance'],
  [/^\/ai(\/|$)/, 'ai-studio'],
  [/^\/library(\/|$)/, 'library'],
  [/^\/insights(\/|$)/, 'insights'],
  [/^\/team(\/|$)/, 'team'],
  [/^\/settings(\/|$)/, 'settings'],
  [/^\/billing(\/|$)/, 'billing'],
  [/^\/audit(\/|$)/, 'audit'],
  [/^\/notifications(\/|$)/, 'notifications'],
  [/^\/preferences(\/|$)/, 'preferences'],
  [/^\/?$/, 'dashboard'],
]

export function isHelpKey(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(MODULE_HELP, key)
}

export function helpKeyForPath(path) {
  if (typeof path !== 'string') return null
  const p = path.split(/[?#]/)[0].toLowerCase()
  for (const [re, key] of ROUTE_HELP) if (re.test(p)) return isHelpKey(key) ? key : null
  return null
}

export function helpEntry(key) {
  return isHelpKey(key) ? MODULE_HELP[key] : null
}

// The whole entry as plain text, in the Help panel's order.
export function guideText(key) {
  const m = helpEntry(key)
  if (!m) return ''
  const out = [`${m.name}`, m.overview]
  if (m.features?.length) out.push('Features:', ...m.features.map(f => `- ${f}`))
  for (const s of m.sections || []) {
    out.push(`${s.title}:`)
    if (s.content) out.push(s.content)
    for (const i of s.items || []) out.push(`- ${i.label}: ${i.desc}`)
  }
  if (m.tips?.length) out.push('Tips:', ...m.tips.map(tip => `- ${tip}`))
  return out.filter(Boolean).join('\n')
}
