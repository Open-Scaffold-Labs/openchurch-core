import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, ArrowRight, FileText } from 'lucide-react'
import { apiUrl } from '../api'
import { loadOne } from '../utils/format'

// Parish Care (CARE.1) — the calm working view.
//
// The governing question is "what parish needs care, what is the context,
// and what is the next faithful action". Not "which parish is failing".
//
// Things deliberately absent from this screen: a KPI wall, red alerts,
// badges, countdowns, rankings, percentages, a health score, and any
// comparison between parishes. The three small state cards explain what
// the words mean rather than shouting a number.
//
// COLOUR NEVER STANDS ALONE. Every status renders its label as text beside
// its dot, and the dot carries aria-hidden — a screen reader hears the
// words, not a colour it cannot see.

const TONE = {
  // On-palette as of 2026-08-17: `sage` is a real Parchment & Brass scale
  // (see tailwind.config.js) rather than raw Tailwind emerald behind an
  // OPERATOR exception. The tone the Pastoral Oversight handoff asked for is
  // unchanged; it is simply part of the design system now.
  'muted-green': { dot: 'bg-sage-600/70', chip: 'text-sage-800 bg-sage-50/70 border-sage-200/60' },
  brass:         { dot: 'bg-brass-500',      chip: 'text-brass-800 bg-brass-50 border-brass-200/70' },
  burgundy:      { dot: 'bg-church-600',     chip: 'text-church-700 bg-church-50/60 border-church-200/60' },
  stone:         { dot: 'bg-ink-400',        chip: 'text-ink-600 bg-parchment-200/70 border-parchment-300/70' },
}

// The order they are explained in, which is also the order of how concrete
// the next human step is — not an order of severity.
const EXPLAINED = ['offer_support', 'review_together', 'awaiting_update', 'ready']

function StatusChip({ status, size = 'sm' }) {
  const tone = TONE[status.tone] ?? TONE.stone
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ${tone.chip} ${size === 'sm' ? 'text-[11px]' : 'text-xs'}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
      {status.label}
    </span>
  )
}

export default function ParishCare() {
  const [data, setData] = useState(null)
  const [selected, setSelected] = useState(null)
  const [panel, setPanel] = useState(null)
  const [error, setError] = useState('')
  // CARE.3 — narrowing, not sorting. There is no "sort by" here on purpose:
  // an ordering is an implied ranking, and this list is alphabetical.
  const [stateFilter, setStateFilter] = useState(null)
  const [q, setQ] = useState('')
  const [typed, setTyped] = useState('')

  // Debounced so a search runs when someone stops typing rather than on
  // every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQ(typed.trim()), 250)
    return () => clearTimeout(id)
  }, [typed])

  useEffect(() => {
    const params = new URLSearchParams()
    if (stateFilter) params.set('state', stateFilter)
    if (q) params.set('q', q)
    const suffix = params.toString() ? `?${params}` : ''
    // `d.parishes ? d : { parishes: [], counts: {} }` swallowed a 500 the
    // same way the rest of this app did: an error body has no `parishes`
    // key, so a failed request rendered as a diocese with no parishes in it
    // — on the screen a chancery uses to decide who needs attention.
    let live = true
    loadOne(apiUrl(`/api/diocese/care${suffix}`)).then(({ ok, data }) => {
      if (!live) return
      if (!ok || !Array.isArray(data?.parishes)) {
        setError('Could not load parish care just now.')
        return
      }
      setError('')
      setData(data)
    })
    return () => { live = false }
  }, [stateFilter, q])

  useEffect(() => {
    if (!selected) { setPanel(null); return }
    setPanel('loading')
    // A failed panel used to `setPanel(null)`, which closes it as if nothing
    // had been clicked. `'error'` is a third state so the panel can say so.
    loadOne(apiUrl(`/api/diocese/care/${selected}`)).then(({ ok, data }) => {
      setPanel(ok && data?.parish ? data : 'error')
    })
  }, [selected])

  if (error) {
    // Calm under error: say what happened, offer the one useful action, and
    // do not colour the whole screen red about it.
    return (
      <div className="max-w-xl">
        <h1 className="font-serif text-3xl font-bold text-church-600 mb-2">Parish Care</h1>
        <p className="text-sm text-ink-600">{error} Nothing has changed — try again in a moment.</p>
      </div>
    )
  }
  if (!data) {
    return <div className="flex justify-center py-24"><Loader2 size={22} className="animate-spin text-brass-500" /></div>
  }

  const { parishes, counts } = data
  const withNextStep = parishes.filter(p => p.status.key !== 'ready')
  const settled = parishes.filter(p => p.status.key === 'ready')

  return (
    <div className="flex gap-8 items-start">
      <div className="flex-1 min-w-0 max-w-3xl">
        <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">Parish Care</h1>
        <p className="text-sm text-ink-500 mb-5">
          A quiet view of where a parish may need attention, accompaniment, or simply time.
        </p>

        {/* Find a parish you already have in mind. Not a search engine —
            a filter over a list of dozens, matching the four things a
            staff member actually remembers. */}
        <div className="mb-6">
          <label htmlFor="care-search" className="sr-only">Find a parish</label>
          <input
            id="care-search" type="search" value={typed} onChange={e => setTyped(e.target.value)}
            placeholder="Find a parish, place, deanery or tradition"
            className="w-full max-w-md px-3 py-2 text-sm rounded-lg border border-parchment-300 bg-parchment-50 text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
          />
        </div>

        {/* Explanatory states, not a KPI wall. The number is small and the
            sentence is the point. */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
          {EXPLAINED.map(key => {
            const sample = parishes.find(p => p.status.key === key)?.status
            const meta = sample ?? FALLBACK_MEANING[key]
            const tone = TONE[meta.tone] ?? TONE.stone
            const on = stateFilter === key
            return (
              <button
                key={key} type="button"
                onClick={() => setStateFilter(on ? null : key)}
                aria-pressed={on}
                className={`text-left rounded-xl border p-4 transition-colors ${
                  on ? 'border-brass-400 bg-parchment-200/60' : 'border-parchment-300/70 bg-parchment-50 hover:bg-parchment-100'}`}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-500">{meta.label}</p>
                </div>
                <p className="font-serif text-2xl text-church-700 leading-none mb-2">{counts[key] ?? 0}</p>
                <p className="text-[11.5px] text-ink-500 leading-snug">{meta.meaning}</p>
              </button>
            )
          })}
        </div>

        {(stateFilter || q) && (
          <p className="text-[12.5px] text-ink-500 mb-4">
            Showing {parishes.length} of {data.total ?? parishes.length}
            {stateFilter ? ` in ${(FALLBACK_MEANING[stateFilter]?.label ?? stateFilter).toLowerCase()}` : ''}
            {q ? ` matching “${q}”` : ''}.{' '}
            <button type="button" onClick={() => { setStateFilter(null); setTyped(''); }}
              className="text-church-700 hover:underline">Show everything</button>
          </p>
        )}

        {parishes.length === 0 && (stateFilter || q) ? (
          <div className="rounded-2xl border border-parchment-300/70 bg-parchment-50 p-8 text-center">
            <p className="font-serif text-xl font-bold text-church-600 mb-2">Nothing matches that</p>
            <p className="text-sm text-ink-600 max-w-md mx-auto">
              Try a shorter search, or{' '}
              <button type="button" onClick={() => { setStateFilter(null); setTyped(''); }}
                className="text-church-700 hover:underline">show everything</button>.
            </p>
          </div>
        ) : parishes.length === 0 ? (
          <div className="rounded-2xl border border-parchment-300/70 bg-parchment-50 p-8 text-center">
            <p className="font-serif text-xl font-bold text-church-600 mb-2">No parishes yet</p>
            <p className="text-sm text-ink-600 max-w-md mx-auto">
              Once a parish accepts an invitation from the Parishes page, it will appear here
              with whatever context the office has recorded.
            </p>
          </div>
        ) : (
          <>
            <SectionList
              title="Where there is a next step"
              rows={withNextStep} selected={selected} onSelect={setSelected}
              empty="Nothing is outstanding with any parish today."
            />
            {settled.length > 0 && (
              <SectionList
                title="Settled for now"
                rows={settled} selected={selected} onSelect={setSelected}
                muted
              />
            )}
          </>
        )}
      </div>

      <ContextPanel panel={panel} onClose={() => setSelected(null)} />
    </div>
  )
}

// Meanings for a state with no parish currently in it — so an empty column
// still explains itself rather than reading as a bare zero.
const FALLBACK_MEANING = {
  ready:           { label: 'Ready',           tone: 'muted-green', meaning: 'Required work is current or intentionally scheduled.' },
  review_together: { label: 'Review together', tone: 'brass',       meaning: 'A report or record deserves a shared check-in.' },
  offer_support:   { label: 'Offer support',   tone: 'burgundy',    meaning: 'Something suggests this parish could use a hand — a transition, an exception needing human context, or trouble with the software. Not necessarily a request made of you.' },
  awaiting_update: { label: 'Awaiting update', tone: 'stone',       meaning: 'A gentle cue for a kind check-in.' },
}

function SectionList({ title, rows, selected, onSelect, empty, muted }) {
  return (
    <section className="mb-8">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-2.5">{title}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-500 italic">{empty}</p>
      ) : (
        <ul className={`rounded-xl border border-parchment-300/70 overflow-hidden divide-y divide-parchment-300/60 ${muted ? 'opacity-80' : ''}`}>
          {rows.map(p => {
            const tone = TONE[p.status.tone] ?? TONE.stone
            const isOn = selected === p.parish_org_id
            return (
              <li key={p.parish_org_id}>
                <button
                  onClick={() => onSelect(isOn ? null : p.parish_org_id)}
                  aria-pressed={isOn}
                  className={`w-full text-left px-4 py-3.5 flex items-start gap-3 transition-colors ${
                    isOn ? 'bg-parchment-200/70' : 'bg-parchment-50 hover:bg-parchment-100'}`}>
                  <span className={`mt-1.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink-900 truncate">{p.parish_name}</span>
                    <span className="block text-[12.5px] text-ink-500 leading-snug mt-0.5">{p.status.because}</span>
                  </span>
                  <StatusChip status={p.status} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// Context BEFORE action — the panel establishes who the parish is and what
// has been happening before it offers anything to do.
function ContextPanel({ panel, onClose }) {
  if (!panel) {
    return (
      <aside className="w-80 shrink-0 hidden lg:block">
        <div className="rounded-xl border border-dashed border-parchment-300 p-5">
          <p className="text-sm text-ink-500 leading-relaxed">
            Choose a parish to see its context — what has been happening, what was agreed,
            and what the next faithful action might be.
          </p>
        </div>
      </aside>
    )
  }
  if (panel === 'loading') {
    return (
      <aside className="w-80 shrink-0 hidden lg:flex justify-center pt-10">
        <Loader2 size={18} className="animate-spin text-brass-500" />
      </aside>
    )
  }
  if (panel === 'error') {
    return (
      <aside className="w-80 shrink-0 hidden lg:block">
        <div className="rounded-xl border border-amber-300/70 bg-amber-50/70 p-5">
          <p className="text-sm font-semibold text-ink-900">This parish’s context didn’t load.</p>
          <p className="text-sm text-ink-600 mt-1 leading-relaxed">
            Read it as missing, not as an empty record — this parish’s history is intact.
            Choose it again in a moment.
          </p>
        </div>
      </aside>
    )
  }

  const { parish, status, current_work: work, timeline } = panel
  const agreed = work.followups?.[0]

  return (
    <aside className="w-80 shrink-0 hidden lg:block">
      <div className="rounded-xl border border-parchment-300/70 bg-parchment-50 p-5 space-y-5">
        <div>
          <div className="flex items-start justify-between gap-2">
            <h2 className="font-serif text-xl font-bold text-church-700 leading-tight">{parish.name}</h2>
            <button onClick={onClose} className="text-[11px] text-ink-400 hover:text-ink-600 shrink-0">Close</button>
          </div>
          {parish.region && <p className="text-[11px] text-ink-500 mt-0.5">{parish.region}</p>}
          <div className="mt-2"><StatusChip status={status} size="md" /></div>
          <p className="text-[12.5px] text-ink-600 leading-snug mt-2">{status.because}</p>
          {status.also?.map((line, i) => (
            <p key={i} className="text-[12px] text-ink-500 leading-snug mt-1.5">{line}</p>
          ))}
        </div>

        {agreed && (
          <div className="border-t border-parchment-300/60 pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-1.5">Agreed next action</p>
            <p className="text-[13px] text-ink-800 leading-snug">{agreed.next_action}</p>
            <p className="text-[11.5px] text-ink-500 mt-1">{agreed.context}</p>
            {agreed.due_on && <p className="text-[11px] text-ink-400 mt-1">By {agreed.due_on}</p>}
          </div>
        )}

        {timeline.length > 0 && (
          <div className="border-t border-parchment-300/60 pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-2">Recently</p>
            <ul className="space-y-2.5">
              {timeline.slice(0, 4).map(t => (
                <li key={t.id}>
                  <p className="text-[12.5px] text-ink-700 leading-snug">{t.summary}</p>
                  <p className="text-[11px] text-ink-400 mt-0.5">
                    {t.occurred_on}{t.actor_name ? ` · ${t.actor_name}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* One primary action, one quiet secondary. */}
        <div className="border-t border-parchment-300/60 pt-4 space-y-2">
          <Link to={`/care/${parish.id}`}
            className="w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-lg bg-church-600 text-parchment-50 text-sm font-semibold hover:bg-church-700">
            Review parish history <ArrowRight size={14} />
          </Link>
          <Link to={`/care/${parish.id}/brief`}
            className="w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm text-church-700 hover:bg-parchment-200">
            <FileText size={14} /> Prepare a care brief
          </Link>
        </div>
      </div>
    </aside>
  )
}

export { StatusChip, TONE }
