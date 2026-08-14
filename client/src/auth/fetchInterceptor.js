// Wraps the global fetch so every call to our backend automatically carries
// the bearer token saved by AuthContext. This lets the rest of the app keep
// using the existing `fetch(apiUrl(...))` pattern without threading auth
// headers through every call site.
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

let installed = false
export function installFetchInterceptor() {
  if (installed) return
  installed = true

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? ''
    const attach = shouldAttachAuth(url)

    let finalInit = init
    if (attach) {
      // Literal 'ochr_token' (not the TOKEN_KEY constant) so the
      // ecosystem registry audit can pattern-match it. The
      // audit greps for localStorage.getItem('ochr_token') as a
      // literal — through-a-variable usage reads as "not declared".
      const token = localStorage.getItem('ochr_token')
      if (token) {
        finalInit = {
          ...init,
          headers: {
            ...(init?.headers || {}),
            Authorization: `Bearer ${token}`,
          },
        }
      }
    }

    const res = await originalFetch(input, finalInit)

    if (attach && res.status === 401) {
      // Don't fire for /api/auth/* — those endpoints return 401 on bad
      // credentials and we want the login page to handle that locally
      // rather than bouncing itself.
      const isAuthEndpoint =
        url.includes('/api/auth/login') ||
        url.includes('/api/auth/signup')
      if (!isAuthEndpoint) {
        window.dispatchEvent(new Event(EVENT_UNAUTHORIZED))
      }
    }

    return res
  }
}

export const TOKEN_STORAGE_KEY   = TOKEN_KEY
export const UNAUTHORIZED_EVENT  = EVENT_UNAUTHORIZED
