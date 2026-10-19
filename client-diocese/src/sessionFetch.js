// Same cookie session as the parish client. Send credentials on every
// /api call and wipe any leftover pre-cookie JWT. Literal 'ochr_token'
// so the ecosystem registry audit can pattern-match the purge.
//
// A 401 from an authenticated request signs the shell out, except
// POST /api/auth/deactivate. That answer does not prove whether this
// login is on or off, and the account page stays put.

const base = import.meta.env.VITE_API_URL || ''

export const UNAUTHORIZED_EVENT = 'opendiocese:unauthorized'

function requestMethod(input, init) {
  if (init && typeof init.method === 'string' && init.method.trim()) {
    return init.method.trim().toUpperCase()
  }
  if (input && typeof input !== 'string' && typeof input.method === 'string' && input.method.trim()) {
    return input.method.trim().toUpperCase()
  }
  return 'GET'
}

function requestPathname(urlString) {
  try {
    const origin = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost'
    return new URL(urlString, origin).pathname
  } catch {
    return ''
  }
}

// POST and the pathname /api/auth/deactivate, after URL parsing.
// A lookalike path or another method is an ordinary rejection.
export function isSelfDeactivatePost(urlString, input, init) {
  return requestMethod(input, init) === 'POST' && requestPathname(urlString) === '/api/auth/deactivate'
}

export function isSelfClosePost(urlString, input, init) {
  return requestMethod(input, init) === 'POST' && requestPathname(urlString) === '/api/auth/close'
}

function purgeLegacyToken() {
  try {
    if (localStorage.getItem('ochr_token')) localStorage.removeItem('ochr_token')
  } catch { /* private mode */ }
}

let installedFetch = null
export function installSessionFetch() {
  if (installedFetch && window.fetch === installedFetch) return
  purgeLegacyToken()

  const originalFetch = window.fetch.bind(window)
  const wrapped = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? ''
    const attach = url.startsWith('/api/') || (base && url.startsWith(base + '/api/'))
    let finalInit = init
    if (attach) {
      purgeLegacyToken()
      finalInit = { ...init, credentials: 'include' }
    }
    const res = await originalFetch(input, finalInit)
    if (attach && res.status === 401 && !isSelfDeactivatePost(url, input, finalInit) && !isSelfClosePost(url, input, finalInit)) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    }
    return res
  }
  window.fetch = wrapped
  installedFetch = wrapped
}
