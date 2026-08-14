import { useEffect, useState, useCallback } from 'react'
import { Loader2, Download, RefreshCw } from 'lucide-react'
import { apiUrl } from '../api'

// The roll-up (DIO.2): consolidated financials across every affiliated
// parish, from approved submissions only. CSV export honors the Pledge —
// the diocese's data leaves freely too.

const fmtMoney = v => Number(v ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

function yearBounds() {
  const y = new Date().getFullYear()
  return { start: `${y}-01-01`, end: `${y}-12-31` }
}

export default function Financials() {
  const [{ start, end }, setPeriod] = useState(yearBounds)
  const [data, setData] = useState(null)

  const load = useCallback(() => {
    setData(null)
    fetch(apiUrl(`/api/diocese/financials?start=${start}&end=${end}`))
      .then(r => r.json())
      .then(setData)
      .catch(() => setData({}))
  }, [start, end])
  useEffect(load, [load])

  const exportCsv = () => {
    if (!data?.parishes) return
    const lines = [['parish', 'periods', 'revenue', 'expense', 'net', 'assessable_base'].join(',')]
    for (const p of data.parishes) {
      lines.push([`"${p.parish_name.replaceAll('"', '""')}"`, p.periods, p.revenue, p.expense, p.net, p.assessable_base].join(','))
    }
    lines.push(['"— Diocese total"', data.submission_count, data.totals.revenue, data.totals.expense, data.totals.net, data.totals.assessable_base].join(','))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `diocese-financials-${start}-to-${end}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const inputCls = 'px-3 py-2 text-sm rounded-lg border border-parchment-300 bg-parchment-50 text-ink-900 focus:outline-none focus:ring-2 focus:ring-brass-400'

  return (
    <div className="max-w-6xl">
      <div className="flex items-end justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">Financials</h1>
          <p className="text-sm text-ink-500">Approved submissions only — the numbers a chancery can stand behind.</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={start} onChange={e => setPeriod(p => ({ ...p, start: e.target.value }))} className={inputCls} aria-label="From" />
          <span className="text-ink-400">–</span>
          <input type="date" value={end} onChange={e => setPeriod(p => ({ ...p, end: e.target.value }))} className={inputCls} aria-label="To" />
          <button onClick={load} aria-label="Refresh" className="p-2 rounded-lg border border-parchment-300 text-ink-500 hover:text-church-600"><RefreshCw size={15} /></button>
          <button onClick={exportCsv} disabled={!data?.parishes?.length}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg border border-brass-300 text-brass-700 hover:bg-brass-50 disabled:opacity-40">
            <Download size={14} /> CSV
          </button>
        </div>
      </div>

      {data === null ? (
        <div className="flex justify-center py-24"><Loader2 size={22} className="animate-spin text-brass-500" /></div>
      ) : !data.parishes?.length ? (
        <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 p-8 text-center text-sm text-ink-500">
          No approved submissions in this range yet. Approve parish periods
          on the Submissions page and the roll-up assembles here.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {[
              ['Revenue', data.totals.revenue],
              ['Expense', data.totals.expense],
              ['Net', data.totals.net],
              ['Assessable base', data.totals.assessable_base],
            ].map(([label, value]) => (
              <div key={label} className="bg-parchment-50 rounded-2xl border border-parchment-300/70 p-5">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-600">{label}</p>
                <p className="mt-1.5 font-serif text-2xl font-bold text-ink-900">{fmtMoney(value)}</p>
              </div>
            ))}
          </div>

          <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-brass-600 border-b border-parchment-300/60">
                  <th className="px-4 py-3 font-bold">Parish</th>
                  <th className="px-4 py-3 font-bold text-right">Periods</th>
                  <th className="px-4 py-3 font-bold text-right">Revenue</th>
                  <th className="px-4 py-3 font-bold text-right">Expense</th>
                  <th className="px-4 py-3 font-bold text-right">Net</th>
                  <th className="px-4 py-3 font-bold text-right">Assessable</th>
                </tr>
              </thead>
              <tbody>
                {data.parishes.map(p => (
                  <tr key={p.parish_org_id} className="border-b last:border-b-0 border-parchment-300/40 text-ink-800">
                    <td className="px-4 py-2.5 font-medium">{p.parish_name}</td>
                    <td className="px-4 py-2.5 text-right text-ink-500">{p.periods}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">{fmtMoney(p.revenue)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">{fmtMoney(p.expense)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">{fmtMoney(p.net)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap font-medium">{fmtMoney(p.assessable_base)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-3">By account group, diocese-wide</p>
            <table className="w-full text-sm">
              <tbody>
                {data.groups.map((g, i) => (
                  <tr key={i} className="border-t first:border-t-0 border-parchment-300/40 text-ink-800">
                    <td className="py-1.5 pr-2">{g.rollup_group}
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-400">{g.acct_type}</span>
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap font-medium">{fmtMoney(g.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
