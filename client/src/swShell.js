// Cached SPA shell (PWA-L2-04).
//
// Precache matches exact URLs. A document navigation to /members (or a
// refresh on that path) is not /index.html, so offline client routes
// used to miss the shell. NavigationRoute binds those document
// requests to the precached HTML. /api, /api?…, and /api/… stay out —
// those are not the app shell. Workbox tests pathname + search.
//
// Headed offline-nav on a phone / genuine radio: NOT MEASURED.

export const SHELL_NAV_DENYLIST = [/^\/api(?:\/|\?|$)/]

export function resolveCachedShellUrl(manifest) {
  const urls = (manifest || [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.url))
    .filter(Boolean)
  return urls.find((url) => url === '/index.html' || url === 'index.html' || /(^|\/)index\.html$/.test(url)) || null
}

// `pathnameAndSearch` is the string Workbox NavigationRoute tests:
// url.pathname + url.search.
export function isDeniedShellNavigation(pathnameAndSearch) {
  return SHELL_NAV_DENYLIST.some((re) => re.test(pathnameAndSearch))
}
