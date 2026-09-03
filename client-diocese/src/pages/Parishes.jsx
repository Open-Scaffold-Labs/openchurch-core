import { useEffect, useState, useCallback } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { apiUrl } from '../api'
import { useConfirm } from '../components/ConfirmProvider'
import { loadOne, postJson } from '../utils/format'
import LoadError from '../components/LoadError'

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
  // A failed roster used to `setRows([])`, and this page renders an empty
  // roster as "No parishes yet. Invite the first one." A diocese of forty
  // parishes was being shown the first-run screen because a request timed
  // out — and the obvious next move from that screen is to re-invite a
  // parish that is already affiliated.
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    const { ok, data } = await loadOne(apiUrl('/api/diocese/parishes'), d => d.parishes ?? [])
    if (!ok) { setFailed(true); setRows([]); return }
    setRows(data)
  }, [])
  useEffect(() => { load() }, [load])

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

      {/* flex-wrap: at Split View widths the field and its button cannot sit
          side by side, and a nowrap row pushes the whole page sideways
          rather than stacking. */}
      <Deaneries onChanged={() => load()} />

      <form onSubmit={invite} className="flex flex-wrap items-center gap-2 mb-2 max-w-lg">
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

      {failed ? (
        <LoadError
          title="The roster didn't load."
          body="This is not an empty diocese — don't invite from this screen until it loads, or you may re-invite a parish that is already here."
          onRetry={load}
        />
      ) : rows.length === 0 ? (
        <div className="bg-parchment-50 rounded-2xl border border-parchment-300/70 p-8 text-center text-sm text-ink-500 mt-4">
          No parishes yet. Invite the first one by its admin's email — the
          invitation appears in their parish Settings, under Diocese.
        </div>
      ) : (
        /* overflow-x-auto, not overflow-hidden. The rounded corners still
           clip, but the table can now be reached sideways instead of
           silently losing its right-hand columns — which is what happened
           at iPad Split View and Slide Over widths, where the app is
           320-507pt wide while still being a tablet. A table that cannot be
           scrolled to is a table whose last column does not exist. */
          /* `relative` is load-bearing, not decoration. The header cells
             carry `sr-only` spans, which Tailwind implements as
             position:absolute. With no positioned ancestor between them and
             <html>, they resolve against the DOCUMENT — so an invisible
             screen-reader label sitting inside a horizontally scrolled
             table dragged the whole page 174px wider than the viewport, and
             the page slid sideways under your thumb for no visible reason.
             Making the scroll container the containing block keeps them in
             it. Found auditing iPad portrait widths. */
        <div className="relative bg-parchment-50 rounded-2xl border border-parchment-300/70 overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-widest text-brass-600 border-b border-parchment-300/60">
                <th className="px-4 py-3 font-bold">Parish</th>
                <th className="px-4 py-3 font-bold">Status</th>
                <th className="px-4 py-3 font-bold">Deanery</th>
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
                  <td className="px-4 py-2.5">
                    {p.status === 'active' || p.status === 'suspended'
                      ? <DeaneryPicker parishOrgId={p.parish_org_id} value={p.region_id} />
                      : <span className="text-ink-400">—</span>}
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

// Deaneries (PILOT.1).
//
// A deanery is a name and nothing else — no policy, no permissions, no
// roll-up of its own, and deliberately no comparison between the parishes
// inside it. Grouping parishes is how a ranking gets built by accident, so
// this groups them for FINDING and nothing else: the payoff is that the
// care dashboard's search now matches a deanery.
function Deaneries({ onChanged }) {
  const [regions, setRegions] = useState(null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Same defect, smaller blast radius: a failed list said "None yet",
  // which invites creating a deanery that already exists.
  const [failed, setFailed] = useState(false)
  const load = async () => {
    setFailed(false)
    const { ok, data } = await loadOne(apiUrl('/api/diocese/regions'), d => d.regions ?? [])
    if (!ok) { setFailed(true); setRegions([]); return }
    setRegions(data)
  }
  useEffect(() => { load() }, [])

  const add = async (e) => {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/diocese/regions'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not add that'); return }
      setName(''); await load(); onChanged?.()
    } finally { setBusy(false) }
  }

  const remove = async (r) => {
    setError('')
    const res = await fetch(apiUrl(`/api/diocese/regions/${r.id}`), { method: 'DELETE' })
    if (res.status === 409) {
      // The server refuses rather than cascading, and says how many.
      // Show its sentence rather than inventing one.
      const d = await res.json().catch(() => ({}))
      setError(d.error || 'That deanery still has parishes in it.')
      return
    }
    await load(); onChanged?.()
  }

  if (!regions) return null

  return (
    <div className="mb-6">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="text-[12.5px] text-church-700 hover:underline">
        {open ? 'Hide deaneries' : `Deaneries (${regions.length})`}
      </button>

      {open && (
        <div className="mt-3 rounded-xl border border-parchment-300/70 bg-parchment-50 p-4 max-w-lg">
          <p className="text-[12px] text-ink-500 mb-3 leading-relaxed">
            Deaneries group parishes so they are easier to find. They carry no policy,
            and nothing about them reaches a parish.
          </p>

          {failed ? (
            <p className="text-[13px] text-amber-800 mb-3">
              The deanery list didn’t load — this doesn’t mean there are none.{' '}
              <button type="button" onClick={load} className="underline font-semibold">Try again</button>
            </p>
          ) : regions.length === 0 ? (
            <p className="text-[13px] text-ink-500 italic mb-3">
              None yet. Parishes work perfectly well without one.
            </p>
          ) : (
            <ul className="mb-3 divide-y divide-parchment-300/50">
              {regions.map(r => (
                <li key={r.id} className="flex items-center justify-between py-1.5">
                  <span className="text-[13.5px] text-ink-800">
                    {r.name}
                    <span className="text-ink-400 text-[12px] ml-2">
                      {r.parish_count === 1 ? '1 parish' : `${r.parish_count} parishes`}
                    </span>
                  </span>
                  <button type="button" onClick={() => remove(r)}
                    className="text-[12px] text-ink-500 hover:text-church-700 hover:underline">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={add} className="flex flex-wrap items-center gap-2">
            <label htmlFor="new-deanery" className="sr-only">New deanery name</label>
            <input id="new-deanery" value={name} onChange={e => setName(e.target.value)}
              placeholder="Northern Deanery"
              className="flex-1 min-w-[12rem] px-3 py-2 text-sm rounded-lg border border-parchment-300 bg-parchment-50 text-ink-900 focus:outline-none focus:ring-2 focus:ring-brass-400" />
            <button type="submit" disabled={busy || name.trim().length < 2}
              className="px-3 py-2 rounded-lg bg-church-600 text-parchment-50 text-[13px] font-semibold disabled:opacity-50">
              Add
            </button>
          </form>
          {error && <p className="mt-2 text-[12.5px] text-church-700">{error}</p>}
        </div>
      )}
    </div>
  )
}

// One parish's deanery. Saves on change — there is nothing to confirm
// about filing a parish under a name.
function DeaneryPicker({ parishOrgId, value }) {
  const [regions, setRegions] = useState([])
  const [current, setCurrent] = useState(value ?? '')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    loadOne(apiUrl('/api/diocese/regions'), d => d.regions ?? [])
      .then(({ ok, data }) => { if (ok) setRegions(data) })
  }, [])
  useEffect(() => { setCurrent(value ?? '') }, [value])

  if (!regions.length) return <span className="text-ink-400">—</span>

  // The select showed the new deanery whether or not the server took it.
  // Optimistic is fine; silently optimistic is not — put it back and say so.
  const change = async (e) => {
    const next = e.target.value
    const previous = current
    setCurrent(next); setBusy(true); setFailed(false)
    try {
      const { ok } = await postJson(
        apiUrl(`/api/diocese/regions/assign/${parishOrgId}`),
        { region_id: next === '' ? null : Number(next) },
        'PATCH',
      )
      if (!ok) { setCurrent(previous); setFailed(true) }
    } finally { setBusy(false) }
  }

  return (
    <>
      <label htmlFor={`deanery-${parishOrgId}`} className="sr-only">Deanery for this parish</label>
      <select id={`deanery-${parishOrgId}`} value={current} onChange={change} disabled={busy}
        className="px-2 py-1 text-[12.5px] rounded-lg border border-parchment-300 bg-parchment-50 text-ink-700 focus:outline-none focus:ring-2 focus:ring-brass-400">
        <option value="">—</option>
        {regions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      {failed && <span className="ml-1.5 text-[11px] text-amber-800">didn’t save</span>}
    </>
  )
}
