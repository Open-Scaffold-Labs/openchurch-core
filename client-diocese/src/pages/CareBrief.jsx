import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Loader2, ChevronLeft, Printer } from 'lucide-react'
import { apiUrl } from '../api'

// The Parish Care Brief (CARE.2) — the artifact.
//
// "Artifacts outlive dashboards." This is the page that leaves the
// building: printed, carried into a bishop's visit, annotated in pen, kept
// in a folder. It is designed for paper first and the screen second.
//
// Print discipline: parchment ground drops to white for toner, the chrome
// disappears, nothing is clipped by a scroll container, and the whole thing
// is meant to hold to one page for an ordinary parish.
//
// Context before action, throughout. The situation and what has been
// happening come first; what was agreed comes after. A brief that opens
// with a task turns a conversation into an errand.

export default function CareBrief() {
  const { parishId } = useParams()
  const [brief, setBrief] = useState(null)
  const [internal, setInternal] = useState(false)
  const [error, setError] = useState('')
  const [recorded, setRecorded] = useState(false)

  useEffect(() => {
    setBrief(null)
    fetch(apiUrl(`/api/diocese/care/${parishId}/brief${internal ? '?internal=1' : ''}`))
      .then(r => r.ok ? r.json() : Promise.reject(new Error()))
      .then(setBrief)
      .catch(() => setError('That parish is not affiliated with this diocese.'))
  }, [parishId, internal])

  const printIt = async () => {
    if (!recorded) {
      // Recording that a brief was prepared is part of the record. It is
      // fire-and-forget: a failure here must never stop somebody printing.
      fetch(apiUrl(`/api/diocese/care/${parishId}/brief`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).catch(() => {})
      setRecorded(true)
    }
    window.print()
  }

  if (error) return <p className="text-sm text-ink-600">{error}</p>
  if (!brief) return <div className="flex justify-center py-24"><Loader2 size={22} className="animate-spin text-brass-500" /></div>

  const cy = brief.church_year
  const churchYear = [cy.feast, cy.season, cy.colour].filter(Boolean).join(' · ')

  return (
    <div className="max-w-3xl print:max-w-none">
      <style>{`
        @media print {
          @page { margin: 16mm; }
          body { background: #fff; }
          .no-print { display: none !important; }
          .brief-sheet {
            border: 0 !important; box-shadow: none !important;
            background: #fff !important; padding: 0 !important;
          }
          /* Never break a section across pages mid-thought. */
          .brief-sheet section { break-inside: avoid; }
        }
      `}</style>

      <div className="no-print flex items-center justify-between mb-5">
        <Link to={`/care/${parishId}`} className="inline-flex items-center gap-1 text-[12.5px] text-ink-500 hover:text-church-700">
          <ChevronLeft size={14} /> Back to the parish
        </Link>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-600">
            <input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} />
            Include internal notes
          </label>
          <button onClick={printIt}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-church-600 text-parchment-50 text-sm font-semibold hover:bg-church-700">
            <Printer size={14} /> Print
          </button>
        </div>
      </div>

      {internal && (
        <p className="no-print text-[12px] text-church-700 bg-church-50/60 border border-church-200/60 rounded-lg px-3 py-2 mb-4">
          This copy carries the office’s internal notes. Consider whether it should leave the office.
        </p>
      )}

      <article className="brief-sheet rounded-xl border border-parchment-300/70 bg-parchment-50 px-9 py-8 text-ink-900">
        <header className="text-center border-b border-parchment-300 pb-5 mb-6">
          <p className="text-[10.5px] uppercase tracking-[0.2em] text-brass-600 mb-2">Parish Care Brief</p>
          <h1 className="font-serif text-3xl font-bold text-church-700 leading-tight">{brief.parish.name}</h1>
          <p className="text-[12.5px] text-ink-500 mt-1.5">
            {[brief.parish.region, brief.diocese].filter(Boolean).join(' · ')}
          </p>
          {churchYear && <p className="font-serif italic text-[13px] text-ink-600 mt-2">{churchYear}</p>}
        </header>

        <Block title="Where things stand">
          <p className="text-[14px] leading-relaxed">{brief.situation.because}</p>
          {brief.situation.also?.map((l, i) => (
            <p key={i} className="text-[13px] text-ink-600 leading-relaxed mt-1.5">{l}</p>
          ))}
        </Block>

        {brief.recent_history.length > 0 && (
          <Block title="Recently">
            <ul className="space-y-1.5">
              {brief.recent_history.map((h, i) => (
                <li key={i} className="text-[13.5px] leading-snug">
                  <span className="text-ink-400 tabular-nums mr-2">{h.occurred_on}</span>
                  {h.summary}
                </li>
              ))}
            </ul>
          </Block>
        )}

        {(brief.current_work.open_support_requests > 0 || brief.current_work.transitions.length > 0 ||
          brief.current_work.reports.length > 0) && (
          <Block title="Current work">
            <ul className="space-y-1.5 text-[13.5px] leading-snug">
              {/* A count and a plain statement of whose channel it is. The
                  ticket text is the parish's message to OpenChurch and never
                  prints here — see careBrief.js. It also no longer reads as
                  "Support requested", which claimed the parish had asked the
                  diocese for something it had not. */}
              {brief.current_work.open_support_requests > 0 && (
                <li>
                  {brief.current_work.open_support_requests === 1
                    ? 'One open support request with OpenChurch'
                    : `${brief.current_work.open_support_requests} open support requests with OpenChurch`}
                  <span className="text-ink-500"> — details are between the parish and OpenChurch</span>
                </li>
              )}
              {brief.current_work.transitions.map((t, i) => (
                <li key={`t${i}`} className="capitalize-first">
                  {String(t.kind).replaceAll('_', ' ')}
                  {t.continuity_needs ? ` — ${t.continuity_needs}` : ''}
                </li>
              ))}
              {brief.current_work.reports.slice(0, 2).map((r, i) => (
                <li key={`r${i}`}>Report {r.period_start} to {r.period_end} — {REPORT_WORD[r.status] ?? r.status}</li>
              ))}
            </ul>
          </Block>
        )}

        {/* Action comes AFTER the context, never before it. */}
        {brief.agreed_next_steps.length > 0 && (
          <Block title="Agreed next steps">
            <ul className="space-y-2">
              {brief.agreed_next_steps.map((f, i) => (
                <li key={i} className="text-[13.5px] leading-snug">
                  {f.next_action}
                  <span className="block text-[12px] text-ink-500 mt-0.5">
                    {[f.context, f.owner_name, f.due_on && `by ${f.due_on}`].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {brief.people.length > 0 && (
          <Block title="People">
            <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-[13px]">
              {brief.people.map((p, i) => (
                <li key={i}>
                  <span className="font-medium">{p.name}</span>
                  <span className="text-ink-500"> — {p.role}</span>
                  {(p.email || p.phone) && (
                    <span className="block text-[11.5px] text-ink-500">{[p.phone, p.email].filter(Boolean).join(' · ')}</span>
                  )}
                </li>
              ))}
            </ul>
          </Block>
        )}

        {brief.withheld && (
          <p className="text-[11.5px] italic text-ink-500 border-l-2 border-parchment-300 pl-3 mb-5">{brief.withheld}</p>
        )}

        <footer className="border-t border-parchment-300 pt-4 mt-6">
          <p className="text-[11px] text-ink-500 leading-relaxed">{brief.footer}</p>
          <p className="text-[11px] text-ink-400 mt-2">Prepared {brief.prepared_on}.</p>
          {/* Room to write on. A brief is meant to be annotated. */}
          <div className="no-screen mt-6 hidden print:block">
            <p className="text-[10.5px] uppercase tracking-widest text-ink-400 mb-2">Notes</p>
            {[0, 1, 2, 3].map(i => <div key={i} className="border-b border-parchment-300 h-6" />)}
          </div>
        </footer>
      </article>
    </div>
  )
}

// Care language on the artifact, whatever the stored state is called.
const REPORT_WORD = {
  submitted: 'prepared for review',
  approved:  'acknowledged',
  returned:  'back with the parish',
}

function Block({ title, children }) {
  return (
    <section className="mb-5">
      <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-brass-600 mb-2">{title}</h2>
      {children}
    </section>
  )
}
