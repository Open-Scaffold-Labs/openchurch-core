import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { apiUrl } from '../api'
import { UNAUTHORIZED_EVENT } from '../auth/fetchInterceptor'
import { clearIntentionDraft } from '../utils/intentionDraft'

// Shape of the in-memory user object (matches what /api/auth/me returns):
//   { id, email, name, role, organization: { id, name, slug } }

const AuthContext = createContext(null)

// Clear the service-worker API cache (name mirrors the NetworkFirst
// route in sw.js). Called on every logout / session-drop so a shared
// machine doesn't leak one tenant's cached /api/* GETs to the next
// signed-in user. Belt and suspenders: ask the active SW to delete it
// (it owns the cache) AND delete directly from the page in case no SW
// is controlling yet. Fully guarded — a browser without SW/Cache API
// just no-ops.
function clearApiCache() {
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_API_CACHE' })
    }
  } catch {}
  try {
    if (typeof window !== 'undefined' && window.caches) {
      window.caches.delete('ochr-api')
    }
  } catch {}
}

// Pre-cookie JWTs lived in localStorage under ochr_token and were
// XSS-stealable. After the httpOnly cookie cutover the session is not
// readable from script. Any leftover value from an older build must
// be wiped on sight — the literal key is what the registry audit greps.
function purgeLegacyToken() {
  try {
    if (localStorage.getItem('ochr_token')) {
      localStorage.removeItem('ochr_token')
    }
  } catch {}
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null)
  // The JWT is httpOnly. This field stays null so callers that once
  // read `token` cannot put a durable credential back in script storage.
  const [token] = useState(null)
  // `loading` stays true while we ask /me whether the cookie session is
  // valid. Pages should show a skeleton during this window rather than
  // flash the login screen when the user actually is signed in.
  const [loading, setLoading] = useState(true)
  // Three states, not two. `GET /api/auth/me` answers 401 for every positive
  // rejection — no cookie, bad or expired token, unknown user, revoked
  // token_version — and 500 when the database threw and it COULD NOT CHECK
  // (server/src/middleware/auth.js, 'Authentication check failed'). It cannot
  // answer 403: the route carries requireAuth and no role gate.
  //
  // A rejection ends a session. Silence does not. The cookie is httpOnly,
  // so a 5xx cannot and must not try to destroy it from script.
  //   'authenticated'   — the server said yes
  //   'unauthenticated' — the server said no
  //   'unknown'         — nobody said anything; the cookie is untouched
  const [authStatus, setAuthStatus] = useState('unknown')

  const beginSession = useCallback((nextUser) => {
    purgeLegacyToken()
    setUser(nextUser ?? null)
    setAuthStatus(nextUser ? 'authenticated' : 'unauthenticated')
  }, [])

  const endSession = useCallback(() => {
    purgeLegacyToken()
    clearApiCache()
    clearIntentionDraft()
    setUser(null)
    setAuthStatus('unauthenticated')
  }, [])

  // The server re-issues the session cookie on password change. There is
  // no script-visible token to swap. Kept as a no-op so older call sites
  // (and tests that mock it) do not throw.
  const replaceToken = useCallback((_nextToken) => {}, [])

  // Merge a partial patch into the in-memory user — used when a
  // self-serve edit (e.g. uploading a profile picture) changes the
  // account without re-issuing the session. No-ops if logged out.
  const updateUser = useCallback((patch) => {
    setUser(prev => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const logout = useCallback(async () => {
    // Deliberately fire-and-forget, and it must stay that way.
    // POST /api/auth/logout clears the httpOnly cookie. Failing to
    // clear the local session because that call failed would strand a
    // person signed in on a shared parish computer.
    try { await fetch(apiUrl('/api/auth/logout'), { method: 'POST' }) } catch {}
    endSession()
  }, [endSession])

  // Sign out everywhere: bump token_version so every outstanding JWT
  // for this user fails requireAuth immediately, then drop this device.
  // Unlike logout(), a failed call must NOT clear the local session —
  // the secretary is still signed in everywhere, including here, and
  // saying otherwise would send her to /login while the kiosk stayed up.
  const logoutAll = useCallback(async () => {
    const res = await fetch(apiUrl('/api/auth/logout-all'), { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || 'Could not sign out everywhere. Please try again.')
    }
    endSession()
  }, [endSession])

  const login = useCallback(async (email, password) => {
    const res  = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Login failed (${res.status})`)
    beginSession(data.user)
    return data.user
  }, [beginSession])

  const signup = useCallback(async (payload) => {
    const res = await fetch(apiUrl('/api/auth/signup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Signup failed (${res.status})`)
    // flushSync commits the session immediately. Without it, the caller's
    // subsequent navigate('/welcome') races with RedirectIfAuthed on /signup:
    // React may re-render /signup with isAuthenticated=true *before* the
    // URL change propagates, and RedirectIfAuthed's <Navigate to="/" /> wins,
    // bouncing the user to the Dashboard and skipping the Welcome screen.
    flushSync(() => beginSession(data.user))
    return data.user
  }, [beginSession])

  // On mount, rehydrate the user via /api/auth/me. The cookie (if any)
  // travels with credentials: 'include' from the fetch interceptor.
  //
  // Only a 401 ends the session. Everything else — 5xx, a dropped
  // connection, a body that is not JSON, a 200 carrying no user — leaves the
  // httpOnly cookie exactly where it was and reports that we do not know.
  const verifySession = useCallback(async () => {
    purgeLegacyToken()
    setLoading(true)
    let outcome = 'unknown'
    try {
      const res = await fetch(apiUrl('/api/auth/me'))
      if (res.status === 401) {
        endSession()
        outcome = 'unauthenticated'
      } else if (!res.ok) {
        setAuthStatus('unknown')
      } else {
        const data = await res.json()
        if (data?.user) {
          setUser(data.user)
          setAuthStatus('authenticated')
          outcome = 'authenticated'
        } else {
          setAuthStatus('unknown')
        }
      }
    } catch {
      setAuthStatus('unknown')
    } finally {
      setLoading(false)
    }
    return outcome
  }, [endSession])

  useEffect(() => {
    verifySession()
    // Only run on mount — session changes elsewhere already update state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Listen for 401s from the fetch interceptor and log out. This keeps
  // the UI in sync when a session expires mid-request or is revoked
  // server-side.
  useEffect(() => {
    const handler = () => endSession()
    window.addEventListener(UNAUTHORIZED_EVENT, handler)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler)
  }, [endSession])

  // Role helpers — derived from user.role so callers can do
  //   const { canWrite, isAdmin } = useAuth()
  // without re-deriving the same boolean in every page.
  //
  // Note: the server is the source of truth for permissions. These
  // are UI-only — hiding write buttons is a friendlier experience
  // than letting a viewer click and see a 403, but the gate is
  // enforced regardless.
  const role     = user?.role || null
  const isAdmin  = role === 'admin'
  const isStaff  = role === 'staff'
  const isViewer = role === 'viewer'
  const canWrite = role === 'admin' || role === 'staff'

  const value = {
    user,
    token,
    loading,
    isAuthenticated: authStatus === 'authenticated' && !!user,
    authStatus,
    // True only when we asked and could not confirm. This is the state
    // the app must not render as "signed out".
    authUnavailable: authStatus === 'unknown',
    retryAuth: verifySession,
    role,
    isAdmin,
    isStaff,
    isViewer,
    canWrite,
    login,
    signup,
    logout,
    logoutAll,
    updateUser,
    replaceToken,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
