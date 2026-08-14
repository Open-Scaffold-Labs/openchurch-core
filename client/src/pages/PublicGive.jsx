import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Heart, Loader2, AlertTriangle, Check, ArrowLeft } from 'lucide-react'
import { apiUrl } from '../api'

// Public give page (Online giving / GIV.2). Unauthenticated — a
// parishioner gives to one of the church's funds. The charge runs
// through the vendor-neutral payments stub server-side (GIV.1), so this
// is a real end-to-end flow today; only the processor swaps in later.
//
// URL: /p/:slug/give
// Data:
//   GET  /api/public/:slug/funds  → active funds + church name
//   POST /api/public/:slug/give   → charge (stub) + record donation
//
// Renders outside the app shell like the other /p/:slug surfaces.

const QUICK_AMOUNTS = [25, 50, 100, 250]

function fmtMoney(n) {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

export default function PublicGive() {
  const { slug } = useParams()
  const [church, setChurch] = useState(null)
  const [funds, setFunds]   = useState([])
  const [loading, setLoad]  = useState(true)
  const [loadErr, setLoadErr] = useState('')

  const [fundId, setFundId]   = useState('')
  const [amount, setAmount]   = useState('')
  const [name, setName]       = useState('')
  const [email, setEmail]     = useState('')
  const [message, setMessage] = useState('')
  const [frequency, setFrequency] = useState('once') // once | monthly | weekly

  const [status, setStatus] = useState('idle') // idle | submitting | done
  const [error, setError]   = useState('')
  const [receipt, setReceipt] = useState(null)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    fetch(apiUrl(`/api/public/${slug}/funds`))
      .then(r => {
        if (r.status === 404) throw new Error('not-found')
        if (!r.ok) throw new Error(`Failed (${r.status})`)
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        setChurch(d.church ?? null)
        setFunds(d.funds ?? [])
        if ((d.funds ?? []).length === 1) setFundId(String(d.funds[0].id))
      })
      .catch(e => { if (!cancelled) setLoadErr(e.message) })
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [slug])

  const amountNum = Number(amount)
  const canSubmit = fundId && Number.isFinite(amountNum) && amountNum > 0 && name.trim() && status !== 'submitting'

  async function onSubmit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setStatus('submitting'); setError('')
    try {
      const res = await fetch(apiUrl(`/api/public/${slug}/give`), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fund_id:     Number(fundId),
          amount:      amountNum,
          donor_name:  name.trim(),
          donor_email: email.trim() || undefined,
          message:     message.trim() || undefined,
          frequency:   frequency === 'once' ? undefined : frequency,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || `Something went wrong (${res.status})`)
      // Live payments: the server hands back a hosted-checkout URL and
      // the browser finishes the gift on the processor's page.
      if (d.checkout_url) { window.location.assign(d.checkout_url); return }
      setReceipt(d.receipt)
      setStatus('done')
    } catch (err) {
      setError(err.message)
      setStatus('idle')
    }
  }

  const inputCls = 'w-full px-3 py-2.5 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-church-500'

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-parchment-50 dark:bg-ink-950">
        <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
      </div>
    )
  }

  if (loadErr === 'not-found') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-parchment-50 dark:bg-ink-950">
        <div className="text-center max-w-md">
          <AlertTriangle size={28} className="mx-auto text-amber-600 dark:text-amber-300 mb-3" />
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">Church not found</h1>
          <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70">
            We couldn't find a church at <span className="font-mono">/p/{slug}</span>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-parchment-50 dark:bg-ink-950 px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
        className="w-full max-w-lg mx-auto"
      >
        {/* Brand mark */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-church-900 dark:bg-brass-200 flex items-center justify-center shadow-warm">
            <svg width="16" height="20" viewBox="0 0 14 18" fill="currentColor" className="text-brass-200 dark:text-church-900">
              <rect x="5.5" y="0" width="3" height="18" rx="1" />
              <rect x="0" y="4" width="14" height="3" rx="1" />
            </svg>
          </div>
        </div>

        <header className="text-center mb-8">
          <h1 className="font-display text-3xl md:text-4xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
            Give{church?.name ? ` to ${church.name}` : ''}
          </h1>
        </header>

        {status === 'done' ? (
          <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-8 text-center">
            <span className="inline-flex w-12 h-12 rounded-full bg-brass-100 dark:bg-brass-900/40 items-center justify-center text-brass-700 dark:text-brass-300 mb-4">
              <Check size={22} />
            </span>
            <h2 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">Thank you!</h2>
            <p className="mt-2 text-sm text-ink-600 dark:text-parchment-300/80">
              Your gift of <span className="font-semibold">{fmtMoney(receipt?.amount ?? amountNum)}</span>
              {receipt?.fund ? <> to <span className="font-semibold">{receipt.fund}</span></> : null} was received.
              {receipt?.recurring && <> It will repeat <span className="font-semibold">{receipt.recurring}</span>.</>}
            </p>
            {receipt?.reference && (
              <p className="mt-1 text-[11px] text-ink-500 dark:text-parchment-300/60">
                Reference: <span className="font-mono">{receipt.reference}</span>
              </p>
            )}
            <Link
              to={`/p/${slug}`}
              className="inline-flex items-center gap-1.5 mt-6 text-sm font-semibold text-church-800 dark:text-brass-300 hover:text-church-900 dark:hover:text-brass-200 transition-colors"
            >
              <ArrowLeft size={14} /> Back to {church?.name ?? 'home'}
            </Link>
          </div>
        ) : funds.length === 0 ? (
          <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-8 text-center">
            <Heart size={26} className="mx-auto text-brass-500 dark:text-brass-300 mb-3 opacity-70" />
            <p className="text-sm text-ink-600 dark:text-parchment-300/80">
              Online giving isn't set up for this church yet. Please check back soon.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 space-y-5">
            {/* Amount */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200 mb-2">Amount</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                {QUICK_AMOUNTS.map(a => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAmount(String(a))}
                    className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                      Number(amount) === a
                        ? 'bg-church-900 dark:bg-church-700 text-parchment-50 border-transparent'
                        : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:border-church-400/60'
                    }`}
                  >
                    ${a}
                  </button>
                ))}
              </div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500 dark:text-parchment-300/70">$</span>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  inputMode="decimal"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="Other amount"
                  className={`${inputCls} pl-7`}
                />
              </div>
            </div>

            {/* Frequency */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200 mb-2">Frequency</label>
              <div className="grid grid-cols-3 gap-2">
                {[['once', 'One-time'], ['monthly', 'Monthly'], ['weekly', 'Weekly']].map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setFrequency(val)}
                    className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                      frequency === val
                        ? 'bg-church-900 dark:bg-church-700 text-parchment-50 border-transparent'
                        : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:border-church-400/60'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Fund */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200 mb-2">Give to</label>
              <select value={fundId} onChange={e => setFundId(e.target.value)} className={inputCls}>
                <option value="">Choose a fund…</option>
                {funds.map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              {fundId && funds.find(f => String(f.id) === fundId)?.description && (
                <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
                  {funds.find(f => String(f.id) === fundId).description}
                </p>
              )}
            </div>

            {/* Donor */}
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name *" className={inputCls} />
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email (for your receipt)" className={inputCls} />
            <textarea value={message} onChange={e => setMessage(e.target.value)} rows={2} placeholder="Note (optional)" className={`${inputCls} resize-none`} />

            {error && <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-40"
            >
              {status === 'submitting'
                ? <><Loader2 size={16} className="animate-spin" /> Processing…</>
                : <><Heart size={16} /> Give{Number.isFinite(amountNum) && amountNum > 0 ? ` ${fmtMoney(amountNum)}` : ''}</>}
            </button>
            <p className="text-center text-[11px] text-ink-500 dark:text-parchment-300/50">
              Powered by OpenChurch
            </p>
          </form>
        )}
      </motion.div>
    </div>
  )
}
