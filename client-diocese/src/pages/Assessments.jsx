import { useEffect, useState } from 'react'
import { Loader2, Plus, Download, RefreshCw } from 'lucide-react'
import { apiUrl } from '../api'
import { useConfirm, usePrompt } from '../components/ConfirmProvider'

// Assessments (DIO.4): the cathedraticum as arithmetic. Create a year at
// a rate, bases fill themselves from approved submissions, hardship
// overrides and payments are per-line, and publishing freezes the bill.

const fmtMoney = v => Number(v ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const pct = bps => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`
const STATUS_CLS = {
  draft:     'bg-parchment-200/80 text-ink-700',
  published: 'bg-brass-50 text-brass-700 border border-brass-200/70',
  closed:    'bg-parchment-100 text-ink-400',
  pending:   'bg-parchment-200/80 text-ink-600',
  partial:   'bg-brass-50 text-brass-700 border border-brass-200/70',
  paid:      'bg-brass-100/80 text-brass-800',
  waived:    'bg-parchment-100 text-ink-400',
}

export default function Assessments() {
  const ask = useConfirm()
  const askFor = usePrompt()
  const [years, setYears] = useState(null)
  const [selected, setSelected] = useState(null) // detail object
  const [form, setForm] = useState({ fiscal_year: String(new Date().getFullYear()), rate_pct: '8' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadYears = () => {
    fetch(apiUrl('/api/diocese/assessments'))
      .then(r => r.json())
      .then(d => setYears(d.assessments ?? []))
      .catch(() => setYears([]))
  }
  useEffect(loadYears, [])

  const open = (id) => {
    setSelected(null)
    fetch(apiUrl(`/api/diocese/assessments/${id}`))
      .then(r => r.json())
      .then(setSelected)
      .catch(() => setError('Failed to open the assessment'))
  }

  const act = async (path, method, body) => {
    setBusy(true); setError('')
    try {
      const res = await fetch(apiUrl(path), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'That failed — nothing was lost.')
      loadYears()
      if (d.id && d.lines) setSelected(d)
      return d
    } catch (err) { setError(err.message); return null } finally { setBusy(false) }
  }

  const create = async (e) => {
    e.preventDefault()
    const bps = Math.round(Number(form.rate_pct) * 100)
    const d = await act('/api/diocese/assessments', 'POST', { fiscal_year: form.fiscal_year, rate_bps: bps })
    if (d) setSelected(d)
  }

  const overrideRate = async (line) => {
    const v = await askFor({
      title: `Hardship override for ${line.parish_name}`,
      body: 'The new rate applies to this parish for this year only. The roll records it as an override.',
      inputLabel: 'New rate (%)',
      inputType: 'number',
      defaultValue: pct(line.rate_bps).replace('%', ''),
      confirmLabel: 'Apply override',
      required: true,
    })
    if (v == null || v === '') return
    await act(`/api/diocese/assessments/${selected.id}/lines/${line.id}`, 'PATCH', { rate_bps: Math.round(Number(v) * 100), note: 'Rate override' })
  }
  const recordPayment = async (line) => {
    const v = await askFor({
      title: `Record a payment from ${line.parish_name}`,
      inputLabel: 'Amount ($)',
      inputType: 'number',
      confirmLabel: 'Record payment',
      required: true,
    })
    if (v == null || v === '') return
    await act(`/api/diocese/assessments/${selected.id}/lines/${line.id}`, 'PATCH', { record_payment: Number(v) })
  }
  const waive = async (line) => {
    if (!(await ask({
      title: `Waive the ${selected.fiscal_year} assessment for ${line.parish_name}?`,
      body: 'The parish owes nothing for this year. The line stays on the roll, marked waived.',
      confirmLabel: 'Waive assessment',
    }))) return
    await act(`/api/diocese/assessments/${selected.id}/lines/${line.id}`, 'PATCH', { status: 'waived' })
  }

  const exportCsv = () => {
    if (!selected?.lines) return
    const rows = [['parish', 'base', 'rate', 'assessed', 'paid', 'status'].join(',')]
    for (const l of selected.lines) {
      rows.push([`"${l.parish_name.replaceAll('"', '""')}"`, l.base, pct(l.rate_bps), l.assessed, l.paid, l.status].join(','))
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `assessment-${selected.fiscal_year}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const inputCls = 'px-3 py-2 text-sm rounded-lg border border-parchment-300 bg-parchment-50 text-ink-900 focus:outline-none focus:ring-2 focus:ring-brass-400'

  return (
    <div className="max-w-6xl">
      <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">Assessments</h1>
      <p className="text-sm text-ink-500 mb-6">Rate × the assessable base from approved submissions. Overrides and waivers are per-parish; publishing freezes the year as the authoritative bill.</p>
      {error && <p className="text-sm text-rose-700 mb-3">{error}</p>}

      <form onSubmit={create} className="flex items-center gap-2 mb-6 flex-wrap">
        <input type="text" value={form.fiscal_year} onChange={e => setForm(f => ({ ...f, fiscal_year: e.target.value }))}
          className={`${inputCls} w-24`} aria-label="Fiscal year" placeholder="2026" />
        <div className="flex items-center gap-1">
          <input type="number" step="0.25" min="0" max="30" value={form.rate_pct}
            onChange={e => setForm(f => ({ ...f, rate_pct: e.target.value }))}
            className={`${inputCls} w-24`} aria-label="Rate percent" />
          <span className="text-sm text-ink-500">%</span>
        </div>
        <button type="submit" disabled={busy}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-church-600 text-parchment-50 hover:bg-church-700 disabled:opacity-60">
          <Plus size={14} /> New assessment year
        </button>
      </form>

      {years === null ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-brass-500" /></div>
      ) : years.length === 0 ? (
        <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 p-8 text-center text-sm text-ink-500">
          No assessment years yet. Create one above — every affiliated parish
          with approved submissions in that year gets a line automatically.
        </div>
      ) : (
        <div className="flex gap-2 mb-6 flex-wrap">
          {years.map(y => (
            <button key={y.id} onClick={() => open(y.id)}
              className={`px-4 py-2 rounded-xl border text-sm transition-colors ${
                selected?.id === y.id ? 'border-church-600 bg-parchment-50' : 'border-parchment-300 bg-parchment-50 hover:border-brass-400'
              }`}>
              <span className="font-serif font-bold text-church-600">{y.fiscal_year}</span>
              <span className="ml-2 text-ink-500">{pct(y.rate_bps)}</span>
              <span className={`ml-2 inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_CLS[y.status] ?? ''}`}>{y.status}</span>
              <span className="block text-[11px] text-ink-500 mt-0.5">{fmtMoney(y.total_paid)} of {fmtMoney(y.total_assessed)} collected</span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-parchment-300/60 flex-wrap">
            <p className="text-sm text-ink-700">
              <span className="font-serif font-bold text-church-600 text-lg">{selected.fiscal_year}</span>
              <span className="ml-2">at {pct(selected.rate_bps)}</span>
              <span className="ml-3 text-ink-500">Assessed {fmtMoney(selected.totals.assessed)} · Collected {fmtMoney(selected.totals.paid)}</span>
            </p>
            <div className="flex items-center gap-2">
              {selected.status === 'draft' && (
                <>
                  <button disabled={busy} onClick={() => act(`/api/diocese/assessments/${selected.id}/recompute`, 'POST')}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-[12px] font-semibold rounded-lg border border-parchment-300 text-ink-600 hover:bg-parchment-200">
                    <RefreshCw size={12} /> Recompute bases
                  </button>
                  <button disabled={busy} onClick={async () => {
                      if (await ask({
                        title: 'Publish this year?',
                        body: 'Every line freezes as the authoritative bill. Bases stop recomputing.',
                        confirmLabel: 'Publish year',
                        tone: 'neutral',
                      })) act(`/api/diocese/assessments/${selected.id}`, 'PATCH', { status: 'published' })
                    }}
                    className="px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-church-600 text-parchment-50 hover:bg-church-700">
                    Publish
                  </button>
                </>
              )}
              {selected.status === 'published' && (
                <button disabled={busy} onClick={async () => {
                    if (await ask({
                      title: 'Close this year?',
                      body: 'No further changes will be possible to any line.',
                      confirmLabel: 'Close year',
                    })) act(`/api/diocese/assessments/${selected.id}`, 'PATCH', { status: 'closed' })
                  }}
                  className="px-3 py-1.5 text-[12px] font-semibold rounded-lg border border-parchment-300 text-ink-600 hover:bg-parchment-200">
                  Close year
                </button>
              )}
              <button onClick={exportCsv}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-[12px] font-semibold rounded-lg border border-brass-300 text-brass-700 hover:bg-brass-50">
                <Download size={12} /> CSV
              </button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-brass-600 border-b border-parchment-300/60">
                <th className="px-4 py-3 font-bold">Parish</th>
                <th className="px-4 py-3 font-bold text-right">Base</th>
                <th className="px-4 py-3 font-bold text-right">Rate</th>
                <th className="px-4 py-3 font-bold text-right">Assessed</th>
                <th className="px-4 py-3 font-bold text-right">Paid</th>
                <th className="px-4 py-3 font-bold">Status</th>
                <th className="px-4 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {selected.lines.map(l => (
                <tr key={l.id} className="border-b last:border-b-0 border-parchment-300/40 text-ink-800">
                  <td className="px-4 py-2.5 font-medium">{l.parish_name}
                    {l.note && <span className="block text-[11px] font-normal text-ink-400">{l.note}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">{fmtMoney(l.base)}</td>
                  <td className="px-4 py-2.5 text-right">{pct(l.rate_bps)}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap font-medium">{fmtMoney(l.assessed)}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">{fmtMoney(l.paid)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_CLS[l.status] ?? ''}`}>{l.status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-3">
                    {selected.status !== 'closed' && l.status !== 'waived' && (
                      <>
                        <button disabled={busy} onClick={() => recordPayment(l)} className="text-[12px] font-semibold text-brass-700 hover:underline">Payment</button>
                        <button disabled={busy} onClick={() => overrideRate(l)} className="text-[12px] font-semibold text-ink-500 hover:underline">Rate</button>
                        <button disabled={busy} onClick={() => waive(l)} className="text-[12px] font-semibold text-rose-700 hover:underline">Waive</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
