// The two decisions the service worker makes about cached API data, lifted out
// of sw.js so they can be tested.
//
// sw.js itself cannot be unit-tested: it calls registerRoute() at module scope
// against the live Workbox runtime and expects a ServiceWorkerGlobalScope. Both
// of the defects these rules exist for were found in a real browser and pinned
// by mutation there — but a browser probe is not a CI gate, and a rule nothing
// watches is a rule that comes back. So the decisions live here, as plain
// functions over injected signals, and sw.js wires them to the real globals.
//
// Nothing here touches Workbox; the two returned objects are Workbox plugins by
// shape only (the lifecycle callbacks it looks for).

/**
 * @param {() => (boolean|undefined)} getNavigatorOnline
 *   The worker's own navigator.onLine, or undefined where it cannot be read.
 */
// AI responses are not an offline cache. A native shell that has AI
// excluded, or that has not yet agreed, must not be able to read a
// previously cached generation, status, quota, or key summary. Daily
// verse and the liturgical calendar are not AI and stay cacheable.
const AI_API_PREFIXES = ['/api/ai', '/api/assistant']

export function isAiApiPath(pathname) {
  const p = String(pathname || '')
  return AI_API_PREFIXES.some(prefix => p === prefix || p.startsWith(prefix + '/'))
}

// Public parish page / bulletin / groups must never enter ochr-api.
// Workbox CacheableResponsePlugin keys on status only and ignores
// Cache-Control: no-store, so a prior 200 would survive takedown offline
// (N466-1 /page, N469-1 /bulletin, N466-2 defense-in-depth for /groups).
export function isPublicApiPath(pathname) {
  const p = String(pathname || '')
  return p === '/api/public' || p.startsWith('/api/public/')
}

export function isRuntimeApiCacheable(pathname) {
  const p = String(pathname || '')
  if (!p.startsWith('/api/')) return false
  if (isAiApiPath(p)) return false
  if (isPublicApiPath(p)) return false
  return true
}

export function createCachePolicy(getNavigatorOnline) {
  // Unknown, not `true`. Before any page has spoken, the decision must rest on
  // the worker's own signal — an assumed value here is a value that can be
  // wrong in the direction that unlocks the cache.
  let pageOnline = null
  let generation = 0

  // CONNECTIVITY, RANKED. The worker's own navigator.onLine is authoritative in
  // both directions; the page's flag is a fallback consulted only in its
  // silence. OR-ing the two let a stale pageOnline=false outrank a worker that
  // knew it was online, and a genuine network error was then answered out of a
  // 24h-old cache with no banner on screen.
  const isOffline = () => {
    const nav = getNavigatorOnline()
    if (nav === false) return true
    if (nav === true) return false
    return pageOnline === false
  }

  return {
    isOffline,
    setPageOnline(online) { pageOnline = online !== false },
    /** Ends the current cache generation. Call BEFORE deleting the cache. */
    endGeneration() { generation += 1 },
    get generation() { return generation },

    /** A cached answer may be served only while the browser is offline. */
    onlyWhenOffline: {
      cachedResponseWillBeUsed: async ({ cachedResponse }) =>
        (isOffline() ? cachedResponse : null),
    },

    // A response may only be written into the generation its request was issued
    // under. Deleting the cache on logout does not cancel requests already in
    // flight, and a write landing afterwards silently re-creates the previous
    // tenant's data under a URL the next tenant will read.
    generationGuard: {
      requestWillFetch: async ({ request, state }) => {
        state.generation = generation
        return request
      },
      cacheWillUpdate: async ({ response, state }) =>
        (state.generation === generation ? response : null),
    },
  }
}
