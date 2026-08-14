// The Founder Workbench (FB.2) — internal, founder-only read over the
// Inner Circle feedback ledger, across all parishes. Deliberately
// unlisted: no nav link anywhere; the route only renders data for the
// configured super-admin (everyone else gets the server's 404 and an
// empty room). Manual 4's <48h-reply promise lives or dies here.
//
// Minimalist by mandate: a table, a filter, a status toggle. Anything
// richer is internal-tool gold-plating the freeze exists to prevent.

import { useCallback, useEffect, useState } from 'react'
import { Inbox, Loader2, Check, RotateCcw } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import { apiUrl } from '../api'

const CATEGORY_STYLE = {
  bug:           'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border-rose-200/60 dark:border-rose-900/40',
  suggestion:    'bg-brass-50 text-brass-800 dark:bg-brass-950/40 dark:text-brass-300 border-brass-200/60 dark:border-brass-900/40',
  pastoral_note: 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border-amber-200/60 dark:border-amber-900/40',
}

export default function Workbench() {
  const [rows,    setRows]    = useState([])
  const [filter,  setFilter]  = useState('open')
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [busyId,  setBusyId]  = useState(null)

  const load = useCallback(async (f) => {
    setLoading(true); setError(null)
    try {
      const qs = f ? `?status=${f}&limit=100` : '?limit=100'
      const res = await fetch(apiUrl(`/api/admin/feedback${qs}`))
      if (res.status === 404) throw new Error('not-found')
      if (!res.ok) throw new Error(`Failed (${res.status})`)
      const d = await res.json()
      setRows(d.feedback ?? [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(filter) }, [filter, load])

  async function toggle(row) {
    const next = row.status === 'open' ? 'replied' : 'open'
    setBusyId(row.id)
    try {
      const res = await fetch(apiUrl(`/api/admin/feedback/${row.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      if (!res.ok) throw new Error('Failed to update')
      setRows(rs => filter
        ? rs.filter(r => r.id !== row.id)          // filtered view: row leaves the lane
        : rs.map(r => r.id === row.id ? { ...r, status: next } : r))
    } catch {
      /* leave row as-is; next load corrects */
    } finally {
      setBusyId(null)
    }
  }

  if (error === 'not-found') {
    return (
      <PageWrapper>
        <p className="py-24 text-center text-sm text-ink-400 dark:text-parchment-400/60">There's nothing at this address.</p>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper>
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Inbox size={20} className="text-church-700 dark:text-brass-300" />
          <div>
            <h1 className="text-2xl font-display font-bold text-ink-900 dark:text-parchment-50">Workbench</h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70">Inner Circle feedback, all parishes. Reply within 48 hours.</p>
          </div>
        </div>
        <select value={filter} onChange={e => setFilter(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-ink-900 dark:text-parchment-50">
          <option value="open">Open</option>
          <option value="replied">Replied</option>
          <option value="">All</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
      ) : error ? (
        <p className="text-sm text-rose-700 dark:text-rose-300 py-8 text-center">{error}</p>
      ) : rows.length === 0 ? (
        <p className="py-16 text-center text-sm text-ink-400 dark:text-parchment-400/60 italic">
          {filter === 'open' ? 'Inbox zero. The 48-hour promise is being kept.' : 'Nothing here.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-white dark:bg-ink-900 shadow-warm">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-400 dark:text-parchment-400/60 border-b border-parchment-300/60 dark:border-brass-900/30">
                <th className="px-4 py-2.5">Received</th>
                <th className="px-4 py-2.5">Parish</th>
                <th className="px-4 py-2.5">From</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5 w-full">Message</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-b border-parchment-200/60 dark:border-ink-800 last:border-0 align-top">
                  <td className="px-4 py-2.5 whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
                    {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    <span className="block text-[11px] text-ink-400 dark:text-parchment-400/50">
                      {new Date(r.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap font-medium text-ink-900 dark:text-parchment-50">{r.organization}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
                    {r.user_email || '—'}
                    {r.user_role && <span className="block text-[11px] text-ink-400 dark:text-parchment-400/50">{r.user_role}</span>}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-medium ${CATEGORY_STYLE[r.category] ?? ''}`}>
                      {r.category.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-ink-700 dark:text-parchment-200">
                    {r.message}
                    {r.route && <span className="block text-[11px] font-mono text-ink-400 dark:text-parchment-400/50 mt-0.5">{r.route}</span>}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => toggle(r)}
                      disabled={busyId === r.id}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium border transition-colors disabled:opacity-50 ${
                        r.status === 'open'
                          ? 'border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-brass-50 hover:text-brass-700 dark:hover:bg-brass-950/30'
                          : 'border-brass-200/60 dark:border-brass-900/40 bg-brass-50 dark:bg-brass-950/30 text-brass-700 dark:text-brass-300'
                      }`}
                    >
                      {busyId === r.id ? <Loader2 size={12} className="animate-spin" />
                        : r.status === 'open' ? <Check size={12} /> : <RotateCcw size={12} />}
                      {r.status === 'open' ? 'Mark replied' : 'Replied'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageWrapper>
  )
}
