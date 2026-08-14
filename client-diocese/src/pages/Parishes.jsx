import { useEffect, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { apiUrl } from '../api'
import { useConfirm } from '../components/ConfirmProvider'

// Affiliation roster (DIO.1/2): invite by parish-admin email, watch
// acceptance land, suspend/end when governance requires it.

const STATUS_CLS = {
  active:    'bg-brass-50 text-brass-700 border border-brass-200/70',
  invited:   'bg-parchment-200/80 text-ink-600',
  suspended: 'bg-parchment-200 text-ink-500',
  ended:     'bg-parchment-100 text-ink-400',
}

export default function Parishes() {
  const ask = useConfirm()
  const [rows, setRows] = useState(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null) // { kind: 'ok'|'err', text }

  const load = () => {
    fetch(apiUrl('/api/diocese/parishes'))
      .then(r => r.json())
      .then(d => setRows(d.parishes ?? []))
      .catch(() => setRows([]))
  }
  useEffect(load, [])

  const invite = async (e) => {
    e.preventDefault()
    setBusy(true); setNotice(null)
    try {
      const res = await fetch(apiUrl('/api/diocese/parishes/invite'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Invitation failed')
      setEmail('')
      setNotice({ kind: 'ok', text: `Invitation sent to ${d.parish_name}. It appears in their parish Settings.` })
      load()
    } catch (err) { setNotice({ kind: 'err', text: err.message }) } finally { setBusy(false) }
  }

  const setStatus = async (id, status, label) => {
    if (!(await ask({
      title: `${label} this affiliation?`,
      body: 'The parish keeps its own records either way; only the diocese\u2019s access changes.',
      confirmLabel: label,
    }))) return
    try {
      const res = await fetch(apiUrl(`/api/diocese/parishes/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Update failed')
      load()
    } catch (err) { setNotice({ kind: 'err', text: err.message }) }
  }

  if (rows === null) return <div className="flex justify-center py-24"><Loader2 size={22} className="animate-spin text-brass-500" /></div>

  return (
    <div className="max-w-5xl">
      <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">Parishes</h1>
      <p className="text-sm text-ink-500 mb-6">Affiliation is a covenant: you invite, the parish accepts and chooses what it shares. Activation is always the parish's move.</p>

      <form onSubmit={invite} className="flex items-center gap-2 mb-2 max-w-lg">
        <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
          placeholder="parish-admin@example.com"
          className="flex-1 px-3 py-2 text-sm rounded-lg border border-parchment-300 bg-parchment-50 text-ink-900 focus:outline-none focus:ring-2 focus:ring-brass-400" />
        <button type="submit" disabled={busy}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-church-600 text-parchment-50 hover:bg-church-700 disabled:opacity-60">
          <Plus size={14} /> Invite parish
        </button>
      </form>
      {notice && (
        <p className={`text-sm mb-4 ${notice.kind === 'ok' ? 'text-brass-700' : 'text-rose-700'}`}>{notice.text}</p>
      )}

      {rows.length === 0 ? (
        <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 p-8 text-center text-sm text-ink-500 mt-4">
          No parishes yet. Invite the first one by its admin's email — the
          invitation appears in their parish Settings, under Diocese.
        </div>
      ) : (
        <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 overflow-hidden mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-brass-600 border-b border-parchment-300/60">
                <th className="px-4 py-3 font-bold">Parish</th>
                <th className="px-4 py-3 font-bold">Status</th>
                <th className="px-4 py-3 font-bold">Sharing</th>
                <th className="px-4 py-3 font-bold">Since</th>
                <th className="px-4 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.id} className="border-b last:border-b-0 border-parchment-300/40 text-ink-800">
                  <td className="px-4 py-2.5 font-medium">{p.parish_name}
                    {p.status === 'invited' && <span className="block text-[11px] font-normal text-ink-400">invited via {p.invited_email}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_CLS[p.status] ?? ''}`}>{p.status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-ink-500">{p.status === 'active' ? p.grant_level : '—'}</td>
                  <td className="px-4 py-2.5 text-ink-500 whitespace-nowrap">{p.accepted_at ? new Date(p.accepted_at).toLocaleDateString() : '—'}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-3">
                    {p.status === 'active' && (
                      <button onClick={() => setStatus(p.id, 'suspended', 'Suspend')} className="text-[12px] font-semibold text-ink-500 hover:underline">Suspend</button>
                    )}
                    {p.status === 'suspended' && (
                      <button onClick={() => setStatus(p.id, 'active', 'Reinstate')} className="text-[12px] font-semibold text-brass-700 hover:underline">Reinstate</button>
                    )}
                    {p.status !== 'ended' && (
                      <button onClick={() => setStatus(p.id, 'ended', 'End')} className="text-[12px] font-semibold text-rose-700 hover:underline">End</button>
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
