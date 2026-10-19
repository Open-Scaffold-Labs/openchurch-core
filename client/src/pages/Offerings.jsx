// Offerings & Fees — the parish billing workbench (BILL.2).
//
// Two tabs over the BILL.0/BILL.1 API:
//   Invoices — the working list: compose a draft from the catalog (or ad
//     hoc), issue it (sequential number), record payments, waive (admin,
//     reason required), refund (admin), cancel, print.
//   Catalog  — the fee schedule the composer offers ("Wedding — church
//     use, $800, $400 parishioner").
//
// Vocabulary is doctrine-aware throughout: offerings and fees-for-use,
// never a sacrament with a price tag; waiving is presented as the normal
// pastoral act it is, not discount math. There is no dunning surface —
// no overdue flag, no red, nothing that nags a family.
//
// Roles: staff do the daily work (draft, issue, record); waive + refund
// render only for admins and are enforced server-side regardless.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  HandCoins, Plus, X, Printer, Loader2, ChevronRight,
  Trash2, ListPlus,
} from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { useAuth } from '../context/AuthContext'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadFailure from '../components/LoadFailure'
import { SkeletonRowList } from '../components/Skeleton'
import { useConfirm, usePrompt } from '../components/ConfirmProvider'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip } from '../components/MobileSheet'
import { loadList } from '../utils/format'

export const CATEGORIES = ['wedding', 'funeral', 'baptism', 'quinceanera', 'facility', 'stipend', 'other']
const METHODS = ['cash', 'check', 'card', 'online', 'other']

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

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// A missing amount is not $0.00. Pass `unavailable` for any figure that
// came from a read. A computed draft subtotal is always a real number.
function money(v, unavailable = '—') {
  const n = knownNumber(v)
  if (n == null) return unavailable
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function isInvoiceRow(row) {
  return isPlainObject(row) && positiveIntId(row.id) != null
}

function asInvoiceList(body) {
  if (!Array.isArray(body)) return null
  if (body.some(row => !isInvoiceRow(row))) return null
  return body
}

function isInvoiceDetail(body) {
  return isPlainObject(body)
    && positiveIntId(body.id) != null
    && Array.isArray(body.lines)
    && body.lines.every(isPlainObject)
    && Array.isArray(body.payments)
    && body.payments.every(isPlainObject)
}

function writeError(res, data, t) {
  const server = data && typeof data.error === 'string' ? data.error.trim() : ''
  if (res && res.status >= 400 && res.status < 500 && server && !/\b\d{3}\b/.test(server)) return server
  return t('err.save')
}

function savedId(data) {
  return positiveIntId(data?.id)
}

export const STATUS_TONE = {
  draft:          'bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-300/80',
  issued:         'bg-church-50 text-church-800 dark:bg-church-900/40 dark:text-brass-200',
  partially_paid: 'bg-amber-50 text-amber-800 dark:bg-amber-900/25 dark:text-amber-300',
  paid:           'bg-brass-50 text-brass-700 dark:bg-brass-900/25 dark:text-brass-300',
  waived:         'bg-brass-50 text-brass-700 dark:bg-brass-900/25 dark:text-brass-300',
  cancelled:      'bg-parchment-200 text-ink-500 dark:bg-ink-800 dark:text-parchment-300/70',
}

const inputCls = 'w-full rounded-lg border border-parchment-300 dark:border-brass-900/40 bg-white dark:bg-ink-900 px-2.5 py-2 text-sm text-ink-800 dark:text-parchment-100 focus:outline-none focus:ring-2 focus:ring-church-500/40 min-h-[40px]'
const btnPrimary = 'inline-flex items-center justify-center gap-2 rounded-lg bg-church-800 px-3.5 py-2 text-sm font-medium text-parchment-50 hover:bg-church-900 disabled:opacity-60 dark:bg-brass-700 dark:hover:bg-brass-600 min-h-[40px]'
const btnQuiet = 'inline-flex items-center justify-center gap-2 rounded-lg border border-parchment-300 dark:border-brass-900/40 px-3.5 py-2 text-sm text-ink-700 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800 disabled:opacity-60 min-h-[40px]'

function Badge({ status, t }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap ${STATUS_TONE[status] || STATUS_TONE.draft}`}>
      {t(`bil.status.${status}`)}
    </span>
  )
}

function FieldLabel({ children }) {
  return <span className="block text-[10px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70 mb-1">{children}</span>
}

/* ── The composer: a new draft ─────────────────────────────────────────── */

function ComposerSheet({ catalog, catalogFailed = false, members, membersFailed, onClose, onCreated }) {
  const { t } = useLocale()
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('other')
  const [clientId, setClientId] = useState('')
  const [payerName, setPayerName] = useState('')
  const [lines, setLines] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const activeCatalog = catalog.filter(f => f.active)
  const isMember = clientId !== ''

  function addFromCatalog(fee) {
    setLines(ls => [...ls, {
      fee_schedule_id: fee.id, description: fee.name, qty: 1,
      unit_amount: isMember && fee.parishioner_amount != null ? fee.parishioner_amount : fee.amount,
    }])
    if (!category || category === 'other') setCategory(fee.category)
  }
  const addBlank = () => setLines(ls => [...ls, { fee_schedule_id: null, description: '', qty: 1, unit_amount: '' }])
  const setLine = (i, k, v) => setLines(ls => ls.map((l, idx) => idx === i ? { ...l, [k]: v } : l))
  const dropLine = (i) => setLines(ls => ls.filter((_, idx) => idx !== i))

  // Re-price catalog lines when the payer flips member ↔ non-member, so
  // the parishioner amount is never silently kept for an outside payer.
  useEffect(() => {
    setLines(ls => ls.map(l => {
      if (!l.fee_schedule_id) return l
      const fee = catalog.find(f => f.id === l.fee_schedule_id)
      if (!fee) return l
      return { ...l, unit_amount: isMember && fee.parishioner_amount != null ? fee.parishioner_amount : fee.amount }
    }))
  }, [isMember]) // eslint-disable-line react-hooks/exhaustive-deps

  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_amount) || 0), 0)

  async function save() {
    setError('')
    if (!title.trim()) { setError(t('bil.needTitle')); return }
    if (!isMember && !payerName.trim()) { setError(t('bil.needPayer')); return }
    if (!lines.length) { setError(t('bil.needLine')); return }
    setBusy(true)
    try {
      let res
      try {
        res = await fetch(apiUrl('/api/invoices'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(), category,
            client_id: isMember ? Number(clientId) : null,
            payer_name: payerName.trim() || undefined,
            lines: lines.map((l, i) => ({
              fee_schedule_id: l.fee_schedule_id ?? undefined,
              description: l.description?.trim() || undefined,
              qty: Number(l.qty) || 1,
              unit_amount: l.unit_amount === '' ? undefined : Number(l.unit_amount),
              sort_order: i,
            })),
          }),
        })
      } catch {
        setError(t('err.save'))
        return
      }
      const data = await res.json().catch(() => ({}))
      const id = savedId(data)
      // A refused write, or a 200 that is not an invoice, leaves the draft
      // on screen. Closing the sheet would look like it was saved.
      if (!res.ok || id == null) {
        setError(writeError(res, data, t))
        return
      }
      onCreated(id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`${sheetOverlayCls} z-40`} onClick={onClose}>
      <div className={sheetPanelCls} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('bil.new')}>
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-5 py-3 border-b border-parchment-300/60 dark:border-brass-900/30">
          <h2 className="font-display text-lg font-semibold text-church-800 dark:text-brass-400">{t('bil.new')}</h2>
          <button onClick={onClose} aria-label={t('bil.close')} className="p-1.5 rounded-lg text-ink-500 hover:bg-parchment-200/70 dark:text-parchment-300/70 dark:hover:bg-ink-800"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <label className="block">
            <FieldLabel>{t('bil.fTitle')}</FieldLabel>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('bil.titlePh')} className={inputCls} />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <FieldLabel>{t('bil.fOccasion')}</FieldLabel>
              <select value={category} onChange={e => setCategory(e.target.value)} className={inputCls}>
                {CATEGORIES.map(c => <option key={c} value={c}>{t(`bil.cat.${c}`)}</option>)}
              </select>
            </label>
            <label className="block">
              <FieldLabel>{t('bil.fMember')}</FieldLabel>
              <select value={clientId} onChange={e => setClientId(e.target.value)} className={inputCls}>
                <option value="">{t('bil.notAMember')}</option>
                {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              {/* An empty <select> is indistinguishable from a parish with
                  no members. Say which one this is, rather than letting the
                  absence speak. */}
              {membersFailed && (
                <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400 leading-snug">
                  {t('bil.membersUnread')}
                </p>
              )}
            </label>
          </div>

          {!isMember && (
            <label className="block">
              <FieldLabel>{t('bil.fPayer')}</FieldLabel>
              <input value={payerName} onChange={e => setPayerName(e.target.value)} placeholder={t('bil.payerPh')} className={inputCls} />
            </label>
          )}
          {isMember && (
            <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('bil.memberPricing')}</p>
          )}

          {/* Catalog quick-adds */}
          {catalogFailed && (
            <p role="status" className="text-xs text-amber-800 dark:text-amber-300">{t('bil.catalogUnread')}</p>
          )}
          {activeCatalog.length > 0 && (
            <div>
              <FieldLabel>{t('bil.fromCatalog')}</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {activeCatalog.map(f => (
                  <button key={f.id} onClick={() => addFromCatalog(f)}
                    className="px-2.5 py-1.5 rounded-full text-xs border border-brass-200/70 bg-brass-50 text-brass-700 hover:bg-brass-100 dark:bg-brass-900/20 dark:text-brass-300 dark:border-brass-800/40 dark:hover:bg-brass-900/35 min-h-[32px]">
                    {f.name} · {money(isMember && f.parishioner_amount != null ? f.parishioner_amount : f.amount, t('money.unavailable'))}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Lines */}
          <div>
            <FieldLabel>{t('bil.fLines')}</FieldLabel>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={l.description} onChange={e => setLine(i, 'description', e.target.value)}
                    placeholder={t('bil.linePh')} aria-label={t('bil.lineDesc')} className={`${inputCls} flex-1`} />
                  <input value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} inputMode="numeric"
                    aria-label={t('bil.lineQty')} className={`${inputCls} w-14 text-center`} />
                  <input value={l.unit_amount} onChange={e => setLine(i, 'unit_amount', e.target.value)} inputMode="decimal"
                    placeholder="0.00" aria-label={t('bil.lineAmount')} className={`${inputCls} w-24 text-right`} />
                  <button onClick={() => dropLine(i)} aria-label={t('bil.removeLine')}
                    className="p-2 rounded-lg text-ink-400 hover:text-church-700 hover:bg-parchment-100 dark:text-parchment-300/70 dark:hover:text-brass-300 dark:hover:bg-ink-800 min-h-[40px] min-w-[40px]">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <button onClick={addBlank} className={`${btnQuiet} w-full`}><ListPlus size={15} /> {t('bil.addLine')}</button>
            </div>
          </div>

          <div className="flex items-baseline justify-between border-t border-parchment-300/60 dark:border-brass-900/30 pt-3">
            <span className="text-sm text-ink-600 dark:text-parchment-300/80">{t('bil.subtotal')}</span>
            <span className="font-display text-xl font-semibold text-ink-900 dark:text-parchment-50">{money(subtotal)}</span>
          </div>
          {error && <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-parchment-300/60 dark:border-brass-900/30 flex justify-end gap-2">
          <button onClick={onClose} className={btnQuiet}>{t('bil.cancelBtn')}</button>
          <button onClick={save} disabled={busy} className={btnPrimary}>
            {busy && <Loader2 size={14} className="animate-spin" />} {t('bil.saveDraft')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── The invoice detail sheet ──────────────────────────────────────────── */

function DetailSheet({ id, onClose, onChanged }) {
  const { t, dateLocale } = useLocale()
  const { isAdmin } = useAuth()
  const ask = useConfirm()
  const askFor = usePrompt()
  const [inv, setInv] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [payOpen, setPayOpen] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('cash')
  const [payDeposit, setPayDeposit] = useState(false)
  // A retry and the reload after a payment can be in flight together.
  // Only the latest request for this invoice may change the sheet.
  const loadGen = useRef(0)

  const load = useCallback(async () => {
    const gen = ++loadGen.current
    const requestedId = id
    setLoadFailed(false)
    try {
      const r = await fetch(apiUrl(`/api/invoices/${requestedId}`))
      if (gen !== loadGen.current) return
      if (!r.ok) throw new Error('unread')
      const body = await r.json()
      if (gen !== loadGen.current) return
      // No lines array is not an empty bill. A body for a different id
      // is not this sheet. Leave it unread.
      if (!isInvoiceDetail(body) || positiveIntId(body.id) !== positiveIntId(requestedId)) {
        throw new Error('shape')
      }
      setInv(body)
      setLoadFailed(false)
    } catch {
      if (gen !== loadGen.current) return
      setLoadFailed(true)
    }
  }, [id])
  useEffect(() => {
    load()
    return () => { loadGen.current += 1 }
  }, [load])

  async function act(label, path, body, confirmOpts) {
    if (confirmOpts) {
      const ok = await ask(confirmOpts)
      if (!ok) return
    }
    setBusy(label); setError('')
    try {
      let r
      try {
        r = await fetch(apiUrl(`/api/invoices/${id}${path}`), {
          method: path === '' ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        })
      } catch {
        setError(t('err.save'))
        return
      }
      const data = await r.json().catch(() => ({}))
      if (!r.ok || data?.ok !== true) {
        setError(writeError(r, data, t))
        return
      }
      if (path === '' ) { onChanged(); onClose(); return }
      await load(); onChanged()
    } finally {
      setBusy('')
    }
  }

  async function waive() {
    const reason = await askFor({
      title: t('bil.waiveTitle'),
      body: t('bil.waiveBody'),
      confirmLabel: t('bil.waiveConfirm'),
      placeholder: t('bil.waiveReasonPh'),
    })
    if (!reason) return
    act('waive', '/waive', { reason })
  }

  async function recordPayment() {
    const amt = Number(payAmount)
    if (!Number.isFinite(amt) || amt <= 0) { setError(t('bil.badAmount')); return }
    setBusy('pay'); setError('')
    try {
      let r
      try {
        r = await fetch(apiUrl(`/api/invoices/${id}/payments`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: amt, method: payMethod, is_deposit: payDeposit }),
        })
      } catch {
        setError(t('err.save'))
        return
      }
      const data = await r.json().catch(() => ({}))
      // No payment id means the amount was not recorded. Keep what was typed.
      if (!r.ok || savedId(data) == null) {
        setError(writeError(r, data, t))
        return
      }
      setPayOpen(false); setPayAmount(''); setPayDeposit(false)
      await load(); onChanged()
    } finally { setBusy('') }
  }

  const totalN = knownNumber(inv?.total)
  const paidN = knownNumber(inv?.amount_paid)
  const balance = totalN == null || paidN == null ? null : totalN - paidN
  const waivedN = knownNumber(inv?.waived_amount)
  const unavailable = t('money.unavailable')
  const isDraft = inv?.status === 'draft'
  const canPay = inv && ['issued', 'partially_paid'].includes(inv.status)
  const canWaive = isAdmin && inv && ['draft', 'issued', 'partially_paid'].includes(inv.status)
  const canCancel = inv && (isDraft || (inv.status === 'issued' && paidN === 0))

  return (
    <div className={`${sheetOverlayCls} z-40`} onClick={onClose}>
      <div className={sheetPanelCls} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('bil.detail')}>
        <MobileSheetGrip />
        {!inv ? (
          <div className="px-5 py-8">{loadFailed
            ? <LoadFailure body={t('bil.detailFailedBody')} onRetry={load} />
            : <div className="flex justify-center py-6"><Loader2 size={20} className="animate-spin text-brass-600" /></div>}</div>
        ) : (
          <>
            <div className="flex items-start justify-between px-5 py-3 border-b border-parchment-300/60 dark:border-brass-900/30">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">{inv.title}</h2>
                  <Badge status={inv.status} t={t} />
                </div>
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
                  {inv.invoice_no ? `${t('bil.no')} ${inv.invoice_no} · ` : `${t('bil.status.draft')} · `}
                  {t(`bil.cat.${inv.category}`)} · {inv.payer_member_name || inv.payer_name}
                  {inv.event_title ? ` · ${inv.event_title}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {!isDraft && inv.status !== 'cancelled' && (
                  <Link to={`/offerings/${inv.id}/print`} aria-label={t('bil.print')}
                    className="p-2 rounded-lg text-ink-500 hover:bg-parchment-200/70 dark:text-parchment-300/70 dark:hover:bg-ink-800 min-h-[40px] min-w-[40px] inline-flex items-center justify-center">
                    <Printer size={16} />
                  </Link>
                )}
                <button onClick={onClose} aria-label={t('bil.close')} className="p-2 rounded-lg text-ink-500 hover:bg-parchment-200/70 dark:text-parchment-300/70 dark:hover:bg-ink-800 min-h-[40px] min-w-[40px]"><X size={17} /></button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {loadFailed && (
                <LoadFailure variant="strip" body={t('bil.detailFailedBody')} onRetry={load} />
              )}
              {/* Lines */}
              <div>
                <FieldLabel>{t('bil.fLines')}</FieldLabel>
                <ul className="divide-y divide-parchment-200/70 dark:divide-brass-900/25">
                  {inv.lines.map(l => (
                    <li key={l.id} className="py-2 flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-ink-800 dark:text-parchment-100">
                        {l.description}
                        {Number(l.qty) !== 1 && <span className="text-ink-500 dark:text-parchment-300/70"> × {Number(l.qty)}</span>}
                        {l.pass_through && <span className="text-xs italic text-ink-500 dark:text-parchment-300/70"> · {t('bil.passThrough')}{l.payee ? ` — ${l.payee}` : ''}</span>}
                      </span>
                      <span className="text-ink-800 dark:text-parchment-100 whitespace-nowrap">{money(l.amount, unavailable)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Totals */}
              <div className="rounded-xl bg-parchment-100 dark:bg-ink-800/60 px-4 py-3 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-ink-600 dark:text-parchment-300/80">{t('bil.subtotal')}</span><span>{money(inv.subtotal, unavailable)}</span></div>
                {(waivedN == null || waivedN > 0) && (
                  <div className="flex justify-between text-brass-700 dark:text-brass-300">
                    <span>{t('bil.waivedLine')}{inv.waiver_reason ? ` — ${inv.waiver_reason}` : ''}</span>
                    <span>{waivedN == null ? unavailable : `−${money(inv.waived_amount)}`}</span>
                  </div>
                )}
                <div className="flex justify-between"><span className="text-ink-600 dark:text-parchment-300/80">{t('bil.received')}</span><span>{money(inv.amount_paid, unavailable)}</span></div>
                <div className="flex justify-between border-t border-parchment-300/60 dark:border-brass-900/30 pt-1.5 font-semibold text-ink-900 dark:text-parchment-50">
                  <span>{t('bil.balance')}</span><span>{balance == null ? unavailable : money(Math.max(balance, 0))}</span>
                </div>
              </div>

              {/* Payments */}
              {inv.payments.length > 0 && (
                <div>
                  <FieldLabel>{t('bil.payments')}</FieldLabel>
                  <ul className="divide-y divide-parchment-200/70 dark:divide-brass-900/25">
                    {inv.payments.map(p => (
                      <li key={p.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                        <span className={p.refunded_at ? 'line-through text-ink-400 dark:text-parchment-300/70' : 'text-ink-800 dark:text-parchment-100'}>
                          {money(p.amount, unavailable)} · {t(`bil.method.${p.method}`)}
                          {p.is_deposit && ` · ${t('bil.deposit')}`}
                          <span className="text-xs text-ink-500 dark:text-parchment-300/70"> · {new Date(p.received_at).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })}</span>
                          {p.refunded_at && <span className="text-xs italic"> · {t('bil.refunded')}</span>}
                        </span>
                        {isAdmin && !p.refunded_at && (
                          <button onClick={() => act('refund', `/payments/${p.id}/refund`, {}, {
                            title: t('bil.refundTitle'), body: t('bil.refundBody'), confirmLabel: t('bil.refundConfirm'),
                          })} disabled={!!busy}
                            className="text-xs underline text-church-700 dark:text-brass-300 min-h-[32px]">
                            {t('bil.refund')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Record payment */}
              {canPay && (payOpen ? (
                <div className="rounded-xl border border-parchment-300/70 dark:border-brass-900/30 p-3 space-y-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="block flex-1 min-w-[7rem]">
                      <FieldLabel>{t('bil.amount')}</FieldLabel>
                      <input value={payAmount} onChange={e => setPayAmount(e.target.value)} inputMode="decimal"
                        placeholder={balance == null ? '' : Math.max(balance, 0).toFixed(2)} className={inputCls} />
                    </label>
                    <label className="block">
                      <FieldLabel>{t('bil.methodLabel')}</FieldLabel>
                      <select value={payMethod} onChange={e => setPayMethod(e.target.value)} className={inputCls}>
                        {METHODS.map(m => <option key={m} value={m}>{t(`bil.method.${m}`)}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-ink-700 dark:text-parchment-200">
                    <input type="checkbox" checked={payDeposit} onChange={e => setPayDeposit(e.target.checked)} className="accent-[#7B2D26] w-4 h-4" />
                    {t('bil.isDeposit')}
                  </label>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setPayOpen(false)} className={btnQuiet}>{t('bil.cancelBtn')}</button>
                    <button onClick={recordPayment} disabled={busy === 'pay'} className={btnPrimary}>
                      {busy === 'pay' && <Loader2 size={14} className="animate-spin" />} {t('bil.recordPayment')}
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => { setPayAmount(balance == null ? '' : String(Math.max(balance, 0).toFixed(2))); setPayOpen(true) }} className={`${btnPrimary} w-full`}>
                  {t('bil.recordPayment')}
                </button>
              ))}

              {error && <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p>}
            </div>

            {/* Footer actions by state */}
            <div className="px-5 py-3 border-t border-parchment-300/60 dark:border-brass-900/30 flex flex-wrap justify-end gap-2">
              {isDraft && (
                <>
                  <button onClick={() => act('delete', '', null, {
                    title: t('bil.deleteTitle'), body: t('bil.deleteBody'), confirmLabel: t('bil.deleteConfirm'), tone: 'danger',
                  })} disabled={!!busy} className={btnQuiet}>{t('bil.deleteDraft')}</button>
                  <button onClick={() => act('issue', '/issue', {}, {
                    title: t('bil.issueTitle'), body: t('bil.issueBody'), confirmLabel: t('bil.issueConfirm'),
                  })} disabled={!!busy} className={btnPrimary}>
                    {busy === 'issue' && <Loader2 size={14} className="animate-spin" />} {t('bil.issue')}
                  </button>
                </>
              )}
              {canCancel && !isDraft && (
                <button onClick={() => act('cancel', '/cancel', {}, {
                  title: t('bil.cancelTitle'), body: t('bil.cancelBody'), confirmLabel: t('bil.cancelConfirm'),
                })} disabled={!!busy} className={btnQuiet}>{t('bil.cancelInvoice')}</button>
              )}
              {canWaive && (
                <button onClick={waive} disabled={!!busy} className={btnQuiet}>{t('bil.waive')}</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ── The catalog tab (fee schedule) ────────────────────────────────────── */

function CatalogTab({ catalog, catalogState, reload }) {
  const catalogFailed = catalogState === 'failed'
  // R301-1: new or edited items are only saved once the catalog is known.
  const ready = catalogState === 'ok'
  const { t } = useLocale()
  const ask = useConfirm()
  const [form, setForm] = useState(null) // null | {} | {id,...}
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setError('')
    // Typed values stay in the form; save waits until the catalog is known.
    if (!ready) { setError(t('bil.catalogUnread')); return }
    if (!form.name?.trim()) { setError(t('bil.needName')); return }
    setBusy(true)
    try {
      const isEdit = !!form.id
      const r = await fetch(apiUrl(`/api/fee-schedules${isEdit ? `/${form.id}` : ''}`), {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          category: form.category || 'other',
          amount: Number(form.amount) || 0,
          parishioner_amount: form.parishioner_amount === '' || form.parishioner_amount == null ? null : Number(form.parishioner_amount),
          deposit_amount: form.deposit_amount === '' || form.deposit_amount == null ? null : Number(form.deposit_amount),
          pass_through: !!form.pass_through,
          default_payee: form.default_payee?.trim() || null,
          active: form.active !== false,
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || t('bil.saveError'))
      setForm(null); reload()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function remove(fee) {
    const ok = await ask({
      title: t('bil.feeRemoveTitle'),
      body: t('bil.feeRemoveBody'),
      confirmLabel: t('bil.feeRemoveConfirm'),
    })
    if (!ok) return
    const r = await fetch(apiUrl(`/api/fee-schedules/${fee.id}`), { method: 'DELETE' })
    if (r.ok) reload()
  }

  const byCategory = useMemo(() => {
    const g = new Map()
    for (const f of catalog) {
      if (!g.has(f.category)) g.set(f.category, [])
      g.get(f.category).push(f)
    }
    return [...g.entries()]
  }, [catalog])

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-600 dark:text-parchment-300/80 max-w-2xl">{t('bil.catalogIntro')}</p>

      {byCategory.map(([cat, items]) => (
        <div key={cat}>
          <FieldLabel>{t(`bil.cat.${cat}`)}</FieldLabel>
          <div className="space-y-2">
            {items.map(f => (
              <div key={f.id} className={`rounded-xl border border-parchment-300/70 dark:border-brass-900/30 bg-white/70 dark:bg-ink-800/60 px-4 py-3 flex flex-wrap items-center gap-3 ${f.active ? '' : 'opacity-60'}`}>
                <span className="flex-1 min-w-0 text-sm text-ink-800 dark:text-parchment-100">
                  {f.name}
                  {!f.active && <span className="text-xs italic text-ink-500 dark:text-parchment-300/70"> · {t('bil.inactive')}</span>}
                  {f.pass_through && <span className="text-xs italic text-ink-500 dark:text-parchment-300/70"> · {t('bil.passThrough')}</span>}
                </span>
                <span className="text-sm text-ink-800 dark:text-parchment-100 whitespace-nowrap">
                  {money(f.amount, t('money.unavailable'))}
                  {f.parishioner_amount != null && <span className="text-xs text-brass-700 dark:text-brass-300"> · {money(f.parishioner_amount, t('money.unavailable'))} {t('bil.parishioner')}</span>}
                </span>
                <span className="flex gap-1">
                  <button onClick={() => setForm({ ...f })} className="text-xs underline text-church-700 dark:text-brass-300 min-h-[32px] px-1">{t('bil.edit')}</button>
                  <button onClick={() => remove(f)} className="text-xs underline text-ink-500 dark:text-parchment-300/70 min-h-[32px] px-1">{t('bil.removeFee')}</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {catalogFailed ? (
        <p role="status" className="text-sm text-amber-800 dark:text-amber-300 text-center py-10">{t('bil.catalogUnread')}</p>
      ) : !ready ? (
        <SkeletonRowList count={3} withAvatar={false} />
      ) : catalog.length === 0 && (
        <EmptyState icon={HandCoins} title={t('bil.catalogEmptyTitle')} body={t('bil.catalogEmptyBody')} />
      )}

      {form ? (
        <div className="rounded-xl border border-parchment-300/70 dark:border-brass-900/30 p-4 space-y-3 max-w-xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block sm:col-span-2">
              <FieldLabel>{t('bil.feeName')}</FieldLabel>
              <input value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t('bil.feeNamePh')} className={inputCls} />
            </label>
            <label className="block">
              <FieldLabel>{t('bil.fOccasion')}</FieldLabel>
              <select value={form.category ?? 'other'} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className={inputCls}>
                {CATEGORIES.map(c => <option key={c} value={c}>{t(`bil.cat.${c}`)}</option>)}
              </select>
            </label>
            <label className="block">
              <FieldLabel>{t('bil.standardAmount')}</FieldLabel>
              <input value={form.amount ?? ''} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} inputMode="decimal" className={inputCls} />
            </label>
            <label className="block">
              <FieldLabel>{t('bil.parishionerAmount')}</FieldLabel>
              <input value={form.parishioner_amount ?? ''} onChange={e => setForm(f => ({ ...f, parishioner_amount: e.target.value }))} inputMode="decimal" placeholder={t('bil.sameForAll')} className={inputCls} />
            </label>
            <label className="block">
              <FieldLabel>{t('bil.depositAmount')}</FieldLabel>
              <input value={form.deposit_amount ?? ''} onChange={e => setForm(f => ({ ...f, deposit_amount: e.target.value }))} inputMode="decimal" placeholder={t('bil.optional')} className={inputCls} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-700 dark:text-parchment-200">
            <input type="checkbox" checked={!!form.pass_through} onChange={e => setForm(f => ({ ...f, pass_through: e.target.checked }))} className="accent-[#7B2D26] w-4 h-4" />
            {t('bil.passThroughHelp')}
          </label>
          {form.pass_through && (
            <label className="block max-w-xs">
              <FieldLabel>{t('bil.payee')}</FieldLabel>
              <input value={form.default_payee ?? ''} onChange={e => setForm(f => ({ ...f, default_payee: e.target.value }))} placeholder={t('bil.payeePh')} className={inputCls} />
            </label>
          )}
          {form.id && (
            <label className="flex items-center gap-2 text-sm text-ink-700 dark:text-parchment-200">
              <input type="checkbox" checked={form.active !== false} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="accent-[#7B2D26] w-4 h-4" />
              {t('bil.activeHelp')}
            </label>
          )}
          {error && <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => { setForm(null); setError('') }} className={btnQuiet}>{t('bil.cancelBtn')}</button>
            <button onClick={save} disabled={busy || !ready} className={btnPrimary}>
              {busy && <Loader2 size={14} className="animate-spin" />} {form.id ? t('bil.saveItem') : t('bil.addItem')}
            </button>
          </div>
        </div>
      ) : ready && (
        // No add until the catalog is known: it could duplicate a fee that exists.
        <button onClick={() => setForm({})} className={btnQuiet}><Plus size={15} /> {t('bil.addItem')}</button>
      )}
    </div>
  )
}

/* ── The page ──────────────────────────────────────────────────────────── */

export default function Offerings() {
  const { t, dateLocale } = useLocale()
  const [tab, setTab] = useState('invoices')
  const [invoices, setInvoices] = useState(null)
  // 'loading' until a list read settles. Failure is not an empty parish.
  const [invoiceState, setInvoiceState] = useState('loading') // loading | ok | failed
  const [catalog, setCatalog] = useState([])
  // A refused fee schedule must not look like a parish with no offerings.
  // 'loading' until the first catalog read settles; a reload keeps the last
  // settled state until its own result arrives.
  const [catalogState, setCatalogState] = useState('loading') // loading | ok | failed
  const catalogFailed = catalogState === 'failed'
  const [members, setMembers] = useState([])
  // Distinguishes an empty roster from a roster we could not load.
  const [membersFailed, setMembersFailed] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [detailId, setDetailId] = useState(null)

  const loadGen = useRef(0)
  const load = useCallback(async () => {
    // Latest-request guard: a slower, older load (e.g. before a status
    // filter change) must not overwrite a newer one.
    const gen = ++loadGen.current
    const params = new URLSearchParams({ limit: '200' })
    if (statusFilter) params.set('status', statusFilter)
    // R301-1: the two reads settle independently. A rejected invoice fetch
    // must not discard a returned catalog, and a rejected catalog fetch must
    // still mark the catalog unread.
    const readCatalog = async () => {
      const rc = await fetch(apiUrl('/api/fee-schedules'))
      if (!rc.ok) throw new Error('catalog')
      const cat = await rc.json()
      if (!Array.isArray(cat)) throw new Error('catalog')
      return cat
    }
    const readInvoices = async () => {
      const ri = await fetch(apiUrl(`/api/invoices?${params}`))
      if (!ri.ok) throw new Error('unread')
      const body = await ri.json()
      const list = asInvoiceList(body)
      if (!list) throw new Error('shape')
      return list
    }
    const [inv, cat] = await Promise.allSettled([readInvoices(), readCatalog()])
    if (gen !== loadGen.current) return
    // The fee schedule is its own fact. A refused catalog used to become
    // [] and the tab said "No catalog items yet".
    if (cat.status === 'fulfilled') { setCatalog(cat.value); setCatalogState('ok') }
    else { setCatalog([]); setCatalogState('failed') }
    // A refused invoice list used to become [] and the tab said
    // "No invoices yet", and a missing total became $0.00.
    if (inv.status === 'fulfilled') { setInvoices(inv.value); setInvoiceState('ok') }
    else { setInvoices([]); setInvoiceState('failed') }
  }, [statusFilter])
  useEffect(() => { setInvoices(null); setInvoiceState('loading'); load() }, [load])

  useEffect(() => {
    // An empty picker reads as "you have no members", not as "this did not
    // load" — and the person seeing it is midway through recording somebody's
    // giving. Track the difference so the control can say which it is.
    loadList(apiUrl('/api/clients')).then(({ ok, data }) => {
      setMembers(data)
      setMembersFailed(!ok)
    })
  }, [])

  return (
    <PageWrapper>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="font-display text-2xl font-semibold text-church-900 dark:text-parchment-50">{t('bil.title')}</h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-0.5">{t('bil.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'invoices' && (
            <>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label={t('bil.filterStatus')} className={`${inputCls} w-auto`}>
                <option value="">{t('bil.allStatuses')}</option>
                {Object.keys(STATUS_TONE).map(s => <option key={s} value={s}>{t(`bil.status.${s}`)}</option>)}
              </select>
              <button onClick={() => setComposerOpen(true)} disabled={invoiceState !== 'ok'} className={btnPrimary}><Plus size={15} /> {t('bil.new')}</button>
            </>
          )}
        </div>
      </div>

      <div className="mb-4 flex gap-2">
        {['invoices', 'catalog'].map(k => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3.5 py-2 rounded-lg text-sm min-h-[40px] transition-colors ${tab === k
              ? 'bg-church-800 text-parchment-50 dark:bg-brass-700'
              : 'bg-parchment-200/70 text-ink-700 hover:bg-parchment-300/70 dark:bg-ink-800 dark:text-parchment-200 dark:hover:bg-ink-700'}`}>
            {t(`bil.tab.${k}`)}
          </button>
        ))}
      </div>

      {tab === 'catalog' ? (
        <CatalogTab catalog={catalog} catalogState={catalogState} reload={load} />
      ) : invoiceState === 'loading' || invoices == null ? (
        <SkeletonRowList count={5} withAvatar={false} />
      ) : invoiceState !== 'ok' || !Array.isArray(invoices) ? (
        <LoadFailure body={t('bil.listFailedBody')} onRetry={load} />
      ) : invoices.length === 0 ? (
        <EmptyState icon={HandCoins} title={t('bil.emptyTitle')} body={t('bil.emptyBody')} />
      ) : (
        <div className="space-y-2">
          {invoices.map(inv => {
            const totalN = knownNumber(inv.total)
            const paidN = knownNumber(inv.amount_paid)
            const balance = totalN == null || paidN == null ? null : totalN - paidN
            return (
              <button key={inv.id} onClick={() => setDetailId(inv.id)}
                className="w-full text-left rounded-xl border border-parchment-300/70 dark:border-brass-900/30 bg-white/70 dark:bg-ink-800/60 px-4 py-3 flex flex-wrap items-center gap-3 hover:bg-parchment-100 dark:hover:bg-ink-800">
                <Badge status={inv.status} t={t} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-ink-800 dark:text-parchment-100 truncate">
                    {inv.invoice_no ? `${inv.invoice_no} · ` : ''}{inv.title}
                  </span>
                  <span className="block text-xs text-ink-500 dark:text-parchment-300/70 truncate">
                    {inv.payer_member_name || inv.payer_name}
                    {inv.event_title ? ` · ${inv.event_title}` : ''}
                    {` · ${new Date(inv.created_at).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })}`}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block text-sm font-medium text-ink-900 dark:text-parchment-50">{money(inv.total, t('money.unavailable'))}</span>
                  {['issued', 'partially_paid'].includes(inv.status) && balance != null && balance > 0 && (
                    <span className="block text-xs text-ink-500 dark:text-parchment-300/70">{t('bil.balanceShort')} {money(balance)}</span>
                  )}
                </span>
                <ChevronRight size={15} className="text-ink-400 shrink-0" aria-hidden="true" />
              </button>
            )
          })}
        </div>
      )}

      {composerOpen && (
        <ComposerSheet catalog={catalog} catalogFailed={catalogFailed} members={members} membersFailed={membersFailed}
          onClose={() => setComposerOpen(false)}
          onCreated={(id) => { setComposerOpen(false); load(); setDetailId(id) }} />
      )}
      {detailId && (
        <DetailSheet id={detailId} onClose={() => setDetailId(null)} onChanged={load} />
      )}
    </PageWrapper>
  )
}
