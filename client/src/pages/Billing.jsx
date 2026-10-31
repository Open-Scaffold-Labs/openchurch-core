import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CreditCard, Check, Loader2, AlertTriangle, ExternalLink, Feather } from 'lucide-react'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { isNativeShell } from '../native/nativeShell'
import { planPurchaseOfferedInShell, pricingShownInShell, shellAccountTitle, shellPlanNote } from '../native/planPurchase'
import { PRICING_VISIBLE, betaPricingNote, betaPricingTitle, betaBillingSubtitle } from '../config/pricing'

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


// Plan copy comes from the server in English (server/src/billing/plans.js).
// Translate at display time by exact English text; anything we do not
// know (a renamed plan, a new feature) passes through unchanged rather
// than showing a stale translation.
const PLAN_TEXT_KEYS = {
  'Up to 50 members': 'bill.feat.0',
  'Up to 100 events': 'bill.feat.1',
  'Basic scheduling': 'bill.feat.2',
  'Email support': 'bill.feat.3',
  'Unlimited members': 'bill.feat.4',
  'Unlimited events': 'bill.feat.5',
  'Full AI Studio access': 'bill.feat.6',
  'Priority support': 'bill.feat.7',
  'Custom branding (coming soon)': 'bill.feat.8',
  'Free': 'bill.plan.free',
  'Parish': 'bill.plan.parish',
  'For small congregations getting started.': 'bill.desc.free',
  'Everything a parish office needs, one flat price.': 'bill.desc.parish',
}
export function planText(t, s) {
  const key = PLAN_TEXT_KEYS[s]
  return key ? t(key) : s
}

function fmtDate(d, loc) {
  if (!d) return null
  return new Date(d).toLocaleDateString(loc, { year: 'numeric', month: 'short', day: 'numeric' })
}

// C2: inside the iOS shell the page is a free companion-app note only. It
// does not read /api/billing/status, so no plan name, description, price,
// renewal date, comparison, upgrade, portal or checkout can render.
function ShellBilling() {
  const { locale } = useLocale()
  return (
    <PageWrapper type="list">
      <div className="max-w-4xl mx-auto space-y-8" data-testid="shell-billing">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <PageHeader title={shellAccountTitle(locale)} />
        </motion.div>
        <p className="text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">
          {shellPlanNote(locale)}
        </p>
      </div>
    </PageWrapper>
  )
}

export default function Billing() {
  if (!pricingShownInShell(isNativeShell())) return <ShellBilling />
  return <WebBilling />
}

function WebBilling() {
  const { t, locale, dateLocale } = useLocale()
  // Open beta: with pricing hidden, no price, plan comparison, upgrade,
  // or portal button renders (config/pricing.js).
  const pricingVisible = PRICING_VISIBLE
  const offerPurchase = pricingVisible && planPurchaseOfferedInShell(isNativeShell())
  const [params]    = useSearchParams()
  const navigate    = useNavigate()
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [acting,  setActing]  = useState(false)
  const [err,     setErr]     = useState('')
  const [flash,   setFlash]   = useState(null)

  useEffect(() => {
    if (params.get('success'))      setFlash({ kind: 'success', text: PRICING_VISIBLE ? t('bill.flashSuccess') : betaPricingNote(locale) })
    else if (params.get('canceled')) setFlash({ kind: 'info',    text: t('bill.flashCanceled') })
    if (params.get('stub_checkout') || params.get('stub_portal')) {
      setFlash(prev => ({
        kind: 'info',
        text: (prev?.text ? prev.text + ' ' : '') + t('bill.flashStub'),
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
      setErr(t('load.failedBody'))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { fetchStatus() }, [])

  async function startCheckout(planId) {
    if (!planPurchaseOfferedInShell(isNativeShell())) return
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
    if (!planPurchaseOfferedInShell(isNativeShell())) return
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
      <PageWrapper type="list">
        <div className="flex items-center justify-center py-20">
          <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      </PageWrapper>
    )
  }

  if (err && !data) {
    return (
      <PageWrapper type="list">
        <div className="max-w-xl mx-auto py-12">
          <EmptyState
            icon={AlertTriangle}
            title={t('load.failedTitle')}
            body={err}
            action={{ label: t('bill.tryAgain'), onClick: fetchStatus }}
          />
        </div>
      </PageWrapper>
    )
  }

  const currentPlan = data?.planDetails
  const onPaidPlan  = currentPlan?.id !== 'free'
  const renewAt     = fmtDate(data?.current_period_end, dateLocale)

  return (
    <PageWrapper type="list">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <PageHeader title={t('bill.title')} />
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            {pricingVisible ? t('bill.subtitle') : betaBillingSubtitle(locale)}
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
              <p className="text-xs font-semibold uppercase tracking-wider text-brass-600 dark:text-brass-300">{t('bill.currentPlan')}</p>
              <h2 className="mt-1 font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">{planText(t, currentPlan?.name)}</h2>
              <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">{planText(t, currentPlan?.description)}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {data?.billing_status && (
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_PILL[data.billing_status] ?? STATUS_PILL.canceled}`}>
                    {data.billing_status.replace('_', ' ')}
                  </span>
                )}
                {renewAt && (
                  <span className="text-xs text-ink-500 dark:text-parchment-300/60">
                    {data.billing_status === 'canceled' ? t('bill.accessUntil') : t('bill.renews')} {renewAt}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              {pricingVisible ? (
              <p className="text-3xl font-display font-semibold text-ink-900 dark:text-parchment-50">
                {currentPlan?.price === 0 ? t('bill.plan.free') : `$${currentPlan?.price}${t('bill.perMonth')}`}
              </p>
              ) : (
              <p className="text-xs font-semibold uppercase tracking-wider text-brass-600 dark:text-brass-300">{betaPricingTitle(locale)}</p>
              )}
              {offerPurchase && onPaidPlan && (
                <button
                  type="button"
                  onClick={openPortal}
                  disabled={acting}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 text-sm font-semibold hover:bg-parchment-200 dark:hover:bg-ink-800/70 transition-colors disabled:opacity-50"
                >
                  {acting ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
                  {t('bill.manage')}
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

        {offerPurchase ? (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <h2 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50 mb-4">{t('bill.available')}</h2>
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
                    <h3 className="font-display text-xl font-semibold text-ink-900 dark:text-parchment-50">{planText(t, plan.name)}</h3>
                    {isCurrent && (
                      <span className="text-[11px] font-semibold text-brass-700 dark:text-brass-300 uppercase tracking-wider">{t('bill.current')}</span>
                    )}
                  </div>
                  <p className="text-sm text-ink-500 dark:text-parchment-300/70 mb-4">{planText(t, plan.description)}</p>
                  <p className="text-2xl font-display font-semibold text-ink-900 dark:text-parchment-50 mb-4">
                    {plan.price === 0 ? t('bill.plan.free') : <>${plan.price}<span className="text-sm font-normal text-ink-500 dark:text-parchment-300/70">{t('bill.perMonth')}</span></>}
                  </p>
                  <ul className="space-y-1.5 mb-5">
                    {plan.features.map(f => (
                      <li key={f} className="flex items-start gap-2 text-sm text-ink-700 dark:text-parchment-200">
                        <Check size={14} className="shrink-0 mt-0.5 text-brass-700 dark:text-brass-300" />
                        <span>{planText(t, f)}</span>
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
                      {t('bill.upgradeTo', { plan: planText(t, plan.name) })}
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
                      {t('bill.downgrade')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </motion.div>
        ) : !pricingVisible ? (
          <p data-testid="beta-pricing-note" className="text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">
            {betaPricingNote(locale)}
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">
            {shellPlanNote(locale)}
          </p>
        )}

        {offerPurchase && (
        <p className="text-xs text-ink-500 dark:text-parchment-300/60 leading-relaxed">
          {t('bill.stubNote')}
        </p>
        )}
      </div>
    </PageWrapper>
  )
}
