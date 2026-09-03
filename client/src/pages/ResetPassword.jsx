import { useState, useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Lock, Loader2, Eye, EyeOff, AlertTriangle } from 'lucide-react'
import { apiUrl } from '../api'
import TextField from '../components/TextField'

// Step 2 of password reset. Reads the one-shot token from the URL,
// collects a new password, and posts to /api/auth/reset-password. On
// success, bounces to /login with a flash so the user can sign in
// with the new credentials.

const MIN_PW = 8

export default function ResetPassword() {
  const [params]   = useSearchParams()
  const navigate   = useNavigate()
  const token      = useMemo(() => params.get('token') || '', [params])

  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [showPw,   setShowPw]   = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  // No token in the URL → nothing to do here. Render an explainer
  // instead of an empty form.
  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-parchment-50 dark:bg-ink-950">
        <div className="w-full max-w-md text-center">
          <div className="inline-flex w-12 h-12 rounded-2xl bg-amber-50 dark:bg-amber-900/30 items-center justify-center text-amber-700 dark:text-amber-300 mb-4">
            <AlertTriangle size={20} />
          </div>
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            Reset link missing
          </h1>
          <p className="mt-3 text-sm text-ink-500 dark:text-parchment-300/70 leading-relaxed">
            This page is only reachable from a password-reset email. If you came here directly, request a new link.
          </p>
          <Link
            to="/forgot"
            className="tap mt-6 inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
          >
            Send a reset link
          </Link>
        </div>
      </div>
    )
  }

  async function onSubmit(e) {
    e.preventDefault()
    setError('')
    if (password.length < MIN_PW) {
      return setError(`Password must be at least ${MIN_PW} characters`)
    }
    if (password !== confirm) {
      return setError('Passwords do not match')
    }
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/auth/reset-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "That didn't save — nothing was lost. Please try again.")
      navigate('/login', { replace: true, state: { passwordReset: true } })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-parchment-50 dark:bg-ink-950">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
        className="w-full max-w-md"
      >
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-xl bg-church-900 dark:bg-brass-200 flex items-center justify-center shadow-warm-md">
            <svg width="18" height="22" viewBox="0 0 14 18" fill="currentColor" className="text-brass-200 dark:text-church-900">
              <rect x="5.5" y="0" width="3" height="18" rx="1" />
              <rect x="0" y="4" width="14" height="3" rx="1" />
            </svg>
          </div>
          <span className="font-display text-3xl font-semibold text-church-900 dark:text-parchment-100 leading-none">
            OpenChurch
          </span>
        </div>

        <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm-md p-7">
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            Choose a new password
          </h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            Make it at least {MIN_PW} characters. You&rsquo;ll be signed in fresh after.
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <TextField
              label="New password"
              type={showPw ? 'text' : 'password'}
              required
              minLength={MIN_PW}
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={`At least ${MIN_PW} characters`}
              leadingIcon={Lock}
              trailing={
                <button
                  type="button"
                  onClick={() => setShowPw(s => !s)}
                  className="tap-reach text-ink-400 dark:text-parchment-400/60 hover:text-ink-600 dark:hover:text-parchment-200 transition-colors"
                  tabIndex={-1}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              }
            />

            <TextField
              label="Confirm new password"
              type={showPw ? 'text' : 'password'}
              required
              minLength={MIN_PW}
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="Re-enter the new password"
              leadingIcon={Lock}
            />

            {error && (
              <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password || !confirm}
              className="tap w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : null}
              {loading ? 'Updating…' : 'Set new password'}
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  )
}
