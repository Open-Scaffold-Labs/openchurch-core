import { useEffect, useState, useCallback } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { Landmark, LayoutDashboard, Church, Inbox, Scale, LogOut, Loader2, AlertTriangle, HeartHandshake, ListChecks, Users, User } from 'lucide-react'
import { apiUrl } from './api'
import { AuthCtx, useAuth } from './authContext'
import { STRINGS } from './i18n/strings'
import Dashboard from './pages/Dashboard'
import Parishes from './pages/Parishes'
import Submissions from './pages/Submissions'
import Financials from './pages/Financials'
import Assessments from './pages/Assessments'
import ParishCare from './pages/ParishCare'
import ParishDetail from './pages/ParishDetail'
import CareBrief from './pages/CareBrief'
import FollowUps from './pages/FollowUps'
import ReportReview from './pages/ReportReview'
import Team from './pages/Team'
import Account from './pages/Account'
import AcceptInvite from './pages/AcceptInvite'
import FirstUse from './pages/FirstUse'

// OpenDiocese chancery app (DIO.2). Same backend, same JWT, same
// Parchment & Brass — tuned for a finance back office: denser tables,
// more whitespace, nothing that blinks.

export { useAuth }

// Device override only. Do not import parish useLocale / LocaleProvider.
function t(key) {
  let locale = 'en'
  try {
    const stored = localStorage.getItem('ochr_locale')
    if (stored && STRINGS[stored]) locale = stored
  } catch { /* private mode — stay on English */ }
  return STRINGS[locale]?.[key] ?? STRINGS.en[key] ?? key
}

// Server refusals that arrive as English sentences (only after the
// password matched), mapped to this app's locale keys.
const SIGN_IN_SENTENCES = {
  'This login is deactivated. An admin can turn it back on.': 'auth.loginOff',
  'This login is closed. It cannot be turned back on.': 'auth.loginClosed',
  'This organization is on hold. Access is stopped; parish history remains.': 'auth.organizationHeld',
}

export function Login({ onLogin, onWantSignup }) {
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
      if (!res.ok) throw new Error(d.error || t('auth.signInFailed'))
      onLogin(d.user)
    } catch (err) {
      // Server refusals arrive as English sentences; show them in the
      // office's language.
      setError(SIGN_IN_SENTENCES[err.message] ? t(SIGN_IN_SENTENCES[err.message]) : err.message)
    } finally { setBusy(false) }
  }

  const inputCls = 'w-full px-3 py-2.5 text-sm rounded-lg border border-parchment-300 bg-parchment-50 text-ink-900 focus:outline-none focus:ring-2 focus:ring-brass-400'
  return (
    <div className="min-h-screen bg-parchment-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Landmark size={22} className="text-church-600" />
          <h1 className="font-serif text-3xl font-bold text-church-600">Open<span className="text-brass-500">Diocese</span></h1>
        </div>
        <p className="text-center text-sm text-ink-500 mb-8">{t('auth.tagline')}</p>
        <form onSubmit={submit} className="bg-parchment-50 rounded-2xl border border-parchment-300/70 shadow-sm p-6 space-y-4">
          <div>
            <label htmlFor="dio-login-email" className="block text-xs font-semibold text-ink-500 mb-1.5">{t('auth.email')}</label>
            <input id="dio-login-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="dio-login-pw" className="block text-xs font-semibold text-ink-500 mb-1.5">{t('auth.password')}</label>
            <input id="dio-login-pw" type="password" required value={password} onChange={e => setPassword(e.target.value)} className={inputCls} />
          </div>
          {error && <p className="text-sm text-rose-700">{error}</p>}
          <button type="submit" disabled={busy}
            className="w-full py-2.5 rounded-lg bg-church-600 text-parchment-50 text-sm font-semibold hover:bg-church-700 disabled:opacity-60">
            {busy ? t('auth.signingIn') : t('auth.signIn')}
          </button>
          <p className="text-[11px] text-ink-400 text-center">
            {t('auth.loginBlurb')}
          </p>
        </form>
        <p className="mt-5 text-center text-sm text-ink-500">
          {t('auth.noAccount')}{' '}
          <button type="button" onClick={onWantSignup}
            className="font-semibold text-church-600 underline underline-offset-2 hover:text-church-700">
            {t('auth.setUp')}
          </button>
        </p>
      </div>
    </div>
  )
}

// DIO.5 — a chancery can stand itself up.
//
// The server has always accepted organizationType: 'diocese' on signup;
// nothing in any UI ever sent it, so creating a diocese meant somebody who
// knew the API shape doing it by hand. That is a person between the
// chancery and the product, which is exactly what this app exists to
// remove.
export function Signup({ onLogin, onCancel }) {
  const [form, setForm] = useState({ organizationName: '', name: '', email: '', password: '' })
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  const tooShort = form.password.length > 0 && form.password.length < 8
  const mismatch = confirm.length > 0 && confirm !== form.password
  const ready = form.organizationName.trim() && form.name.trim() && form.email.trim() &&
                form.password.length >= 8 && confirm === form.password

  const submit = async (e) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true); setError('')
    try {
      const res = await fetch(apiUrl('/api/auth/signup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The one field that makes this a chancery and not a parish.
        body: JSON.stringify({ ...form, organizationType: 'diocese' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || t('auth.signupFailed'))
      onLogin(d.user)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const inputCls = 'w-full px-3 py-2.5 text-sm rounded-lg border border-parchment-300 bg-parchment-50 text-ink-900 focus:outline-none focus:ring-2 focus:ring-brass-400'
  const labelCls = 'block text-xs font-semibold text-ink-500 mb-1.5'
  return (
    <div className="min-h-screen bg-parchment-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Landmark size={22} className="text-church-600" />
          <h1 className="font-serif text-3xl font-bold text-church-600">Open<span className="text-brass-500">Diocese</span></h1>
        </div>
        <p className="text-center text-sm text-ink-500 mb-8">{t('auth.signupTagline')}</p>
        <form onSubmit={submit} className="bg-parchment-50 rounded-2xl border border-parchment-300/70 shadow-sm p-6 space-y-4">
          <div>
            <label htmlFor="dio-name" className={labelCls}>{t('auth.diocese')}</label>
            <input id="dio-name" required value={form.organizationName} onChange={set('organizationName')}
              placeholder={t('auth.diocesePlaceholder')} className={inputCls} />
          </div>
          <div>
            <label htmlFor="dio-you" className={labelCls}>{t('auth.yourName')}</label>
            <input id="dio-you" required value={form.name} onChange={set('name')} className={inputCls} />
          </div>
          <div>
            <label htmlFor="dio-email" className={labelCls}>{t('auth.email')}</label>
            <input id="dio-email" type="email" required value={form.email} onChange={set('email')} className={inputCls} />
          </div>
          <div>
            <label htmlFor="dio-pw" className={labelCls}>{t('auth.password')}</label>
            <input id="dio-pw" type="password" required value={form.password} onChange={set('password')} className={inputCls} />
            <p className={`mt-1 text-[11px] ${tooShort ? 'text-rose-700' : 'text-ink-400'}`}>
              {t('auth.passwordHint')}
            </p>
          </div>
          <div>
            <label htmlFor="dio-pw2" className={labelCls}>{t('auth.confirmPassword')}</label>
            <input id="dio-pw2" type="password" required value={confirm} onChange={e => setConfirm(e.target.value)} className={inputCls} />
            {mismatch && <p className="mt-1 text-[11px] text-rose-700">{t('auth.mismatch')}</p>}
          </div>
          {error && <p className="text-sm text-rose-700">{error}</p>}
          <button type="submit" disabled={busy || !ready}
            className="w-full py-2.5 rounded-lg bg-church-600 text-parchment-50 text-sm font-semibold hover:bg-church-700 disabled:opacity-60">
            {busy ? t('auth.settingUp') : t('auth.createAccount')}
          </button>
          <p className="text-[11px] text-ink-400 text-center">
            {t('auth.signupBlurb')}
          </p>
        </form>
        <p className="mt-5 text-center text-sm text-ink-500">
          {t('auth.alreadySetUp')}{' '}
          <button type="button" onClick={onCancel}
            className="font-semibold text-church-600 underline underline-offset-2 hover:text-church-700">
            {t('auth.signIn')}
          </button>
        </p>
      </div>
    </div>
  )
}

export function NotADiocese({ onLogout }) {
  return (
    <div className="min-h-screen bg-parchment-100 flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        <AlertTriangle size={28} className="mx-auto text-brass-500" />
        <h1 className="font-serif text-2xl font-bold text-church-600">{t('auth.wrongDoorTitle')}</h1>
        <p className="text-sm text-ink-600">
          {t('auth.wrongDoorBody')}
        </p>
        <button onClick={onLogout} className="text-sm font-semibold text-church-600 hover:underline">{t('auth.signOut')}</button>
      </div>
    </div>
  )
}

const NAV = [
  { to: '/',            icon: LayoutDashboard, label: 'Dashboard', end: true },
  // Parish Care sits directly under the Dashboard because it is the screen
  // the office actually works from: who needs care, and what is next.
  { to: '/care',        icon: HeartHandshake,  label: 'Parish Care' },
  { to: '/follow-ups',  icon: ListChecks,      label: 'Follow-ups' },
  { to: '/parishes',    icon: Church,          label: 'Parishes' },
  { to: '/submissions', icon: Inbox,           label: 'Submissions' },
  { to: '/financials',  icon: Landmark,        label: 'Financials' },
  { to: '/assessments', icon: Scale,           label: 'Assessments' },
  { to: '/team',        icon: Users,           label: 'The chancery' },
]

// A demo workspace says so, on every screen (PILOT.4).
//
// The old marker was "(Demo)" in the org's name — invisible in a cropped
// screenshot, and gone the moment somebody renames the org to a real parish
// for a demonstration, which the run-sheet explicitly tells them to do. The
// risk is not embarrassment: it is fictional pastoral notes about fictional
// parishes being taken for real ones.
//
// Deliberately a plain band, not an alarm. It states a fact; it is not a
// warning about anything.
function DemoBand() {
  return (
    <div className="print:hidden bg-brass-100 border-b border-brass-300/60 px-4 py-1.5 text-center">
      <p className="text-[12px] text-ink-700">
        <span className="font-semibold">Demonstration workspace.</span>{' '}
        Every parish, person, note and figure here is fictional.
      </p>
    </div>
  )
}

function Shell({ children }) {
  const { user, logout } = useAuth()
  // Print discipline lives here, not only on the page being printed.
  // The care brief is meant to leave the building on paper, and a page that
  // hides its own toolbar while the app's navigation still bleeds through
  // prints "Dashboard / Parish Care / Follow-ups" across a bishop's brief.
  // The chrome is the shell's, so the shell is what removes it.
  return (
    <div className="min-h-screen bg-parchment-100 flex print:block print:min-h-0 print:bg-white">
      <aside className="print:hidden w-56 shrink-0 border-r border-parchment-300/70 bg-parchment-50 flex flex-col">
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
        <div className="m-3 space-y-1">
          <NavLink to="/account"
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive ? 'bg-church-600 text-parchment-50' : 'text-ink-500 hover:bg-parchment-200'
              }`}>
            <User size={15} aria-hidden="true" /> {t('account.link')}
          </NavLink>
          <button onClick={logout}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-ink-500 hover:bg-parchment-200">
            <LogOut size={15} /> {t('auth.signOut')}
          </button>
        </div>
      </aside>
      {/* overflow-y-auto must not survive printing: a scroll container clips
          at the viewport and silently drops the tail of a long brief. */}
      <main className="flex-1 min-w-0 overflow-y-auto print:p-0 print:overflow-visible print:block">
        {user?.organization?.is_demo && <DemoBand />}
        <div className="p-8">
          <FirstUse />
          {children}
        </div>
      </main>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState(null)
  const [mode, setMode] = useState('login')   // 'login' | 'signup'
  const [orgType, setOrgType] = useState(null) // null=unknown, 'diocese', 'other'
  const [booting, setBooting] = useState(true)

  const logout = useCallback(() => {
    fetch(apiUrl('/api/auth/logout'), { method: 'POST' }).catch(() => {})
    try { localStorage.removeItem('ochr_token') } catch { /* leftover JWT purge */ }
    setUser(null); setOrgType(null)
  }, [])

  // Rehydrate + verify the cookie session opens the chancery door: /me
  // for the user, then a diocese-gated read — 403 means a parish session.
  const boot = useCallback(async (knownUser) => {
    setBooting(true)
    try {
      let u = knownUser
      if (!u) {
        const me = await fetch(apiUrl('/api/auth/me'))
        if (!me.ok) { setBooting(false); return }
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
  // Accepting an invitation wins over any existing session.
  //
  // The first cut gated this on `!user`, so anyone who already had a token
  // in this browser — a chancery admin testing the link, or an invitee with
  // a stale session from another account — landed in the authenticated
  // shell and the invitation silently did nothing. The link would simply
  // appear broken.
  //
  // Accepting is a different identity arriving, so the old session is
  // cleared rather than competed with.
  if (window.location.pathname === '/accept-invite') {
    return (
      <AcceptInvite
        onAccepted={(u) => { window.history.replaceState({}, '', '/'); boot(u) }}
        onArrive={() => { if (user) { fetch(apiUrl('/api/auth/logout'), { method: 'POST' }).catch(() => {}); setUser(null) } }}
      />
    )
  }
  if (!user) {
    return mode === 'signup'
      ? <Signup onLogin={(u) => boot(u)} onCancel={() => setMode('login')} />
      : <Login  onLogin={(u) => boot(u)} onWantSignup={() => setMode('signup')} />
  }
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
            <Route path="/care" element={<ParishCare />} />
            <Route path="/care/:parishId" element={<ParishDetail />} />
            <Route path="/care/:parishId/brief" element={<CareBrief />} />
            <Route path="/follow-ups" element={<FollowUps />} />
            <Route path="/team" element={<Team />} />
            <Route path="/account" element={<Account />} />
            {/* CARE.3 — reached from a parish's page or the submissions queue. */}
            <Route path="/review/:submissionId" element={<ReportReview />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </AuthCtx.Provider>
  )
}
