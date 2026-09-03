import { useEffect, useState, useCallback } from 'react'
import { Loader2, Check, Undo2 } from 'lucide-react'
import { apiUrl } from '../api'
import { useConfirm, usePrompt } from '../components/ConfirmProvider'
import { fmtMoney, loadOne } from '../utils/format'
import LoadError from '../components/LoadError'

// Review queue (DIO.2): approve a parish's frozen period, or return it
// with a note. Only approved periods feed the roll-up.
const STATUS_CLS = {
  submitted: 'bg-parchment-200/80 text-ink-700',
  approved:  'bg-brass-50 text-brass-700 border border-brass-200/70',
  returned:  'bg-rose-50 text-rose-700 border border-rose-200/60',
}

export default function Submissions() {
  const askFor = usePrompt()
  const ask = useConfirm()
  const [rows, setRows] = useState(null)
  const [filter, setFilter] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')
  // A failed queue used to `setRows([])`, and an empty queue reads as
  // "nothing to review" — the one message that makes a chancery close the
  // tab. A pending submission going unseen is the failure that matters here.
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (f = filter) => {
    setFailed(false)
    const { ok, data } = await loadOne(
      apiUrl(`/api/diocese/submissions${f ? `?status=${f}` : ''}`),
      d => d.submissions ?? [],
    )
    if (!ok) { setFailed(true); setRows([]); return }
    setRows(data)
  }, [filter])
  useEffect(() => { setRows(null); load(filter) }, [filter]) // eslint-disable-line react-hooks/exhaustive-deps

  const review = async (id, status, row) => {
    let note = null
    // Approve is irreversible and Return was not: returning asks for a note,
    // so it pauses; approving went through on the first click. That is
    // backwards — approving admits a parish's numbers to the diocesan
    // roll-up permanently as-of that submission, and it is the assessment
    // base. The heavier action now asks the heavier question.
    if (status === 'approved') {
      const period = row ? `${row.period_start} → ${row.period_end}` : 'this period'
      const ok = await ask({
        title: `Approve ${row?.parish_name || 'this parish'}?`,
        body: `${period} joins the diocese roll-up and the assessable base at these figures, and stays there. If something looks off, return it instead — the parish can resubmit.`,
        confirmLabel: 'Approve period',
        tone: 'neutral',
      })
      if (!ok) return
    }
    if (status === 'returned') {
      note = await askFor({
        title: 'Return this period to the parish',
        body: 'The note is what the parish sees. Say what to fix before they resubmit.',
        inputLabel: 'What should the parish fix?',
        confirmLabel: 'Return with note',
        required: true,
      })
      if (!note?.trim()) return
    }
    setBusyId(id); setError('')
    try {
      const res = await fetch(apiUrl(`/api/diocese/submissions/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Review failed')
      load()
    } catch (err) { setError(err.message) } finally { setBusyId(null) }
  }

  return (
    <div className="max-w-5xl">
      <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">Submissions</h1>
      <p className="text-sm text-ink-500 mb-6">Each row is a frozen period — approving it admits those numbers to the diocese roll-up, permanently as-of that submission.</p>

      <div className="flex items-center gap-2 mb-4">
        {[['', 'All'], ['submitted', 'Awaiting review'], ['approved', 'Approved'], ['returned', 'Returned']].map(([v, label]) => (
          <button key={v} onClick={() => setFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              filter === v ? 'bg-church-600 text-parchment-50 border-church-600' : 'border-parchment-300 text-ink-600 hover:bg-parchment-200'
            }`}>{label}</button>
        ))}
      </div>
      {error && <p className="text-sm text-rose-700 mb-3">{error}</p>}

      {rows === null ? (
        <div className="flex justify-center py-24"><Loader2 size={22} className="animate-spin text-brass-500" /></div>
      ) : failed ? (
        <LoadError
          title="The review queue didn't load."
          body="Do not read this as an empty queue — a parish may be waiting. Nothing was approved or returned."
          onRetry={() => load(filter)}
        />
      ) : rows.length === 0 ? (
        <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 p-8 text-center text-sm text-ink-500">
          Nothing here. Parish submissions arrive from the parish app's Finance page.
        </div>
      ) : (
          /* `relative` is load-bearing, not decoration. The header cells
             carry `sr-only` spans, which Tailwind implements as
             position:absolute. With no positioned ancestor between them and
             <html>, they resolve against the DOCUMENT — so an invisible
             screen-reader label sitting inside a horizontally scrolled
             table dragged the whole page 174px wider than the viewport, and
             the page slid sideways under your thumb for no visible reason.
             Making the scroll container the containing block keeps them in
             it. Found auditing iPad portrait widths. */
        <div className="relative bg-parchment-50 rounded-2xl border border-parchment-300/70 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-brass-600 border-b border-parchment-300/60">
                <th className="px-4 py-3 font-bold">Parish</th>
                <th className="px-4 py-3 font-bold">Period</th>
                <th className="px-4 py-3 font-bold text-right">Revenue</th>
                <th className="px-4 py-3 font-bold text-right">Assessable</th>
                <th className="px-4 py-3 font-bold">Status</th>
                <th className="px-4 py-3"><span className="sr-only">Review</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(s => (
                <tr key={s.id} className="border-b last:border-b-0 border-parchment-300/40 text-ink-800 align-top">
                  <td className="px-4 py-2.5 font-medium">{s.parish_name}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-ink-600">{s.period_start} → {s.period_end}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">{fmtMoney(s.totals?.revenue)}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">{fmtMoney(s.totals?.assessable_base)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_CLS[s.status] ?? ''}`}>{s.status}</span>
                    {s.review_note && <span className="block text-[11px] text-ink-400 mt-0.5 max-w-[16rem]">{s.review_note}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-3">
                    {s.status === 'submitted' && (
                      <>
                        <button disabled={busyId === s.id} onClick={() => review(s.id, 'approved', s)}
                          className="inline-flex items-center gap-1 text-[12px] font-semibold text-brass-700 hover:underline disabled:opacity-50">
                          <Check size={13} /> Approve
                        </button>
                        <button disabled={busyId === s.id} onClick={() => review(s.id, 'returned')}
                          className="inline-flex items-center gap-1 text-[12px] font-semibold text-rose-700 hover:underline disabled:opacity-50">
                          <Undo2 size={13} /> Return
                        </button>
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
