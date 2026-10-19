import { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Heart, Loader2, AlertTriangle, Check, ArrowLeft, RefreshCw } from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'

// Public give page (Online giving / GIV.2). Unauthenticated —
// a parishioner gives to one of the church's funds. The charge
// runs through the vendor-neutral payments stub server-side
// (GIV.1), so this is a real end-to-end flow today; only the
// processor swaps in later.
//
// URL: /p/:slug/give
// Data:
//   GET  /api/public/:slug/funds  → active funds + church name
//   POST /api/public/:slug/give   → charge (stub) + record donation
//
// Renders outside the app shell like the other /p/:slug surfaces.
// User-visible chrome goes through t() (OC-READY-01-034). Frequency
// *values*, POST body, checkout redirect, and stub honesty stay
// the giving contract.

const QUICK_AMOUNTS = [25, 50, 100, 250]
const FREQUENCIES = ['once', 'monthly', 'weekly']

function fmtMoney(n) {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

function frequencyLabel(frequency, t) {
  if (frequency === 'monthly') return t('give.freqMonthly')
  if (frequency === 'weekly') return t('give.freqWeekly')
  if (frequency === 'once') return t('give.freqOnce')
  return frequency
}

export default function PublicGive() {
  const { t, setPublicLocale } = useLocale()
  const { slug } = useParams()
  const [church, setChurch] = useState(null)
  const [funds, setFunds]   = useState([])
  // The server refuses to record a gift when no payment provider is
  // configured — otherwise a "successful" receipt is issued for money that
  // never moved. Read the same fact here so a parishioner sees the calm
  // "not set up yet" note instead of filling in a form that will be refused.
  const [givingEnabled, setGivingEnabled] = useState(true)
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

  // Deliberately NOT useLoad/LoadState here. This page's states are mostly
  // DOMAIN states — church not found, giving not configured, gift submitted —
  // and only one of them is a load state. Wrapping the read in the primitive
  // would leave the four load branches interleaved with three domain branches
  // and read worse than the explicit version. The abstraction serves the
  // workflow; this workflow does not want it. What it did want was a retry,
  // which is why the read is a named function instead of an inline effect.
  const load = useCallback(() => {
    if (!slug) return
    let cancelled = false
    setLoad(true); setLoadErr('')
    fetch(apiUrl(`/api/public/${slug}/funds`))
      .then(r => {
        if (r.status === 404) throw new Error('not-found')
        if (!r.ok) throw new Error(`Failed (${r.status})`)
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        setChurch(d.church ?? null)
      // The parish's language, from the endpoint. Nobody is signed in
      // here, so this is the only thing that can make the page speak it.
        setPublicLocale(d.church?.locale)
        setFunds(d.funds ?? [])
        setGivingEnabled(d.giving_enabled !== false)
        if ((d.funds ?? []).length === 1) setFundId(String(d.funds[0].id))
      })
      .catch(e => { if (!cancelled) setLoadErr(e.message || 'Failed to load') })
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [slug, setPublicLocale])

  useEffect(() => load(), [load])
  const reload = () => load()

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
      if (!res.ok) throw new Error(d.error || t('give.submitFail', { status: res.status }))
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

  // A failed read is not an unconfigured parish.
  //
  // Observed 27 Aug at 390px: a 500 on /funds and a church that genuinely has
  // no giving produced BYTE-IDENTICAL output — "Online giving isn't set up
  // for this church yet. Please check back soon." Only 'not-found' had a
  // branch; every other load failure fell through to `funds.length === 0`.
  //
  // Pass 9 kept the Give button visible on the church page when the funds
  // state was unknown, on the reasoning that this page is the authority.
  // This page was not being honest either, so that reasoning was moving the
  // lie one screen along rather than removing it. A visitor who came to give
  // was told the parish cannot receive gifts, and told to check back later —
  // advice that is right for one of these situations and useless for the
  // other.
  if (loadErr && loadErr !== 'not-found') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-parchment-50 dark:bg-ink-950">
        <div className="text-center max-w-md">
          <AlertTriangle size={28} className="mx-auto text-amber-600 dark:text-amber-300 mb-3" aria-hidden="true" />
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            {t('give.loadFailTitle')}
          </h1>
          <p role="status" className="mt-2 text-sm text-ink-600 dark:text-parchment-300/80 leading-relaxed">
            {t('give.loadFailBody')}
          </p>
          <button
            type="button"
            onClick={reload}
            disabled={loading}
            className="tap mt-6 inline-flex items-center justify-center gap-1.5 px-5 py-2.5 text-sm font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60"
          >
            {loading
              ? <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              : <RefreshCw size={15} aria-hidden="true" />}
            {t('give.tryAgain')}
          </button>
          <p className="mt-4 text-[11px] text-ink-500 dark:text-parchment-300/60">
            {t('give.loadFailOffice')}
          </p>
        </div>
      </div>
    )
  }

  if (loadErr === 'not-found') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-parchment-50 dark:bg-ink-950">
        <div className="text-center max-w-md">
          <AlertTriangle size={28} className="mx-auto text-amber-600 dark:text-amber-300 mb-3" />
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">{t('give.notFound')}</h1>
          <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70">
            {t('give.notFoundBefore')}<span className="font-mono">/p/{slug}</span>{t('give.notFoundAfter')}
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
            {church?.name ? t('give.titleTo', { name: church.name }) : t('give.title')}
          </h1>
        </header>

        {status === 'done' ? (
          <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-8 text-center">
            <span className="inline-flex w-12 h-12 rounded-full bg-brass-100 dark:bg-brass-900/40 items-center justify-center text-brass-700 dark:text-brass-300 mb-4">
              <Check size={22} />
            </span>
            <h2 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">{t('give.thanks')}</h2>
            <p className="mt-2 text-sm text-ink-600 dark:text-parchment-300/80">
              {t('give.receivedBefore')}<span className="font-semibold">{fmtMoney(receipt?.amount ?? amountNum)}</span>
              {receipt?.fund ? <>{t('give.receivedTo')}<span className="font-semibold">{receipt.fund}</span></> : null}{t('give.receivedAfter')}
              {receipt?.recurring && <>{t('give.repeatsBefore')}<span className="font-semibold">{frequencyLabel(receipt.recurring, t)}</span>{t('give.repeatsAfter')}</>}
            </p>
            {receipt?.reference && (
              <p className="mt-1 text-[11px] text-ink-500 dark:text-parchment-300/60">
                {t('give.reference')} <span className="font-mono">{receipt.reference}</span>
              </p>
            )}
            <Link
              to={`/p/${slug}`}
              className="inline-flex items-center gap-1.5 mt-6 text-sm font-semibold text-church-800 dark:text-brass-300 hover:text-church-900 dark:hover:text-brass-200 transition-colors"
            >
              <ArrowLeft size={14} /> {church?.name ? t('give.back', { name: church.name }) : t('give.backHome')}
            </Link>
          </div>
        ) : (funds.length === 0 || !givingEnabled) ? (
          <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-8 text-center">
            <Heart size={26} className="mx-auto text-brass-500 dark:text-brass-300 mb-3 opacity-70" />
            <p className="text-sm text-ink-600 dark:text-parchment-300/80">
              {t('give.notSetUp')}
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 space-y-5">
            {/* Amount
                Every control on this form used to be labelled by its
                placeholder alone. Placeholders disappear the moment someone
                types, so a parishioner checking their own entry before
                submitting has nothing left to tell them which box is which —
                and a screen reader announces most of them as "edit text".
                This is the page a parish links from its bulletin: unsigned-in,
                usually a phone, often someone who does not use software all
                day. Real labels, kept visible. */}
            <div>
              <label htmlFor="give-amount" className="block text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200 mb-2">{t('give.amount')}</label>
              <div role="group" aria-label={t('give.suggested')} className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                {QUICK_AMOUNTS.map(a => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAmount(String(a))}
                    aria-pressed={Number(amount) === a}
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
                <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500 dark:text-parchment-300/70">$</span>
                <input
                  id="give-amount"
                  type="number"
                  min="1"
                  step="0.01"
                  inputMode="decimal"
                  required
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder={t('give.amountPh')}
                  aria-describedby="give-amount-help"
                  className={`${inputCls} pl-7`}
                />
              </div>
              <p id="give-amount-help" className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
                {t('give.amountHelp')}
              </p>
            </div>

            {/* Frequency — a button group, so it needs radio semantics rather
                than a bare <label>, which has nothing to point at. */}
            <div role="radiogroup" aria-labelledby="give-frequency-label">
              <span id="give-frequency-label" className="block text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200 mb-2">{t('give.frequency')}</span>
              <div className="grid grid-cols-3 gap-2">
                {FREQUENCIES.map(val => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setFrequency(val)}
                    role="radio"
                    aria-checked={frequency === val}
                    className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                      frequency === val
                        ? 'bg-church-900 dark:bg-church-700 text-parchment-50 border-transparent'
                        : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:border-church-400/60'
                    }`}
                  >
                    {frequencyLabel(val, t)}
                  </button>
                ))}
              </div>
            </div>

            {/* Fund */}
            <div>
              <label htmlFor="give-fund" className="block text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200 mb-2">{t('give.fund')}</label>
              <select id="give-fund" value={fundId} onChange={e => setFundId(e.target.value)} className={inputCls}>
                <option value="">{t('give.chooseFund')}</option>
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

            {/* Donor. autoComplete matters more here than anywhere else on the
                site: this is a one-off form a person fills in on a phone,
                once, and the browser already knows their name and email. */}
            <div>
              <label htmlFor="give-name" className="block text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200 mb-2">
                {t('give.name')} <span className="text-church-700 dark:text-brass-300" aria-hidden="true">*</span>
                <span className="sr-only">{t('give.required')}</span>
              </label>
              <input
                id="give-name"
                type="text"
                required
                autoComplete="name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('give.namePh')}
                className={inputCls}
              />
            </div>

            <div>
              <label htmlFor="give-email" className="block text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200 mb-2">{t('give.email')}</label>
              <input
                id="give-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={t('give.emailPh')}
                aria-describedby="give-email-help"
                className={inputCls}
              />
              <p id="give-email-help" className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
                {t('give.emailHelp')}
              </p>
            </div>

            <div>
              <label htmlFor="give-note" className="block text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200 mb-2">
                {t('give.note')} <span className="font-normal normal-case tracking-normal text-ink-500 dark:text-parchment-300/70">{t('give.optional')}</span>
              </label>
              <textarea
                id="give-note"
                value={message}
                onChange={e => setMessage(e.target.value)}
                rows={2}
                placeholder={t('give.notePh')}
                className={`${inputCls} resize-none`}
              />
            </div>

            {error && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-40"
            >
              {status === 'submitting'
                ? <><Loader2 size={16} className="animate-spin" /> {t('give.processing')}</>
                : <><Heart size={16} /> {Number.isFinite(amountNum) && amountNum > 0 ? t('give.submitAmount', { amount: fmtMoney(amountNum) }) : t('give.submit')}</>}
            </button>
            <p className="text-center text-[11px] text-ink-500 dark:text-parchment-300/70">
              {t('give.powered')}
            </p>
          </form>
        )}
      </motion.div>
    </div>
  )
}
