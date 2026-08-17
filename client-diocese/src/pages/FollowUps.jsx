import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Check, X } from 'lucide-react'
import { apiUrl } from '../api'

// The office's own follow-ups (CARE.1).
//
// This is a memory aid for diocesan staff, not a task-assignment system for
// parishes. Nothing here is visible to a parish, nothing is chased, and
// there is no overdue state — a date that has passed is shown as a date,
// not as a failure.
//
// "Let it go" sits beside "Done" on purpose. Deciding a follow-up is no
// longer needed is a legitimate pastoral judgement, and a system that only
// offers "complete" quietly teaches people to lie to it.

export default function FollowUps() {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = () => fetch(apiUrl('/api/diocese/care/followups'))
    .then(r => r.json()).then(d => setRows(d.followups ?? [])).catch(() => setRows([]))
  useEffect(() => { load() }, [])

  const settle = async (id, state) => {
    setBusy(id)
    try {
      await fetch(apiUrl(`/api/diocese/care/followups/${id}`), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      })
      await load()
    } finally { setBusy(null) }
  }

  if (!rows) return <div className="flex justify-center py-24"><Loader2 size={22} className="animate-spin text-brass-500" /></div>

  return (
    <div className="max-w-3xl">
      <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">Follow-ups</h1>
      <p className="text-sm text-ink-500 mb-7">
        The office’s own notes to itself. Parishes never see these, and nothing here will chase you.
      </p>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-parchment-300/70 bg-parchment-50 p-8 text-center">
          <p className="font-serif text-xl font-bold text-church-600 mb-2">Nothing waiting</p>
          <p className="text-sm text-ink-600 max-w-sm mx-auto">
            When something is worth coming back to, note it from a parish’s page and it will wait here.
          </p>
        </div>
      ) : (
        <ul className="rounded-xl border border-parchment-300/70 divide-y divide-parchment-300/60 overflow-hidden">
          {rows.map(f => (
            <li key={f.id} className="bg-parchment-50 px-4 py-3.5 flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <Link to={`/care/${f.parish_org_id}`} className="text-[13px] font-semibold text-church-700 hover:underline">
                  {f.parish_name}
                </Link>
                <p className="text-[13.5px] text-ink-800 leading-snug mt-0.5">{f.next_action}</p>
                <p className="text-[12px] text-ink-500 leading-snug mt-0.5">
                  {[f.context, f.owner_name, f.due_on && `noted for ${f.due_on}`].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => settle(f.id, 'done')} disabled={busy === f.id}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12.5px] text-ink-700 hover:bg-parchment-200 disabled:opacity-50">
                  <Check size={13} /> Done
                </button>
                <button onClick={() => settle(f.id, 'let_go')} disabled={busy === f.id}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12.5px] text-ink-500 hover:bg-parchment-200 disabled:opacity-50">
                  <X size={13} /> Let it go
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
