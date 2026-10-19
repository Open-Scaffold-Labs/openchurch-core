// PWA-L2-04 — cached-shell navigation + update/reload contract.
//
// Audit #144 left cached-shell nav UNKNOWN: precache matched exact
// URLs, so /members (or a refresh there) missed index.html while
// offline. This pins the NavigationRoute wiring and the SKIP_WAITING
// update path. Headed offline-nav / production SW update: NOT MEASURED.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { NavigationRoute } from 'workbox-routing'
import { resolveCachedShellUrl, isDeniedShellNavigation, SHELL_NAV_DENYLIST } from './swShell.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const swSrc = readFileSync(join(HERE, 'sw.js'), 'utf8')
const viteSrc = readFileSync(join(HERE, '../vite.config.js'), 'utf8')

describe('cached SPA shell URL', () => {
  it('resolves /index.html or index.html from the precache manifest', () => {
    expect(resolveCachedShellUrl([{ url: '/index.html', revision: 'a' }])).toBe('/index.html')
    expect(resolveCachedShellUrl([{ url: 'index.html', revision: 'a' }])).toBe('index.html')
    expect(resolveCachedShellUrl(['/assets/app.js', 'index.html'])).toBe('index.html')
  })

  it('returns null when the shell is not in the manifest — do not crash the worker', () => {
    expect(resolveCachedShellUrl([])).toBeNull()
    expect(resolveCachedShellUrl([{ url: '/assets/app.js' }])).toBeNull()
    expect(resolveCachedShellUrl(undefined)).toBeNull()
  })
})

describe('shell navigation denylist — API is not HTML', () => {
  // Workbox tests pathname + search. `/api` and `/api?…` are the API root;
  // `/api/…` is every API path. `/apples` is not the API.
  it('denies /api, /api/, /api/…, and /api?… and allows client routes', () => {
    for (const path of ['/api', '/api/', '/api/clients', '/api/liturgical/today', '/api?x=1', '/api/clients?x=1']) {
      expect(isDeniedShellNavigation(path), path).toBe(true)
    }
    for (const path of ['/members', '/login', '/p/demo/events', '/apples', '/assets/api-foo.js']) {
      expect(isDeniedShellNavigation(path), path).toBe(false)
    }
    expect(SHELL_NAV_DENYLIST).toEqual([/^\/api(?:\/|\?|$)/])
  })

  it('the real NavigationRoute refuses those API URLs and accepts a client route', () => {
    const route = new NavigationRoute(() => new Response('shell'), { denylist: SHELL_NAV_DENYLIST })
    const nav = (path) => route.match({
      url: new URL(path, 'http://127.0.0.1'),
      request: { mode: 'navigate' },
    })
    expect(nav('/api')).toBe(false)
    expect(nav('/api?x=1')).toBe(false)
    expect(nav('/api/clients')).toBe(false)
    expect(nav('/schedule')).toBe(true)
    expect(nav('/clients/1')).toBe(true)
    // A fetch is not a navigation, so the shell route must not take it.
    expect(route.match({
      url: new URL('/schedule', 'http://127.0.0.1'),
      request: { mode: 'cors' },
    })).toBe(false)
  })
})

describe('sw.js wires the shell fallback and the update path', () => {
  it('registers NavigationRoute bound to the resolved shell URL', () => {
    expect(swSrc).toMatch(/new NavigationRoute\(createHandlerBoundToURL\(cachedShellUrl\)/)
    expect(swSrc).toMatch(/denylist:\s*SHELL_NAV_DENYLIST/)
    expect(swSrc).toMatch(/resolveCachedShellUrl\(precacheManifest\)/)
    expect(swSrc).toMatch(/precacheAndRoute\(precacheManifest\)/)
  })

  it('vite injectManifest still precaches html so the shell can exist', () => {
    expect(viteSrc).toMatch(/globPatterns:\s*\[['"]\*\*\/\*\.\{js,css,html/)
  })

  it('Refresh still skip-waits; activate still claims clients', () => {
    expect(swSrc).toMatch(/event\.data\?\.type === 'SKIP_WAITING'/)
    expect(swSrc).toMatch(/self\.skipWaiting\(\)/)
    expect(swSrc).toMatch(/self\.clients\.claim\(\)/)
  })
})
