import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Mail, Lock, Loader2, Eye, EyeOff, Church, User } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import TextField from '../components/TextField'

const MIN_PW = 8

export default function Signup() {
  const { signup } = useAuth()
  const navigate   = useNavigate()

  const [organizationName, setOrganizationName] = useState('')
  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPw,   setShowPw]   = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  async function onSubmit(e) {
    e.preventDefault()
    setError('')
    if (password.length < MIN_PW) {
      return setError(`Password must be at least ${MIN_PW} characters`)
    }
    setLoading(true)
    try {
      await signup({
        organizationName: organizationName.trim(),
        name: name.trim(),
        email: email.trim(),
        password,
      })
      // Land on the welcome screen first — the dashboard is one click away
      // but the first impression should be focused, not noisy.
      navigate('/welcome', { replace: true })
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
            Start your church
          </h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            A private workspace for your staff. Takes under a minute.
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <TextField
              label="Church name"
              required
              autoComplete="organization"
              value={organizationName}
              onChange={e => setOrganizationName(e.target.value)}
              placeholder="First Baptist of Austin"
              leadingIcon={Church}
            />

            <TextField
              label="Your name"
              required
              autoComplete="name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Pastor Jane Doe"
              leadingIcon={User}
            />

            <TextField
              label="Email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@yourchurch.com"
              leadingIcon={Mail}
            />

            <TextField
              label="Password"
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
                  className="text-ink-400 dark:text-parchment-400/60 hover:text-ink-600 dark:hover:text-parchment-200 transition-colors"
                  tabIndex={-1}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              }
            />

            {error && (
              <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : null}
              {loading ? 'Creating your church…' : 'Create church & sign in'}
            </button>
          </form>
        </div>

        <p className="mt-5 text-center text-sm text-ink-500 dark:text-parchment-300/70">
          Already have an account?{' '}
          <Link
            to="/login"
            className="font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
          >
            Sign in
          </Link>
        </p>
      </motion.div>
    </div>
  )
}
