import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CreditCard, Check, Loader2, AlertTriangle, ExternalLink, Feather } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { apiUrl } from '../api'

// Billing & subscription page. Admin-only via the sidebar filter +
// /api/billing mount-level gate on writes. GET /status is readable by
// anyone in the org, but the surface here is built for admins (the
// upgrade and portal buttons are the bulk of it).
//
// Flash banners read three query-param markers from the URL after the
// stub or real provider redirects back:
//   ?success=1      — checkout completed
//   ?canceled=1     — user closed checkout without paying
//   ?stub_checkout=1 — stub mode flag, helpful nudge that no real money moved
//   ?stub_portal=1   — stub portal returned without doing anything

const STATUS_PILL = {
  active:    'bg-brass-50 text-brass-700 dark:bg-brass-900/30 dark:text-brass-300',
  trialing:  'bg-amber-50  text-amber-700  dark:bg-amber-900/30  dark:text-amber-300',
  past_due:  'bg-rose-50   text-rose-700   dark:bg-rose-900/30   dark:text-rose-300',
  canceled:  'bg-parchment-200 text-ink-600 dark:bg-ink-800/60 dark:text-parchment-200',
}

function fmtDate(d) {
  if (!d) return null
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function Billing() {
  const [params]    = useSearchParams()
  const navigate    = useNavigate()
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [acting,  setActing]  = useState(false)
  const [err,     setErr]     = useState('')
  const [flash,   setFlash]   = useState(null)

  useEffect(() => {
    if (params.get('success'))      setFlash({ kind: 'success', text: 'Subscription activated. Welcome to Pro.' })
    else if (params.get('canceled')) setFlash({ kind: 'info',    text: 'Checkout canceled. No charge was made.' })
    if (params.get('stub_checkout') || params.get('stub_portal')) {
      setFlash(prev => ({
        kind: 'info',
        text: (prev?.text ? prev.text + ' ' : '') + 'Running in stub billing mode — no payment provider wired in yet.',
      }))
    }
  }, [params])

  async function fetchStatus() {
    setLoading(true); setErr('')
    try {
      const res = await fetch(apiUrl('/api/billing/status'))
      if (!res.ok) throw new Error(`Failed to load billing (${res.status})`)
      setData(await res.json())
    } catch (e) {
      setErr("Couldn't load billing. Nothing was lost — please retry.")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { fetchStatus() }, [])

  async function startCheckout(planId) {
    setActing(true); setErr('')
    try {
      const res = await fetch(apiUrl('/api/billing/checkout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "That didn't save — nothing was lost. Please try again.")
      // Redirect to provider checkout page (or stub success URL).
      window.location.href = body.url
    } catch (e) {
      setErr(e.message)
      setActing(false)
    }
  }

  async function openPortal() {
    setActing(true); setErr('')
    try {
      const res = await fetch(apiUrl('/api/billing/portal'), { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "That didn't save — nothing was lost. Please try again.")
      window.location.href = body.url
    } catch (e) {
      setErr(e.message)
      setActing(false)
    }
  }

  if (loading) {
    return (
      <PageWrapper>
        <div className="flex items-center justify-center py-20">
          <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      </PageWrapper>
    )
  }

  if (err && !data) {
    return (
      <PageWrapper>
        <div className="max-w-xl mx-auto py-12">
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load billing"
            body={err}
            action={{ label: 'Try again', onClick: fetchStatus }}
          />
        </div>
      </PageWrapper>
    )
  }

  const currentPlan = data?.planDetails
  const onPaidPlan  = currentPlan?.id !== 'free'
  const renewAt     = fmtDate(data?.current_period_end)

  return (
    <PageWrapper>
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Billing & plan</h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            Manage your subscription, payment method, and invoices.
          </p>
        </motion.div>

        {flash && (
          <div className={`flex items-start gap-3 p-4 rounded-xl border ${
            flash.kind === 'success'
              ? 'bg-brass-50 dark:bg-brass-900/20 border-brass-200/70 dark:border-brass-800/40 text-ink-800 dark:text-parchment-100'
              : 'bg-brass-50 dark:bg-brass-900/20 border-brass-200/70 dark:border-brass-800/40 text-ink-800 dark:text-parchment-100'
          }`}>
            <Feather size={16} className="shrink-0 mt-0.5 text-brass-700 dark:text-brass-300" />
            <p className="text-sm flex-1">{flash.text}</p>
            <button onClick={() => { setFlash(null); navigate('/billing', { replace: true }) }} className="text-ink-400 hover:text-ink-700 dark:text-parchment-400/60 dark:hover:text-parchment-100 text-lg leading-none">×</button>
          </div>
        )}

        {/* Current plan card */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-brass-600 dark:text-brass-300">Current plan</p>
              <h2 className="mt-1 font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">{currentPlan?.name}</h2>
              <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">{currentPlan?.description}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {data?.billing_status && (
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_PILL[data.billing_status] ?? STATUS_PILL.canceled}`}>
                    {data.billing_status.replace('_', ' ')}
                  </span>
                )}
                {renewAt && (
                  <span className="text-xs text-ink-500 dark:text-parchment-300/60">
                    {data.billing_status === 'canceled' ? 'Access until' : 'Renews'} {renewAt}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <p className="text-3xl font-display font-semibold text-ink-900 dark:text-parchment-50">
                {currentPlan?.price === 0 ? 'Free' : `$${currentPlan?.price}/mo`}
              </p>
              {onPaidPlan && (
                <button
                  type="button"
                  onClick={openPortal}
                  disabled={acting}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 text-sm font-semibold hover:bg-parchment-200 dark:hover:bg-ink-800/70 transition-colors disabled:opacity-50"
                >
                  {acting ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
                  Manage billing
                  <ExternalLink size={12} className="opacity-60" />
                </button>
              )}
            </div>
          </div>
        </motion.div>

        {err && (
          <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2 flex items-start gap-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>{err}</span>
          </div>
        )}

        {/* Plans grid */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <h2 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50 mb-4">Available plans</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {(data?.availablePlans || []).map(plan => {
              const isCurrent = plan.id === currentPlan?.id
              return (
                <div
                  key={plan.id}
                  className={`rounded-2xl border p-6 transition-colors ${
                    isCurrent
                      ? 'bg-church-50/40 dark:bg-church-900/20 border-church-700/40 dark:border-brass-700/40 shadow-warm-md'
                      : 'bg-parchment-50 dark:bg-ink-900/90 border-parchment-300/60 dark:border-brass-900/30'
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-display text-xl font-semibold text-ink-900 dark:text-parchment-50">{plan.name}</h3>
                    {isCurrent && (
                      <span className="text-[10px] font-semibold text-brass-700 dark:text-brass-300 uppercase tracking-wider">Current</span>
                    )}
                  </div>
                  <p className="text-sm text-ink-500 dark:text-parchment-300/70 mb-4">{plan.description}</p>
                  <p className="text-2xl font-display font-semibold text-ink-900 dark:text-parchment-50 mb-4">
                    {plan.price === 0 ? 'Free' : <>${plan.price}<span className="text-sm font-normal text-ink-500 dark:text-parchment-300/70">/mo</span></>}
                  </p>
                  <ul className="space-y-1.5 mb-5">
                    {plan.features.map(f => (
                      <li key={f} className="flex items-start gap-2 text-sm text-ink-700 dark:text-parchment-200">
                        <Check size={14} className="shrink-0 mt-0.5 text-brass-700 dark:text-brass-300" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  {!isCurrent && plan.id !== 'free' && (
                    <button
                      type="button"
                      onClick={() => startCheckout(plan.id)}
                      disabled={acting}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
                    >
                      {acting && <Loader2 size={14} className="animate-spin" />}
                      Upgrade to {plan.name}
                    </button>
                  )}
                  {!isCurrent && plan.id === 'free' && onPaidPlan && (
                    <button
                      type="button"
                      onClick={openPortal}
                      disabled={acting}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 text-sm font-semibold hover:bg-parchment-200 dark:hover:bg-ink-800/70 transition-colors disabled:opacity-50"
                    >
                      {acting && <Loader2 size={14} className="animate-spin" />}
                      Downgrade in portal
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </motion.div>

        <p className="text-xs text-ink-500 dark:text-parchment-300/60 leading-relaxed">
          Stub billing mode is active until the team lead surfaces a payment provider. Upgrades work locally for testing flow but no real charge happens.
        </p>
      </div>
    </PageWrapper>
  )
}
