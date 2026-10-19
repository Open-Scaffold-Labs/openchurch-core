// SP-014..022: what a Viewer may READ.
//
// The Help role table gives Viewers Dashboard, Schedule and Members (view),
// plus their own profile, preferences and support tickets, the Getting
// settled card (sanitised), and the notification bell, which for a Viewer
// is an EMPTY parish feed while Events/Tasks are closed (routes/
// notifications.js); it is not a per-login inbox.
// Every other GET/HEAD from a parish Viewer is 403, decided here once
// (requireAuth calls it) rather than route by route. Writes are unchanged:
// writeGate and requireRole already refuse parish-record writes; a Viewer
// can still update their own profile, preferences and support tickets.
// Archive and Events/Tasks stay CLOSED for this release (VIEWER_OPTIONS).
//
// Paths are matched on the full /api path without the query string.
// A rule is a prefix ("/api/clients" also covers "/api/clients/12") unless
// it ends in "$" (exact). DENY wins over ALLOW.

export const VIEWER_READ_ALLOW = [
  '/api/auth',                 // own session, profile, avatar
  '/api/clients',              // Members (view)
  '/api/calendar',             // Schedule
  '/api/schedule',             // Schedule
  '/api/liturgical',           // liturgical day on Dashboard/Schedule/Members
  '/api/daily-verse',          // Dashboard verse card
  '/api/notifications',        // header bell: empty parish feed for Viewers
  '/api/notification-prefs',   // own preferences
  '/api/push/vapid-key$',      // own push subscription
  '/api/support-tickets/mine', // own reports (Help > Report a problem)
  '/api/assistant/status$',    // the Assistant (Help role table)
  '/api/search',               // members only for Viewers (routes/search.js)
  // Exception (TARS R288-1, within José's delegated scope): the Getting
  // settled card is shown to every role. For a Viewer, routes/setup.js
  // projects in_place to VIEWER_SETUP_IN_PLACE (workspace, context,
  // tradition, people count, member and calendar counts: no import, no
  // funds), and import_context, deferred and admin suggestions are already
  // withheld. Exact path only; /api/setup/record stays admin-only. Remove
  // this line to close it.
  '/api/setup$',
]

// The two open Viewer decisions (DECISIONS-FOR-JOSE item 12). Flip one
// value here and both the server scope and the Viewer's sidebar/routes
// follow: the client reads this same file (client/src/auth/viewerPages.js).
//   archive     — Archive & Recovery: /api/vault and the /archive page.
//   eventsTasks — Events and Daily Tasks: /api/events, /api/tasks, and the
//                 /events and /tasks pages (also the Dashboard's event and
//                 task widgets). Event attendance stays closed either way.
export const VIEWER_OPTIONS = Object.freeze({
  archive: false,
  eventsTasks: false,
})

const OPTIONAL_READS = {
  archive: ['/api/vault'],
  eventsTasks: ['/api/events', '/api/tasks'],
}

const OPTIONAL_PAGES = {
  archive: ['/archive'],
  eventsTasks: ['/events', '/tasks'],
}

// Pages a Viewer can open (exact paths, plus /clients/:id).
export const VIEWER_PAGES = ['/', '/clients', '/schedule', '/getting-settled', '/preferences']

function enabled(table, options) {
  return Object.entries(table).flatMap(([k, list]) => (options?.[k] ? list : []))
}

export const VIEWER_READ_DENY = [
  /^\/api\/clients\/[^/]+\/donations(\/|$)/, // a member's giving
  /^\/api\/calendar\/conflicts(\/|$)/,       // admin-only page
  /^\/api\/events\/[^/]+\/attendance(\/|$)/,  // attendance, even with eventsTasks
  /^\/api\/clients\/[^/]+\/checkins(\/|$)/,   // R288-2: a member's attendance (event titles, times)
]

export const VIEWER_SCOPE_ERROR = 'Viewers can see Dashboard, Schedule and Members only.'

function stripQuery(url) {
  const i = url.indexOf('?')
  return (i === -1 ? url : url.slice(0, i)).replace(/\/+$/, '') || '/'
}

export function viewerMayRead(url, options = VIEWER_OPTIONS) {
  const path = stripQuery(String(url || '')).toLowerCase()
  if (VIEWER_READ_DENY.some(re => re.test(path))) return false
  return [...VIEWER_READ_ALLOW, ...enabled(OPTIONAL_READS, options)].some(rule => rule.endsWith('$')
    ? path === rule.slice(0, -1)
    : path === rule || path.startsWith(rule + '/'))
}

export function isReadMethod(method) {
  return method === 'GET' || method === 'HEAD'
}

export function viewerMayOpen(pathname, options = VIEWER_OPTIONS) {
  const p = (String(pathname || '/').replace(/\/+$/, '') || '/').toLowerCase()
  if ([...VIEWER_PAGES, ...enabled(OPTIONAL_PAGES, options)].includes(p)) return true
  return /^\/clients\/[^/]+$/.test(p)
}
