import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { apiUrl } from '../api'
import PageWrapper from '../components/PageWrapper'

// Where we stand with the diocese (DIO.6) — the parish's own page.
//
// This is the trickle-down. Until now everything went up: a parish froze
// its totals, submitted them, and heard nothing back. Its assessment, its
// rate, payments recorded against it, and notes the chancery had marked
// "shared with the parish" all lived on the other side of a wall.
//
// It is its own page rather than a card in Settings on purpose. What a
// parish owes and what the diocese has said are not settings, and asking
// somebody to open Org details to find out what they owe is the kind of
// small indignity that tells people where they rank.
//
// TONE. This page reports; it never demands. There is no overdue state, no
// red, no countdown, and no total-arrears figure across years — a parish
// that is behind knows it, and a number in a box does not help. The one
// thing it insists on is showing the *basis* of every assessment, because
// a figure a parish cannot check is a figure a parish resents.

// Money, formatted the way a parish reads it on paper.
const money = v => Number(v ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default function Diocese() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(apiUrl('/api/affiliation/standing'))
      .then(r => (r.ok ? r.json() : Promise.reject(new Error())))
      .then(setData)
      .catch(() => setError('Could not load this just now. Nothing has changed — try again in a moment.'))
  }, [])

  if (error) {
    return (
      <PageWrapper>
      <Header />
        <p className="text-sm text-ink-600 dark:text-parchment-300/70 max-w-lg">{error}</p>
      </PageWrapper>
    )
  }
  if (!data) {
    return (
      <PageWrapper>
      <Header />
        <div className="flex justify-center py-20"><Loader2 size={20} className="animate-spin text-brass-500" /></div>
      </PageWrapper>
    )
  }

  const { affiliation: aff, standing } = data

  if (!aff || !standing) {
    return (
      <PageWrapper>
      <Header />
        <Panel>
          <p className="text-sm text-ink-700 dark:text-parchment-200 max-w-lg leading-relaxed">
            This parish is independent. If your diocese uses OpenDiocese, an invitation
            from the chancery will appear in <span className="font-semibold">Org details</span>,
            and what you share is your choice.
          </p>
        </Panel>
      </PageWrapper>
    )
  }

  const { assessments, notices, with_us: withUs, with_diocese: withDiocese } = standing
  const quiet = !assessments.length && !notices.length && !withUs.length && !withDiocese.length

  return (
    <PageWrapper>
      <Header name={aff.diocese_name} />
      <div className="max-w-3xl space-y-8">
        <p className="text-sm text-ink-500 dark:text-parchment-300/70 -mt-2">
          What the diocese has recorded about this parish, and what is currently between you.
          Nothing here is editable — it is the chancery&rsquo;s side of the conversation, shown to you.
        </p>

        {quiet && (
          <Panel>
            <p className="font-display text-xl font-semibold text-church-900 dark:text-parchment-50 mb-2">
              Nothing outstanding
            </p>
            <p className="text-sm text-ink-600 dark:text-parchment-300/70 max-w-lg">
              The diocese has not published an assessment or shared a note yet, and nothing is
              waiting on either side. This page fills in as the relationship does.
            </p>
          </Panel>
        )}

        {/* What is between us, right now. Fact, never a demand. */}
        {(withUs.length > 0 || withDiocese.length > 0) && (
          <section>
            <Heading>Between us</Heading>
            <ul className="space-y-2">
              {withUs.map(s => (
                <li key={`u${s.id}`} className="rounded-xl border border-brass-300/60 dark:border-brass-900/40 bg-brass-50/50 dark:bg-ink-900 p-4">
                  <p className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
                    {s.period_start} to {s.period_end}
                  </p>
                  <p className="text-sm text-ink-600 dark:text-parchment-300/70 mt-0.5">{s.what}</p>
                </li>
              ))}
              {withDiocese.map(s => (
                <li key={`d${s.id}`} className="rounded-xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 p-4">
                  <p className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
                    {s.period_start} to {s.period_end}
                  </p>
                  <p className="text-sm text-ink-600 dark:text-parchment-300/70 mt-0.5">{s.what}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* The assessment. Basis first, figure second — a number whose
            derivation is visible is a number a parish can check. */}
        {assessments.length > 0 && (
          <section>
            <Heading>Our assessment</Heading>
            <div className="space-y-3">
              {assessments.map(a => (
                <div key={a.fiscal_year}
                  className="rounded-xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="font-display text-2xl font-semibold text-church-900 dark:text-parchment-50">
                      {a.fiscal_year}
                    </p>
                    {a.rate && (
                      <p className="text-[13px] text-ink-500 dark:text-parchment-300/70">{a.rate}</p>
                    )}
                  </div>

                  <p className="text-sm text-ink-700 dark:text-parchment-200 mt-2 leading-relaxed">{a.meaning}</p>
                  <p className="text-[12.5px] text-ink-500 dark:text-parchment-300/70 mt-1 leading-relaxed">{a.because}</p>

                  <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
                    <Figure label="Assessed" value={a.assessed} />
                    <Figure label="Recorded paid" value={a.paid} />
                    <Figure label="Balance" value={a.balance} strong={a.balance > 0} />
                  </dl>

                  {/* The working, where the diocese uses a rate ladder.
                      A treasurer should be able to check this figure with
                      a pen instead of taking it on trust — and the last
                      line deliberately restates the total, so adding the
                      column up is the whole verification. */}
                  {a.breakdown?.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-parchment-300/60 dark:border-brass-900/30">
                      <p className="text-[11px] uppercase tracking-widest text-brass-600 dark:text-brass-300 mb-1.5">
                        How this was worked out
                      </p>
                      <ul className="space-y-1">
                        {a.breakdown.map((b, i) => (
                          <li key={i} className="flex justify-between gap-4 text-[12.5px] text-ink-600 dark:text-parchment-300/80">
                            <span>
                              {money(b.amount_in_band)} of it
                              {b.to === null ? ` above ${money(b.from)}` : ` between ${money(b.from)} and ${money(b.to)}`}
                              {' '}at {b.rate}
                            </span>
                            <span className="tabular-nums whitespace-nowrap">{money(b.assessed)}</span>
                          </li>
                        ))}
                        <li className="flex justify-between gap-4 text-[12.5px] font-semibold text-ink-800 dark:text-parchment-100 pt-1 border-t border-parchment-300/60 dark:border-brass-900/30">
                          <span>Total</span>
                          <span className="tabular-nums">{money(a.assessed)}</span>
                        </li>
                      </ul>
                    </div>
                  )}

                  {a.note && (
                    <p className="mt-4 text-[12.5px] text-ink-600 dark:text-parchment-300/70 border-l-2 border-parchment-300 dark:border-brass-900/40 pl-3 leading-relaxed">
                      {a.note}
                    </p>
                  )}
                  {a.year_status === 'closed' && (
                    <p className="mt-3 text-[11.5px] text-ink-400 dark:text-parchment-400/60">
                      This year is closed. Figures will not change.
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-ink-500 dark:text-parchment-300/70 leading-relaxed">
              Payments are recorded by the chancery, so a payment you have sent may not appear here yet.
              If a figure looks wrong, that is a conversation to have with the office — not something
              to correct in the software.
            </p>
          </section>
        )}

        {/* Only what somebody at the chancery deliberately marked shared. */}
        {notices.length > 0 && (
          <section>
            <Heading>From the diocese</Heading>
            <ol className="border-l border-parchment-300 dark:border-brass-900/40 pl-4 space-y-4">
              {notices.map((n, i) => (
                <li key={i} className="relative">
                  <span className="absolute -left-[21px] top-1.5 w-1.5 h-1.5 rounded-full bg-brass-400" aria-hidden="true" />
                  <p className="text-[11px] uppercase tracking-widest text-ink-400 dark:text-parchment-400/60">
                    {n.on}{n.period ? ` · ${n.period}` : ''}
                  </p>
                  <p className="text-[13.5px] text-ink-800 dark:text-parchment-100 leading-snug mt-0.5">{n.summary}</p>
                  {n.detail && (
                    <p className="text-[12.5px] text-ink-600 dark:text-parchment-300/70 leading-snug mt-1">{n.detail}</p>
                  )}
                  {n.from && <p className="text-[11px] text-ink-400 dark:text-parchment-400/60 mt-1">{n.from}</p>}
                </li>
              ))}
            </ol>
            <p className="mt-3 text-[12px] text-ink-500 dark:text-parchment-300/70 leading-relaxed">
              The chancery keeps its own working notes. Only what it chose to share appears here.
            </p>
          </section>
        )}

        <p className="text-[12px] text-ink-400 dark:text-parchment-400/60 leading-relaxed border-t border-parchment-300/60 dark:border-brass-900/30 pt-4">
          What this parish shares with the diocese is set in{' '}
          <span className="font-semibold text-ink-500 dark:text-parchment-300/70">Org details</span>, and can be
          changed or ended there at any time.
        </p>
      </div>
    </PageWrapper>
  )
}

function Header({ name }) {
  return (
    <div className="mb-7">
      <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
        Diocese
      </h1>
      <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
        {name ? `Where this parish stands with ${name}.` : 'Where this parish stands.'}
      </p>
    </div>
  )
}

function Heading({ children }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 dark:text-brass-300 mb-3">
      {children}
    </h2>
  )
}

function Panel({ children }) {
  return (
    <div className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 p-6">
      {children}
    </div>
  )
}

function Figure({ label, value, strong }) {
  return (
    <div className="rounded-lg bg-parchment-100/70 dark:bg-ink-800/60 py-3">
      <dt className="text-[10.5px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">
        {label}
      </dt>
      <dd className={`font-display text-xl mt-0.5 tabular-nums ${
        strong ? 'text-church-900 dark:text-parchment-50 font-semibold' : 'text-ink-700 dark:text-parchment-200'}`}>
        {Number(value).toFixed(2)}
      </dd>
    </div>
  )
}
