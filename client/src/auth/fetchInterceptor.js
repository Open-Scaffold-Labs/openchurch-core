// Wraps the global fetch so every call to our backend automatically
// sends the httpOnly session cookie (credentials: 'include'). This lets
// the rest of the app keep using `fetch(apiUrl(...))` without threading
// auth through every call site.
//
// The JWT itself is not readable from script. A leftover pre-cookie
// `ochr_token` in localStorage is wiped on sight so XSS cannot steal it.
//
// On a 401 from an authenticated request, we dispatch a window event that
// AuthContext listens for to clear local state and bounce back to /login.

const TOKEN_KEY = 'ochr_token'
const EVENT_UNAUTHORIZED = 'openchurch:unauthorized'

const base = import.meta.env.VITE_API_URL || ''

function shouldAttachAuth(urlString) {
  // Attach on any request that targets our backend.
  // - relative /api/*        (dev proxy)
  // - absolute base + /api/* (prod)
  if (urlString.startsWith('/api/')) return true
  if (base && urlString.startsWith(base + '/api/')) return true
  return false
}

// The deactivate exemption is the backend route itself: POST and the
// pathname /api/auth/deactivate, after URL parsing. A 401 from that call
// does not prove whether the login is on or off, so it must not sign the
// person out. A lookalike path or another method is an ordinary rejection.
function isDeactivatePost(urlString, input, init) {
  const method = requestMethod(input, init)
  return method === 'POST' && requestPathname(urlString) === '/api/auth/deactivate'
}

// Same uncertainty as turning a login off. A 401 from closing your own
// login does not prove whether it closed. Lookalike paths stay ordinary.
function isSelfClosePost(urlString, input, init) {
  const method = requestMethod(input, init)
  return method === 'POST' && requestPathname(urlString) === '/api/auth/close'
}

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

function purgeLegacyToken() {
  try {
    // Literal 'ochr_token' (not the TOKEN_KEY constant) so the
    // ecosystem registry audit can pattern-match it. The
    // audit greps for localStorage.getItem('ochr_token') as a
    // literal — through-a-variable usage reads as "not declared".
    if (localStorage.getItem('ochr_token')) {
      localStorage.removeItem('ochr_token')
    }
  } catch {}
}

let installed = false
export function installFetchInterceptor() {
  if (installed) return
  installed = true
  purgeLegacyToken()

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? ''
    const attach = shouldAttachAuth(url)

    let finalInit = init
    if (attach) {
      purgeLegacyToken()
      finalInit = {
        ...init,
        credentials: 'include',
      }
    }

    const res = await originalFetch(input, finalInit)

    if (attach && res.status === 401) {
      // Login and signup answer 401 for a bad password. The login page
      // handles that itself. POST /api/auth/deactivate can answer 401 when
      // this device's session is rejected. That answer does not prove
      // whether the login is on or off, and Preferences stays on the page,
      // so the shell must not treat that 401 as a sign-out.
      //
      // /api/auth/password is deliberately NOT on this list. A wrong current
      // password used to come back as 401 and sign the user out for a typo;
      // the fix was on the server (it answers 403 now — the caller is
      // authenticated, they just typed the wrong word), not another
      // exemption here. Every exemption weakens the one rule this enforces.
      const isAuthEndpoint =
        url.includes('/api/auth/login') ||
        url.includes('/api/auth/signup') ||
        isDeactivatePost(url, input, finalInit) ||
        isSelfClosePost(url, input, finalInit)
      if (!isAuthEndpoint) {
        window.dispatchEvent(new Event(EVENT_UNAUTHORIZED))
      }
    }

    return res
  }
}

export const TOKEN_STORAGE_KEY   = TOKEN_KEY
export const UNAUTHORIZED_EVENT  = EVENT_UNAUTHORIZED
