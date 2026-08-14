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
  }, [])

  // Merge a partial patch into the in-memory user — used when a
  // self-serve edit (e.g. uploading a profile picture) changes the
  // account without re-issuing the session. No-ops if logged out.
  const updateUser = useCallback((patch) => {
    setUser(prev => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const logout = useCallback(async () => {
    // Fire-and-forget — the server has nothing to revoke with stateless JWT.
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
  useEffect(() => {
    if (!token) { setLoading(false); return }
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(apiUrl('/api/auth/me'))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (alive) setUser(data.user)
      } catch {
        if (alive) setSession(null, null)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
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
    role,
    isAdmin,
    isStaff,
    isViewer,
    canWrite,
    login,
    signup,
    logout,
    updateUser,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
