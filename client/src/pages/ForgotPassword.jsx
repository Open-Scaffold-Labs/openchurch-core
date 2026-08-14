import { useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Mail, Loader2, CheckCircle2 } from 'lucide-react'
import { apiUrl } from '../api'
import TextField from '../components/TextField'

// Step 1 of password reset. Collects an email, asks the server to issue
// a token + send the email. The server replies with the same generic
// 200 whether the email is registered or not, so this page shows the
// same success state in both cases — no email-enumeration leak from
// a confirming UI.

export default function ForgotPassword() {
  const [email,    setEmail]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [sent,     setSent]     = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/auth/forgot-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "That didn't save — nothing was lost. Please try again.")
      }
      setSent(true)
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
          {sent ? (
            <div className="text-center">
              <div className="inline-flex w-12 h-12 rounded-2xl bg-brass-50 dark:bg-brass-900/30 items-center justify-center text-brass-700 dark:text-brass-300 mb-4">
                <CheckCircle2 size={20} />
              </div>
              <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
                Check your email
              </h1>
              <p className="mt-3 text-sm text-ink-500 dark:text-parchment-300/70 leading-relaxed">
                If an account exists for <span className="font-semibold text-ink-700 dark:text-parchment-100">{email}</span>, we&rsquo;ve sent a link to reset the password. The link is valid for one hour.
              </p>
              <Link
                to="/login"
                className="mt-6 inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
                Reset your password
              </h1>
              <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
                Enter the email associated with your church. We&rsquo;ll send a link to set a new password.
              </p>

              <form onSubmit={onSubmit} className="mt-6 space-y-4">
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

                {error && (
                  <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || !email}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
                >
                  {loading ? <Loader2 size={15} className="animate-spin" /> : null}
                  {loading ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            </>
          )}
        </div>

        {!sent && (
          <p className="mt-5 text-center text-sm text-ink-500 dark:text-parchment-300/70">
            Remembered it?{' '}
            <Link
              to="/login"
              className="font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors"
            >
              Back to sign in
            </Link>
          </p>
        )}
      </motion.div>
    </div>
  )
}
