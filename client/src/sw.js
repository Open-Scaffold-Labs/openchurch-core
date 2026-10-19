/// <reference lib="webworker" />
/* eslint-env serviceworker */

// Custom service worker (Sprint PWA / PWA.4b, lifecycle reworked in PWA.6).
//
// We moved from vite-plugin-pwa's `generateSW` to `injectManifest`
// strategy specifically so we can own this file. generateSW handles
// static precache + runtime caching from config, but it doesn't let us
// attach our own listeners — and PWA.4b needs `push` and
// `notificationclick` handlers wired through the browser's push API.
//
// What this file does, top to bottom:
//   1. Precaches the built app shell (Workbox injects the manifest at
//      build time via `self.__WB_MANIFEST`) and binds document
//      navigations to that shell so offline client routes do not 404.
//   2. Re-creates the runtime caching strategies that lived in
//      vite.config.js previously (NetworkFirst for /api/*, CacheFirst
//      for daily-verse + liturgical, StaleWhileRevalidate for fonts).
//   3. Handles `push` — renders an OS notification from the payload
//      the server sent via sendPushToUser().
//   4. Handles `notificationclick` — focuses an open tab on the deep
//      link URL or opens a new one.
//
// Lifecycle (PWA.6):
//   - No skipWaiting on install. A new SW sits in 'waiting' until
//     the user clicks Refresh in <UpdatePrompt>, which calls the
//     vite-plugin-pwa updateSW() helper, which posts a
//     { type: 'SKIP_WAITING' } message to this worker.
//   - The message listener below activates the new SW on demand;
//     clientsClaim then takes over open tabs immediately so the
//     reload picks up the new bundle without a second click.

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import {
  NetworkFirst,
  CacheFirst,
  StaleWhileRevalidate,
} from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import { createCachePolicy } from './swPolicy.js'
import { resolveCachedShellUrl, SHELL_NAV_DENYLIST } from './swShell.js'

// 1. Precache — built fingerprinted assets emitted by Vite.
//    Then bind SPA document navigations to the precached index.html
//    (PWA-L2-04). /api, /api?…, and /api/… are denylisted so a
//    document navigation cannot be answered with index.html.
const precacheManifest = self.__WB_MANIFEST || []
cleanupOutdatedCaches()
precacheAndRoute(precacheManifest)
const cachedShellUrl = resolveCachedShellUrl(precacheManifest)
if (cachedShellUrl) {
  registerRoute(new NavigationRoute(createHandlerBoundToURL(cachedShellUrl), {
    denylist: SHELL_NAV_DENYLIST,
  }))
}

// 2. Runtime caching (mirrors PWA.2). GETs only — Workbox's matchers
//    default to method:'GET' so mutations always go straight to the
//    network.
registerRoute(
  ({ url }) =>
    url.pathname === '/api/daily-verse' ||
    url.pathname.startsWith('/api/liturgical'),
  new CacheFirst({
    cacheName: 'ochr-daily-content',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 24 * 60 * 60 }),
    ],
  }),
)

// A cached API answer may be served ONLY while the browser says it is
// offline — which is exactly when <OfflineBanner> is on screen. The two
// must agree (banner visible ↔ onlyWhenOffline may use the cache). The
// banner itself stays offline-honest: a miss is FAILED, not "showing
// cached data from your last visit".
//
// Before this plugin, NetworkFirst's 3-second timeout served the cached
// copy on any SLOW connection too: online, no banner, and the page rendered
// yesterday's number as today's. Reproduced on the Finance ledger against a
// live server with a 4.5-second link: April held $100.00, the page showed
// the cached $0.00, said nothing, and kept saying it after the real answer
// arrived (the late response only refreshed the cache). A false zero, from
// the transport layer, underneath every FAILED ≠ EMPTY ≠ STALE state the
// app has — and none of them could see it.
//
// So: online means wait for the truth, however slow; a network error while
// online surfaces as the failure it is, and the page's own states handle
// it. Offline behaviour is unchanged. Returning null here is a cache miss,
// and Workbox then awaits the network promise rather than answering null.
// Two signals, RANKED — they are not equals, and OR-ing them was a defect.
//
//   1. The worker's own navigator.onLine. Authoritative in both directions.
//   2. The page's, sent by <OfflineBanner> on change (ONLINE_STATE below).
//      A fallback, used only when the worker has no signal of its own.
//
// The first version treated them as interchangeable: `pageOnline === false
// || navigator.onLine === false`. Reproduced against the preview build with
// the API server killed (a genuine TCP failure, browser online throughout):
// a stale pageOnline=false — left behind by any earlier offline blip, an
// unloaded tab, a client that never sent an update — overrode the worker's
// own navigator.onLine === true and served a 24h-old cached ledger as
// current. Server truth 8 rows, page rendered 7, no banner on screen,
// browser online. The exact false-zero class the plugin exists to prevent,
// reintroduced through the second signal.
//
// So the page flag can only ever say "offline" into a silence. It can never
// contradict a worker that knows it is online. Note the earlier comment's
// premise was also wrong: Playwright's offline emulation DOES reach the
// worker's navigator, so branch 1 is observable from a harness after all.
//
// Startup: pageOnline begins null (unknown, not `true`), so before any
// ONLINE_STATE message arrives the decision rests entirely on the worker's
// own navigator — there is no window in which an unset flag can either
// unlock the cache or falsely vouch for the network.
// Both rules live in ./swPolicy.js as plain functions so CI can watch them go
// red; this file only wires them to the real worker globals.
const policy = createCachePolicy(() => (self.navigator ? self.navigator.onLine : undefined))
const { onlyWhenOffline, generationGuard } = policy

// CACHE GENERATION — a response may only be written into the cache generation
// its request was issued under.
//
// CLEAR_API_CACHE (below) empties 'ochr-api' on logout so a shared machine
// cannot serve one parish's roster to the next person who signs in. Deleting
// the cache does not, however, cancel requests already in flight: NetworkFirst
// writes each one when it resolves, and a write that resolves AFTER the delete
// silently recreates the cache under the previous tenant.
//
// Reproduced in a real browser, not theorised: parish A's
// /api/clients held open 2.5s, logout purge fired at +400ms, cache verified
// empty, the late response landed and re-created /api/clients. Parish B then
// signed in on the same machine, went offline, and was shown parish A's
// roster — 'AAA Alpha', 'ZZZ Omega' — under B's own session. /api/clients is
// the same URL for every tenant, so nothing in the cache key distinguishes
// them; the purge was the only boundary, and this defeated it.
//
// So each request records the generation it was issued under, and the write is
// dropped if the generation has moved on. Returning null from cacheWillUpdate
// is Workbox's "do not cache this" and leaves the response to the caller
// untouched — the in-flight page still gets its data, it just cannot persist
// it into a session that has ended. `state` is per-plugin, per-request, which
// is what makes the pairing safe under concurrency.

registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({
    cacheName: 'ochr-api',
    networkTimeoutSeconds: 3,
    // Session is an httpOnly cookie. Workbox's default fetch is
    // same-origin credentials; say so explicitly so a future
    // cross-origin VITE_API_URL cannot silently drop the cookie.
    fetchOptions: { credentials: 'same-origin' },
    plugins: [
      onlyWhenOffline,
      generationGuard,
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 24 * 60 * 60 }),
    ],
  }),
)

registerRoute(
  ({ url }) =>
    url.origin === 'https://fonts.googleapis.com' ||
    url.origin === 'https://fonts.gstatic.com',
  new StaleWhileRevalidate({
    cacheName: 'ochr-fonts',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 24 * 60 * 60 }),
    ],
  }),
)

// 3. Push. Server sends a JSON payload via sendPushToUser({ title,
//    body, url, tag }). Display gracefully even if the payload is
//    malformed — a generic fallback is far better than throwing
//    inside the SW and dropping the notification entirely.
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    // Some push services deliver plaintext on encryption issues —
    // surface the raw text so the user still sees something.
    payload = { title: 'OpenChurch', body: event.data?.text?.() ?? '' }
  }

  const title = payload.title || 'OpenChurch'
  const options = {
    body:    payload.body || '',
    icon:    '/icon.svg',
    badge:   '/icon.svg',
    tag:     payload.tag || undefined,          // dedupes reminders
    data:    { url: payload.url || '/' },
    renotify: Boolean(payload.tag),             // re-buzz on retag
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

// 4. Notification click — focus an existing tab on the target URL
//    (so we don't pile up duplicate windows when an admin already has
//    OpenChurch open), else open a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || '/'
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of all) {
      // Match on pathname so query-string variants still count.
      const u = new URL(client.url)
      if (u.pathname === new URL(target, self.location.origin).pathname && 'focus' in client) {
        return client.focus()
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target)
    return null
  })())
})

// User-controlled activation (PWA.6). The new SW waits in 'installed'
// until the page posts SKIP_WAITING — the plugin's updateSW() helper
// fires that message when the user clicks Refresh in <UpdatePrompt>.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
  // On logout the app clears the session cookie but the NetworkFirst API cache
  // still holds this tenant's /api/* GET responses for up to 24h. On a
  // shared machine that would leak one org's data to the next signed-in
  // user, so wipe the API cache when the app asks us to. Same cache name
  // as the NetworkFirst route above ('ochr-api').
  if (event.data?.type === 'CLEAR_API_CACHE') {
    // Bump BEFORE the delete, synchronously: every request already in flight
    // now belongs to a generation that has ended, so its write is dropped
    // whether it resolves before or after the delete completes.
    policy.endGeneration()
    event.waitUntil(caches.delete('ochr-api'))
  }
  if (event.data?.type === 'ONLINE_STATE') {
    policy.setPageOnline(event.data.online)
  }
})
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })
