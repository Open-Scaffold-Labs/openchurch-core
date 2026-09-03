import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Check, X, UserRound } from 'lucide-react'
import { apiUrl } from '../api'
import { loadOne, postJson } from '../utils/format'
import LoadError from '../components/LoadError'

// The office's own follow-ups (CARE.1, completed in CARE.3).
//
// This is a memory aid for diocesan staff, not a task-assignment system for
// parishes. Nothing here is visible to a parish, nothing is chased, and
// there is no overdue state — a date that has passed is shown as a date,
// not as a failure.
//
// "Let it go" sits beside "Done" on purpose. Deciding a follow-up is no
// longer needed is a legitimate pastoral judgement, and a system that only
// offers "complete" quietly teaches people to lie to it. CARE.3 gives each
// of them somewhere to say what happened — and keeps those two answers in
// separate fields, because "we did it" and "we decided not to" are
// different facts and a record that conflates them is worth less than none.

const TABS = [
  ['open', 'Waiting'],
  ['done', 'Done'],
  ['let_go', 'Let go'],
]

export default function FollowUps() {
  const [tab, setTab] = useState('open')
  const [rows, setRows] = useState(null)
  const [team, setTeam] = useState([])
  const [busy, setBusy] = useState(null)
  const [settling, setSettling] = useState(null)   // { id, state }
  const [note, setNote] = useState('')
  const [writeError, setWriteError] = useState('')

  // A failed load used to `setRows([])`, which this page renders as
  // "Nothing waiting" — the office told it has no follow-ups when it has
  // some. A memory aid that forgets silently is worse than none.
  const [failed, setFailed] = useState(false)

  const load = async (which = tab) => {
    setFailed(false)
    const { ok, data } = await loadOne(
      apiUrl(`/api/diocese/care/followups?state=${which}`),
      d => d.followups ?? [],
    )
    if (!ok) { setFailed(true); setRows([]); return }
    setRows(data)
  }

  useEffect(() => { setRows(null); load(tab) }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Owner names only. A failure here leaves the list empty, which the
    // rows already render as "no owner" rather than as a claim — so this one
    // stays quiet on purpose, but it still checks the status before
    // trusting the body.
    loadOne(apiUrl('/api/diocese/care/team'), d => d.team ?? [])
      .then(({ ok, data }) => { if (ok) setTeam(data) })
  }, [])

  // Marking a follow-up done used to close the panel and clear the note
  // regardless of what the server said — so "Done" on a failed request
  // removed the reminder from the screen while leaving it open in the
  // database, and threw away whatever was typed about what happened.
  const patch = async (id, body) => {
    setBusy(id); setWriteError('')
    try {
      const { ok, error } = await postJson(apiUrl(`/api/diocese/care/followups/${id}`), body, 'PATCH')
      if (!ok) { setWriteError(`${error} What you wrote is still here.`); return }
      setSettling(null); setNote('')
      await load()
    } finally { setBusy(null) }
  }

  const input = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300 bg-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400'

  return (
    <div className="max-w-3xl">
      <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">Follow-ups</h1>
      <p className="text-sm text-ink-500 mb-6">
        The office’s own notes to itself. Parishes never see these, and nothing here will chase you.
      </p>

      <div className="flex items-center gap-1 mb-6">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" onClick={() => setTab(key)} aria-pressed={tab === key}
            className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
              tab === key ? 'bg-church-600 text-parchment-50' : 'text-ink-600 hover:bg-parchment-200'}`}>
            {label}
          </button>
        ))}
      </div>

      {!rows ? (
        <div className="flex justify-center py-24"><Loader2 size={22} className="animate-spin text-brass-500" /></div>
      ) : failed ? (
        <LoadError
          title="Your follow-ups didn't load."
          body="This is not an empty list — something may still be waiting. Nothing was marked done or let go."
          onRetry={() => load(tab)}
        />
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-parchment-300/70 bg-parchment-50 p-8 text-center">
          <p className="font-serif text-xl font-bold text-church-600 mb-2">
            {tab === 'open' ? 'Nothing waiting' : tab === 'done' ? 'Nothing settled yet' : 'Nothing let go'}
          </p>
          <p className="text-sm text-ink-600 max-w-sm mx-auto">
            {tab === 'open'
              ? 'When something is worth coming back to, note it from a parish’s page and it will wait here.'
              : 'This is where follow-ups go once they are resolved, with whatever was recorded at the time.'}
          </p>
        </div>
      ) : (
        <ul className="rounded-xl border border-parchment-300/70 divide-y divide-parchment-300/60 overflow-hidden">
          {rows.map(f => (
            <li key={f.id} className="bg-parchment-50 px-4 py-3.5">
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <Link to={`/care/${f.parish_org_id}`} className="text-[13px] font-semibold text-church-700 hover:underline">
                    {f.parish_name}
                  </Link>
                  <p className="text-[13.5px] text-ink-800 leading-snug mt-0.5">{f.next_action}</p>
                  <p className="text-[12px] text-ink-500 leading-snug mt-0.5">
                    {[f.context,
                      f.owner_name ? `with ${f.owner_name}` : 'unassigned',
                      f.due_on && `noted for ${f.due_on}`,
                      // Where this came from, when it came from reading a
                      // report together. Context before action, as ever.
                      f.period_start && `from the ${f.period_start} to ${f.period_end} report`,
                     ].filter(Boolean).join(' · ')}
                  </p>
                  {f.completion_note && (
                    <p className="text-[12px] text-ink-600 leading-snug mt-1.5 border-l-2 border-parchment-300 pl-2">
                      {f.completion_note}
                    </p>
                  )}
                  {f.let_go_reason && (
                    <p className="text-[12px] text-ink-500 italic leading-snug mt-1.5 border-l-2 border-parchment-300 pl-2">
                      Let go — {f.let_go_reason}
                    </p>
                  )}
                  {f.settled_on && (
                    <p className="text-[11px] text-ink-400 mt-1">
                      {f.state === 'done' ? 'Done' : 'Let go'} {f.settled_on}
                      {f.settled_by_name ? ` · ${f.settled_by_name}` : ''}
                    </p>
                  )}
                </div>

                {tab === 'open' && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => { setSettling({ id: f.id, state: 'done' }); setNote('') }}
                      disabled={busy === f.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12.5px] text-ink-700 hover:bg-parchment-200 disabled:opacity-50">
                      <Check size={13} /> Done
                    </button>
                    <button onClick={() => { setSettling({ id: f.id, state: 'let_go' }); setNote('') }}
                      disabled={busy === f.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12.5px] text-ink-500 hover:bg-parchment-200 disabled:opacity-50">
                      <X size={13} /> Let it go
                    </button>
                  </div>
                )}
              </div>

              {/* Assignment. A follow-up nobody owns is a follow-up nobody
                  does, and "unassigned" is an honest state to show. */}
              {tab === 'open' && settling?.id !== f.id && (
                <div className="mt-2.5 flex items-center gap-2">
                  <UserRound size={13} className="text-ink-400 shrink-0" aria-hidden="true" />
                  <label htmlFor={`owner-${f.id}`} className="sr-only">Who is looking after this</label>
                  <select id={`owner-${f.id}`} value={f.owner_user_id ?? ''} disabled={busy === f.id}
                    onChange={e => patch(f.id, { owner_user_id: e.target.value ? Number(e.target.value) : null })}
                    className="px-2 py-1 text-[12.5px] rounded-lg border border-parchment-300 bg-parchment-50 text-ink-700 focus:outline-none focus:ring-2 focus:ring-brass-400">
                    <option value="">No one yet</option>
                    {team.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
              )}

              {/* Settling asks what happened. One line is enough; it is a
                  record, not a report. */}
              {settling?.id === f.id && (
                <form className="mt-3 space-y-2" onSubmit={e => {
                  e.preventDefault()
                  patch(f.id, settling.state === 'done'
                    ? { state: 'done', completion_note: note.trim() || undefined }
                    : { state: 'let_go', let_go_reason: note.trim() || undefined })
                }}>
                  <label htmlFor={`note-${f.id}`} className="block text-[12px] text-ink-600">
                    {settling.state === 'done'
                      ? 'What happened? (optional)'
                      : 'Why is this no longer needed? (optional)'}
                  </label>
                  <input id={`note-${f.id}`} className={input} value={note} onChange={e => setNote(e.target.value)}
                    placeholder={settling.state === 'done'
                      ? 'Sat together on Tuesday; the import maps now.'
                      : 'They sorted it themselves.'} />
                  <div className="flex gap-2">
                    {/* "Record it", not a second "Let it go". The row
                        already has a button by that name — the one that
                        opened this form — and two controls with the same
                        accessible name in the same row means a screen
                        reader announces the identical thing twice and the
                        user cannot tell which is which. Found by a browser
                        test that could not tell them apart either. */}
                    <button type="submit" disabled={busy === f.id}
                      className="px-3 py-1.5 rounded-lg bg-church-600 text-parchment-50 text-[13px] font-semibold disabled:opacity-60">
                      Record it
                    </button>
                    <button type="button" onClick={() => { setSettling(null); setNote('') }}
                      className="px-3 py-1.5 text-[13px] text-ink-500">Cancel</button>
                  </div>
                  {writeError && <p className="text-[12px] text-amber-800">{writeError}</p>}
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
