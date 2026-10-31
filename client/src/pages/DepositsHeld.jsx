// Deposits held (migration 130). Event deposits sit in 2300 Deposits Held
// until staff confirm, on the event day, which invoice lines they pay for.
// Nothing is applied automatically. Refunds, forfeits and reversals are
// requests a second admin approves. A parish with one admin approves its
// own request only with a typed reason. A figure that did not load shows
// as unavailable, never as $0.00.
import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { useAuth } from '../context/AuthContext'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import LoadFailure from '../components/LoadFailure'

function money(v, unavailable) {
  if (v == null || v === '') return unavailable
  const n = Number(v)
  if (!Number.isFinite(n)) return unavailable
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function call(path, method = 'GET', body) {
  let r
  try {
    r = await fetch(apiUrl(path), {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch { return { ok: false, status: 0, data: {} } }
  const data = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, data }
}

const newKey = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`)

function ApplyForm({ dep, onDone, t }) {
  const unavailable = t('money.unavailable')
  const [lines, setLines] = useState(null)
  const [amounts, setAmounts] = useState({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [key] = useState(newKey)
  useEffect(() => {
    call(`/api/invoices/${dep.invoice_id}`).then(({ ok, data }) => {
      if (!ok || !Array.isArray(data?.lines)) { setErr(t('dep.linesFailed')); return }
      setLines(data.lines.filter(l => !l.pass_through))
    })
  }, [dep.invoice_id, t])
  async function submit() {
    const allocations = Object.entries(amounts)
      .filter(([, v]) => Number(v) > 0).map(([id, v]) => ({ line_id: Number(id), amount: Number(v) }))
    if (!allocations.length) { setErr(t('dep.applyNeedAmount')); return }
    setBusy(true); setErr('')
    const { ok, data } = await call(`/api/deposits/payments/${dep.payment_id}/apply`, 'POST', { allocations, idempotency_key: key })
    setBusy(false)
    if (!ok) { setErr(data?.error || t('err.save')); return }
    onDone()
  }
  if (!lines) return <p className="text-sm">{err || t('dep.loading')}</p>
  return (
    <div className="space-y-2 rounded-xl border border-parchment-300/70 p-3">
      <p className="text-xs text-ink-600">{t('dep.applyHelp')}</p>
      {lines.map(l => (
        <label key={l.id} className="flex items-center justify-between gap-2 text-sm">
          <span>{l.description} · {money(l.amount, unavailable)} · {l.account_code || t('dep.noAccount')}</span>
          <input type="number" min="0" step="0.01" aria-label={t('dep.applyAmount')}
            className="w-28 rounded border px-2 py-1" value={amounts[l.id] ?? ''}
            onChange={e => setAmounts(a => ({ ...a, [l.id]: e.target.value }))} />
        </label>
      ))}
      {err && <p role="alert" className="text-sm text-rose-700">{err}</p>}
      <button onClick={submit} disabled={busy} className="rounded-lg bg-church-700 px-3 py-1.5 text-sm text-parchment-50">
        {t('dep.applyConfirm')}
      </button>
    </div>
  )
}

function RequestForm({ dep, kind, onDone, t }) {
  const [amount, setAmount] = useState(dep.held)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  async function submit() {
    if (!reason.trim()) { setErr(t('dep.reasonRequired')); return }
    const { ok, data } = await call(`/api/deposits/payments/${dep.payment_id}/requests`, 'POST',
      { kind, amount: Number(amount), reason: reason.trim() })
    if (!ok) { setErr(data?.error || t('err.save')); return }
    onDone()
  }
  return (
    <div className="space-y-2 rounded-xl border border-parchment-300/70 p-3">
      <p className="text-xs text-ink-600">{kind === 'refund' ? t('dep.refundHelp') : t('dep.forfeitHelp')}</p>
      <input type="number" min="0" step="0.01" aria-label={t('dep.requestAmount')} value={amount}
        onChange={e => setAmount(e.target.value)} className="w-28 rounded border px-2 py-1 text-sm" />
      <input type="text" aria-label={t('dep.reason')} placeholder={t('dep.reason')} value={reason}
        onChange={e => setReason(e.target.value)} className="w-full rounded border px-2 py-1 text-sm" />
      {err && <p role="alert" className="text-sm text-rose-700">{err}</p>}
      <button onClick={submit} className="rounded-lg bg-church-700 px-3 py-1.5 text-sm text-parchment-50">{t('dep.requestSend')}</button>
    </div>
  )
}

export default function DepositsHeld() {
  const { t } = useLocale()
  const { isAdmin } = useAuth()
  const unavailable = t('money.unavailable')
  const [sched, setSched] = useState(null)
  const [reqs, setReqs] = useState(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(null)
  const [msg, setMsg] = useState('')
  const [soloReason, setSoloReason] = useState({})

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([call('/api/deposits/schedule'), call('/api/deposits/requests?status=pending')])
    if (!s.ok) { setFailed(true); return }
    setFailed(false); setSched(s.data); setReqs(r.ok ? r.data.requests : null); setOpen(null)
  }, [])
  useEffect(() => { load() }, [load])

  async function decide(req, verb) {
    setMsg('')
    const body = verb === 'approve' && soloReason[req.id]?.trim() ? { single_admin_reason: soloReason[req.id].trim() } : {}
    const { ok, data } = await call(`/api/deposits/requests/${req.id}/${verb}`, 'POST', body)
    if (!ok) { setMsg(data?.error || t('err.save')); return }
    load()
  }

  if (failed) return <PageWrapper type="list" title={t('dep.title')}><LoadFailure onRetry={load} /></PageWrapper>
  if (!sched) return <PageWrapper type="list" title={t('dep.title')}><p>{t('dep.loading')}</p></PageWrapper>
  const tot = sched.totals || {}
  return (
    <PageWrapper type="list">
      <PageHeader title={t('dep.title')} />
      <p className="mb-3 text-sm text-ink-600">{t('dep.intro')}</p>
      <section aria-label={t('dep.reconTitle')} className="mb-4 rounded-xl border p-3 text-sm">
        <div className="flex justify-between"><span>{t('dep.scheduleTotal')}</span><span>{money(tot.held, unavailable)}</span></div>
        <div className="flex justify-between"><span>{t('dep.ledgerTotal')}</span><span>{money(tot.ledger_2300, unavailable)}</span></div>
        <div className="flex justify-between"><span>{t('dep.otherEntries')}</span><span>{money(tot.other_entries_on_2300, unavailable)}</span></div>
        <div className="flex justify-between font-semibold"><span>{t('dep.difference')}</span><span>{money(tot.difference, unavailable)}</span></div>
        <p className="mt-1 text-xs">
          {tot.reconciled == null ? t('dep.reconUnknown') : tot.reconciled ? t('dep.reconOk') : t('dep.reconOff')}
        </p>
      </section>

      {sched.deposits.length === 0 ? <p className="text-sm">{t('dep.empty')}</p> : (
        <ul className="divide-y">
          {sched.deposits.map(d => (
            <li key={d.payment_id} className="space-y-1 py-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">{d.invoice_no} · {d.title}</span>
                <span>{t('dep.held')}: {money(d.held, unavailable)}</span>
              </div>
              <div className="text-xs text-ink-600">
                {d.payer_name} · {d.event_date || t('dep.noEventDate')} · {t('dep.received')} {money(d.received, unavailable)}
                {' · '}{t('dep.applied')} {money(d.applied, unavailable)} · {t('dep.refunded')} {money(d.refunded, unavailable)}
                {' · '}{t('dep.forfeited')} {money(d.forfeited, unavailable)}
              </div>
              {d.stale && <p className="text-xs text-amber-800">{t('dep.stale')}</p>}
              {d.cancelled_unresolved && <p className="text-xs text-amber-800">{t('dep.cancelled')}</p>}
              {Number(d.held) > 0 && (
                <div className="flex flex-wrap gap-3 text-xs">
                  <button className="underline" onClick={() => setOpen({ id: d.payment_id, kind: 'apply' })}>{t('dep.apply')}</button>
                  <button className="underline" onClick={() => setOpen({ id: d.payment_id, kind: 'refund' })}>{t('dep.requestRefund')}</button>
                  <button className="underline" onClick={() => setOpen({ id: d.payment_id, kind: 'forfeit' })}>{t('dep.requestForfeit')}</button>
                </div>
              )}
              {open?.id === d.payment_id && (open.kind === 'apply'
                ? <ApplyForm dep={d} onDone={load} t={t} />
                : <RequestForm dep={d} kind={open.kind} onDone={load} t={t} />)}
            </li>
          ))}
        </ul>
      )}

      <section aria-label={t('dep.pendingTitle')} className="mt-6">
        <h2 className="mb-2 font-semibold">{t('dep.pendingTitle')}</h2>
        {msg && <p role="alert" className="text-sm text-rose-700">{msg}</p>}
        {reqs == null ? <p className="text-sm">{t('dep.requestsFailed')}</p>
          : reqs.length === 0 ? <p className="text-sm">{t('dep.noPending')}</p> : (
          <ul className="divide-y">
            {reqs.map(r => (
              <li key={r.id} className="space-y-1 py-2 text-sm">
                <div>{t(`dep.kind.${r.kind}`)} · {money(r.amount, unavailable)} · {r.reason}</div>
                {isAdmin && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <input type="text" aria-label={t('dep.soloReason')} placeholder={t('dep.soloReason')}
                      value={soloReason[r.id] || ''} onChange={e => setSoloReason(s => ({ ...s, [r.id]: e.target.value }))}
                      className="min-w-[12rem] flex-1 rounded border px-2 py-1" />
                    <button className="underline" onClick={() => decide(r, 'approve')}>{t('dep.approve')}</button>
                    <button className="underline" onClick={() => decide(r, 'reject')}>{t('dep.reject')}</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {isAdmin && <p className="mt-2 text-xs text-ink-600">{t('dep.secondAdminNote')}</p>}
      </section>
    </PageWrapper>
  )
}
