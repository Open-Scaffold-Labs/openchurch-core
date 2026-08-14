import { useEffect, useState, createContext, useContext, useCallback } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { Landmark, LayoutDashboard, Church, Inbox, Scale, LogOut, Loader2, AlertTriangle } from 'lucide-react'
import { apiUrl } from './api'
import Dashboard from './pages/Dashboard'
import Parishes from './pages/Parishes'
import Submissions from './pages/Submissions'
import Financials from './pages/Financials'
import Assessments from './pages/Assessments'

// OpenDiocese chancery app (DIO.2). Same backend, same JWT, same
// Parchment & Brass — tuned for a finance back office: denser tables,
// more whitespace, nothing that blinks.

const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)

function Login({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Sign-in failed')
      localStorage.setItem('ochr_token', d.token)
      onLogin(d.user)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const inputCls = 'w-full px-3 py-2.5 text-sm rounded-lg border border-parchment-300 bg-parchment-50 text-ink-900 focus:outline-none focus:ring-2 focus:ring-brass-400'
  return (
    <div className="min-h-screen bg-parchment-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Landmark size={22} className="text-church-600" />
          <h1 className="font-serif text-3xl font-bold text-church-600">Open<span className="text-brass-500">Diocese</span></h1>
        </div>
        <p className="text-center text-sm text-ink-500 mb-8">The chancery, kept well.</p>
        <form onSubmit={submit} className="bg-parchment-50 rounded-2xl border border-parchment-300/70 shadow-sm p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-500 mb-1.5">Email</label>
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-500 mb-1.5">Password</label>
            <input type="password" required value={password} onChange={e => setPassword(e.target.value)} className={inputCls} />
          </div>
          {error && <p className="text-sm text-rose-700">{error}</p>}
          <button type="submit" disabled={busy}
            className="w-full py-2.5 rounded-lg bg-church-600 text-parchment-50 text-sm font-semibold hover:bg-church-700 disabled:opacity-60">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="text-[11px] text-ink-400 text-center">
            Sign in with a diocese account. Parish accounts use the parish app.
          </p>
        </form>
      </div>
    </div>
  )
}

function NotADiocese({ onLogout }) {
  return (
    <div className="min-h-screen bg-parchment-100 flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        <AlertTriangle size={28} className="mx-auto text-brass-500" />
        <h1 className="font-serif text-2xl font-bold text-church-600">This is the chancery door</h1>
        <p className="text-sm text-ink-600">
          Your account belongs to a parish, so OpenDiocese has nothing to show it.
          The parish app is where your work lives — including the Diocese panel in Settings.
        </p>
        <button onClick={onLogout} className="text-sm font-semibold text-church-600 hover:underline">Sign out</button>
      </div>
    </div>
  )
}

const NAV = [
  { to: '/',            icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/parishes',    icon: Church,          label: 'Parishes' },
  { to: '/submissions', icon: Inbox,           label: 'Submissions' },
  { to: '/financials',  icon: Landmark,        label: 'Financials' },
  { to: '/assessments', icon: Scale,           label: 'Assessments' },
]

function Shell({ children }) {
  const { user, logout } = useAuth()
  return (
    <div className="min-h-screen bg-parchment-100 flex">
      <aside className="w-56 shrink-0 border-r border-parchment-300/70 bg-parchment-50 flex flex-col">
        <div className="px-5 py-5 border-b border-parchment-300/60">
          <p className="font-serif text-xl font-bold text-church-600">Open<span className="text-brass-500">Diocese</span></p>
          <p className="text-[11px] text-ink-500 truncate mt-0.5">{user?.organization?.name}</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map(({ to, icon: Icon, label, end }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive ? 'bg-church-600 text-parchment-50' : 'text-ink-600 hover:bg-parchment-200'
                }`}>
              <Icon size={15} /> {label}
            </NavLink>
          ))}
        </nav>
        <button onClick={logout}
          className="m-3 flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-ink-500 hover:bg-parchment-200">
          <LogOut size={15} /> Sign out
        </button>
      </aside>
      <main className="flex-1 min-w-0 p-8 overflow-y-auto">{children}</main>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState(null)
  const [orgType, setOrgType] = useState(null) // null=unknown, 'diocese', 'other'
  const [booting, setBooting] = useState(true)

  const logout = useCallback(() => {
    localStorage.removeItem('ochr_token')
    setUser(null); setOrgType(null)
  }, [])

  // Rehydrate + verify this token opens the chancery door: /me for the
  // user, then a diocese-gated read — 403 means a parish token.
  const boot = useCallback(async (knownUser) => {
    setBooting(true)
    try {
      let u = knownUser
      if (!u) {
        if (!localStorage.getItem('ochr_token')) { setBooting(false); return }
        const me = await fetch(apiUrl('/api/auth/me'))
        if (!me.ok) { logout(); setBooting(false); return }
        u = (await me.json()).user
      }
      const gate = await fetch(apiUrl('/api/diocese/parishes'))
      setUser(u)
      setOrgType(gate.status === 403 ? 'other' : 'diocese')
    } catch {
      // Network hiccup: keep the login screen rather than a broken shell.
    } finally {
      setBooting(false)
    }
  }, [logout])

  useEffect(() => { boot() }, [boot])
  useEffect(() => {
    const onUnauthorized = () => logout()
    window.addEventListener('opendiocese:unauthorized', onUnauthorized)
    return () => window.removeEventListener('opendiocese:unauthorized', onUnauthorized)
  }, [logout])

  if (booting) {
    return <div className="min-h-screen bg-parchment-100 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-brass-500" /></div>
  }
  if (!user) return <Login onLogin={(u) => boot(u)} />
  if (orgType === 'other') return <NotADiocese onLogout={logout} />

  return (
    <AuthCtx.Provider value={{ user, logout }}>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/parishes" element={<Parishes />} />
            <Route path="/submissions" element={<Submissions />} />
            <Route path="/financials" element={<Financials />} />
            <Route path="/assessments" element={<Assessments />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </AuthCtx.Provider>
  )
}
