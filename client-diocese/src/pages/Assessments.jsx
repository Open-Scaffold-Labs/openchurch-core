import { useEffect, useState, useCallback } from 'react'
import { Loader2, Plus, Download, RefreshCw } from 'lucide-react'
import { apiUrl } from '../api'
import { useConfirm, usePrompt } from '../components/ConfirmProvider'
import { fmtMoney, loadOne } from '../utils/format'
import LoadError from '../components/LoadError'

// Assessments (DIO.4, extended in 087): the cathedraticum as arithmetic.
// Create a year at a rate, bases fill themselves from approved
// submissions, hardship overrides and payments are per-line, and
// publishing freezes the bill.
//
// A rate is EITHER one number or a ladder, because real diocesan formulas
// are usually a ladder — Maine charges 5% on the first $10,000 and 15%
// above it, and the churchwide assessment exempts the first $200,000 then
// charges 15%, which is the same ladder with a zero on the bottom rung.
//
// The builder shows a worked example as you type. A rate ladder is the
// one thing on this screen where a typo becomes somebody's invoice, and
// the difference between 5%/15% and 15%/5% is invisible in a form and
// obvious in a number. So the form carries the number.

const pct = bps => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`
// One number, or the ladder in a phrase short enough for a chip.
// "5% to $10,000, then 15%" is the whole formula, which is what somebody
// scanning a list of years actually wants to know.
const ladderPhrase = (a) => {
  if (!Array.isArray(a?.bands) || !a.bands.length) return pct(a?.rate_bps ?? 0)
  return a.bands
    .map(b => b.upto === null ? `then ${pct(b.rate_bps)}` : `${pct(b.rate_bps)} to ${fmtMoney(b.upto)}`)
    .join(', ')
}
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
  const [form, setForm] = useState({
    fiscal_year: String(new Date().getFullYear()),
    rate_pct: '8',
    base_year: '',
  })
  // A ladder, or null for a single rate. Rungs are held as strings while
  // being typed — a half-typed "1" must not become a rate of 1%.
  const [bands, setBands] = useState(null)
  const [sample, setSample] = useState('50000')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // A failed list used to `setYears([])`, which this page renders as "no
  // assessment years yet" — an invitation to create a year that already
  // exists. Creating a duplicate of a year already published is exactly the
  // mistake this screen is meant to prevent.
  const [failed, setFailed] = useState(false)

  const loadYears = useCallback(async () => {
    setFailed(false)
    const { ok, data } = await loadOne(apiUrl('/api/diocese/assessments'), d => d.assessments ?? [])
    if (!ok) { setFailed(true); setYears([]); return }
    setYears(data)
  }, [])
  useEffect(() => { loadYears() }, [loadYears])

  const open = async (id) => {
    setSelected(null); setError('')
    // The old version parsed the body without checking the status, so a 500
    // whose body is `{ error: ... }` was set as the assessment — and the
    // header immediately reads `selected.totals.assessed`, which throws on
    // undefined and takes the whole screen down. Shape-check before trusting.
    const { ok, data } = await loadOne(apiUrl(`/api/diocese/assessments/${id}`))
    if (!ok || !data?.totals || !Array.isArray(data.lines)) {
      setError('Failed to open the assessment')
      return
    }
    setSelected(data)
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

  // The same marginal arithmetic the server does, so the worked example
  // on the form matches the invoice. Kept deliberately simple and only
  // ever used for the preview — the server is the authority, and the
  // number that gets billed is computed there.
  const previewLadder = (total, rungs) => {
    let floor = 0, sum = 0
    const slices = []
    for (const r of rungs) {
      const ceiling = r.upto === '' || r.upto === null ? Infinity : Number(r.upto)
      if (!(total > floor)) break
      const slice = Math.min(total, ceiling) - floor
      if (slice > 0) {
        const amount = Math.round(slice * Number(r.rate_pct || 0)) / 100
        sum += amount
        slices.push({ from: floor, to: ceiling, slice, rate_pct: Number(r.rate_pct || 0), amount })
      }
      floor = ceiling
      if (floor === Infinity) break
    }
    return { total: sum, slices }
  }

  const addBand = () => setBands(b => {
    const next = [...(b ?? [{ upto: '', rate_pct: form.rate_pct }])]
    // A new rung goes ABOVE the open one, and the open one stays last —
    // the top rung must have no ceiling or income above it is silently
    // unassessed.
    const open = next.pop()
    next.push({ upto: '', rate_pct: open.rate_pct })
    next.push({ upto: '', rate_pct: open.rate_pct })
    next[next.length - 2].upto = ''
    return next
  })

  const create = async (e) => {
    e.preventDefault()
    const bps = Math.round(Number(form.rate_pct) * 100)
    const payload = { fiscal_year: form.fiscal_year, rate_bps: bps }
    if (form.base_year.trim()) payload.base_year = form.base_year.trim()
    if (bands) {
      payload.bands = bands.map((r, i) => ({
        upto: i === bands.length - 1 ? null : Number(r.upto),
        rate_bps: Math.round(Number(r.rate_pct) * 100),
      }))
      payload.rate_bps = payload.bands[payload.bands.length - 1].rate_bps
    }
    const d = await act('/api/diocese/assessments', 'POST', payload)
    if (d) { setSelected(d); setBands(null) }
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

      <form onSubmit={create} className="mb-6">
        <div className="flex items-center gap-2 flex-wrap">
          <input type="text" value={form.fiscal_year} onChange={e => setForm(f => ({ ...f, fiscal_year: e.target.value }))}
            className={`${inputCls} w-24`} aria-label="Fiscal year" placeholder="2026" />
          {!bands && (
            <div className="flex items-center gap-1">
              <input type="number" step="0.25" min="0" max="30" value={form.rate_pct}
                onChange={e => setForm(f => ({ ...f, rate_pct: e.target.value }))}
                className={`${inputCls} w-24`} aria-label="Rate percent" />
              <span className="text-sm text-ink-500">%</span>
            </div>
          )}
          <button type="submit" disabled={busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-church-600 text-parchment-50 hover:bg-church-700 disabled:opacity-60">
            <Plus size={14} /> New assessment year
          </button>
          {!bands && (
            <button type="button" onClick={() => setBands([{ upto: '10000', rate_pct: '5' }, { upto: '', rate_pct: form.rate_pct }])}
              className="px-3 py-2 text-[12px] font-semibold rounded-lg border border-parchment-300 text-ink-600 hover:bg-parchment-200">
              Use a rate ladder
            </button>
          )}
        </div>

        {/* Where the base comes from. Written as a question rather than a
            field label because most dioceses assess on the current year
            and should be able to ignore this entirely — but Maine assesses
            on the parochial report from two years prior, and a diocese
            that needs it needs it badly. */}
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <label htmlFor="base-year" className="text-[12px] text-ink-500">
            Assess on approved reports closing in
          </label>
          <input id="base-year" type="text" value={form.base_year} placeholder={form.fiscal_year || 'same year'}
            onChange={e => setForm(f => ({ ...f, base_year: e.target.value }))}
            className={`${inputCls} w-24`} />
          <span className="text-[12px] text-ink-400">leave blank for the same year</span>
        </div>

        {/* The ladder builder.
            Marginal, like tax brackets: each rate applies only to the
            slice inside its band. The last rung deliberately has no
            ceiling — the server refuses a ladder that stops, because
            income above the top rung would be silently unassessed. */}
        {bands && (
          <div className="mt-3 rounded-xl border border-parchment-300/70 bg-parchment-50 p-4">
            <p className="text-sm text-ink-700 font-medium">Rate ladder</p>
            <p className="text-[12px] text-ink-500 mt-0.5 mb-3">
              Each rate applies only to the part of a parish’s base inside that band —
              the way tax brackets work. A first band at 0% is an exemption.
            </p>
            <div className="space-y-2">
              {bands.map((r, i) => {
                const last = i === bands.length - 1
                const floor = i === 0 ? 0 : Number(bands[i - 1].upto || 0)
                return (
                  <div key={i} className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12px] text-ink-500 w-28 shrink-0">
                      {fmtMoney(floor)} {last ? 'and above' : 'up to'}
                    </span>
                    {!last && (
                      <input type="number" min="0" value={r.upto} aria-label={`Band ${i + 1} upper limit`}
                        onChange={e => setBands(b => b.map((x, j) => j === i ? { ...x, upto: e.target.value } : x))}
                        className={`${inputCls} w-32`} />
                    )}
                    <div className="flex items-center gap-1">
                      <input type="number" step="0.25" min="0" max="30" value={r.rate_pct}
                        aria-label={`Band ${i + 1} rate percent`}
                        onChange={e => setBands(b => b.map((x, j) => j === i ? { ...x, rate_pct: e.target.value } : x))}
                        className={`${inputCls} w-24`} />
                      <span className="text-sm text-ink-500">%</span>
                    </div>
                    {bands.length > 2 && !last && (
                      <button type="button" aria-label={`Remove band ${i + 1}`}
                        onClick={() => setBands(b => b.filter((_, j) => j !== i))}
                        className="px-2 py-1 text-[12px] rounded-lg border border-parchment-300 text-ink-500 hover:bg-parchment-200">
                        Remove
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <button type="button" onClick={addBand}
                className="px-3 py-1.5 text-[12px] font-semibold rounded-lg border border-parchment-300 text-ink-600 hover:bg-parchment-200">
                Add a band
              </button>
              <button type="button" onClick={() => setBands(null)}
                className="px-3 py-1.5 text-[12px] rounded-lg text-ink-500 hover:bg-parchment-200">
                Back to one rate
              </button>
            </div>

            {/* The worked example. A rate ladder is the one place on this
                screen where a typo becomes somebody's invoice, and
                5%/15% versus 15%/5% looks identical in a form and
                completely different in a number. So the form carries the
                number. */}
            <div className="mt-4 pt-3 border-t border-parchment-300/60">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12px] text-ink-500">A parish with a base of</span>
                <input type="number" min="0" value={sample} aria-label="Sample base"
                  onChange={e => setSample(e.target.value)} className={`${inputCls} w-32`} />
                <span className="text-[12px] text-ink-500">would be assessed</span>
                <span className="font-serif text-lg font-bold text-church-600">
                  {fmtMoney(previewLadder(Number(sample) || 0, bands).total)}
                </span>
              </div>
              <ul className="mt-2 space-y-0.5">
                {previewLadder(Number(sample) || 0, bands).slices.map((sl, i) => (
                  <li key={i} className="text-[12px] text-ink-500">
                    {fmtMoney(sl.slice)} at {sl.rate_pct}% — {fmtMoney(sl.amount)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </form>

      {years === null ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-brass-500" /></div>
      ) : failed ? (
        <LoadError
          title="The assessment years didn't load."
          body="Don't create a year from this screen until it does — one may already be published. Nothing was changed."
          onRetry={loadYears}
        />
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
              <span className="ml-2 text-ink-500">{ladderPhrase(y)}</span>
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
              <span className="ml-2">at {ladderPhrase(selected)}</span>
              {selected.base_year && selected.base_year !== selected.fiscal_year && (
                <span className="ml-2 text-ink-500">on {selected.base_year} reports</span>
              )}
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
