import { useEffect, useState } from 'react'
import { Landmark, Loader2 } from 'lucide-react'
import { apiUrl } from '../api'

// Accepting an invitation (PILOT.2).
//
// Pre-auth: the token in the link is the credential. The person choosing a
// password here becomes its only holder — the administrator who invited
// them never sees it, which is the entire point of the flow.
//
// It signs them straight in afterwards rather than bouncing to a login
// screen, because being asked to type the password you just chose is the
// kind of small friction that makes software feel like it is not paying
// attention.
export default function AcceptInvite({ onAccepted, onArrive }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // A different person is arriving. Whatever session this browser was
  // holding is not theirs.
  useEffect(() => { onArrive?.() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const tooShort = password.length > 0 && password.length < 8
  const mismatch = confirm.length > 0 && confirm !== password
  const ready = password.length >= 8 && confirm === password && token

  const submit = async (e) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true); setError('')
    try {
      const res = await fetch(apiUrl('/api/auth/accept-invite'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not accept that invitation'); return }
      localStorage.setItem('ochr_token', d.token)
      onAccepted?.(d.user)
    } catch {
      setError('Could not reach the server. Try again in a moment.')
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
        <p className="text-center text-sm text-ink-500 mb-8">Choose a password.</p>

        {!token ? (
          <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 shadow-sm p-6">
            <p className="text-sm text-ink-700 leading-relaxed">
              This page is only reachable from an invitation link. If you came here
              directly, ask whoever invited you to send it again.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-parchment-50 rounded-2xl border border-parchment-300/70 shadow-sm p-6 space-y-4">
            <div>
              <label htmlFor="pw" className="block text-xs font-semibold text-ink-500 mb-1.5">Password</label>
              <input id="pw" type="password" required value={password}
                onChange={e => setPassword(e.target.value)} className={inputCls} />
              <p className={`mt-1 text-[11px] ${tooShort ? 'text-church-700' : 'text-ink-400'}`}>
                At least 8 characters.
              </p>
            </div>
            <div>
              <label htmlFor="pw2" className="block text-xs font-semibold text-ink-500 mb-1.5">Confirm password</label>
              <input id="pw2" type="password" required value={confirm}
                onChange={e => setConfirm(e.target.value)} className={inputCls} />
              {mismatch && <p className="mt-1 text-[11px] text-church-700">These do not match.</p>}
            </div>
            {error && <p className="text-sm text-church-700">{error}</p>}
            <button type="submit" disabled={busy || !ready}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-lg bg-church-600 text-parchment-50 text-sm font-semibold hover:bg-church-700 disabled:opacity-60">
              {busy && <Loader2 size={14} className="animate-spin" />}
              Set my password and sign in
            </button>
            <p className="text-[11px] text-ink-400 text-center leading-relaxed">
              Only you will know this. Nobody at the chancery can see it, including
              whoever invited you.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
