import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Link } from 'react-router-dom'
import {
  DollarSign, TrendingUp, Users, Award, Plus, X, Trash2,
  ChevronDown, Banknote, CheckCircle2, Clock, AlertCircle, FileText,
  Landmark, FlaskConical, RotateCcw, Repeat, History,
} from 'lucide-react'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import PageWrapper, { itemVariants } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'
import { DonationsIllustration } from '../components/illustrations'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip, scrimCls } from '../components/MobileSheet'
import { apiUrl } from '../api'
import { todayLocalISO } from '../utils/dates'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { useConfirm } from '../components/ConfirmProvider'

// ── Constants ─────────────────────────────────────────────────
const CATEGORIES = ['tithe', 'offering', 'event', 'building fund', 'missions', 'other']
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
  category: 'offering', counted_by: '', verified_by: '', notes: '',
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
function fmtDate(str) {
  if (!str) return '—'
  return new Date(str + 'T00:00:00').toLocaleDateString('en-US', {
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
function buildTrendFromDonations(donations) {
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
    if (don.refunded_at) continue          // refunded gifts aren't giving
    days[idx].total += Number(don.amount) || 0
    anyInWindow = true
  }
  // If not a single donation fell in the last 30 days, there's no trend
  // worth drawing — let the caller render the empty state.
  return anyInWindow ? days : []
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

function SummaryCard({ icon: Icon, label, value, sub, accent }) {
  const accentCls = {
    violet: 'bg-church-50 dark:bg-church-900/30 text-church-700 dark:text-brass-200',
    indigo: 'bg-brass-50 dark:bg-brass-900/20 text-brass-700 dark:text-brass-300',
    emerald:'bg-parchment-200/70 dark:bg-ink-800 text-ink-700 dark:text-parchment-200',
    amber:  'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  }[accent]
  return (
    <motion.div variants={itemVariants}
      className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 p-5 flex items-start gap-4 hover:shadow-md transition-shadow">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${accentCls}`}>
        <Icon size={20} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-ink-500 dark:text-parchment-300/70 mb-0.5">{label}</p>
        <p className="text-2xl font-bold text-ink-900 dark:text-parchment-50 tracking-tight truncate">{value}</p>
        {sub && <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">{sub}</p>}
      </div>
    </motion.div>
  )
}

// ── Denomination Row ──────────────────────────────────────────
function DenomRow({ label, value, count, onChange }) {
  const subtotal = (Number(count) * value)
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-parchment-300/50 dark:border-brass-900/20 last:border-0">
      <span className="w-12 text-sm font-semibold text-ink-700 dark:text-parchment-100">{label}</span>
      <div className="flex items-center gap-1.5 flex-1">
        <button
          type="button"
          onClick={() => onChange(Math.max(0, Number(count) - 1))}
          className="w-7 h-7 rounded-lg bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700 text-base font-bold leading-none transition-colors flex items-center justify-center"
        >−</button>
        <input
          type="number" min="0"
          value={count === 0 ? '' : count}
          onChange={e => onChange(Math.max(0, parseInt(e.target.value || '0', 10)))}
          placeholder="0"
          className="w-16 text-center px-2 py-1 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
        />
        <button
          type="button"
          onClick={() => onChange(Number(count) + 1)}
          className="w-7 h-7 rounded-lg bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700 text-base font-bold leading-none transition-colors flex items-center justify-center"
        >+</button>
      </div>
      <span className={`w-20 text-right text-sm font-medium tabular-nums ${subtotal > 0 ? 'text-church-700 dark:text-brass-300' : 'text-ink-300 dark:text-parchment-400/50'}`}>
        {subtotal > 0 ? fmtCurrency(subtotal, 2) : '—'}
      </span>
    </div>
  )
}

// ── Cash Count Drawer ─────────────────────────────────────────
function CashCountDrawer({ onClose, onSaved }) {
  const [form, setForm]     = useState(EMPTY_SESSION)
  const [counts, setCounts] = useState(EMPTY_COUNTS)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setCount = (denom, qty) => setCounts(c => ({ ...c, [denom]: qty }))
  const total = calcTotal(counts)

  async function submit(e) {
    e.preventDefault()
    if (!form.service_name.trim()) return setError('Service name is required')
    if (!form.counted_by.trim())   return setError('Counter 1 name is required')
    if (total <= 0)                return setError('Cash total must be greater than $0')
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
      setError(err.message || "That didn't save — nothing was lost. Please try again.")
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
        onClick={onClose}
      />
      {/* Panel */}
      <motion.div
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-parchment-50 dark:bg-ink-900 shadow-warm-lg flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brass-50 dark:bg-brass-900/25 flex items-center justify-center">
              <Banknote size={16} className="text-brass-700 dark:text-brass-300" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">Cash Count Session</h2>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70">Count and verify physical cash</p>
            </div>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <form onSubmit={submit} className="flex-1 overflow-y-auto">
          <div className="px-6 py-5 space-y-5">
            {error && (
              <div className="flex items-center gap-2 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 rounded-lg px-3 py-2">
                <AlertCircle size={13} />
                {error}
              </div>
            )}

            {/* Service info */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">Service Info</h3>
              <div>
                <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Service Name</label>
                <input
                  value={form.service_name}
                  onChange={e => set('service_name', e.target.value)}
                  placeholder="e.g. Sunday Morning Service"
                  className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Date</label>
                  <input
                    type="date" value={form.service_date}
                    onChange={e => set('service_date', e.target.value)}
                    className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Category</label>
                  <select
                    value={form.category} onChange={e => set('category', e.target.value)}
                    className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400 capitalize"
                  >
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Counters */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">Counters</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Counter 1 <span className="text-rose-300">*</span></label>
                  <input
                    value={form.counted_by}
                    onChange={e => set('counted_by', e.target.value)}
                    placeholder="First name"
                    className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Counter 2 <span className="text-ink-400">(verify)</span></label>
                  <input
                    value={form.verified_by}
                    onChange={e => set('verified_by', e.target.value)}
                    placeholder="First name"
                    className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
                  />
                </div>
              </div>
              {form.verified_by && (
                <p className="text-xs text-brass-700 dark:text-brass-300 flex items-center gap-1.5">
                  <CheckCircle2 size={12} /> Dual-verified count — both counters will be recorded
                </p>
              )}
            </div>

            {/* Bills */}
            <div>
              <h3 className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider mb-2">Bills</h3>
              <div className="bg-parchment-100 dark:bg-ink-800 rounded-xl px-4 py-1">
                {BILLS.map(d => (
                  <DenomRow key={d.value} label={d.label} value={d.value}
                    count={counts[d.value]} onChange={qty => setCount(d.value, qty)} />
                ))}
              </div>
            </div>

            {/* Coins */}
            <div>
              <h3 className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider mb-2">Coins</h3>
              <div className="bg-parchment-100 dark:bg-ink-800 rounded-xl px-4 py-1">
                {COINS.map(d => (
                  <DenomRow key={d.value} label={d.label} value={d.value}
                    count={counts[d.value]} onChange={qty => setCount(d.value, qty)} />
                ))}
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Notes <span className="text-ink-400">(optional)</span></label>
              <input
                value={form.notes} onChange={e => set('notes', e.target.value)}
                placeholder="e.g. Plate offering + visitor envelopes"
                className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/30 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
              />
            </div>
          </div>
        </form>

        {/* Sticky footer — total + submit */}
        <div className="flex-shrink-0 border-t border-parchment-300/60 dark:border-brass-900/30 px-6 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-500 dark:text-parchment-300/70">Counted Total</span>
            <span className={`text-2xl font-bold tabular-nums tracking-tight ${total > 0 ? 'text-ink-900 dark:text-parchment-50' : 'text-ink-300 dark:text-parchment-400/50'}`}>
              {fmtCurrency(total, 2)}
            </span>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 text-sm font-medium rounded-xl bg-parchment-200 dark:bg-ink-800 text-ink-700 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700 transition-colors">
              Cancel
            </button>
            <button onClick={submit} disabled={saving || total <= 0}
              className="flex-1 py-2.5 text-sm font-semibold rounded-xl bg-brass-700 hover:bg-brass-800 text-parchment-50 transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : 'Save Count'}
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
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function submit(e) {
    e.preventDefault()
    if (!form.donor_name.trim()) return setError('Donor name is required')
    if (!form.amount || isNaN(form.amount) || Number(form.amount) <= 0) return setError('Enter a valid amount')
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
      setError(err.message || "That didn't save — nothing was lost. Please try again.")
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
      <motion.div
        initial={{ scale: 0.95, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0, y: 10 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
          <h2 className="text-base font-semibold text-ink-900 dark:text-parchment-50">Add Donation</h2>
          <button onClick={onClose}
            className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 rounded-lg px-3 py-2">{error}</p>}

          <div>
            <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Donor Name</label>
            <input value={form.donor_name} onChange={e => set('donor_name', e.target.value)}
              placeholder="John Smith"
              className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Amount</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 text-sm font-medium">$</span>
                <input type="number" min="0" step="0.01" value={form.amount}
                  onChange={e => set('amount', e.target.value)} placeholder="0.00"
                  className="w-full pl-7 pr-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Date</label>
              <input type="date" value={form.date} onChange={e => set('date', e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Category</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map(c => (
                <button key={c} type="button" onClick={() => set('category', c)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                    form.category === c ? 'bg-church-800 text-parchment-50' : 'bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700'
                  }`}>{c}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Method</label>
            <div className="flex gap-2">
              {METHODS.map(m => (
                <button key={m} type="button" onClick={() => set('method', m)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium capitalize transition-colors ${
                    form.method === m ? 'bg-church-800 text-parchment-50' : 'bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700'
                  }`}>{m}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-600 dark:text-parchment-300 mb-1.5">Notes <span className="text-ink-400">(optional)</span></label>
            <input value={form.notes} onChange={e => set('notes', e.target.value)}
              placeholder="e.g. Easter Sunday offering"
              className="w-full px-3 py-2.5 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
            />
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 text-sm font-medium rounded-xl bg-parchment-200 dark:bg-ink-800 text-ink-700 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 text-sm font-semibold rounded-xl bg-church-800 hover:bg-church-900 text-parchment-50 transition-colors disabled:opacity-60">
              {saving ? 'Saving…' : 'Add Donation'}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  )
}

// ── Cash Count History Row ─────────────────────────────────────
function CashCountRow({ session, onConfirm, onDelete }) {
  const [confirming, setConfirming] = useState(false)
  const confirmed = session.status === 'confirmed'

  async function handleConfirm() {
    setConfirming(true)
    await onConfirm(session.id)
    setConfirming(false)
  }

  const counters = [session.counted_by, session.verified_by].filter(Boolean).join(' & ')

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      className="flex items-center gap-4 px-5 py-4 hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors group"
    >
      {/* Status icon */}
      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
        confirmed ? 'bg-brass-50 dark:bg-brass-900/25' : 'bg-amber-100 dark:bg-amber-900/30'
      }`}>
        {confirmed
          ? <CheckCircle2 size={16} className="text-brass-700 dark:text-brass-300" />
          : <Clock size={16} className="text-amber-600 dark:text-amber-400" />
        }
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">{session.service_name}</p>
        <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
          {fmtDate(session.service_date)} · Counted by {counters}
          {session.verified_by && <span className="ml-1 text-brass-700 dark:text-brass-300">(verified)</span>}
        </p>
      </div>

      {/* Category */}
      <span className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize hidden sm:inline-flex ${CATEGORY_STYLES[session.category] || CATEGORY_STYLES.other}`}>
        {session.category}
      </span>

      {/* Total */}
      <span className="text-sm font-semibold text-ink-900 dark:text-parchment-50 tabular-nums w-20 text-right">
        {fmtCurrency(session.total, 2)}
      </span>

      {/* Actions */}
      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {!confirmed && (
          <button onClick={handleConfirm} disabled={confirming}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-brass-700 hover:bg-brass-800 text-parchment-50 transition-colors disabled:opacity-60">
            {confirming ? '…' : 'Confirm'}
          </button>
        )}
        <button onClick={() => onDelete(session.id)}
          className="p-1.5 rounded-lg text-ink-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-all">
          <Trash2 size={13} />
        </button>
      </div>
    </motion.div>
  )
}

// ── Main Page ─────────────────────────────────────────────────
// Funds management drawer (GIV.3). The designations the public give
// page offers. Create/activate/delete here; online gifts record against
// the active ones. Shows whether giving is live or on the test stub.
function FundsDrawer({ onClose }) {
  const [funds, setFunds]       = useState([])
  const [provider, setProvider] = useState('stub')
  const [loading, setLoading]   = useState(true)
  const [name, setName]         = useState('')
  const [description, setDesc]  = useState('')
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState('')
  const toast = useToast()
  const ask = useConfirm()

  async function load() {
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/funds'))
      const d = res.ok ? await res.json() : { funds: [] }
      setFunds(d.funds ?? [])
      if (d.provider) setProvider(d.provider)
    } catch { /* keep what we have */ }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function addFund(e) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true); setError('')
    try {
      const res = await fetch(apiUrl('/api/funds'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || "That didn't save — nothing was lost. Please try again.")
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
    } catch (err) { toast.error("That didn't save — nothing was lost. Please try again.") }
  }

  async function removeFund(f) {
    if (!(await ask({
      title: `Delete the “${f.name}” fund?`,
      body: 'Gifts already recorded to it stay. It just stops being offered for new gifts.',
      confirmLabel: 'Delete fund',
    }))) return
    try {
      const res = await fetch(apiUrl(`/api/funds/${f.id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(`Failed (${res.status})`)
      setFunds(list => list.filter(x => x.id !== f.id))
    } catch (err) { toast.error("That didn't delete — nothing was changed. Please try again.") }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className={sheetOverlayCls}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0, y: 10 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
          <div className="flex items-center gap-2">
            <Landmark size={16} className="text-brass-600 dark:text-brass-300" />
            <h2 className="text-base font-semibold text-ink-900 dark:text-parchment-50">Giving funds</h2>
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
                Online giving is in <span className="font-semibold">test mode</span> — gifts are recorded but no real
                charge is made. It goes live when a payment provider is connected.
              </p>
            </div>
          )}

          <p className="text-xs text-ink-500 dark:text-parchment-300/70 leading-snug">
            Funds are the designations donors can give to on your public giving page.
          </p>

          {/* Add fund */}
          <form onSubmit={addFund} className="space-y-2 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 p-3">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Fund name — e.g. Building Fund"
              className="w-full px-3 py-2 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
            />
            <input
              value={description}
              onChange={e => setDesc(e.target.value)}
              placeholder="Short description (optional)"
              className="w-full px-3 py-2 text-sm bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 rounded-lg text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
            />
            {error && <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-church-800 hover:bg-church-900 text-parchment-50 transition-colors disabled:opacity-40"
            >
              <Plus size={13} /> {busy ? 'Adding…' : 'Add fund'}
            </button>
          </form>

          {/* List */}
          {loading ? (
            <SkeletonRowList count={3} withAvatar={false} />
          ) : funds.length === 0 ? (
            <p className="text-xs text-ink-500 dark:text-parchment-300/70 text-center py-4">
              No funds yet. Add one above to start collecting designated gifts.
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
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-parchment-200 dark:bg-ink-700 text-ink-500 dark:text-parchment-300/70">
                          Hidden
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
                      aria-label="Delete fund"
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

export default function Donations() {
  const [donations, setDonations]       = useState([])
  const [cashCounts, setCashCounts]     = useState([])
  const [summary, setSummary]           = useState(null)
  const [funds, setFunds]               = useState([]) // giving-by-fund breakdown (GIV.4)
  const [recurring, setRecurring]       = useState([]) // active recurring gifts (GIV.7)
  const [loading, setLoading]           = useState(true)
  const [showDonationModal, setShowDonationModal] = useState(false)
  const { canWrite, user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const toast = useToast()
  const ask = useConfirm()
  const [showCashCount, setShowCashCount]         = useState(false)
  const [showFunds, setShowFunds]                 = useState(false)
  const [filter, setFilter]             = useState('all')
  const [sortDesc, setSortDesc]         = useState(true)
  // Pagination (mirrors Clients). The donation log fetches a page at a
  // time; "Load more" appends the next page. `hasMore` is derived from
  // whether the last page came back full — a short page means the end.
  const [hasMore, setHasMore]           = useState(false)
  const [loadingMore, setLoadingMore]   = useState(false)

  const PAGE_SIZE = 50

  async function load() {
    try {
      const [dRes, sRes, ccRes, fRes, rgRes] = await Promise.all([
        // First page only — the list endpoint clamps to a safety cap, so
        // ask explicitly and page the rest in via "Load more".
        fetch(apiUrl(`/api/donations?limit=${PAGE_SIZE}&offset=0`)),
        fetch(apiUrl('/api/donations/summary')),
        fetch(apiUrl('/api/donations/cash-counts')),
        fetch(apiUrl('/api/donations/by-fund?days=365')),
        fetch(apiUrl('/api/donations/recurring')),
      ])
      if (dRes.ok)  {
        const rows = await dRes.json()
        setDonations(rows)
        // A full page implies there may be more; a short page is the end.
        setHasMore(rows.length === PAGE_SIZE)
      }
      if (sRes.ok)  setSummary(await sRes.json())
      if (ccRes.ok) setCashCounts(await ccRes.json())
      if (fRes.ok)  { const d = await fRes.json(); setFunds(d.funds ?? []) }
      if (rgRes.ok) { const d = await rgRes.json(); setRecurring(d.recurring ?? []) }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Fetch the next page and APPEND (so the 30-day giving trend, which
  // derives from the fetched donations, keeps everything it already has).
  // Offset is the current row count so it stays correct across pages.
  async function loadMoreDonations() {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(apiUrl(`/api/donations?limit=${PAGE_SIZE}&offset=${donations.length}`))
      if (!res.ok) return
      const rows = await res.json()
      setDonations(prev => [...prev, ...rows])
      setHasMore(rows.length === PAGE_SIZE)
    } catch (err) {
      console.error(err)
    } finally {
      setLoadingMore(false)
    }
  }

  async function deleteDonation(id) {
    if (!(await ask({ title: 'Delete this donation entry?', confirmLabel: 'Delete gift' }))) return
    const res = await fetch(apiUrl(`/api/donations/${id}`), { method: 'DELETE' })
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || "That didn't delete — nothing was changed. Please try again.")
      return
    }
    setDonations(prev => prev.filter(d => d.id !== id))
    load()
  }

  async function refundDonation(id) {
    if (!(await ask({
      title: 'Refund this online gift?',
      body: 'It is marked refunded and drops out of your giving totals.',
      confirmLabel: 'Refund gift',
    }))) return
    const res = await fetch(apiUrl(`/api/donations/${id}/refund`), { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.error || "That didn't save — nothing was lost. Please try again.")
      return
    }
    toast.success('Gift refunded')
    load()
  }

  async function cancelRecurring(id) {
    if (!(await ask({
      title: 'Cancel this recurring gift?',
      body: 'No further charges will be made. Gifts already given are unaffected.',
      confirmLabel: 'Cancel recurring gift',
    }))) return
    const res = await fetch(apiUrl(`/api/donations/recurring/${id}/cancel`), { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || "That didn't save — nothing was lost. Please try again.")
      return
    }
    setRecurring(prev => prev.filter(r => r.id !== id))
    toast.success('Recurring gift cancelled')
  }

  async function confirmCashCount(id) {
    const res = await fetch(apiUrl(`/api/donations/cash-counts/${id}/confirm`), { method: 'PATCH' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || "That didn't save — nothing was lost. Please try again.")
      return
    }
    load()
  }

  async function deleteCashCount(id) {
    if (!(await ask({ title: 'Delete this cash-count session?', confirmLabel: 'Delete session' }))) return
    const res = await fetch(apiUrl(`/api/donations/cash-counts/${id}`), { method: 'DELETE' })
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || "That didn't delete — nothing was changed. Please try again.")
      return
    }
    setCashCounts(prev => prev.filter(c => c.id !== id))
  }

  function handleDonationSave(donation) {
    setDonations(prev => [donation, ...prev])
    setShowDonationModal(false)
    load()
  }

  function handleCashCountSaved(session) {
    setCashCounts(prev => [session, ...prev])
    setShowCashCount(false)
  }

  const filtered = useMemo(() => {
    const rows = filter === 'all' ? donations : donations.filter(d => d.category === filter)
    return sortDesc ? rows : [...rows].reverse()
  }, [donations, filter, sortDesc])

  // Giving trend, derived from the real donations already on the page —
  // no fabricated numbers. Empty until at least one real gift lands in
  // the last 30 days, in which case we show an empty state, not a chart.
  const chartData = useMemo(() => buildTrendFromDonations(donations), [donations])

  const pendingCounts = cashCounts.filter(c => c.status === 'pending').length

  return (
    <PageWrapper>
      {/* Header */}
      <motion.div variants={itemVariants} className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Donations</h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-0.5">Track giving and generosity</p>
        </div>
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
              Year-end statements
            </Link>
          )}
          {/* Audit trail for the giving records (AUD.5) — admin-only,
              scoped to every donation create/refund/delete. The honest
              answer to "who touched our books?". */}
          {isAdmin && (
            <Link
              to="/audit?entity_type=donation"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-parchment-100 dark:hover:bg-ink-800/70 transition-colors"
              title="See every change made to donation records"
            >
              <History size={16} />
              Change history
            </Link>
          )}
        {canWrite && (
          <>
          <motion.button
            onClick={() => setShowFunds(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-parchment-100 dark:hover:bg-ink-800/70 transition-colors"
          >
            <Landmark size={16} />
            Funds
          </motion.button>
          <motion.button
            onClick={() => setShowCashCount(true)}
            className="relative flex items-center gap-2 px-4 py-2.5 bg-brass-700 hover:bg-brass-800 text-parchment-50 text-sm font-semibold rounded-xl shadow-sm transition-colors"
          >
            <Banknote size={16} />
            Cash Count
            {pendingCounts > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-amber-400 text-amber-900 text-[10px] font-bold rounded-full flex items-center justify-center">
                {pendingCounts}
              </span>
            )}
          </motion.button>
          <motion.button
            onClick={() => setShowDonationModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-church-800 hover:bg-church-900 text-parchment-50 text-sm font-semibold rounded-xl shadow-sm transition-colors"
          >
            <Plus size={16} />
            Add Donation
          </motion.button>
          </>
        )}
        </div>
      </motion.div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SummaryCard icon={DollarSign} label="This Month"    value={summary ? fmtCurrency(summary.month_total) : '—'} sub="Total donations"     accent="violet" />
        <SummaryCard icon={TrendingUp} label="This Week"     value={summary ? fmtCurrency(summary.week_total)  : '—'} sub="7-day running total" accent="indigo" />
        <SummaryCard icon={Award}      label="Largest Gift"  value={summary ? fmtCurrency(summary.largest)     : '—'} sub="Single donation"     accent="amber"  />
        <SummaryCard icon={Users}      label="Unique Donors" value={summary ? Number(summary.donor_count)      : 0}   sub="All time"            accent="emerald"/>
      </div>

      {/* Chart */}
      <motion.div variants={itemVariants}
        className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 p-5 mb-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">Giving Trends</h2>
          <p className="text-xs text-ink-500 dark:text-parchment-300/70">Last 30 days</p>
        </div>
        {chartData.length === 0 ? (
          // No real giving in the last 30 days — a quiet empty state
          // rather than a fabricated line. Real gifts populate this.
          <div className="h-[200px] flex flex-col items-center justify-center text-center px-6">
            <TrendingUp size={22} className="text-ink-300 dark:text-parchment-400/50 mb-2" />
            <p className="text-sm font-medium text-ink-500 dark:text-parchment-300/70">No giving data yet</p>
            <p className="text-xs text-ink-400 dark:text-parchment-300/50 mt-0.5">Gifts from the last 30 days will chart here.</p>
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
              <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">Giving by Fund</h2>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70">Last 12 months</p>
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
                      <span className="font-medium text-ink-800 dark:text-parchment-100 capitalize truncate">{f.category}</span>
                      <span className="tabular-nums font-semibold text-ink-900 dark:text-parchment-50 shrink-0">
                        {fmtCurrency(Number(f.total), 2)}
                        <span className="text-ink-500 dark:text-parchment-300/60 font-normal"> · {pct}%</span>
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-parchment-200 dark:bg-ink-800 overflow-hidden">
                      <div className="h-full rounded-full bg-brass-500" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 mt-0.5">
                      {f.count} gift{f.count === 1 ? '' : 's'}
                    </p>
                  </div>
                )
              })
            })()}
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
            <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">Recurring Gifts</h2>
            <span className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70">({recurring.length})</span>
          </div>
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
                <button
                  type="button"
                  onClick={() => cancelRecurring(r.id)}
                  className="shrink-0 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:text-rose-700 dark:hover:text-rose-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Cash Count History */}
      {cashCounts.length > 0 && (
        <motion.div variants={itemVariants}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 overflow-hidden mb-6">
          <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">Cash Count Sessions</h2>
              {pendingCounts > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  {pendingCounts} pending
                </span>
              )}
            </div>
            <p className="text-xs text-ink-500 dark:text-parchment-300/70">Confirm to post to donations log</p>
          </div>
          <AnimatePresence initial={false}>
            {cashCounts.map(s => (
              <CashCountRow key={s.id} session={s}
                onConfirm={confirmCashCount} onDelete={deleteCashCount} />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Donations Table */}
      <motion.div variants={itemVariants}
        className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/60 dark:border-brass-900/30 gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
            Donation Log
            <span className="ml-2 text-xs font-normal text-ink-500 dark:text-parchment-300/70">{filtered.length} records</span>
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            {['all', ...CATEGORIES].map(c => (
              <button key={c} onClick={() => setFilter(c)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                  filter === c ? 'bg-church-800 text-parchment-50' : 'bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-300/70 dark:hover:bg-ink-700'
                }`}>{c}</button>
            ))}
          </div>
        </div>

        {loading ? (
          <SkeletonRowList count={6} withAvatar={false} />
        ) : donations.length === 0 ? (
          // Truly empty — no donations at all in the org. Warm card with
          // a primary CTA only when the caller can actually act on it.
          <div className="p-6">
            <EmptyState
              illustration={DonationsIllustration}
              title="No donations yet"
              body="Track tithes, offerings, and one-time gifts here. Confirm a cash count or log a donation directly to start building the picture."
              action={canWrite ? { label: 'Log a donation', onClick: () => setShowDonationModal(true) } : null}
              secondary={canWrite ? { label: 'Or open a cash count', onClick: () => setShowCashCount(true) } : null}
            />
          </div>
        ) : filtered.length === 0 ? (
          // Filter narrowed everything away — minimalist text, no big card.
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-ink-500 dark:text-parchment-300/70">No donations match this filter</p>
            <button onClick={() => setFilter('all')} className="mt-2 text-xs font-semibold text-church-700 hover:text-church-900 dark:text-brass-300 dark:hover:text-brass-200 transition-colors">
              Show all
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-500 dark:text-parchment-300/70 bg-parchment-100 dark:bg-ink-800/60">
                  <th className="px-5 py-3 font-medium">Donor</th>
                  <th className="px-5 py-3 font-medium">Amount</th>
                  <th className="px-5 py-3 font-medium">Category</th>
                  <th className="px-5 py-3 font-medium">Method</th>
                  <th className="px-5 py-3 font-medium cursor-pointer select-none" onClick={() => setSortDesc(p => !p)}>
                    <span className="flex items-center gap-1">
                      Date <ChevronDown size={12} className={`transition-transform ${sortDesc ? '' : 'rotate-180'}`} />
                    </span>
                  </th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment-200/60 dark:divide-white/[0.04]">
                <AnimatePresence initial={false}>
                  {filtered.map(d => (
                    <motion.tr key={d.id}
                      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                      className="hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors group">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-full bg-church-50 dark:bg-church-900/40 flex items-center justify-center text-church-800 dark:text-brass-200 text-xs font-bold flex-shrink-0">
                            {d.donor_name.charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-ink-900 dark:text-parchment-50">{d.donor_name}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`font-semibold ${d.refunded_at ? 'text-ink-400 dark:text-parchment-300/50 line-through' : 'text-ink-900 dark:text-parchment-50'}`}>{fmtCurrency(d.amount, 2)}</span>
                        {d.refunded_at && (
                          <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">Refunded</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize ${CATEGORY_STYLES[d.category] || CATEGORY_STYLES.other}`}>
                          {d.category}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize ${METHOD_STYLES[d.method] || ''}`}>
                          {d.method}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-ink-500 dark:text-parchment-300/70">{fmtDate(d.date)}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-1 justify-end">
                          {d.method === 'online' && !d.refunded_at && (
                            <button onClick={() => refundDonation(d.id)} title="Refund this gift" aria-label="Refund this gift"
                              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-ink-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-all">
                              <RotateCcw size={14} />
                            </button>
                          )}
                          <button onClick={() => deleteDonation(d.id)} aria-label="Delete this gift"
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-ink-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-all">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                  ))}
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
            disabled={loadingMore}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-church-800 dark:text-brass-200 bg-parchment-100 dark:bg-ink-800/80 border border-parchment-300/60 dark:border-brass-900/30 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      {/* Modals / Drawers */}
      <AnimatePresence>
        {showDonationModal && <DonationModal onClose={() => setShowDonationModal(false)} onSave={handleDonationSave} />}
        {showCashCount && <CashCountDrawer onClose={() => setShowCashCount(false)} onSaved={handleCashCountSaved} />}
        {showFunds && <FundsDrawer onClose={() => setShowFunds(false)} />}
      </AnimatePresence>
    </PageWrapper>
  )
}
