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
//      build time via `self.__WB_MANIFEST`).
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

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import {
  NetworkFirst,
  CacheFirst,
  StaleWhileRevalidate,
} from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

// 1. Precache — built fingerprinted assets emitted by Vite.
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST || [])

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

registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({
    cacheName: 'ochr-api',
    networkTimeoutSeconds: 3,
    plugins: [
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
  // On logout the app clears the token but the NetworkFirst API cache
  // still holds this tenant's /api/* GET responses for up to 24h. On a
  // shared machine that would leak one org's data to the next signed-in
  // user, so wipe the API cache when the app asks us to. Same cache name
  // as the NetworkFirst route above ('ochr-api').
  if (event.data?.type === 'CLEAR_API_CACHE') {
    event.waitUntil(caches.delete('ochr-api'))
  }
})
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })
