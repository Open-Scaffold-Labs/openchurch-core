import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Link, useSearchParams } from 'react-router-dom'
import {
  DollarSign, TrendingUp, Users, Award, Plus, X, Trash2,
  ChevronDown, Banknote, CheckCircle2, Clock, AlertCircle, FileText,
  Landmark, FlaskConical, RotateCcw, Repeat, History,
} from 'lucide-react'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import PageWrapper, { PageHeader, itemVariants } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'
import { DonationsIllustration } from '../components/illustrations'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip, scrimCls } from '../components/MobileSheet'
import { apiUrl } from '../api'
import { todayLocalISO } from '../utils/dates'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { useConfirm, usePrompt } from '../components/ConfirmProvider'
import useDialogFocus from '../components/useDialogFocus'
import { useLocale } from '../i18n'
import { enT } from '../i18n/sweepStrings'
import { dialogMotionNow, drawerMotion } from '../utils/motion'

// ── Constants ─────────────────────────────────────────────────
// SP-089: includes the words the sample seed writes for each tradition
// (offertory, pledge, special collection, special offering) so seeded and
// real gifts in those categories are filterable and choosable.
const CATEGORIES = ['tithe', 'offering', 'offertory', 'pledge', 'special collection', 'special offering', 'event', 'building fund', 'missions', 'other']
const METHODS    = ['cash', 'card', 'online', 'check']

const BILLS = [
  { label: '$100', value: 100 },
  { label: '$50',  value: 50  },
  { label: '$20',  value: 20  },
  { label: '$10',  value: 10  },
  { label: '$5',   value: 5   },
  { label: '$2',   value: 2   },
  { label: '$1',   value: 1   },
]
const COINS = [
  { label: '25¢', value: 0.25 },
  { label: '10¢', value: 0.10 },
  { label: '5¢',  value: 0.05 },
  { label: '1¢',  value: 0.01 },
]
const ALL_DENOMS = [...BILLS, ...COINS]

const EMPTY_COUNTS = Object.fromEntries(ALL_DENOMS.map(d => [d.value, 0]))
const EMPTY_SESSION = {
  service_name: '', service_date: todayLocalISO(),
  category: 'offering', counted_by: '', notes: '',
}

// One quiet voice for category/method chips (C3): labels, not traffic
// lights — amber/rose are reserved for genuine attention/errors, never
// as category identity (OPERATOR).
const CATEGORY_TONE = 'bg-brass-50 text-brass-700 dark:bg-brass-900/20 dark:text-brass-300'
const METHOD_TONE   = 'bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-200'
const CATEGORY_STYLES = {
  tithe:          CATEGORY_TONE,
  offering:       CATEGORY_TONE,
  event:          CATEGORY_TONE,
  'building fund':CATEGORY_TONE,
  missions:       CATEGORY_TONE,
  offertory:      CATEGORY_TONE,
  pledge:         CATEGORY_TONE,
  'special collection': CATEGORY_TONE,
  'special offering':   CATEGORY_TONE,
  other:          'bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-200',
}
const METHOD_STYLES = {
  cash:   METHOD_TONE,
  card:   METHOD_TONE,
  online: METHOD_TONE,
  check:  METHOD_TONE,
}

// ── Helpers ───────────────────────────────────────────────────
function fmtCurrency(n, decimals = 0) {
  return Number(n ?? 0).toLocaleString('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: decimals,
  })
}
function fmtDate(str, loc = 'en-US') {
  if (!str) return '—'
  // Two shapes reach this. Calendar-day columns arrive as 'YYYY-MM-DD' (the
  // routes to_char them). Columns that really are moments — last_failed_at —
  // arrive as a full ISO timestamp. Appending 'T00:00:00' to the second shape
  // produced an unparseable string, and the donation log showed 'Invalid Date'
  // on every row (13 of 13, measured 4 Sep) because the routes were sending
  // the first shape as the second.
  //
  // Both shapes start with the calendar day, so take that and read it as a
  // local day. A date has no time to lose, and doing it this way means a
  // column that regresses to a timestamp degrades to the right day rather
  // than to nothing. Anything genuinely unparseable shows the same em-dash an
  // empty value gets — never the words 'Invalid Date'.
  const day = String(str).slice(0, 10)
  const d = new Date(day + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(loc, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}
function calcTotal(counts) {
  return ALL_DENOMS.reduce((sum, d) => sum + (Number(counts[d.value] ?? 0) * d.value), 0)
}

// Build a 30-day giving trend from *real* donations. We seed one bucket
// per calendar day (local time) for the last 30 days so the x-axis is
// continuous even on days with no gifts, then sum each donation into its
// day. Returns [] when there's nothing real to plot — the caller shows
// an empty state rather than a fabricated line.
// What this gift still contributes. A void or a full refund contributes
// nothing. A partial contributes the remainder, not the original amount.
// Without a books block (older payloads) a stamped refund contributes nothing.
export function giftLiveAmount(don) {
  if (don?.books && (typeof don.books.live_amount === 'number' || typeof don.books.live_amount === 'string')) {
    const n = Number(don.books.live_amount)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  if (don?.refunded_at) return 0
  const n = Number(don?.amount)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function buildTrendFromDonations(donations) {
  if (!donations?.length) return []
  // Local-midnight keys for the last 30 days, oldest → newest.
  const days = []
  const index = new Map()
  const now = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    index.set(key, days.length)
    days.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, total: 0 })
  }
  let anyInWindow = false
  for (const don of donations) {
    if (!don?.date) continue
    // Donation dates are 'YYYY-MM-DD' — take the first 10 chars so an
    // accidental timestamp still keys to the right local day.
    const key = String(don.date).slice(0, 10)
    const idx = index.get(key)
    if (idx === undefined) continue        // outside the 30-day window
    const net = giftLiveAmount(don)
    if (net <= 0) continue
    days[idx].total += net
    anyInWindow = true
  }
  // If not a single donation fell in the last 30 days, there's no trend
  // worth drawing — let the caller render the empty state.
  return anyInWindow ? days : []
}

// Admin only, matching the Help table and the cash-count void. A gift
// posted from a cash count is voided with the count, so the two stay together.
export function canMarkGift(user, donation) {
  if (user?.role !== 'admin' || !donation) return false
  if (donation.books?.from_cash_count) return false
  if (donation.books?.marker === 'voided') return false
  return giftLiveAmount(donation) > 0
}

export function providerRefundCopy(donation, t) {
  const online = donation?.payment_ref || donation?.source === 'online' || donation?.source === 'recurring'
  if (!online) return null
  return t ? t('don.providerRefund') : 'This marks the parish books only. Return the money in the payment provider if it has not already been returned there.'
}

// ── Sub-components ────────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-parchment-50 dark:bg-ink-900 border border-parchment-300/70 dark:border-brass-900/40 rounded-xl px-3 py-2 shadow-warm-md text-sm">
      <p className="text-ink-500 dark:text-parchment-300/70 mb-0.5">{label}</p>
      <p className="font-semibold text-ink-900 dark:text-parchment-50">{fmtCurrency(payload[0].value)}</p>
    </div>
  )
}

export function SummaryCard({ icon: Icon, label, value, sub, accent }) {
  const accentCls = {
    violet: 'bg-church-50 dark:bg-church-900/30 text-church-700 dark:text-brass-200',
    indigo: 'bg-brass-50 dark:bg-brass-900/20 text-brass-700 dark:text-brass-300',
    emerald:'bg-parchment-200/70 dark:bg-ink-800 text-ink-700 dark:text-parchment-200',
    amber:  'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  }[accent]
  return (
    <motion.div variants={itemVariants}
      className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 p-4 sm:p-5 flex flex-col sm:flex-row items-start gap-3 sm:gap-4 min-w-0 hover:shadow-md transition-shadow">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${accentCls}`}>
        <Icon size={20} />
      </div>
      <div className="min-w-0 w-full">
        <p className="text-xs font-medium text-ink-500 dark:text-parchment-300/70 mb-0.5">{label}</p>
        <p data-testid="summary-value" className="text-xl sm:text-2xl font-bold text-ink-900 dark:text-parchment-50 tracking-tight tabular-nums [overflow-wrap:anywhere]">{value}</p>
        {sub && <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">{sub}</p>}
      </div>
    </motion.div>
  )
}

// ── Denomination Row ──────────────────────────────────────────
// SP-310: +/− need a ≥44px touch target and an accessible name that
// includes the denomination (screen readers otherwise just say "minus").
function DenomRow({ label, value, count, onChange, decAria, incAria }) {
  const subtotal = (Number(count) * value)
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-parchment-300/50 dark:border-brass-900/20 last:border-0">
      <span className="w-12 text-sm font-semibold text-ink-700 dark:text-parchment-100">{label}</span>
      <div className="flex items-center gap-1.5 flex-1">
        <button
          type="button"
          aria-label={decAria}
          onClick={() => onChange(Math.max(0, Number(count) - 1))}
          className="min-h-[44px] min-w-[44px] w-11 h-11 rounded-lg bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700 text-base font-bold leading-none transition-colors flex items-center justify-center"
        >−</button>
        <input
          type="number" min="0"
          value={count === 0 ? '' : count}
          onChange={e => onChange(Math.max(0, parseInt(e.target.value || '0', 10)))}
          placeholder="0"
          aria-label={label}
          className="w-16 text-center px-2 py-1 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
        />
        <button
          type="button"
          aria-label={incAria}
          onClick={() => onChange(Number(count) + 1)}
          className="min-h-[44px] min-w-[44px] w-11 h-11 rounded-lg bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700 text-base font-bold leading-none transition-colors flex items-center justify-center"
        >+</button>
      </div>
      <span className={`w-20 text-right text-sm font-medium tabular-nums ${subtotal > 0 ? 'text-church-700 dark:text-brass-300' : 'text-ink-300 dark:text-parchment-400/50'}`}>
        {subtotal > 0 ? fmtCurrency(subtotal, 2) : '—'}
      </span>
    </div>
  )
}

// ── Cash Count Drawer ─────────────────────────────────────────
// SP-309: Cancel / backdrop / X must not throw away a non-zero count
// without asking. SP-310: dialog semantics + Esc (same requestClose),
// labelled ≥44px steppers, labelled close. Money math and the save
// payload are unchanged.
function CashCountDrawer({ onClose, onSaved }) {
  const { t } = useLocale()
  const ask = useConfirm()
  const panelRef = useRef(null)
  const [form, setForm]     = useState(EMPTY_SESSION)
  const [counts, setCounts] = useState(EMPTY_COUNTS)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setCount = (denom, qty) => setCounts(c => ({ ...c, [denom]: qty }))
  const total = calcTotal(counts)

  // Non-zero counted total is the "half-done" signal Saint measured.
  const requestClose = useCallback(async () => {
    if (total > 0) {
      const ok = await ask({
        title: t('don.cc.discardTitle'),
        body: t('don.cc.discardBody'),
        confirmLabel: t('don.cc.discardConfirm'),
      })
      if (!ok) return
    }
    onClose()
  }, [total, ask, t, onClose])

  useDialogFocus(panelRef, requestClose)

  async function submit(e) {
    e.preventDefault()
    if (!form.service_name.trim()) return setError(t('don.cc.errService'))
    if (!form.counted_by.trim())   return setError(t('don.counter1Required'))
    if (total <= 0)                return setError(t('don.cc.errTotal'))
    setError('')
    setSaving(true)
    try {
      const res = await fetch(apiUrl('/api/donations/cash-counts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, denominations: counts, total }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error) }
      const session = await res.json()
      onSaved(session)
    } catch (err) {
      setError(err.message || t('don.didntSave'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className={`${scrimCls} z-40`}
        onClick={requestClose}
      />
      {/* Panel */}
      <motion.div
        {...drawerMotion}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cash-count-drawer-title"
        tabIndex={-1}
        className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-parchment-50 dark:bg-ink-900 shadow-warm-lg flex flex-col outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brass-50 dark:bg-brass-900/25 flex items-center justify-center">
              <Banknote size={16} className="text-brass-700 dark:text-brass-300" />
            </div>
            <div>
              <h2 id="cash-count-drawer-title" className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('don.cc.title')}</h2>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('don.cc.sub')}</p>
            </div>
          </div>
          <button type="button" onClick={requestClose} aria-label={t('don.close')}
            className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <form onSubmit={submit} className="flex-1 overflow-y-auto">
          {/* SP-291: sticky footer covers the lower bill rows at 390px; pad
              the scroll body so the last denomination clears Guardar. */}
          <div className="px-4 sm:px-6 py-5 space-y-5 pb-28">
            {error && (
              <div className="flex items-center gap-2 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 rounded-lg px-3 py-2">
                <AlertCircle size={13} />
                {error}
              </div>
            )}

            {/* Service info */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">{t('don.cc.serviceInfo')}</h3>
              <div>
                <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.cc.serviceName')}</label>
                <input
                  value={form.service_name}
                  onChange={e => set('service_name', e.target.value)}
                  placeholder={t('don.cc.servicePh')}
                  className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.date')}</label>
                  <input
                    type="date" value={form.service_date}
                    onChange={e => set('service_date', e.target.value)}
                    className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.category')}</label>
                  <select
                    value={form.category} onChange={e => set('category', e.target.value)}
                    className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400 capitalize"
                  >
                    {CATEGORIES.map(c => <option key={c} value={c}>{catLabel(t, c)}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Counters */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">{t('don.cc.counters')}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.cc.counter1')} <span className="text-rose-300">*</span></label>
                  <input
                    value={form.counted_by}
                    onChange={e => set('counted_by', e.target.value)}
                    placeholder={t('don.cc.firstName')}
                    className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
                  />
                </div>
              </div>
              {/* 123 (José, 21 Oct): the second counter verifies by confirming
                  the count from their own sign-in, not by a typed name here. */}
              <p className="text-xs text-ink-500 dark:text-parchment-300/70">
                {t('don.cc.verifyHint')}
              </p>
            </div>

            {/* Bills */}
            <div>
              <h3 className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider mb-2">{t('don.cc.bills')}</h3>
              <div className="bg-parchment-100 dark:bg-ink-800 rounded-xl px-4 py-1">
                {BILLS.map(d => (
                  <DenomRow key={d.value} label={d.label} value={d.value}
                    count={counts[d.value]} onChange={qty => setCount(d.value, qty)}
                    decAria={t('don.cc.decAria', { denom: d.label })}
                    incAria={t('don.cc.incAria', { denom: d.label })} />
                ))}
              </div>
            </div>

            {/* Coins */}
            <div>
              <h3 className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider mb-2">{t('don.cc.coins')}</h3>
              <div className="bg-parchment-100 dark:bg-ink-800 rounded-xl px-4 py-1">
                {COINS.map(d => (
                  <DenomRow key={d.value} label={d.label} value={d.value}
                    count={counts[d.value]} onChange={qty => setCount(d.value, qty)}
                    decAria={t('don.cc.decAria', { denom: d.label })}
                    incAria={t('don.cc.incAria', { denom: d.label })} />
                ))}
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.notes')} <span className="text-ink-400">{t('don.optional')}</span></label>
              <input
                value={form.notes} onChange={e => set('notes', e.target.value)}
                placeholder={t('don.cc.notesPh')}
                className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
              />
            </div>
          </div>
        </form>

        {/* Sticky footer — total + submit.
            SP-309: Cancel sits alone on the left (not a flex-1 twin of Save)
            so a thumb aiming for Save is less likely to hit Cancel. */}
        <div className="flex-shrink-0 border-t border-parchment-300/60 dark:border-brass-900/30 px-6 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-500 dark:text-parchment-300/70">{t('don.cc.total')}</span>
            <span className={`text-2xl font-bold tabular-nums tracking-tight ${total > 0 ? 'text-ink-900 dark:text-parchment-50' : 'text-ink-300 dark:text-parchment-400/50'}`}>
              {fmtCurrency(total, 2)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <button type="button" onClick={requestClose}
              className="px-4 py-2.5 text-sm font-medium rounded-xl text-ink-600 dark:text-parchment-200 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
              {t('don.cancel')}
            </button>
            <button type="button" onClick={submit} disabled={saving || total <= 0}
              className="min-w-[9rem] px-5 py-2.5 text-sm font-semibold rounded-xl bg-brass-700 hover:bg-brass-800 text-parchment-50 transition-colors disabled:opacity-50">
              {saving ? t('don.saving') : t('don.cc.save')}
            </button>
          </div>
        </div>
      </motion.div>
    </>
  )
}

// ── Add Donation Modal ────────────────────────────────────────
const EMPTY_FORM = {
  donor_name: '', amount: '', category: 'tithe', method: 'cash',
  date: todayLocalISO(), notes: '',
}

function DonationModal({ onClose, onSave }) {
  const { t } = useLocale()
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function submit(e) {
    e.preventDefault()
    if (!form.donor_name.trim()) return setError(t('don.errDonor'))
    if (!form.amount || isNaN(form.amount) || Number(form.amount) <= 0) return setError(t('don.errAmount'))
    setError('')
    setSaving(true)
    try {
      const res = await fetch(apiUrl('/api/donations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, amount: Number(form.amount) }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error) }
      onSave(await res.json())
    } catch (err) {
      setError(err.message || t('don.didntSave'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className={sheetOverlayCls}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div {...dialogMotionNow()}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
          <h2 className="text-base font-semibold text-ink-900 dark:text-parchment-50">{t('don.add')}</h2>
          <button type="button" onClick={onClose} aria-label={t('don.close')}
            className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 rounded-lg px-3 py-2">{error}</p>}

          <div>
            <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.donorName')}</label>
            <input value={form.donor_name} onChange={e => set('donor_name', e.target.value)}
              placeholder={t('don.donorNamePh')}
              className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.amount')}</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 text-sm font-medium">$</span>
                <input type="number" min="0" step="0.01" value={form.amount}
                  onChange={e => set('amount', e.target.value)} placeholder="0.00"
                  className="w-full pl-7 pr-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.date')}</label>
              <input type="date" value={form.date} onChange={e => set('date', e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.category')}</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map(c => (
                <button key={c} type="button" onClick={() => set('category', c)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                    form.category === c ? 'bg-church-800 text-parchment-50' : 'bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700'
                  }`}>{catLabel(t, c)}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.method')}</label>
            <div className="flex gap-2">
              {METHODS.map(m => (
                <button key={m} type="button" onClick={() => set('method', m)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium capitalize transition-colors ${
                    form.method === m ? 'bg-church-800 text-parchment-50' : 'bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700'
                  }`}>{methodLabel(t, m)}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">{t('don.notes')} <span className="text-ink-400">{t('don.optional')}</span></label>
            <input value={form.notes} onChange={e => set('notes', e.target.value)}
              placeholder={t('don.notesPh')}
              className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
            />
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 text-sm font-medium rounded-xl bg-parchment-200 dark:bg-ink-800 text-ink-700 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700 transition-colors">
              {t('don.cancel')}
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 text-sm font-semibold rounded-xl bg-church-800 hover:bg-church-900 text-parchment-50 transition-colors disabled:opacity-60">
              {saving ? t('don.saving') : t('don.add')}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  )
}

// SP-092: the cash-count list URL with the optional service-date range.
export function cashCountsUrl(from, to) {
  const q = new URLSearchParams()
  if (from) q.set('from', from)
  if (to) q.set('to', to)
  const qs = q.toString()
  return `/api/donations/cash-counts${qs ? `?${qs}` : ''}`
}

// R360-1: is a count inside the active service-date range (inclusive)?
export function cashCountInRange(session, { from, to }) {
  const d = String(session?.service_date || '').slice(0, 10)
  if (from && !(d >= from)) return false
  if (to && !(d <= to)) return false
  return true
}

// ── Cash Count History Row ─────────────────────────────────────
// How a count was verified, in words. 123 (José, 21 Oct): a single count is
// always labelled 'Single count, not verified'; counts confirmed before
// signed-in verification keep their typed names and say so.
export function cashCountVerificationLabel(session, t = enT) {
  if (session.status !== 'confirmed') return null
  if (session.verification === 'two_person') {
    return session.confirmed_by_name
      ? t('don.verifiedBy', { name: session.confirmed_by_name })
      : t('don.verifiedBySecond')
  }
  if (session.verification === 'single') return t('don.singleNotVerified')
  return t('don.typedNames')
}

// Category and method are stored as English tokens (data); only the
// on-screen word follows the language. Unknown tokens pass through.
export function catLabel(t, c) {
  const k = `don.cat.${c}`
  const s = t(k)
  return s === k ? c : s
}
export function methodLabel(t, m) {
  const k = `don.method.${m}`
  const s = t(k)
  return s === k ? m : s
}

function CashCountRow({ session, currentUserId, isAdmin, canWrite = true, voidRequest = null, onConfirm, onDelete, onVoid, onRequestVoid, onDecideRequest }) {
  const { t, dateLocale } = useLocale()
  const [confirming, setConfirming] = useState(false)
  const confirmed = session.status === 'confirmed'
  const voided = Boolean(session.voided_at)
  // Counts saved before 123 have no signed-in counter and keep the #357
  // typed second-counter field (R357-1/R357-2).
  const legacy = session.counted_by_user_id == null
  const mine = !legacy && currentUserId != null && Number(session.counted_by_user_id) === Number(currentUserId)

  const [verifier, setVerifier] = useState(session.verified_by || '')
  async function run(body) {
    setConfirming(true)
    await onConfirm(session.id, body)
    setConfirming(false)
  }

  const counters = legacy
    ? [session.counted_by, session.verified_by].filter(Boolean).join(' & ')
    : session.counted_by
  const label = cashCountVerificationLabel(session, t)

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      data-testid={`cash-count-${session.id}`}
      className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-2 sm:gap-4 px-4 sm:px-5 py-4 hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors group"
    >
      {/* Status icon */}
      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
        confirmed ? 'bg-brass-50 dark:bg-brass-900/25' : 'bg-amber-100 dark:bg-amber-900/30'
      }`}>
        {confirmed
          ? <CheckCircle2 size={16} aria-hidden="true" className="text-brass-700 dark:text-brass-300" />
          : <Clock size={16} aria-hidden="true" className="text-amber-600 dark:text-amber-400" />
        }
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span className="truncate min-w-0">{session.service_name}</span>
          {/* SP-092: status in words, not only the icon. */}
          {confirmed
            ? <span data-testid={`cash-count-status-${session.id}`} className="px-2 py-0.5 rounded-full text-xs font-semibold bg-brass-50 text-brass-800 dark:bg-brass-900/25 dark:text-brass-200">{t('don.confirmed')}</span>
            : <span data-testid={`cash-count-status-${session.id}`} className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">{t('don.pending')}</span>}
          {voided && <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-200">{t('don.voided')}</span>}
        </p>
        <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5 break-words">
          {fmtDate(session.service_date, dateLocale)} · {t('don.countedBy', { names: counters })}
          {label && <span className={`ml-1 ${session.verification === 'single' ? 'text-amber-700 dark:text-amber-400' : 'text-brass-700 dark:text-brass-300'}`}>· {label}</span>}
        </p>
        {voided && (
          <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
            {session.voided_by_name
              ? t('don.cc.voidedBy', { name: session.voided_by_name, reason: session.void_reason })
              : t('don.cc.voidedNoName', { reason: session.void_reason })}
          </p>
        )}
        {confirmed && !voided && voidRequest && (
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
            {voidRequest.requested_by_name
              ? t('don.cc.voidRequestedBy', { name: voidRequest.requested_by_name, reason: voidRequest.reason })
              : t('don.cc.voidRequestedNoName', { reason: voidRequest.reason })}
          </p>
        )}
        {!confirmed && legacy && (
          <label className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-600 dark:text-parchment-300">
            <span>{t('don.cc.secondCounter')}</span>
            <input value={verifier} onChange={e => setVerifier(e.target.value)} maxLength={200}
              aria-label={t('don.cc.secondCounterAria', { service: session.service_name })}
              placeholder={t('don.cc.secondPh')}
              className="min-w-0 max-w-full px-2 py-1 rounded-md border border-parchment-300 dark:border-ink-700 bg-white dark:bg-ink-900 text-ink-900 dark:text-parchment-50" />
          </label>
        )}
        {!confirmed && mine && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {t('don.cc.waiting')}
          </p>
        )}
      </div>

      {/* Category */}
      <span className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize hidden sm:inline-flex ${CATEGORY_STYLES[session.category] || CATEGORY_STYLES.other}`}>
        {session.category}
      </span>

      {/* Total */}
      <span className="text-sm font-semibold text-ink-900 dark:text-parchment-50 tabular-nums sm:w-20 text-right ml-auto sm:ml-0">
        {fmtCurrency(session.total, 2)}
      </span>

      {/* Actions */}
      {/* SP-092: always visible on phones (no hover); hover-revealed from sm up. */}
      <div className="flex flex-wrap items-center justify-end gap-1.5 w-full sm:w-auto sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
        {!confirmed && !mine && (
          <button onClick={() => run(legacy ? { verified_by: verifier.trim() } : {})} disabled={confirming}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-brass-700 hover:bg-brass-800 text-parchment-50 transition-colors disabled:opacity-60">
            {confirming ? '…' : t('don.confirm')}
          </button>
        )}
        {!confirmed && mine && (
          <button onClick={() => run({ single_count: true })} disabled={confirming}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-parchment-200 hover:bg-parchment-300 text-ink-700 dark:bg-ink-800 dark:text-parchment-200 transition-colors disabled:opacity-60">
            {confirming ? '…' : t('don.cc.postSingle')}
          </button>
        )}
        {/* 124: staff ask for a void; an admin who is not the requester decides. */}
        {confirmed && !voided && !isAdmin && canWrite && !voidRequest && (
          <button onClick={() => onRequestVoid(session)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-ink-600 hover:text-rose-600 hover:bg-rose-50 dark:text-parchment-200 dark:hover:bg-rose-900/20 transition-colors">
            {t('don.requestVoid')}
          </button>
        )}
        {confirmed && !voided && isAdmin && voidRequest && !(voidRequest && currentUserId != null && Number(voidRequest.requested_by_user_id) === Number(currentUserId)) && (
          <>
            <button onClick={() => onDecideRequest(voidRequest, 'approve')}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-brass-700 hover:bg-brass-800 text-parchment-50 transition-colors">
              {t('don.approveVoid')}
            </button>
            <button onClick={() => onDecideRequest(voidRequest, 'reject')}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-ink-600 hover:bg-parchment-200 dark:text-parchment-200 dark:hover:bg-ink-800 transition-colors">
              {t('don.reject')}
            </button>
          </>
        )}
        {confirmed && !voided && isAdmin && (
          <button onClick={() => onVoid(session)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-ink-600 hover:text-rose-600 hover:bg-rose-50 dark:text-parchment-200 dark:hover:bg-rose-900/20 transition-colors">
            {t('don.void')}
          </button>
        )}
        {/* SP-091: a confirmed count is posted to the ledger; the server refuses deleting it. */}
        {!confirmed && (
          <button onClick={() => onDelete(session.id)} aria-label={t('don.cc.delete')}
            className="p-1.5 rounded-lg text-ink-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-all">
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </motion.div>
  )
}

// ── Main Page ─────────────────────────────────────────────────
// Funds management drawer (GIV.3). The designations the public give
// page offers. Create/activate/delete here; online gifts record against
// the active ones. Shows whether giving is live or on the test stub.
function FundsDrawer({ onClose }) {
  const { t } = useLocale()
  const [funds, setFunds]       = useState([])
  const [fundsFailed, setFundsFailed] = useState(false)
  // Unknown until a read says so. Starting at 'stub' told a refused
  // drawer that online giving was in test mode.
  const [provider, setProvider] = useState(null)
  const [loading, setLoading]   = useState(true)
  const [name, setName]         = useState('')
  const [description, setDesc]  = useState('')
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState('')
  const toast = useToast()
  const ask = useConfirm()

  const loadGen = useRef(0)
  async function load() {
    // Latest-request guard (defensive; add is also blocked while loading).
    const gen = ++loadGen.current
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/funds'))
      if (gen !== loadGen.current) return
      // `{ funds: [] }` on a 500 painted "No funds yet" and, because
      // provider never arrived, the test-mode banner.
      if (!res.ok) throw new Error('unread')
      const d = await res.json()
      if (gen !== loadGen.current) return
      const list = d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.funds) ? d.funds : null
      if (!list) throw new Error('shape')
      setFunds(list)
      setFundsFailed(false)
      setProvider(typeof d.provider === 'string' ? d.provider : null)
    } catch {
      if (gen !== loadGen.current) return
      setFunds([])
      setFundsFailed(true)
      setProvider(null)
    } finally { if (gen === loadGen.current) setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function addFund(e) {
    e.preventDefault()
    // No write against an unread (or still loading) fund list: a new fund
    // could duplicate one that exists.
    if (!name.trim() || loading || fundsFailed) return
    setBusy(true); setError('')
    try {
      const res = await fetch(apiUrl('/api/funds'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || t('don.didntSave'))
      }
      setName(''); setDesc(''); await load()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  async function toggleActive(f) {
    try {
      const res = await fetch(apiUrl(`/api/funds/${f.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !f.active }),
      })
      if (!res.ok) throw new Error(`Failed (${res.status})`)
      setFunds(list => list.map(x => (x.id === f.id ? { ...x, active: !x.active } : x)))
    } catch (err) { toast.error(t('don.didntSave')) }
  }

  async function removeFund(f) {
    if (!(await ask({
      title: t('don.removeFundTitle', { name: f.name }),
      body: t('don.removeFundBody'),
      recoverable: true,
      confirmLabel: t('don.deleteFund'),
    }))) return
    try {
      const res = await fetch(apiUrl(`/api/funds/${f.id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(`Failed (${res.status})`)
      setFunds(list => list.filter(x => x.id !== f.id))
    } catch (err) { toast.error(t('don.didntDelete')) }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className={sheetOverlayCls}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div {...dialogMotionNow()}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
          <div className="flex items-center gap-2">
            <Landmark size={16} className="text-brass-600 dark:text-brass-300" />
            <h2 className="text-base font-semibold text-ink-900 dark:text-parchment-50">{t('don.givingFunds')}</h2>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {provider === 'stub' && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 px-3 py-2.5">
              <FlaskConical size={14} className="text-amber-600 dark:text-amber-300 shrink-0 mt-0.5" />
              <p className="text-[12px] text-amber-800 dark:text-amber-200 leading-snug">
                {t('don.onlineGivingIn')} <span className="font-semibold">{t('don.testMode')}</span> — {t('don.testModeBody')}
              </p>
            </div>
          )}

          <p className="text-xs text-ink-500 dark:text-parchment-300/70 leading-snug">
            {t('don.fundsHelp')}
          </p>

          {/* Add fund */}
          <form onSubmit={addFund} className="space-y-2 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 p-3">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('don.fundNamePh')}
              className="w-full px-3 py-2 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
            />
            <input
              value={description}
              onChange={e => setDesc(e.target.value)}
              placeholder={t('don.fundDescPh')}
              className="w-full px-3 py-2 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
            />
            {error && <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
            <button
              type="submit"
              disabled={busy || !name.trim() || loading || fundsFailed}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-church-800 hover:bg-church-900 text-parchment-50 transition-colors disabled:opacity-40"
            >
              <Plus size={13} /> {busy ? t('don.adding') : t('don.addFund')}
            </button>
          </form>

          {/* List */}
          {loading ? (
            <SkeletonRowList count={3} withAvatar={false} />
          ) : fundsFailed ? (
            <p role="status" className="text-xs text-amber-800 dark:text-amber-300 text-center py-4">
              {t('giv.fundsUnread')}
            </p>
          ) : funds.length === 0 ? (
            <p className="text-xs text-ink-500 dark:text-parchment-300/70 text-center py-4">
              {t('don.noFundsYet')}
            </p>
          ) : (
            <ul className="space-y-2">
              {funds.map(f => (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">{f.name}</span>
                      {!f.active && (
                        <span className="text-[11px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-parchment-200 dark:bg-ink-700 text-ink-500 dark:text-parchment-300/70">
                          {t('don.hidden')}
                        </span>
                      )}
                    </div>
                    {f.description && (
                      <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 truncate">{f.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => toggleActive(f)}
                      className="px-2 py-1 text-[11px] font-semibold rounded-md border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-parchment-200/70 dark:hover:bg-ink-700/70 transition-colors"
                    >
                      {f.active ? 'Hide' : 'Show'}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFund(f)}
                      aria-label={t('don.deleteFund')}
                      className="p-1.5 rounded-md text-ink-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

// R352-2: a usable side-read body. Plain object, not an array or null.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
// R352-2 (re-review): an entry is usable only when every field this page
// renders or acts on has the type it is used as. A text field rendered as
// a React child must be a string (or absent where optional); an id used
// by Confirm/Delete/Refund/Cancel must be usable; money must be numeric.
const isId = v => (Number.isInteger(v) && v > 0) || (typeof v === 'string' && v.trim() !== '')
const isText = v => typeof v === 'string'
const isOptText = v => v == null || typeof v === 'string'
// A gift count: a non-negative whole number, or pg's bigint-as-string.
const isCount = v => (Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d+$/.test(v))
// Summary tiles: absent (rendered as before) or numeric, never an object.
const SUMMARY_FIELDS = ['month_total', 'week_total', 'largest', 'donor_count']
const isMoney = v => (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
const ROW_SHAPES = {
  donation: { id: isId, donor_name: isText, amount: isMoney, category: isOptText, method: isOptText, date: isOptText, refunded_at: isOptText },
  cash: { id: isId, status: isText, service_name: isOptText, category: isOptText, counted_by: isOptText, verified_by: isOptText, service_date: isOptText, total: isMoney,
    verification: isOptText, confirmed_by_name: isOptText, voided_at: isOptText, voided_by_name: isOptText, void_reason: isOptText },
  fund: { category: isText, total: isMoney, count: isCount },
  recurring: { id: isId, donor_name: isOptText, amount: isMoney, frequency: isOptText, fund_name: isOptText, last_failed_at: isOptText, next_charge_date: isOptText, donor_email: isOptText },
}
const MARKERS = ['none', 'voided', 'refunded', 'partial']
function validBooks(b) {
  if (b == null) return true
  if (!isPlainObject(b)) return false
  return MARKERS.includes(b.marker)
    && isMoney(b.refunded_total)
    && isMoney(b.live_amount)
    && (b.void_reason == null || typeof b.void_reason === 'string')
    && (b.voided_by_name == null || typeof b.voided_by_name === 'string')
    && (b.voided_at == null || typeof b.voided_at === 'string')
    && typeof b.from_cash_count === 'boolean'
    && typeof b.statement_drift === 'boolean'
}
function validRow(kind, r) {
  if (!isPlainObject(r)) return false
  const shape = ROW_SHAPES[kind]
  if (!Object.keys(shape).every(k => shape[k](r[k]))) return false
  if (kind === 'donation' && !validBooks(r.books)) return false
  return true
}
// A list whose every entry fits its view, else null (failed). [] is empty.
function rowList(kind, v) {
  return Array.isArray(v) && v.every(r => validRow(kind, r)) ? v : null
}

function RefundMarkerDialog({ donation, onClose, onSubmit }) {
  const { t } = useLocale()
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const keyRef = useRef(globalThis.crypto?.randomUUID?.() ?? `refund-${Date.now()}`)
  const provider = providerRefundCopy(donation, t)
  const remaining = donation.books?.live_amount ?? donation.amount

  // SP-110 / R367-1: a real modal: focus in, Tab contained, Escape closes,
  // focus back to the opener.
  const panelRef = useRef(null)
  useDialogFocus(panelRef, onClose)

  async function submit(e) {
    e.preventDefault()
    if (!reason.trim()) {
      setError(t('don.reasonRequired'))
      return
    }
    if (amount.trim()) {
      const n = Number(amount)
      if (!Number.isFinite(n) || n <= 0) {
        setError(t('don.amountGtZero'))
        return
      }
    }
    setError('')
    setSaving(true)
    try {
      await onSubmit({ reason: reason.trim(), amount: amount.trim(), idempotency_key: keyRef.current })
    } catch (err) {
      setError(err.message || t('don.didntSaveGift'))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <button type="button" aria-label={t('don.close')} className={`${scrimCls} absolute inset-0`} onClick={onClose} />
      <form onSubmit={submit} ref={panelRef} tabIndex={-1}
        role="dialog" aria-modal="true" aria-labelledby="refund-dialog-title"
        className="relative w-full max-w-md bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm-lg p-5 space-y-4">
        <div>
          <h2 id="refund-dialog-title" className="font-display text-xl text-ink-900 dark:text-parchment-50">{t('don.refundThisGift')}</h2>
          <p className="mt-1 text-sm text-ink-600 dark:text-parchment-300">
            {donation.donor_name} · {fmtCurrency(donation.amount, 2)} stays in the log.
            Leave the amount blank to refund what remains ({fmtCurrency(remaining, 2)}).
          </p>
        </div>
        {provider && (
          <p className="text-sm text-ink-700 dark:text-parchment-200 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
            {provider}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</p>
        )}
        <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300">
          {t('don.amountLabel')}
          <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal"
            placeholder={String(remaining)}
            className="mt-1 w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400" />
        </label>
        <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300">
          {t('don.reasonLabel')}
          <textarea value={reason} onChange={e => setReason(e.target.value)} required rows={3}
            className="mt-1 w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-3 py-2 text-sm font-semibold rounded-lg text-ink-600 dark:text-parchment-200 hover:bg-parchment-200 dark:hover:bg-ink-800">
            {t('don.cancelBtn')}
          </button>
          <button type="submit" disabled={saving}
            className="px-3 py-2 text-sm font-semibold rounded-lg bg-church-800 hover:bg-church-900 text-parchment-50 disabled:opacity-50">
            {saving ? t('don.saving') : t('don.refundConfirm')}
          </button>
        </div>
      </form>
    </div>
  )
}

const isPosIntId = v => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) > 0
// R359-2: a pending void request row is usable only if every field the row reads is sound.
function isValidPendingVoidRequest(r) {
  return !!r && typeof r === 'object' && !Array.isArray(r)
    && isPosIntId(r.id) && isPosIntId(r.cash_count_id)
    && r.status === 'pending'
    && typeof r.reason === 'string' && r.reason.trim() !== ''
    && (r.requested_by_name == null || typeof r.requested_by_name === 'string')
    && (r.requested_by_user_id == null || isPosIntId(r.requested_by_user_id))
}

export default function Donations() {
  const { t, dateLocale } = useLocale()
  const [donations, setDonations]       = useState([])
  const [cashCounts, setCashCounts]     = useState([])
  const [voidRequests, setVoidRequests] = useState({})
  const [voidRequestsFailed, setVoidRequestsFailed] = useState(false)
  const [summary, setSummary]           = useState(null)
  const [summaryFailed, setSummaryFailed] = useState(false)
  const [funds, setFunds]               = useState([]) // giving-by-fund breakdown (GIV.4)
  const [recurring, setRecurring]       = useState([]) // active recurring gifts (GIV.7)
  // Gifts the charger gave up on after three attempts — an expired card,
  // almost always. The donor was told each time; this is the office finding
  // out. Kept separate from the active list because "who needs a word" is a
  // different question from "what is coming in".
  const [needsAttention, setNeedsAttention] = useState([])
  const [loading, setLoading]           = useState(true)
  // Which reads on the last load did not come back. A refused or failed
  // read used to leave these lists at [] — the log said "No donations yet",
  // the trend said "No giving data yet", and pending cash counts, recurring
  // gifts and the by-fund breakdown simply vanished, as though the parish
  // had none. FAILED is not ZERO, so each one is tracked and said.
  const [donationsFailed, setDonationsFailed] = useState(false)
  const [sideFailed, setSideFailed]     = useState([]) // section names that didn't load
  const [showDonationModal, setShowDonationModal] = useState(false)
  const { canWrite, user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const toast = useToast()
  const ask = useConfirm()
  const askFor = usePrompt()
  const [showCashCount, setShowCashCount]         = useState(false)
  // SP-092: cash-count date filter (service date, inclusive). Empty = all.
  const [ccFrom, setCcFrom] = useState('')
  const [ccTo, setCcTo]     = useState('')
  const ccFilterActive = Boolean(ccFrom || ccTo)
  // R360-1: one owner for the cash-count list. Every read that may replace
  // it (page load, refresh after an action, a date edit or clear, a save)
  // takes a new sequence; only the newest may write, so an older response
  // can never restore rows from another range or from before an action.
  // load() reads the range from this ref, never from a stale closure.
  const cashSeqRef = useRef(0)
  const ccRangeRef = useRef({ from: '', to: '' })
  ccRangeRef.current = { from: ccFrom, to: ccTo }
  // R360-2: the state of the CURRENT range's read. 'ok' is the only state
  // in which an empty list may be called empty.
  const [ccRead, setCcRead] = useState('loading') // loading | ok | failed | invalid
  useEffect(() => () => { cashSeqRef.current++ }, [])
  async function readCashCounts() {
    const cs = ++cashSeqRef.current
    const owns = () => cs === cashSeqRef.current
    const { from, to } = ccRangeRef.current
    if (from && to && from > to) { setCcRead('invalid'); return }
    setCcRead('loading')
    try {
      const res = await fetch(apiUrl(cashCountsUrl(from, to)))
      if (!owns()) return
      if (!res.ok) { setCcRead('failed'); return }
      const body = await res.json()
      if (!owns()) return
      const rows = rowList('cash', body)
      if (!rows) { setCcRead('failed'); return }
      setCashCounts(rows)
      setCcRead('ok')
    } catch {
      if (owns()) setCcRead('failed')
    }
  }
  const ccFilterFirst = useRef(true)
  useEffect(() => {
    if (ccFilterFirst.current) { ccFilterFirst.current = false; return }
    readCashCounts()
  }, [ccFrom, ccTo])
  const [showFunds, setShowFunds]                 = useState(false)
  const [filter, setFilter]             = useState('all')
  const [sortDesc, setSortDesc]         = useState(true)
  // ⌘K / global search lands here with ?id= so the gift that was found
  // stays identifiable — not a blind dump of the log. No new module.
  const [searchParams] = useSearchParams()
  const focusId = searchParams.get('id')
  const focusedRowRef = useRef(null)
  // Pagination (mirrors Clients). The donation log fetches a page at a
  // time; "Load more" appends the next page. `hasMore` is derived from
  // whether the last page came back full — a short page means the end.
  const [hasMore, setHasMore]           = useState(false)
  const [loadingMore, setLoadingMore]   = useState(false)
  // The last refund that landed inside an already-approved reporting period:
  // { submission_id, amount, message }. Held on the page, not only in a
  // toast — the approved totals and any bill drawn from them still include
  // the gift, and that is the one sentence here somebody has to actually read.
  const [refundNotice, setRefundNotice] = useState(null)
  const [refundTarget, setRefundTarget] = useState(null)
  // The notice sits at the top of the page and the person who triggered it
  // is scrolled to the row they just refunded — measured 738px above the
  // viewport at 1440, i.e. off-screen. Bring it to them when it appears.
  const refundNoticeRef = useRef(null)
  useEffect(() => {
    const el = refundNoticeRef.current
    if (refundNotice && el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [refundNotice])

  const PAGE_SIZE = 50

  // R352-3: only the newest load may write. A slower, older load (a
  // failure or a success) must not overwrite what a newer one showed.
  // Starting a load also retires any "Load more" still in flight, since
  // its page belongs to the list being replaced.
  const loadSeqRef = useRef(0)
  const voidReqSeqRef = useRef(0)
  useEffect(() => () => { voidReqSeqRef.current++ }, [])
  const pageSeqRef = useRef(0)
  const refreshingRef = useRef(false)
  const [refreshing, setRefreshing] = useState(false)

  async function load() {
    loadVoidRequests()
    const cashSeq = ++cashSeqRef.current
    const ownsCash = () => cashSeq === cashSeqRef.current
    const range = ccRangeRef.current
    if (range.from && range.to && range.from > range.to) setCcRead('invalid')
    else setCcRead('loading')
    const seq = ++loadSeqRef.current
    const current = () => seq === loadSeqRef.current
    pageSeqRef.current += 1
    setLoadingMore(false)
    // R352-3 (re-review): no page may start while the list is being
    // replaced — its offset would be the old list's length.
    refreshingRef.current = true
    setRefreshing(true)
    const failedSections = []
    const failList = () => {
      setDonations([]); setDonationsFailed(true); setHasMore(false)
    }
    try {
      const [dRes, sRes, ccRes, fRes, rgRes] = await Promise.all([
        // First page only — the list endpoint clamps to a safety cap, so
        // ask explicitly and page the rest in via "Load more".
        fetch(apiUrl(`/api/donations?limit=${PAGE_SIZE}&offset=0`)),
        fetch(apiUrl('/api/donations/summary')),
        fetch(apiUrl(cashCountsUrl(range.from, range.to))),
        fetch(apiUrl('/api/donations/by-fund?days=365')),
        fetch(apiUrl('/api/donations/recurring')),
      ])
      // Read every body before writing anything, so a stale load can be
      // dropped whole. An unreadable body is that section failing.
      const readJson = async (res) => {
        if (!res.ok) return { ok: false }
        try { return { ok: true, body: await res.json() } } catch { return { ok: false } }
      }
      const [d, sm, cc, fb, rg] = await Promise.all([dRes, sRes, ccRes, fRes, rgRes].map(readJson))
      if (!current()) return

      if (d.ok && rowList('donation', d.body)) {
        setDonations(d.body)
        setDonationsFailed(false)
        // A full page implies there may be more; a short page is the end.
        setHasMore(d.body.length === PAGE_SIZE)
      } else {
        failList()
      }
      // A 200 is not a shape. Observed 27 Aug: /api/donations/summary
      // answering 200 with an ARRAY made `summary` truthy-but-empty, so
      // `Number(summary.donor_count)` was NaN and the Unique Donors tile
      // rendered "NaN" to the parish. The four tiles below already render
      // "—" when `summary` is null, which is the honest answer — they just
      // never got the chance, because [] is truthy.
      const usableSummary = sm.ok && isPlainObject(sm.body)
        && SUMMARY_FIELDS.every(k => sm.body[k] == null || isMoney(sm.body[k]))
      setSummary(usableSummary ? sm.body : null)
      setSummaryFailed(!usableSummary)
      // R352-2: a 200 {} or a list with a null entry is failed, not empty.
      // A failed section shows no rows, never the previous load's rows.
      const cash = cc.ok ? rowList('cash', cc.body) : null
      // R360-1: cash-count failure is owned by ccRead (shown in its section),
      // so a stale cash read can neither publish nor leave a global warning.
      // R360-1: a date edit or a newer read since this load began owns the list.
      if (ownsCash() && !(range.from && range.to && range.from > range.to)) {
        if (cash) { setCashCounts(cash); setCcRead('ok') }
        else { setCashCounts([]); setCcRead('failed') }
      }
      const byFund = fb.ok && isPlainObject(fb.body) ? rowList('fund', fb.body.funds) : null
      if (byFund) setFunds(byFund)
      else { setFunds([]); failedSections.push('giving by fund') }
      const rec = rg.ok && isPlainObject(rg.body) ? rowList('recurring', rg.body.recurring) : null
      const attn = rg.ok && isPlainObject(rg.body) ? rowList('recurring', rg.body.needs_attention) : null
      if (rec && attn) { setRecurring(rec); setNeedsAttention(attn) }
      else {
        setRecurring([]); setNeedsAttention([])
        failedSections.push('recurring gifts')
      }
      setSideFailed(failedSections)
    } catch (err) {
      // A network error: nothing on this page can be vouched for, so every
      // section says it didn't load and none keeps the previous load's rows.
      if (!current()) return
      console.error(err)
      failList()
      setSummary(null)
      setSummaryFailed(true)
      if (ownsCash()) { setCashCounts([]); setCcRead('failed') }
      setFunds([]); setRecurring([]); setNeedsAttention([])
      setSideFailed(['giving by fund', 'recurring gifts'])
    } finally {
      if (current()) {
        setLoading(false)
        refreshingRef.current = false
        setRefreshing(false)
      }
    }
  }

  useEffect(() => { load() }, [])

  // Fetch the next page and APPEND (so the 30-day giving trend, which
  // derives from the fetched donations, keeps everything it already has).
  // Offset is the current row count so it stays correct across pages.
  async function loadMoreDonations() {
    if (loadingMore || refreshingRef.current) return
    const pageSeq = pageSeqRef.current
    setLoadingMore(true)
    try {
      const res = await fetch(apiUrl(`/api/donations?limit=${PAGE_SIZE}&offset=${donations.length}`))
      if (!res.ok) throw new Error(`donations page ${res.status}`)
      const rows = await res.json()
      if (!rowList('donation', rows)) throw new Error('donations page: malformed')
      // A reload replaced the list while this page was in flight.
      if (pageSeq !== pageSeqRef.current) return
      setDonations(prev => [...prev, ...rows])
      setHasMore(rows.length === PAGE_SIZE)
    } catch (err) {
      if (pageSeq !== pageSeqRef.current) return
      // Used to return quietly, so the button just stopped doing anything
      // and the log looked complete.
      console.error(err)
      toast.error(t('don.nextPageFailed'))
    } finally {
      if (pageSeq === pageSeqRef.current) setLoadingMore(false)
    }
  }

  async function deleteDonation(id) {
    if (!(await ask({
      title: t('don.removeGiftTitle'),
      body: t('don.removeGiftBody'),
      confirmLabel: t('don.removeGiftConfirm'),
      recoverable: true,
    }))) return
    const res = await fetch(apiUrl(`/api/donations/${id}`), { method: 'DELETE' })
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || t('don.didntDelete'))
      return
    }
    setDonations(prev => prev.filter(d => d.id !== id))
    load()
  }

  function noteMarker(id, data) {
    if (data.period_adjustment) {
      setRefundNotice({ ...data.period_adjustment, donation_id: id })
      toast.info(t('don.recordedPeriodSent'), { duration: 8000 })
    }
    if (data.issued_statements?.length) {
      const first = data.issued_statements[0]
      toast.info(
        t('don.statementUnchanged', { no: first.statement_no }),
        { duration: 8000 },
      )
    }
  }

  async function voidDonation(d) {
    const provider = providerRefundCopy(d, t)
    const reason = await askFor({
      title: t('don.voidNamedTitle', { name: d.donor_name }),
      body: `${provider ? provider + ' ' : ''}${t('don.voidBody')}`,
      inputLabel: t('don.reasonLabel'),
      required: true,
      tone: 'destructive',
      confirmLabel: t('don.voidConfirm'),
    })
    if (reason === null) return
    const res = await fetch(apiUrl(`/api/donations/${d.id}/void`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason,
        idempotency_key: globalThis.crypto?.randomUUID?.() ?? `void-${d.id}-${Date.now()}`,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.error || t('don.didntVoidGift'))
      return
    }
    noteMarker(d.id, data)
    if (!data.period_adjustment) toast.success(data.replayed ? t('don.giftAlreadyVoided') : t('don.giftVoided'))
    load()
  }

  async function recordRefund(d, { reason, amount, idempotency_key }) {
    const res = await fetch(apiUrl(`/api/donations/${d.id}/record-refund`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason,
        idempotency_key,
        ...(amount ? { amount } : {}),
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data.error || t('don.didntSaveGift'))
    }
    setRefundTarget(null)
    noteMarker(d.id, data)
    if (!data.period_adjustment) toast.success(data.replayed ? t('don.refundAlreadyRecorded') : t('don.refundRecorded'))
    load()
  }

  async function cancelRecurring(id) {
    if (!(await ask({
      title: t('don.cancelRecurringTitle'),
      body: t('don.cancelRecurringBody'),
      confirmLabel: t('don.cancelRecurringConfirm'),
    }))) return
    const res = await fetch(apiUrl(`/api/donations/recurring/${id}/cancel`), { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || t('don.didntSave'))
      return
    }
    // Both lists, because the same button clears a paused gift from the
    // "stopped" card. Filtering only `recurring` left the amber row and its
    // count on screen after a successful cancel, and a second click then
    // 404'd into "that didn't save" on an operation that had already worked.
    setRecurring(prev => prev.filter(r => r.id !== id))
    setNeedsAttention(prev => prev.filter(r => String(r.id) !== String(id)))
    toast.success(t('don.recurringCancelled'))
  }

  async function confirmCashCount(id, body) {
    // Legacy rows send their typed field explicitly, even when cleared
    // (R357-2); signed-in rows send {} or { single_count: true } (123).
    if (body?.single_count && !(await ask({
      title: t('don.cc.singleTitle'),
      body: t('don.cc.singleBody'),
      confirmLabel: t('don.cc.singleConfirm'),
    }))) return
    const res = await fetch(apiUrl(`/api/donations/cash-counts/${id}/confirm`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || t('don.didntSave'))
      return
    }
    load()
  }

  // 123: admin-only reasoned void. The count and its gift are kept; the
  // server posts a linked reversing entry.
  async function voidCashCount(session) {
    const reason = await askFor({
      title: t('don.cc.voidTitle', { service: session.service_name }),
      body: t('don.cc.voidBody'),
      inputLabel: t('don.reasonLabel'),
      required: true,
      tone: 'destructive',
      confirmLabel: t('don.cc.voidConfirm'),
    })
    if (reason === null) return
    const res = await fetch(apiUrl(`/api/donations/cash-counts/${session.id}/void`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || t('don.didntVoid'))
      return
    }
    load()
  }

  // 124: pending void requests, keyed by count. Loaded on its own so a
  // failure here never blanks the cash-count list. A failed read keeps the
  // last known requests and says so (voidRequestsFailed) rather than
  // presenting "no requests".
  // R359-1: latest-read ownership. Every call takes a new sequence; only the
  // newest may write (success or failure). Unmount retires all reads.
  // R359-2: the whole list is validated before it replaces state; any bad
  // row keeps the last good list and shows the read-failure warning.
  async function loadVoidRequests() {
    const seq = ++voidReqSeqRef.current
    const current = () => voidReqSeqRef.current === seq
    try {
      const res = await fetch(apiUrl('/api/donations/cash-counts/void-requests?status=pending'))
      if (!res.ok) throw new Error('void requests')
      const body = await res.json()
      if (!current()) return
      if (!Array.isArray(body) || !body.every(isValidPendingVoidRequest)) throw new Error('void requests shape')
      const map = Object.fromEntries(body.map(r => [String(r.cash_count_id), r]))
      if (Object.keys(map).length !== body.length) throw new Error('void requests duplicate')
      setVoidRequests(map)
      setVoidRequestsFailed(false)
    } catch {
      if (!current()) return
      setVoidRequestsFailed(true)
    }
  }

  async function requestCashCountVoid(session) {
    const reason = await askFor({
      title: t('don.cc.requestTitle', { service: session.service_name }),
      body: t('don.cc.requestBody'),
      inputLabel: t('don.reasonLabel'),
      required: true,
      confirmLabel: t('don.cc.requestConfirm'),
    })
    if (reason === null) return
    const res = await fetch(apiUrl(`/api/donations/cash-counts/${session.id}/void-requests`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || t('don.didntSend'))
      return
    }
    toast.success(t('don.voidRequested'))
    loadVoidRequests()
  }

  async function decideVoidRequest(vr, decision) {
    let body = {}
    if (decision === 'approve') {
      if (!(await ask({
        title: t('don.cc.approveTitle'),
        body: t('don.cc.approveBody', { reason: vr.reason }),
        confirmLabel: t('don.cc.approveConfirm'),
      }))) return
    } else {
      const note = await askFor({
        title: t('don.cc.rejectTitle'),
        body: t('don.cc.rejectBody'),
        inputLabel: t('don.cc.noteLabel'),
        tone: 'neutral',
        confirmLabel: t('don.cc.rejectConfirm'),
      })
      if (note === null) return
      body = note.trim() ? { note } : {}
    }
    const res = await fetch(apiUrl(`/api/donations/cash-counts/void-requests/${vr.id}/${decision}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || t('don.didntSaveChanged'))
    }
    load()
  }

  async function deleteCashCount(id) {
    if (!(await ask({ title: t('don.cc.deleteTitle'), confirmLabel: t('don.cc.deleteConfirm') }))) return
    const res = await fetch(apiUrl(`/api/donations/cash-counts/${id}`), { method: 'DELETE' })
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || t('don.didntDelete'))
      return
    }
    setCashCounts(prev => prev.filter(c => c.id !== id))
  }

  function handleDonationSave(donation) {
    setDonations(prev => [donation, ...prev])
    setShowDonationModal(false)
    load()
  }

  // R360-1: a saved count joins the list only if it is inside the active
  // range; then the current range is read again so the list is the server's.
  function handleCashCountSaved(session) {
    if (cashCountInRange(session, ccRangeRef.current)) setCashCounts(prev => [session, ...prev])
    setShowCashCount(false)
    readCashCounts()
  }

  const filtered = useMemo(() => {
    const rows = filter === 'all' ? donations : donations.filter(d => d.category === filter)
    const ordered = sortDesc ? rows : [...rows].reverse()
    if (!focusId) return ordered
    const idx = ordered.findIndex(d => String(d.id) === String(focusId))
    if (idx <= 0) return ordered
    return [ordered[idx], ...ordered.slice(0, idx), ...ordered.slice(idx + 1)]
  }, [donations, filter, sortDesc, focusId])

  useEffect(() => {
    const el = focusedRowRef.current
    if (focusId && el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [focusId, filtered])

  // Giving trend, derived from the real donations already on the page —
  // no fabricated numbers. Empty until at least one real gift lands in
  // the last 30 days, in which case we show an empty state, not a chart.
  const chartData = useMemo(() => buildTrendFromDonations(donations), [donations])

  // R360-1: the cash entry in the page notice comes only from the current
  // cash read's state, so a stale failure cannot publish it and a later
  // successful read clears it. Other sections keep their own entries.
  const shownSideFailed = ccRead === 'failed' ? ['cash count sessions', ...sideFailed] : sideFailed
  const pendingCounts = cashCounts.filter(c => c.status === 'pending').length

  return (
    <PageWrapper type="list">
      {/* A refund that landed inside an approved reporting period. The gift is
          out of the live totals and still inside the frozen ones — saying only
          "Gift refunded" would let the parish believe the diocesan figures and
          the bill had moved with it. They have not. */}
      {refundNotice && (
        <div
          ref={refundNoticeRef}
          role="status"
          className="mb-4 rounded-2xl border border-brass-300/60 dark:border-brass-800/40 bg-brass-50 dark:bg-brass-900/20 px-5 py-4 text-[13px] leading-relaxed text-ink-800 dark:text-parchment-100"
        >
          <p className="font-medium">
            Refunded — but this {fmtCurrency(refundNotice.amount, 2)} gift is inside an approved reporting period.
          </p>
          <p className="mt-1.5 text-ink-600 dark:text-parchment-300/80">{refundNotice.message}</p>
          <p className="mt-1.5 text-ink-600 dark:text-parchment-300/80">
            {t('don.unresolvedOf')} <span className="font-semibold">{fmtCurrency(refundNotice.amount, 2)}</span> {t('don.unresolvedUntil')}
          </p>
          <button
            onClick={() => setRefundNotice(null)}
            className="mt-2 text-[12px] font-medium text-brass-700 dark:text-brass-300 hover:underline"
          >
            {t('don.dismiss')}
          </button>
        </div>
      )}

      {/* Header */}
      <motion.div variants={itemVariants} className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <PageHeader title={t('don.title')} subtitle={t('don.subtitle')} />
        <div className="flex items-center gap-2 flex-wrap">
          {/* Admin-only entry point to year-end giving statements.
              Lives here rather than the sidebar — bookkeepers already
              work out of the Donations page, and this keeps it
              proximate to the source data. The destination page also
              gates via requireRole('admin') server-side. */}
          {isAdmin && (
            <Link
              to="/donations/statements"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-parchment-100 dark:hover:bg-ink-800/70 transition-colors"
            >
              <FileText size={16} />
              {t('don.yearEnd')}
            </Link>
          )}
          {/* Audit trail for the giving records (AUD.5) — admin-only,
              scoped to every donation create/refund/delete. The honest
              answer to "who touched our books?". */}
          {isAdmin && (
            <Link
              to="/audit?entity_type=donation"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-parchment-100 dark:hover:bg-ink-800/70 transition-colors"
              title={t('don.historyTitle')}
            >
              <History size={16} />
              {t('don.history')}
            </Link>
          )}
        {canWrite && (
          <>
          <motion.button
            onClick={() => setShowFunds(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-parchment-100 dark:hover:bg-ink-800/70 transition-colors"
          >
            <Landmark size={16} />
            {t('don.funds')}
          </motion.button>
          <motion.button
            onClick={() => setShowCashCount(true)}
            className="relative flex items-center gap-2 px-4 py-2.5 bg-brass-700 hover:bg-brass-800 text-parchment-50 text-sm font-semibold rounded-xl shadow-sm transition-colors"
          >
            <Banknote size={16} />
            {t('don.cashCount')}
            {pendingCounts > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-amber-400 text-amber-900 text-[11px] font-bold rounded-full flex items-center justify-center">
                {pendingCounts}
              </span>
            )}
          </motion.button>
          <motion.button
            onClick={() => setShowDonationModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-church-800 hover:bg-church-900 text-parchment-50 text-sm font-semibold rounded-xl shadow-sm transition-colors"
          >
            <Plus size={16} />
            {t('don.add')}
          </motion.button>
          </>
        )}
        </div>
      </motion.div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SummaryCard icon={DollarSign} label={t('don.sum.month')}    value={summary ? fmtCurrency(summary.month_total) : '—'} sub={t('don.sum.monthSub')}     accent="violet" />
        <SummaryCard icon={TrendingUp} label={t('don.sum.week')}     value={summary ? fmtCurrency(summary.week_total) : '—'} sub={t('don.sum.weekSub')} accent="indigo" />
        <SummaryCard icon={Award}      label={t('don.sum.largest')}  value={summary ? fmtCurrency(summary.largest)     : '—'} sub={t('don.sum.largestSub')}     accent="amber"  />
        <SummaryCard icon={Users}      label={t('don.sum.donors')} value={summary ? Number(summary.donor_count)      : '—'} sub={t('don.sum.donorsSub')}            accent="emerald"/>
      </div>
      {shownSideFailed.length > 0 && !loading && (
        <p role="status" className="mb-6 text-xs text-amber-700 dark:text-amber-400">
          {t('don.sidesFailed', { sides: shownSideFailed.map(s => (
            s === 'cash count sessions' ? t('don.side.cashCounts')
              : s === 'giving by fund' ? t('don.side.byFund')
                : s === 'recurring gifts' ? t('don.side.recurring')
                  : s
          )).join(', ') })}
          <button onClick={() => load()} className="ml-2 font-semibold underline">{t('don.tryAgain')}</button>
        </p>
      )}
      {summaryFailed && (
        <p role="status" className="-mt-4 mb-6 text-xs text-amber-700 dark:text-amber-400">
          {t('don.totalsFailed')}
        </p>
      )}
      <div className="hidden">
      </div>

      {/* Chart */}
      <motion.div variants={itemVariants}
        className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 p-5 mb-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('don.trends')}</h2>
          <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('don.last30')}</p>
        </div>
        {donationsFailed ? (
          <div className="h-[200px] flex flex-col items-center justify-center text-center px-6">
            <TrendingUp size={22} className="text-ink-300 dark:text-parchment-400/50 mb-2" />
            <p role="status" className="text-sm font-medium text-amber-700 dark:text-amber-400">{t('don.trendsFailedTitle')}</p>
            <p className="text-xs text-ink-400 dark:text-parchment-300/70 mt-0.5">{t('don.trendsFailedBody')}</p>
          </div>
        ) : chartData.length === 0 ? (
          // No real giving in the last 30 days — a quiet empty state
          // rather than a fabricated line. Real gifts populate this.
          <div className="h-[200px] flex flex-col items-center justify-center text-center px-6">
            <TrendingUp size={22} className="text-ink-300 dark:text-parchment-400/50 mb-2" />
            <p className="text-sm font-medium text-ink-500 dark:text-parchment-300/70">{t('don.noTrend')}</p>
            <p className="text-xs text-ink-400 dark:text-parchment-300/70 mt-0.5">{t('don.noTrendSub')}</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="donationGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#9F8240" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#9F8240" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-parchment-300/70 dark:text-ink-800" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'currentColor' }} className="text-ink-500 dark:text-parchment-300/70" tickLine={false} axisLine={false} interval={4} />
              <YAxis tick={{ fontSize: 11, fill: 'currentColor' }} className="text-ink-500 dark:text-parchment-300/70" tickLine={false} axisLine={false} tickFormatter={v => `$${v >= 1000 ? (v/1000).toFixed(1)+'k' : v}`} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="total" stroke="#7B2D26" strokeWidth={2} fill="url(#donationGrad)" dot={false} activeDot={{ r: 4, fill: '#7B2D26' }} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </motion.div>

      {/* Giving by fund (GIV.4) — per-fund totals + share of the last
          12 months. Online gifts land here under their fund name. */}
      {funds.length > 0 && (
        <motion.div variants={itemVariants}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 p-5 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Landmark size={15} className="text-brass-600 dark:text-brass-300" />
            <div>
              <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('don.byFund')}</h2>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('don.last12')}</p>
            </div>
          </div>
          <div className="space-y-3">
            {(() => {
              const total = funds.reduce((s, f) => s + Number(f.total), 0) || 1
              return funds.map(f => {
                const pct = Math.round((Number(f.total) / total) * 100)
                return (
                  <div key={f.category}>
                    <div className="flex items-center justify-between text-sm mb-1 gap-3">
                      <span className="font-medium text-ink-800 dark:text-parchment-100 capitalize truncate">{catLabel(t, f.category)}</span>
                      <span className="tabular-nums font-semibold text-ink-900 dark:text-parchment-50 shrink-0">
                        {fmtCurrency(Number(f.total), 2)}
                        <span className="text-ink-500 dark:text-parchment-300/60 font-normal"> · {pct}%</span>
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-parchment-200 dark:bg-ink-800 overflow-hidden">
                      <div className="h-full rounded-full bg-brass-500" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 mt-0.5">
                      {t(Number(f.count) === 1 ? 'don.giftOne' : 'don.giftMany', { n: Number(f.count) })}
                    </p>
                  </div>
                )
              })
            })()}
          </div>
        </motion.div>
      )}

      {/* Recurring gifts that stopped. Deliberately ABOVE the active list and
          deliberately quiet — amber, not red. Nobody did anything wrong; a
          card expired. The copy is written to prompt a conversation, not to
          open a collections task. */}
      {needsAttention.length > 0 && (
        <motion.div variants={itemVariants}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-amber-300/70 dark:border-amber-700/40 p-5 mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Repeat size={15} className="text-amber-700 dark:text-amber-400" />
            <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('don.recurringStopped')}</h2>
            <span className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70">({needsAttention.length})</span>
          </div>
          <p className="text-xs text-ink-600 dark:text-parchment-300/80 mb-4">
            {t('don.recurringTried')}
          </p>
          {!isAdmin && (
            <p data-testid="recurring-admin-only-note" className="text-xs text-ink-500 dark:text-parchment-300/70 mb-3">
              {t('don.onlyAdminCancelRecurring')}
            </p>
          )}
          <div className="space-y-2">
            {needsAttention.map(r => (
              <div key={r.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">
                    {r.donor_name}
                    <span className="text-ink-500 dark:text-parchment-300/70 font-normal"> · {fmtCurrency(r.amount, 2)} {r.frequency}</span>
                  </p>
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">
                    {r.fund_name || 'General'}
                    {r.last_failed_at ? ` · stopped ${fmtDate(r.last_failed_at)}` : ''}
                    {r.donor_email ? ` · ${r.donor_email}` : ''}
                  </p>
                </div>
{isAdmin && (
                <button
                  type="button"
                  onClick={() => cancelRecurring(r.id)}
                  className="shrink-0 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:text-church-800 dark:hover:text-brass-200 transition-colors"
                >
                  {t('don.clear')}
                </button>
                )}
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Recurring gifts (GIV.7) — active recurring schedules; cancel
          stops future charges. */}
      {recurring.length > 0 && (
        <motion.div variants={itemVariants}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 p-5 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Repeat size={15} className="text-brass-600 dark:text-brass-300" />
            <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('don.recurringGifts')}</h2>
            <span className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70">({recurring.length})</span>
          </div>
          {!isAdmin && (
            <p data-testid="recurring-admin-only-note" className="text-xs text-ink-500 dark:text-parchment-300/70 mb-3">
              {t('don.onlyAdminCancelRecurring')}
            </p>
          )}
          <div className="space-y-2">
            {recurring.map(r => (
              <div key={r.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">
                    {r.donor_name}
                    <span className="text-ink-500 dark:text-parchment-300/70 font-normal"> · {fmtCurrency(r.amount, 2)} {r.frequency}</span>
                  </p>
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">
                    {r.fund_name || 'General'} · next {fmtDate(r.next_charge_date)}
                  </p>
                </div>
{isAdmin && (
                <button
                  type="button"
                  onClick={() => cancelRecurring(r.id)}
                  className="shrink-0 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:text-rose-700 dark:hover:text-rose-300 transition-colors"
                >
                  {t('don.cancel')}
                </button>
                )}
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Cash Count History */}
      {(cashCounts.length > 0 || ccFilterActive || ccRead === 'failed' || ccRead === 'invalid' || (ccRead === 'loading' && !loading)) && (
        <motion.div variants={itemVariants}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 overflow-hidden mb-6">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 sm:px-5 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('don.ccSessions')}</h2>
              {pendingCounts > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  {t('don.nPending', { n: pendingCounts })}
                </span>
              )}
            </div>
            <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('don.ccConfirmHint')}</p>
            {voidRequestsFailed && (
              <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
                {t('don.voidRequestsFailed')}
                <button onClick={() => loadVoidRequests()} className="ml-1 font-semibold underline">{t('don.tryAgain')}</button>
              </p>
            )}
          </div>
          {/* SP-092: service-date filter, applied by the server for this parish. */}
          <div className="flex flex-wrap items-end gap-3 px-4 sm:px-5 py-3 border-b border-parchment-300/60 dark:border-brass-900/30">
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-600 dark:text-parchment-300">
              {t('don.from')}
              <input type="date" value={ccFrom} max={ccTo || undefined} onChange={e => setCcFrom(e.target.value)}
                aria-label={t('don.ccFromAria')}
                className="px-2 py-1.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-600 dark:text-parchment-300">
              {t('don.to')}
              <input type="date" value={ccTo} min={ccFrom || undefined} onChange={e => setCcTo(e.target.value)}
                aria-label={t('don.ccToAria')}
                className="px-2 py-1.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50" />
            </label>
            {ccFilterActive && (
              <button onClick={() => { setCcFrom(''); setCcTo('') }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-ink-600 hover:bg-parchment-200 dark:text-parchment-200 dark:hover:bg-ink-800 transition-colors">
                {t('don.clearDates')}
              </button>
            )}
          </div>
          {ccRead === 'invalid' && (
            <p role="status" className="px-4 sm:px-5 py-3 text-xs text-amber-700 dark:text-amber-400">{t('don.dateRangeHint')}</p>
          )}
          {ccRead === 'loading' && (
            <p role="status" data-testid="cash-counts-loading" className="px-4 sm:px-5 py-3 text-xs text-ink-500 dark:text-parchment-300/70">Loading cash counts{ccFilterActive ? ' for these dates' : ''}…</p>
          )}
          {ccRead === 'failed' && (
            <p role="status" data-testid="cash-counts-failed" className="px-4 sm:px-5 py-3 text-xs text-amber-700 dark:text-amber-400">
              Cash counts didn't load{ccFilterActive ? ' for these dates' : ''}.{cashCounts.length > 0 ? ' The rows below are from an earlier read and may not match.' : ''}
              <button onClick={() => readCashCounts()} className="ml-1 font-semibold underline">{t('don.tryAgain')}</button>
            </p>
          )}
          {ccRead === 'ok' && ccFilterActive && cashCounts.length === 0 && (
            <p className="px-4 sm:px-5 py-4 text-sm text-ink-500 dark:text-parchment-300/70">{t('don.noCc')}</p>
          )}
          <div data-testid="cash-count-list" aria-busy={ccRead === 'loading'}
            className={ccRead === 'ok' ? '' : 'opacity-60'}>
          <AnimatePresence initial={false}>
            {cashCounts.map(s => (
              <CashCountRow key={s.id} session={s}
                currentUserId={user?.id} isAdmin={user?.role === 'admin'}
                canWrite={canWrite} voidRequest={voidRequests[String(s.id)] || null}
                onConfirm={confirmCashCount} onDelete={deleteCashCount} onVoid={voidCashCount}
                onRequestVoid={requestCashCountVoid} onDecideRequest={decideVoidRequest} />
            ))}
          </AnimatePresence>
          </div>
        </motion.div>
      )}

      {/* Donations Table */}
      <motion.div variants={itemVariants}
        className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/60 dark:border-brass-900/30 gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
            {t('don.log')}
            <span className="ml-2 text-xs font-normal text-ink-500 dark:text-parchment-300/70">{donationsFailed ? t('don.recordsUnknown') : t('don.records', { n: filtered.length })}</span>
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            {['all', ...CATEGORIES].map(c => (
              <button key={c} onClick={() => setFilter(c)} data-filter={c}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                  filter === c ? 'bg-church-800 text-parchment-50' : 'bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700'
                }`}>{c === 'all' ? t('don.filterAll') : catLabel(t, c)}</button>
            ))}
          </div>
        </div>
        {!isAdmin && !loading && !donationsFailed && donations.length > 0 && (
          <p data-testid="donations-admin-only-note" className="px-4 sm:px-5 py-2 text-xs text-ink-500 dark:text-parchment-300/70">
            {t('don.adminOnly')}
          </p>
        )}

        {loading ? (
          <SkeletonRowList count={6} withAvatar={false} />
        ) : donationsFailed ? (
          <div className="p-12 text-center" role="status">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">{t('don.logFailedTitle')}</p>
            <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-1">{t('don.logFailedBody')}</p>
            <button onClick={() => load()} className="mt-2 text-xs font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors">
              {t('don.tryAgain')}
            </button>
          </div>
        ) : donations.length === 0 ? (
          // Truly empty — no donations at all in the org. Warm card with
          // a primary CTA only when the caller can actually act on it.
          <div className="p-6">
            <EmptyState
              illustration={DonationsIllustration}
              title={t('don.emptyTitle')}
              body={t('don.emptyTrackBody')}
              action={canWrite ? { label: t('don.emptyLog'), onClick: () => setShowDonationModal(true) } : null}
              secondary={canWrite ? { label: t('don.emptyCc'), onClick: () => setShowCashCount(true) } : null}
            />
          </div>
        ) : filtered.length === 0 ? (
          // Filter narrowed everything away — minimalist text, no big card.
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-ink-500 dark:text-parchment-300/70">{t('don.noMatch')}</p>
            <button onClick={() => setFilter('all')} className="mt-2 text-xs font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors">
              {t('don.showAll')}
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-500 dark:text-parchment-300/70 bg-parchment-100 dark:bg-ink-800/60">
                  <th className="px-5 py-3 font-medium">{t('don.donor')}</th>
                  <th className="px-5 py-3 font-medium">{t('don.amount')}</th>
                  <th className="px-5 py-3 font-medium">{t('don.category')}</th>
                  <th className="px-5 py-3 font-medium">{t('don.method')}</th>
                  <th className="px-5 py-3 font-medium cursor-pointer select-none" onClick={() => setSortDesc(p => !p)}>
                    <span className="flex items-center gap-1">
                      {t('don.date')} <ChevronDown size={12} className={`transition-transform ${sortDesc ? '' : 'rotate-180'}`} />
                    </span>
                  </th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment-200/60 dark:divide-white/[0.04]">
                <AnimatePresence initial={false}>
                  {filtered.map(d => {
                    const focused = focusId && String(d.id) === String(focusId)
                    return (
                    <motion.tr key={d.id}
                      ref={focused ? focusedRowRef : undefined}
                      data-testid={focused ? 'focused-gift' : undefined}
                      aria-current={focused ? 'true' : undefined}
                      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                      className={`${focused
                        ? 'bg-brass-50 dark:bg-brass-900/20 ring-1 ring-inset ring-brass-400'
                        : 'hover:bg-parchment-100 dark:hover:bg-ink-800/60'
                      } transition-colors group`}>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-full bg-church-50 dark:bg-church-900/40 flex items-center justify-center text-church-800 dark:text-brass-200 text-xs font-bold flex-shrink-0">
                            {d.donor_name.charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-ink-900 dark:text-parchment-50">{d.donor_name}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        {(() => {
                          const marker = d.books?.marker
                          const struck = marker === 'voided' || marker === 'refunded' || (!d.books && d.refunded_at)
                          const provider = (marker && marker !== 'none') ? providerRefundCopy(d, t) : null
                          return (
                            <>
                              <span className={`font-semibold ${struck ? 'text-ink-400 dark:text-parchment-300/70 line-through' : 'text-ink-900 dark:text-parchment-50'}`}>{fmtCurrency(d.amount, 2)}</span>
                              {(marker === 'refunded' || (!d.books && d.refunded_at)) && (
                                <span data-testid={`gift-marker-${d.id}`} className="ml-2 px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">{t('don.refunded')}</span>
                              )}
                              {marker === 'voided' && (
                                <span data-testid={`gift-marker-${d.id}`} className="ml-2 px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-200">{t('don.voided')}</span>
                              )}
                              {marker === 'partial' && (
                                <span data-testid={`gift-marker-${d.id}`} className="ml-2 px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                                  {t('don.partial')} · {fmtCurrency(d.books.refunded_total, 2)}
                                </span>
                              )}
                              {marker === 'voided' && (
                                <span className="block mt-1 text-[11px] font-normal leading-snug text-ink-500 dark:text-parchment-300/70 max-w-[22rem]">
                                  {d.books.voided_by_name ? t('don.voidedBy', { name: d.books.voided_by_name }) : t('don.voided')}{d.books.void_reason ? `: ${d.books.void_reason}` : ''}. {t('don.voidNote')}
                                </span>
                              )}
                              {marker === 'partial' && (
                                <span className="block mt-1 text-[11px] font-normal leading-snug text-ink-500 dark:text-parchment-300/70">
                                  {t('don.stillInTotals', { amount: fmtCurrency(d.books.live_amount, 2) })}
                                </span>
                              )}
                              {provider && (
                                <span className="block mt-1 text-[11px] font-normal leading-snug text-amber-800 dark:text-amber-300 max-w-[22rem]">{provider}</span>
                              )}
                              {d.books?.statement_drift && (
                                <span data-testid={`statement-flag-${d.id}`} className="block mt-1 text-[11px] font-normal leading-snug text-rose-700 dark:text-rose-300 max-w-[22rem]">
                                  {t('don.statementDrift')}
                                </span>
                              )}
                            </>
                          )
                        })()}
                        {/* The same condition as the page-top notice, on the
                            row the person is looking at. Distinct from the
                            Refunded badge: that one is done; this one is not. */}
                        {refundNotice && String(refundNotice.donation_id) === String(d.id) && (
                          <span role="note" data-testid={`refund-adjustment-${d.id}`}
                            className="block mt-1 text-[11px] font-normal leading-snug text-rose-700 dark:text-rose-300 max-w-[20rem]">
                            <span className="font-semibold">{t('don.unresolvedAdj')}</span>
                            {' · '}{fmtCurrency(refundNotice.amount, 2)} — this gift is still counted in the approved period's total
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize ${CATEGORY_STYLES[d.category] || CATEGORY_STYLES.other}`}>
                          {catLabel(t, d.category)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize ${METHOD_STYLES[d.method] || ''}`}>
                          {methodLabel(t, d.method)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-ink-500 dark:text-parchment-300/70">{fmtDate(d.date, dateLocale)}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-1 justify-end">
                          {canMarkGift(user, d) && (
                            <>
                              <button onClick={() => voidDonation(d)} title={t('don.voidGift')} aria-label={t('don.voidGift')}
                                className="px-2 py-1 rounded-lg text-xs font-semibold text-ink-500 hover:text-rose-700 hover:bg-rose-50 dark:text-parchment-300 dark:hover:text-rose-300 dark:hover:bg-rose-900/20 transition-colors">
                                {t('don.void')}
                              </button>
                              <button onClick={() => setRefundTarget(d)} title={t('don.refundGift')} aria-label={t('don.refundGift')}
                                className="p-1.5 rounded-lg text-ink-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors">
                                <RotateCcw size={14} />
                              </button>
                            </>
                          )}
                          <button onClick={() => deleteDonation(d.id)} aria-label={t('don.deleteGift')}
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-ink-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-all">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                    )
                  })}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        )}
      </motion.div>

      {/* Load more — only while the last page came back full. Appends the
          next page rather than replacing, so the giving trend keeps its
          history (mirrors Clients). */}
      {hasMore && donations.length > 0 && (
        <div className="flex justify-center mt-6">
          <button
            onClick={loadMoreDonations}
            disabled={loadingMore || refreshing}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-church-800 dark:text-brass-200 bg-parchment-100 dark:bg-ink-800/80 border border-parchment-300/60 dark:border-brass-900/30 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors disabled:opacity-50"
          >
            {loadingMore ? t('don.loading') : t('don.loadMore')}
          </button>
        </div>
      )}

      {/* Modals / Drawers */}
      <AnimatePresence>
        {refundTarget && (
          <RefundMarkerDialog
            donation={refundTarget}
            onClose={() => setRefundTarget(null)}
            onSubmit={(fields) => recordRefund(refundTarget, fields)}
          />
        )}
        {showDonationModal && <DonationModal onClose={() => setShowDonationModal(false)} onSave={handleDonationSave} />}
        {showCashCount && <CashCountDrawer onClose={() => setShowCashCount(false)} onSaved={handleCashCountSaved} />}
        {showFunds && <FundsDrawer onClose={() => setShowFunds(false)} />}
      </AnimatePresence>
    </PageWrapper>
  )
}
