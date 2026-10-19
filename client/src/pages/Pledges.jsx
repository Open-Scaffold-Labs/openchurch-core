import { useEffect, useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Heart, Plus, X, Pencil, Trash2, AlertTriangle, Loader2, User as UserIcon, Mail,
} from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadFailure from '../components/LoadFailure'
import { SkeletonRowList } from '../components/Skeleton'
import TextField from '../components/TextField'
import SaveButton, { useSaveStatus } from '../components/SaveButton'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip } from '../components/MobileSheet'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../context/AuthContext'
import { apiUrl } from '../api'
import { todayLocalISO } from '../utils/dates'
import { useConfirm } from '../components/ConfirmProvider'
import { loadList } from '../utils/format'
import { useLocale } from '../i18n'

// Pledges admin page (Sprint D / D.2). Lists every pledge with
// computed fulfillment, supports create/edit/cancel via modal.
// Admin-only — the route + the underlying endpoint both gate.
//
// Layout decisions:
// - Table on desktop, stacked cards on mobile (same pattern as
//   GivingStatements). Fulfillment is the load-bearing metric so
//   it gets its own column with a progress bar.
// - Cancelled pledges hide behind a "Show cancelled" toggle so the
//   default view is the actionable subset (active + completed).

const FREQUENCIES = [
  { value: 'weekly',   label: 'Weekly' },
  { value: 'monthly',  label: 'Monthly' },
  { value: 'yearly',   label: 'Yearly' },
  { value: 'one_time', label: 'One-time' },
]

const STATUS_PILL = {
  active:    'bg-brass-100 text-brass-700 dark:bg-brass-900/30 dark:text-brass-300',
  completed: 'bg-church-100 text-church-800 dark:bg-church-900/40 dark:text-brass-200',
  cancelled: 'bg-parchment-200 text-ink-700 dark:bg-ink-800/40 dark:text-parchment-200',
}

// A figure counts only as a finite number or a plain decimal string
// (including zero and Postgres numeric text). Booleans, arrays, objects,
// and blanks are not zero.
function knownNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function positiveIntId(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v
  if (typeof v === 'string' && /^[1-9]\d*$/.test(v)) {
    const n = Number(v)
    if (Number.isSafeInteger(n)) return n
  }
  return null
}

function fmtCurrency(n, unavailable) {
  const v = knownNumber(n)
  if (v == null) return unavailable
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

function sumMoney(rows, key) {
  let sum = 0
  for (const row of rows) {
    const n = knownNumber(row[key])
    if (n == null) return null
    sum += n
  }
  return sum
}

function isPledgeRow(row) {
  return !!row && typeof row === 'object' && !Array.isArray(row)
    && positiveIntId(row.id) != null && typeof row.frequency === 'string'
}

// `{ pledges: null }`, a bare array, or an error object is not an empty book.
function asPledgeList(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (!Array.isArray(body.pledges)) return null
  if (body.pledges.some(row => !isPledgeRow(row))) return null
  return body.pledges
}

function writeError(res, data, t) {
  const server = data && typeof data.error === 'string' ? data.error.trim() : ''
  if (res && res.status >= 400 && res.status < 500 && server && !/\b\d{3}\b/.test(server)) return server
  return t('err.save')
}

function fmtDate(iso) {
  if (!iso) return null
  const [y, m, d] = iso.split('T')[0].split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Progress bar — colored by fulfillment ratio. Green at full, amber
// in mid, rose when underfunded (< 0.5 of expected for the period).
function FulfillmentBar({ fulfillment, unavailable }) {
  const ratio = knownNumber(fulfillment)
  if (ratio == null) {
    return <span className="text-xs font-semibold text-ink-700 dark:text-parchment-200">{unavailable}</span>
  }
  const pct = Math.round(ratio * 100)
  const barCls = ratio >= 1
    ? 'bg-brass-500'
    : ratio >= 0.5
      ? 'bg-amber-500'
      : 'bg-rose-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-parchment-200/80 dark:bg-ink-800 overflow-hidden min-w-[80px]">
        <div className={`h-full ${barCls} transition-all duration-300`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="text-xs font-semibold text-ink-700 dark:text-parchment-200 tabular-nums w-10 text-right">
        {pct}%
      </span>
    </div>
  )
}

function PledgeModal({ pledge, members, membersFailed, onClose, onSaved }) {
  const isEdit = !!pledge
  const toast = useToast()
  const ask = useConfirm()
  const { t } = useLocale()

  const [form, setForm] = useState(() => ({
    member_id:   pledge?.member_id ?? null,
    donor_email: pledge?.donor_email ?? '',
    amount:      pledge?.amount ?? '',
    frequency:   pledge?.frequency ?? 'monthly',
    start_date:  pledge?.start_date ? pledge.start_date.slice(0, 10) : todayLocalISO(),
    end_date:    pledge?.end_date ? pledge.end_date.slice(0, 10) : '',
    notes:       pledge?.notes ?? '',
    status:      pledge?.status ?? 'active',
  }))

  const { status: saveStatus, run: save } = useSaveStatus(async () => {
    // Strip empties → null. donor_email empty means 'use member-
    // lookup'; end_date empty means open-ended.
    const payload = {
      member_id:   form.member_id || null,
      donor_email: form.donor_email?.trim() || null,
      amount:      Number(form.amount),
      frequency:   form.frequency,
      start_date:  form.start_date || null,
      end_date:    form.end_date || null,
      notes:       form.notes?.trim() || null,
      status:      form.status,
    }
    const url = isEdit ? `/api/pledges/${pledge.id}` : '/api/pledges'
    const method = isEdit ? 'PATCH' : 'POST'
    let res
    try {
      res = await fetch(apiUrl(url), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch {
      throw new Error(t('err.save'))
    }
    const data = await res.json().catch(() => ({}))
    const returnedId = positiveIntId(data?.id)
    // true, [7], and a different pledge's id are not this save.
    const saved = returnedId != null && (!isEdit || returnedId === positiveIntId(pledge.id))
    if (!res.ok || !saved) throw new Error(writeError(res, data, t))
    return data
  }, {
    onSuccess: () => { onSaved(); onClose() },
  })

  const f = k => e => setForm(prev => ({ ...prev, [k]: e.target.value }))

  return (
    <div className={sheetOverlayCls}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18 }}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
          <h2 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">
            {isEdit ? 'Edit pledge' : 'New pledge'}
          </h2>
          <button type="button" onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors">
            <X size={18} />
          </button>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); save().catch(err => toast.error(err.message)) }}
          className="p-6 space-y-4 overflow-y-auto"
        >
          {/* Member picker — small dropdown rather than a full
              MemberPicker since pledges are 1:1 with donor, not
              multi-assign. */}
          <div>
            <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">
              Member
            </label>
            <select
              value={form.member_id ?? ''}
              onChange={(e) => setForm(prev => ({ ...prev, member_id: e.target.value ? Number(e.target.value) : null }))}
              className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
            >
              <option value="">— Non-member donor (use email below) —</option>
              {members.map(m => (
                <option key={m.id} value={m.id}>{m.name}{m.email ? ` · ${m.email}` : ''}</option>
              ))}
            </select>
            {/* An empty picker reads as "you have no members" to somebody
                halfway through recording a pledge. Name the difference. */}
            {membersFailed && (
              <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400 leading-snug">
                {t('plg.membersUnread')}
              </p>
            )}
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
              Pledges match donations by the member's email. Pick the donor here for the cleanest tracking.
            </p>
          </div>

          {!form.member_id && (
            <TextField
              label="Donor email (when not a member)"
              type="email"
              value={form.donor_email}
              onChange={f('donor_email')}
              leadingIcon={Mail}
              hint="Donations with this email will count toward the pledge."
            />
          )}

          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Amount"
              type="number"
              step="0.01"
              min="0.01"
              required
              value={form.amount}
              onChange={f('amount')}
              placeholder="100"
              hint="Per period"
            />
            <div>
              <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">Frequency</label>
              <select
                value={form.frequency}
                onChange={f('frequency')}
                className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
              >
                {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Start date"
              type="date"
              value={form.start_date}
              onChange={f('start_date')}
            />
            <TextField
              label="End date (optional)"
              type="date"
              value={form.end_date}
              onChange={f('end_date')}
              hint="Leave empty for open-ended."
            />
          </div>

          {isEdit && (
            <div>
              <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">Status</label>
              <select
                value={form.status}
                onChange={f('status')}
                className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
              >
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">Notes</label>
            <textarea
              value={form.notes}
              onChange={f('notes')}
              rows={2}
              placeholder="Optional context — building campaign, missions fund, etc." aria-label="Optional context — building campaign, missions fund, etc."
              className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-brass-400 resize-none"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-parchment-300/60 dark:border-brass-900/25">
            <button type="button" onClick={onClose} className="text-sm text-ink-600 dark:text-parchment-300 hover:text-ink-900 dark:hover:text-parchment-50 px-3 py-2">
              Cancel
            </button>
            <SaveButton status={saveStatus}>{isEdit ? 'Save pledge' : 'Create pledge'}</SaveButton>
          </div>
        </form>
      </motion.div>
    </div>
  )
}

export default function Pledges() {
  const { user } = useAuth()
  const { t } = useLocale()
  const isAdmin = user?.role === 'admin'
  const toast   = useToast()
  // Same defect as Forms.jsx: removePledge() referenced an `ask` that only
  // existed inside PledgeModal. Deleting a pledge threw instead of confirming.
  const ask = useConfirm()

  const [pledges, setPledges] = useState(null)
  const [members, setMembers] = useState([])
  // Distinguishes an empty roster from a roster we could not load.
  const [membersFailed, setMembersFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  // A refused or shapeless read is not an empty book and not a $0 summary.
  const [failed, setFailed] = useState(false)
  const [modal, setModal]     = useState(null)   // null | 'new' | pledge object
  const [showCancelled, setShowCancelled] = useState(false)
  const loadGen = useRef(0)

  const load = useCallback(() => {
    if (!isAdmin) return
    const gen = ++loadGen.current
    setLoading(true)
    setFailed(false)
    ;(async () => {
      try {
        const res = await fetch(apiUrl('/api/pledges'))
        if (!res.ok) throw new Error('unread')
        const body = await res.json()
        const list = asPledgeList(body)
        if (!list) throw new Error('shape')
        if (gen !== loadGen.current) return
        setPledges(list)
        setFailed(false)
      } catch {
        if (gen !== loadGen.current) return
        setPledges([])
        setFailed(true)
      } finally {
        if (gen === loadGen.current) setLoading(false)
      }
    })()
  }, [isAdmin])

  useEffect(() => { load() }, [load])

  // Members list for the pledge-modal dropdown.
  useEffect(() => {
    if (!isAdmin) return
    // An empty picker reads as "you have no members", not as "this did not
    // load" — and the person seeing it is midway through recording somebody's
    // giving. Track the difference so the control can say which it is.
    loadList(apiUrl('/api/clients')).then(({ ok, data }) => {
      setMembers(data)
      setMembersFailed(!ok)
    })
  }, [isAdmin])

  async function removePledge(p) {
    if (!(await ask({
      title: 'Delete this pledge?',
      body: 'The matched donations stay. Only the pledge record goes away.',
      confirmLabel: 'Delete pledge',
    }))) return
    try {
      const res = await fetch(apiUrl(`/api/pledges/${p.id}`), { method: 'DELETE' })
      // 204 is the only success. A 200 error body must not read as deleted.
      if (res.status !== 204) throw new Error('delete')
      toast.info('Pledge deleted')
      load()
    } catch (e) {
      toast.error("That didn't delete — nothing was changed. Please try again.")
    }
  }

  if (!isAdmin) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState
            icon={AlertTriangle}
            title="Admins only"
            body="Pledges are restricted to admins — they show donor commitments and fulfillment."
          />
        </div>
      </PageWrapper>
    )
  }

  const unavailable = t('money.unavailable')
  const visible = (pledges ?? []).filter(p => showCancelled || p.status !== 'cancelled')
  const listReady = !loading && !failed
  const totalPledged = listReady ? sumMoney(visible, 'period_total') : null
  const totalMatched = listReady ? sumMoney(visible, 'matched_total') : null

  return (
    <PageWrapper>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4"
        >
          <div>
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
              Pledges
            </h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
              Donor commitments and fulfillment toward them. Donations match by email.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setModal('new')}
            disabled={loading || failed}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-church-900 hover:bg-church-800 text-parchment-50 text-sm font-semibold shadow-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={16} /> New pledge
          </button>
        </motion.div>

        {/* Summary card */}
        {listReady && visible.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 shadow-warm p-5 grid grid-cols-3 gap-4 sm:max-w-2xl"
          >
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">Pledges</p>
              <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 mt-1">
                {visible.length}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">Expected</p>
              <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 mt-1">
                {fmtCurrency(totalPledged, unavailable)}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">Received</p>
              <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 mt-1">
                {fmtCurrency(totalMatched, unavailable)}
              </p>
            </div>
          </motion.div>
        )}

        {/* Body */}
        {loading ? (
          <SkeletonRowList count={5} />
        ) : failed ? (
          <LoadFailure body={t('plg.loadFailedBody')} onRetry={load} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Heart}
            title={t('plg.emptyTitle')}
            body={t('plg.emptyBody')}
            action={{ label: 'New pledge', onClick: () => setModal('new') }}
          />
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 overflow-hidden"
          >
            <ul className="divide-y divide-parchment-200/60 dark:divide-brass-900/25">
              {visible.map(p => (
                <li key={p.id} className="px-5 py-4 flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">
                        {p.member_name || p.donor_email || 'Unnamed donor'}
                      </p>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${STATUS_PILL[p.status]}`}>
                        {p.status}
                      </span>
                    </div>
                    <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5 truncate">
                      {p.member_email ? <><Mail size={10} className="inline mr-1" />{p.member_email}</>
                        : p.donor_email ? <><Mail size={10} className="inline mr-1" />{p.donor_email}</>
                        : <><UserIcon size={10} className="inline mr-1" />No email on file</>}
                    </p>
                  </div>
                  <div className="hidden sm:block text-right shrink-0 min-w-[110px]">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70">Pledged</p>
                    <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 tabular-nums">
                      {fmtCurrency(p.amount, unavailable)}<span className="text-ink-500 text-xs"> / {p.frequency.replace('_', ' ')}</span>
                    </p>
                  </div>
                  <div className="hidden md:block shrink-0 w-44">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70 mb-1">Fulfillment</p>
                    <FulfillmentBar fulfillment={p.fulfillment} unavailable={unavailable} />
                    <p className="text-[10px] text-ink-500 dark:text-parchment-300/70 mt-1 tabular-nums">
                      {fmtCurrency(p.matched_total, unavailable)} of {fmtCurrency(p.period_total, unavailable)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setModal(p)}
                      aria-label="Edit pledge"
                      className="p-2 rounded-lg text-ink-400 hover:text-church-700 dark:hover:text-brass-200 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removePledge(p)}
                      aria-label="Delete pledge"
                      className="p-2 rounded-lg text-ink-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </motion.div>
        )}

        {/* Show-cancelled toggle */}
        {pledges?.some(p => p.status === 'cancelled') && (
          <div className="text-center">
            <button
              type="button"
              onClick={() => setShowCancelled(s => !s)}
              className="text-xs font-medium text-ink-500 dark:text-parchment-300/70 hover:text-ink-700 dark:hover:text-parchment-100 transition-colors"
            >
              {showCancelled ? 'Hide cancelled' : 'Show cancelled pledges'}
            </button>
          </div>
        )}
      </div>

      <AnimatePresence>
        {modal && (
          <PledgeModal
            pledge={modal === 'new' ? null : modal}
            members={members}
            membersFailed={membersFailed}
            onClose={() => setModal(null)}
            onSaved={load}
          />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}
