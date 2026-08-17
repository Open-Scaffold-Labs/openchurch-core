import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Loader2, ChevronLeft, FileText, Plus } from 'lucide-react'
import { apiUrl } from '../api'
import { StatusChip } from './ParishCare'

// The parish detail page (CARE.1) — the diocesan office's durable memory of
// a parish, not a data profile.
//
// The timeline reads like an institutional record: dated entries in
// sentences, with who wrote them. Deliberately NOT an activity feed — no
// avatars, no relative timestamps ("3h ago"), no icons shouting event
// types, no infinite scroll. A canon should be able to read it the way they
// would read minutes.

const KIND_LABEL = {
  report: 'Report', visit: 'Visit', support_request: 'Support',
  transition: 'Transition', followup: 'Follow-up', brief: 'Care brief', note: 'Note',
}

export default function ParishDetail() {
  const { parishId } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ context: '', next_action: '', due_on: '' })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => fetch(apiUrl(`/api/diocese/care/${parishId}`))
    .then(r => r.ok ? r.json() : Promise.reject(new Error('not found')))
    .then(setData)
    .catch(() => setError('That parish is not affiliated with this diocese.'))

  useEffect(() => { load() }, [parishId]) // eslint-disable-line react-hooks/exhaustive-deps

  const addFollowUp = async (e) => {
    e.preventDefault()
    if (!form.context.trim() || !form.next_action.trim()) return
    setBusy(true)
    try {
      await fetch(apiUrl(`/api/diocese/care/${parishId}/followups`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, due_on: form.due_on || undefined }),
      })
      setForm({ context: '', next_action: '', due_on: '' }); setAdding(false); await load()
    } finally { setBusy(false) }
  }

  const addNote = async (e) => {
    e.preventDefault()
    if (note.trim().length < 3) return
    setBusy(true)
    try {
      await fetch(apiUrl(`/api/diocese/care/${parishId}/timeline`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'note', summary: note.trim() }),
      })
      setNote(''); await load()
    } finally { setBusy(false) }
  }

  if (error) return <p className="text-sm text-ink-600 max-w-lg">{error}</p>
  if (!data) return <div className="flex justify-center py-24"><Loader2 size={22} className="animate-spin text-brass-500" /></div>

  const { parish, status, current_work: work, timeline } = data
  const input = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300 bg-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400'

  return (
    <div className="max-w-4xl">
      <Link to="/care" className="inline-flex items-center gap-1 text-[12.5px] text-ink-500 hover:text-church-700 mb-4">
        <ChevronLeft size={14} /> Parish Care
      </Link>

      {/* Context first, always. */}
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="font-serif text-3xl font-bold text-church-600">{parish.name}</h1>
        <Link to={`/care/${parish.id}/brief`}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-church-600 text-parchment-50 text-sm font-semibold hover:bg-church-700 shrink-0">
          <FileText size={14} /> Care brief
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2.5 text-[12.5px] text-ink-500 mb-3">
        {parish.region && <span>{parish.region}</span>}
        {parish.tradition && parish.tradition !== 'general' && <span className="capitalize">{parish.tradition}</span>}
        <span>Sharing: {parish.grant_level}</span>
      </div>
      <StatusChip status={status} size="md" />
      <p className="text-sm text-ink-600 leading-snug mt-2 mb-8 max-w-2xl">{status.because}</p>

      <div className="grid lg:grid-cols-2 gap-8">
        <section>
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-3">Current work</h2>
          <div className="space-y-3">
            {/* A count only. The ticket text is the parish's message to
                OpenChurch and is not the diocese's to read — see
                server/src/diocese/careBrief.js. */}
            {work.open_support_requests > 0 && (
              <Card label="Open with OpenChurch"
                body={work.open_support_requests === 1
                  ? 'One open support request'
                  : `${work.open_support_requests} open support requests`}
                foot="Details are between the parish and OpenChurch" />
            )}
            {work.transitions.map(t => (
              <Card key={`t${t.id}`} label="Transition"
                body={String(t.kind).replaceAll('_', ' ')}
                foot={t.continuity_needs || (t.began_on ? `Began ${t.began_on}` : null)} />
            ))}
            {work.submissions.filter(s => s.status === 'submitted').map(s => (
              <Card key={`r${s.id}`} label="Prepared for review" body={`${s.period_start} to ${s.period_end}`} foot="Waiting on a shared review" />
            ))}
            {work.followups.map(f => (
              <Card key={`f${f.id}`} label="Agreed next action" body={f.next_action}
                foot={[f.context, f.owner_name, f.due_on && `by ${f.due_on}`].filter(Boolean).join(' · ')} />
            ))}
            {!work.open_support_requests && !work.transitions.length &&
             !work.followups.length && !work.submissions.some(s => s.status === 'submitted') && (
              <p className="text-sm text-ink-500 italic">Nothing is outstanding on either side just now.</p>
            )}
          </div>

          {!adding ? (
            <button onClick={() => setAdding(true)}
              className="mt-4 inline-flex items-center gap-1.5 text-[13px] text-church-700 hover:underline">
              <Plus size={13} /> Note something to come back to
            </button>
          ) : (
            <form onSubmit={addFollowUp} className="mt-4 space-y-2 rounded-lg border border-parchment-300/70 p-3">
              <input className={input} placeholder="Context — e.g. Rector transition last spring"
                value={form.context} onChange={e => setForm(f => ({ ...f, context: e.target.value }))} />
              <input className={input} placeholder="Next action — e.g. Ask whether register help would be useful"
                value={form.next_action} onChange={e => setForm(f => ({ ...f, next_action: e.target.value }))} />
              <input type="date" className={input} value={form.due_on}
                onChange={e => setForm(f => ({ ...f, due_on: e.target.value }))} />
              <p className="text-[11px] text-ink-400">
                This is the office’s own memory. The parish never sees it, and nothing chases you about it.
              </p>
              <div className="flex gap-2">
                <button type="submit" disabled={busy}
                  className="px-3 py-1.5 rounded-lg bg-church-600 text-parchment-50 text-[13px] font-semibold disabled:opacity-60">Keep it</button>
                <button type="button" onClick={() => setAdding(false)} className="px-3 py-1.5 text-[13px] text-ink-500">Cancel</button>
              </div>
            </form>
          )}
        </section>

        <section>
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-3">The record</h2>

          <form onSubmit={addNote} className="mb-4">
            <textarea className={`${input} min-h-[62px]`} value={note} onChange={e => setNote(e.target.value)}
              placeholder="Write a line for the record — “Spoke with the administrator about the register backlog.”" />
            <button type="submit" disabled={busy || note.trim().length < 3}
              className="mt-2 px-3 py-1.5 rounded-lg bg-parchment-200 text-ink-700 text-[13px] font-semibold disabled:opacity-50">
              Add to the record
            </button>
          </form>

          {timeline.length === 0 ? (
            <p className="text-sm text-ink-500 italic">Nothing recorded yet. The first entry is usually a first conversation.</p>
          ) : (
            <ol className="border-l border-parchment-300 pl-4 space-y-4">
              {timeline.map(t => (
                <li key={t.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 w-1.5 h-1.5 rounded-full bg-brass-400" aria-hidden="true" />
                  <p className="text-[11px] uppercase tracking-widest text-ink-400">
                    {t.occurred_on} · {KIND_LABEL[t.kind] ?? t.kind}
                    {t.visibility === 'shared' && <span className="ml-1.5 normal-case tracking-normal text-brass-600">shared with the parish</span>}
                  </p>
                  <p className="text-[13.5px] text-ink-800 leading-snug mt-0.5">{t.summary}</p>
                  {t.detail && <p className="text-[12.5px] text-ink-500 leading-snug mt-1">{t.detail}</p>}
                  {t.actor_name && <p className="text-[11px] text-ink-400 mt-1">{t.actor_name}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  )
}

function Card({ label, body, foot }) {
  return (
    <div className="rounded-lg border border-parchment-300/70 bg-parchment-50 p-3">
      <p className="text-[10.5px] font-semibold uppercase tracking-widest text-brass-600 mb-1">{label}</p>
      <p className="text-[13.5px] text-ink-800 leading-snug capitalize-first">{body}</p>
      {foot && <p className="text-[11.5px] text-ink-500 mt-1 leading-snug">{foot}</p>}
    </div>
  )
}
