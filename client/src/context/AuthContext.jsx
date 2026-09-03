import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { apiUrl } from '../api'
import { UNAUTHORIZED_EVENT } from '../auth/fetchInterceptor'

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

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null)
  // Literal 'ochr_token' string (matches what fetchInterceptor uses)
  // so the ecosystem registry audit can pattern-match it.
  const [token,   setToken]   = useState(() => localStorage.getItem('ochr_token'))
  // `loading` stays true while we verify a stored token against /me on
  // first load. Pages should show a skeleton during this window rather
  // than flash the login screen when the user actually is signed in.
  const [loading, setLoading] = useState(!!token)
  // Three states, not two. `GET /api/auth/me` answers 401 for every positive
  // rejection — no header, bad or expired token, unknown user, revoked
  // token_version — and 500 when the database threw and it COULD NOT CHECK
  // (server/src/middleware/auth.js, 'Authentication check failed'). It cannot
  // answer 403: the route carries requireAuth and no role gate.
  //
  // This client collapsed all of that into `if (!res.ok) throw` and cleared
  // the session in the catch, so a database hiccup signed the secretary out
  // and sent her to /login — the app asserting her session was invalid when
  // what it actually knew was nothing. A rejection ends a session. Silence
  // does not.
  //   'authenticated'   — the server said yes
  //   'unauthenticated' — the server said no, or there is no token to check
  //   'unknown'         — nobody said anything; the credential is untouched
  const [authStatus, setAuthStatus] = useState(token ? 'unknown' : 'unauthenticated')

  const setSession = useCallback((nextToken, nextUser) => {
    if (nextToken) {
      localStorage.setItem('ochr_token', nextToken)
    } else {
      localStorage.removeItem('ochr_token')
      // Session is ending (logout, 401, or rejected token on boot) —
      // purge the cached tenant API responses so they can't leak.
      clearApiCache()
    }
    setToken(nextToken ?? null)
    setUser(nextUser ?? null)
    setAuthStatus(nextToken && nextUser ? 'authenticated' : 'unauthenticated')
  }, [])

  // Swap the session token without changing who is signed in.
  //
  // The server re-issues a token for the SAME user in exactly one case:
  // changing your own password. That bumps token_version to kill every
  // session signed in with the old password — including this device's,
  // which would otherwise sign the user out mid-action for doing the
  // right thing. Narrower than setSession on purpose: it cannot change
  // the user, only the credential carrying them.
  const replaceToken = useCallback((nextToken) => {
    if (!nextToken) return
    localStorage.setItem('ochr_token', nextToken)
    setToken(nextToken)
  }, [])

  // Merge a partial patch into the in-memory user — used when a
  // self-serve edit (e.g. uploading a profile picture) changes the
  // account without re-issuing the session. No-ops if logged out.
  const updateUser = useCallback((patch) => {
    setUser(prev => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const logout = useCallback(async () => {
    // Deliberately fire-and-forget, and it must stay that way.
    // POST /api/auth/logout is a 204 no-op (server/src/routes/auth.js) —
    // the token stays valid until expiry either way, and "sign out
    // everywhere" is /logout-all, which does check its result. Failing to
    // clear the local session because a no-op call failed would strand a
    // person signed in on a shared parish computer.
    try { await fetch(apiUrl('/api/auth/logout'), { method: 'POST' }) } catch {}
    setSession(null, null)
  }, [setSession])

  const login = useCallback(async (email, password) => {
    const res  = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Login failed (${res.status})`)
    setSession(data.token, data.user)
    return data.user
  }, [setSession])

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
    flushSync(() => setSession(data.token, data.user))
    return data.user
  }, [setSession])

  // On mount, rehydrate the user from the stored token via /api/auth/me.
  // If the token is rejected, we clear local state silently so the app
  // simply boots logged out.
  //
  // Only a 401 ends the session. Everything else — 5xx, a dropped
  // connection, a body that is not JSON, a 200 carrying no user — leaves the
  // stored credential exactly where it was and reports that we do not know.
  // The screen that follows says so and offers a retry, which is the truth
  // and is also what gets the secretary back to work when the server
  // returns, without her having to find her password.
  const verifySession = useCallback(async () => {
    const stored = localStorage.getItem('ochr_token')
    if (!stored) { setAuthStatus('unauthenticated'); setLoading(false); return 'unauthenticated' }
    setLoading(true)
    let outcome = 'unknown'
    try {
      const res = await fetch(apiUrl('/api/auth/me'))
      if (res.status === 401) {
        // A positive rejection. This is the one branch that may destroy a
        // session, and it must stay narrow: 403 is authenticated-but-not-
        // permitted and never lands here.
        setSession(null, null)
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
          // A 200 is not an answer if it does not carry the user.
          setAuthStatus('unknown')
        }
      }
    } catch {
      setAuthStatus('unknown')
    } finally {
      setLoading(false)
    }
    return outcome
  }, [setSession])

  useEffect(() => {
    verifySession()
    // Only run on mount — token changes elsewhere already update state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Listen for 401s from the fetch interceptor and log out. This keeps
  // the UI in sync when a token expires mid-session or is revoked
  // server-side.
  useEffect(() => {
    const handler = () => setSession(null, null)
    window.addEventListener(UNAUTHORIZED_EVENT, handler)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler)
  }, [setSession])

  // Role helpers — derived from user.role so callers can do
  //   const { canWrite, isAdmin } = useAuth()
  // without re-deriving the same boolean in every page.
  //
  // Note: the server is the source of truth for permissions. These
  // are UI-only — hiding write buttons is a friendlier experience
  // than letting a viewer click and see a 403, but the gate is
  // enforced regardless. A user who clears their JWT and re-fetches
  // their role server-side is still bound by the actual checks.
  const role     = user?.role || null
  const isAdmin  = role === 'admin'
  const isStaff  = role === 'staff'
  const isViewer = role === 'viewer'
  const canWrite = role === 'admin' || role === 'staff'

  const value = {
    user,
    token,
    loading,
    isAuthenticated: !!token && !!user,
    authStatus,
    // True only when we hold a credential nobody has rejected and cannot
    // currently confirm. This is the state the app must not render as
    // "signed out".
    authUnavailable: authStatus === 'unknown' && !!token,
    retryAuth: verifySession,
    role,
    isAdmin,
    isStaff,
    isViewer,
    canWrite,
    login,
    signup,
    logout,
    updateUser,
    replaceToken,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
