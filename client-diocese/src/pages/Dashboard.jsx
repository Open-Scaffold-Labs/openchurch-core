import { useEffect, useState, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { apiUrl } from '../api'
import { fmtMoney, fmtCount, loadAll } from '../utils/format'
import LoadError from '../components/LoadError'

// Chancery dashboard (DIO.2): the year at a glance — roster health,
// review queue, and the consolidated totals from approved submissions.

function yearBounds() {
  const y = new Date().getFullYear()
  return { start: `${y}-01-01`, end: `${y}-12-31` }
}

export default function Dashboard() {
  const [parishes, setParishes] = useState(null)
  const [queue, setQueue] = useState(null)
  const [rollup, setRollup] = useState(null)
  const [health, setHealth] = useState(null)
  // Which parts did not load. Previously a failed request became an empty
  // array or an empty object, which this page renders as "no parishes yet"
  // and "$0.00" — a diocese with forty parishes told it has none, and a
  // consolidated revenue figure of zero that nothing measured.
  const [failed, setFailed] = useState([])
  const [reloading, setReloading] = useState(false)

  const load = useCallback(async () => {
    const { start, end } = yearBounds()
    const { data, failed } = await loadAll({
      parishes: { url: apiUrl('/api/diocese/parishes'), pick: d => d.parishes ?? [] },
      queue:    { url: apiUrl('/api/diocese/submissions?status=submitted'), pick: d => d.submissions ?? [] },
      rollup:   { url: apiUrl(`/api/diocese/financials?start=${start}&end=${end}`) },
      health:   { url: apiUrl('/api/diocese/observations'), pick: d => d.parishes ?? [] },
    })
    setParishes(data.parishes ?? [])
    setQueue(data.queue ?? [])
    // undefined, NOT {} — so fmtMoney renders an em dash rather than $0.00.
    setRollup(data.rollup)
    setHealth(data.health ?? [])
    setFailed(failed)
  }, [])

  useEffect(() => { load() }, [load])

  const retry = async () => { setReloading(true); await load(); setReloading(false) }

  if (parishes === null) {
    return <div className="flex justify-center py-24"><Loader2 size={22} className="animate-spin text-brass-500" /></div>
  }

  const active = parishes.filter(p => p.status === 'active').length
  const invited = parishes.filter(p => p.status === 'invited').length
  const year = new Date().getFullYear()

  const tiles = [
    ['Affiliated parishes',
      failed.includes('parishes') ? '—' : fmtCount(active),
      failed.includes('parishes') ? "couldn't be loaded"
        : invited ? `${invited} invitation${invited > 1 ? 's' : ''} pending` : 'roster settled'],
    ['Awaiting review',
      failed.includes('queue') ? '—' : fmtCount(queue.length),
      failed.includes('queue') ? "couldn't be loaded"
        : queue.length ? 'submissions in the queue' : 'queue is clear'],
    [`Revenue · ${year}`, fmtMoney(rollup?.totals?.revenue),
      failed.includes('rollup') ? "couldn't be loaded"
        : `${rollup?.submission_count ?? 0} approved period${rollup?.submission_count === 1 ? '' : 's'}`],
    [`Assessable base · ${year}`, fmtMoney(rollup?.totals?.assessable_base),
      failed.includes('rollup') ? "couldn't be loaded" : 'from approved submissions'],
  ]

  return (
    <div className="max-w-5xl">
      <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">Dashboard</h1>
      <p className="text-sm text-ink-500 mb-8">Consolidated view across the diocese — approved submissions only, so these numbers never shift beneath you.</p>

      {/* Said plainly, and only about the part that failed. A dash in a tile
          means "we could not load this", which is a different thing from a
          measured zero — and on a page a chancery uses to judge whether a
          parish is in trouble, those two must never look alike. */}
      {failed.length > 0 && (
        <LoadError variant="partial" onRetry={retry} retrying={reloading} />
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {tiles.map(([label, value, sub]) => (
          <div key={label} className="bg-parchment-50 rounded-2xl border border-parchment-300/70 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-600">{label}</p>
            <p className="mt-1.5 font-serif text-2xl font-bold text-ink-900">{value}</p>
            <p className="text-[11px] text-ink-500 mt-1">{sub}</p>
          </div>
        ))}
      </div>

      {/* Financial observations (DIO.4) — explainable rules, shown with their
          numbers. A noticing, not a verdict; the working view is Parish Care. */}
      {health && health.length > 0 && (
        <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 p-5 mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-3">Worth a look together</p>
          <div className="space-y-3">
            {health.map(p => (
              <div key={p.parish_org_id} className="border-l-4 border-brass-400 pl-3">
                <p className="text-sm font-semibold text-ink-900">{p.parish_name}</p>
                {p.flags.map((f, i) => (
                  <p key={i} className="text-[12px] text-ink-600">{f.detail}</p>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {parishes.length === 0 && (
        <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 p-8 text-center">
          <p className="font-serif text-xl font-bold text-church-600 mb-2">Begin with the roster</p>
          <p className="text-sm text-ink-600 max-w-md mx-auto">
            Invite your first parish from the Parishes page. Once a parish accepts
            and submits a financial period, the consolidated picture builds itself here.
          </p>
        </div>
      )}
    </div>
  )
}
