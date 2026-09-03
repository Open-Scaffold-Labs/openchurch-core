import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Loader2, ChevronLeft, Check } from 'lucide-react'
import { apiUrl } from '../api'
import { postJson } from '../utils/format'

// Reading a report together (CARE.3).
//
// The chancery could already approve or return a submission, and it could
// write a note nobody could read back. What was missing is the part that
// is actually pastoral: sitting down with the thing, saying something about
// it to the parish, and agreeing what happens next.
//
// READING IS NOT APPROVING. The stored status — submitted, approved,
// returned — is untouched here, because 'approved' gates the assessment
// roll-up and overloading it would be a money change dressed as a
// vocabulary change. "We read this together" is its own fact and implies no
// judgement about the parish, which is the whole reason it needed its own
// place to live.
//
// TWO STREAMS, ONE PAGE. A note is either shared with the parish or kept in
// the office, chosen per note, and only pastoral leadership sees the second
// kind. What the parish may see is never a matter of remembering which box
// you typed into.

export default function ReportReview() {
  const { submissionId } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [body, setBody] = useState('')
  const [shared, setShared] = useState(true)
  const [nextStep, setNextStep] = useState('')
  const [busy, setBusy] = useState(false)
  // Both writes below ignored their response and cleared the form. For the
  // diocese-only note that loses a record; for a SHARED note it does worse —
  // the office comes away believing it said something to the parish that the
  // parish will never see. Nothing clears until the server has agreed.
  const [writeError, setWriteError] = useState('')

  const load = () => fetch(apiUrl(`/api/diocese/care/submissions/${submissionId}/review`))
    .then(r => (r.ok ? r.json() : Promise.reject(new Error())))
    .then(setData)
    .catch(() => setError('That report is not this diocese’s.'))

  useEffect(() => { load() }, [submissionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const addNote = async (e) => {
    e.preventDefault()
    if (body.trim().length < 1) return
    setBusy(true); setWriteError('')
    try {
      const { ok, error } = await postJson(apiUrl(`/api/diocese/care/submissions/${submissionId}/notes`), {
        body: body.trim(),
        visibility: shared ? 'shared' : 'diocese',
        agreed_next_step: nextStep.trim() || undefined,
      })
      if (!ok) {
        setWriteError(shared
          ? `${error} The parish has NOT seen this — your words are still here.`
          : `${error} Your words are still here.`)
        return
      }
      setBody(''); setNextStep(''); await load()
    } finally { setBusy(false) }
  }

  const markRead = async () => {
    setBusy(true); setWriteError('')
    try {
      const { ok, error } = await postJson(apiUrl(`/api/diocese/care/submissions/${submissionId}/reviewed`))
      if (!ok) { setWriteError(error); return }
      await load()
    } finally { setBusy(false) }
  }

  if (error) return <p className="text-sm text-ink-600 max-w-lg">{error}</p>
  if (!data) return <div className="flex justify-center py-24"><Loader2 size={22} className="animate-spin text-brass-500" /></div>

  const s = data.submission
  const input = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300 bg-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400'

  return (
    <div className="max-w-3xl">
      <Link to={`/care/${s.parish_org_id}`} className="inline-flex items-center gap-1 text-[12.5px] text-ink-500 hover:text-church-700 mb-4">
        <ChevronLeft size={14} /> {s.parish_name}
      </Link>

      <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">Reading this together</h1>
      <p className="text-sm text-ink-500 mb-6">
        {s.parish_name} · {s.period_start} to {s.period_end}
      </p>

      {/* Context before action. What the parish sent, and whether anyone
          has sat down with it yet. */}
      <div className="rounded-xl border border-parchment-300/70 bg-parchment-50 p-5 mb-7">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-2">Where this stands</p>
        {s.reviewed_together_on ? (
          <p className="text-sm text-ink-700 leading-relaxed">
            Read together on {s.reviewed_together_on}
            {s.reviewed_together_name ? ` by ${s.reviewed_together_name}` : ''}.
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-700 leading-relaxed mb-3">
              Nobody has recorded reading this with the parish yet.
            </p>
            <button onClick={markRead} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-church-600 text-parchment-50 text-sm font-semibold hover:bg-church-700 disabled:opacity-60">
              <Check size={14} /> We read this together
            </button>
            <p className="text-[11.5px] text-ink-500 mt-2 leading-relaxed">
              This records a conversation. It does not accept the report for assessment,
              and the parish is told only that its report was read.
            </p>
          </>
        )}
      </div>

      {/* The conversation. */}
      <section className="mb-8">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-3">Notes</h2>

        {data.notes.length === 0 ? (
          <p className="text-sm text-ink-500 italic mb-4">
            Nothing written yet. The first note is usually what you said on the phone.
          </p>
        ) : (
          <ul className="space-y-3 mb-5">
            {data.notes.map(n => (
              <li key={n.id} className="rounded-lg border border-parchment-300/70 bg-parchment-50 p-3.5">
                <p className="text-[13.5px] text-ink-800 leading-snug">{n.body}</p>
                {n.agreed_next_step && (
                  <p className="text-[12.5px] text-ink-600 mt-1.5">Agreed: {n.agreed_next_step}</p>
                )}
                <p className="text-[11px] text-ink-400 mt-1.5">
                  {String(n.created_at).slice(0, 10)}
                  {n.author_name ? ` · ${n.author_name}` : ''}
                  {n.visibility === 'shared'
                    ? <span className="ml-1.5 text-brass-600">shared with the parish</span>
                    : <span className="ml-1.5">kept in the office</span>}
                </p>
              </li>
            ))}
          </ul>
        )}

        {/* Said on the page rather than left to be inferred from an absence. */}
        {data.withheld && (
          <p className="text-[12px] text-ink-500 italic border-l-2 border-parchment-300 pl-3 mb-4">
            {data.withheld}
          </p>
        )}

        <form onSubmit={addNote} className="space-y-2 rounded-lg border border-parchment-300/70 p-3">
          <label htmlFor="note" className="sr-only">A note on this report</label>
          <textarea id="note" className={`${input} min-h-[70px]`} value={body} onChange={e => setBody(e.target.value)}
            placeholder="Spoke with the administrator; the building-fund line came in under a different account this period." />
          <label htmlFor="agreed" className="sr-only">What was agreed</label>
          <input id="agreed" className={input} value={nextStep} onChange={e => setNextStep(e.target.value)}
            placeholder="What was agreed, if anything" />
          <label className="flex items-center gap-2 text-[12.5px] text-ink-600">
            <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />
            Share this note with the parish
          </label>
          <p className="text-[11px] text-ink-400 leading-relaxed">
            Unshared notes stay in the office and are visible only to pastoral leadership.
          </p>
          <button type="submit" disabled={busy || !body.trim()}
            className="px-3 py-1.5 rounded-lg bg-church-600 text-parchment-50 text-[13px] font-semibold disabled:opacity-50">
            Add the note
          </button>
          {writeError && <p className="text-[12px] text-amber-800 leading-snug">{writeError}</p>}
        </form>
      </section>

      {/* Action last. */}
      <section>
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-3">What happens next</h2>
        {data.followups.length === 0 ? (
          <p className="text-sm text-ink-500 italic">
            Nothing agreed yet. A follow-up raised from{' '}
            <Link to={`/care/${s.parish_org_id}`} className="text-church-700 hover:underline">
              the parish’s page
            </Link>{' '}
            will appear here.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.followups.map(f => (
              <li key={f.id} className="rounded-lg border border-parchment-300/70 bg-parchment-50 p-3.5">
                <p className="text-[13.5px] text-ink-800 leading-snug">{f.next_action}</p>
                <p className="text-[11.5px] text-ink-500 mt-1">
                  {[f.context, f.owner_name ? `with ${f.owner_name}` : 'unassigned',
                    f.due_on && `noted for ${f.due_on}`,
                    f.state !== 'open' && (f.state === 'done' ? 'done' : 'let go'),
                   ].filter(Boolean).join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
