import { useEffect, useState, useRef } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ChevronLeft, Printer, AlertTriangle, Loader2, Stamp } from 'lucide-react'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'

// Year-end donor giving statement — the actual receipt the bookkeeper
// hands the donor (Sprint Y / Y.3). Renders from a single fetch of
// /api/giving-statements/donor which bundles donor + line items + the
// org's letterhead block.
//
// PDF strategy:
//   Browser print-to-PDF rather than server-side PDF generation.
//   Reasons:
//   - Vercel serverless functions struggle with PDF binary deps
//     (puppeteer, wkhtmltopdf — large cold-starts, sometimes blocked).
//   - The statement is one page of text; a print stylesheet does the
//     same job as a generated PDF with less infrastructure.
//   - Browsers ship 'Save as PDF' in the print dialog natively.
//
// Print rules:
//   - The sidebar carries `print:hidden` in App.jsx so it drops out
//     globally; nothing else here needs to know about that.
//   - The top bar (back link + print button + page title) is wrapped
//     in a `print:hidden` div so it doesn't appear on the printout.
//   - The statement body uses serif type (font-display = Cormorant
//     Garamond) so it reads as formal correspondence on paper.
//   - Total amount is bold + larger so it scans first.
//   - The 501(c)(3) compliance text + signatory block are at the
//     bottom in a smaller size — required content, but not the focus.

function fmtCurrency(n) {
  return Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

// Version-1 snapshots stored String(Date).slice(0, 10): "Sun Sep 27".
// That text is not an instant. new Date('Sun Sep 27') is 2001 in V8, and
// splitting on 'T' eats "Tue" and "Thu" (both start with T) down to an
// empty prefix and then "Invalid Date". Rebuild the civil day from the
// snapshot's tax year, and only when the stored weekday agrees.
const LEGACY_CIVIL_DAY = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})$/
const LEGACY_MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}
const LEGACY_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ISO_CIVIL_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/

function fullDate(date) {
  const formatted = date.toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  })
  return formatted === 'Invalid Date' ? null : formatted
}

export function fmtDateLong(value, taxYear) {
  if (value == null || value === '') return ''
  const raw = String(value)

  const legacy = LEGACY_CIVIL_DAY.exec(raw)
  if (legacy) {
    const year = Number(taxYear)
    const month = LEGACY_MONTHS[legacy[2]]
    const day = Number(legacy[3])
    if (!Number.isInteger(year) || month == null || !Number.isInteger(day)) return raw
    // Parts only. The legacy string itself is never a Date argument.
    const reconstructed = new Date(year, month, day)
    const sameDay = reconstructed.getFullYear() === year
      && reconstructed.getMonth() === month
      && reconstructed.getDate() === day
    const weekdayMatches = LEGACY_WEEKDAYS[reconstructed.getDay()] === legacy[1]
    if (!sameDay || !weekdayMatches) return raw
    return fullDate(reconstructed) ?? raw
  }

  const iso = ISO_CIVIL_DAY.exec(raw)
  if (!iso) return raw
  const year = Number(iso[1])
  const month = Number(iso[2])
  const day = Number(iso[3])
  const date = new Date(year, month - 1, day)
  const sameDay = date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
  if (!sameDay) return raw
  return fullDate(date) ?? raw
}

function todayLong() {
  return new Date().toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  })
}

// Multi-line address splitter — addresses are typed as free-text
// (e.g. "142 Olive St, Austin TX 78701"); we split on commas so the
// statement reads like a mailing label rather than one long line.
function renderAddress(addr) {
  if (!addr) return null
  return addr.split(',').map((line, i) => (
    <span key={i} className="block">{line.trim()}</span>
  ))
}

// Banner shown when the org hasn't filled in letterhead yet. Surfaces
// what's missing and links to Settings → Org details (Y.4). Hidden on
// print so the donor never sees the admin note.
function LetterheadBanner({ org }) {
  const missing = []
  if (!org.address)         missing.push('mailing address')
  if (!org.tax_id)          missing.push('EIN / tax ID')
  if (!org.signatory_name)  missing.push('signatory name')
  if (missing.length === 0) return null
  return (
    <div className="print:hidden mb-6 rounded-lg border border-amber-200/70 dark:border-amber-800/30 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
      <div>
        <p className="font-semibold">Letterhead incomplete</p>
        <p className="mt-0.5">
          Missing: {missing.join(', ')}. The receipt prints with
          placeholders until you fill these in.{' '}
          <Link to="/settings" className="underline font-semibold">
            Add letterhead →
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function DonorStatement() {
  const { donorKey } = useParams()
  const [params] = useSearchParams()
  const year = params.get('year')
  const by   = params.get('by') // 'email' | 'name' | null (server defaults)
  const { user } = useAuth()
  const { t } = useLocale()
  const isAdmin = user?.role === 'admin'

  const [data, setData]     = useState(null)
  const [loading, setLoad]  = useState(true)
  const [err, setErr]       = useState('')
  // GIV-09. ?issued=<id> renders the FROZEN claim; without it this page is a
  // live preview. The two must never look alike: a preview handed to a donor
  // is not a statement the parish has issued.
  const issuedId = params.get('issued')
  const [issuedMeta, setIssuedMeta] = useState(null)
  const [issuing, setIssuing] = useState(false)
  // An issuance failure is NOT a page-load failure. Writing it to `err` would
  // trip the early return below, replace the statement with "couldn't load",
  // and take the Issue button with it — leaving the parish no way to retry in
  // place, only to navigate back and remount, which mints a fresh key. That is
  // how one lost response becomes two historical claims.
  const [issueErr, setIssueErr] = useState('')
  // ONE key per intentional issuance, held across every transport retry. It is
  // minted on the first attempt and released only when the claim is confirmed,
  // so a retry after a lost or ambiguous response asks the server about the
  // SAME claim instead of asking for a second one. Remounting the page — the
  // parish deliberately starting again — is what mints a new one.
  const issueKeyRef = useRef(null)

  useEffect(() => {
    if (!isAdmin || !issuedId) return
    let cancelled = false
    setLoad(true); setErr('')
    fetch(apiUrl(`/api/giving-statements/issued/${issuedId}`))
      .then(async r => {
        if (r.status === 404) throw new Error('That issued statement is not on this church\u2019s register.')
        if (r.status === 403) throw new Error('admin-only')
        if (!r.ok) throw new Error("Couldn't load the issued statement. Nothing was lost \u2014 please retry.")
        return r.json()
      })
      .then(({ statement }) => {
        if (cancelled) return
        const snap = statement.snapshot_json
        setData({
          organization: snap.organization, donor: snap.donor,
          // The row list keys on `id`; the frozen line carries `donation_id`.
          lines: snap.lines.map(l => ({ ...l, id: l.donation_id })),
          total: Number(snap.total), year: snap.tax_year,
        })
        setIssuedMeta({
          statement_no: statement.statement_no, issued_at: statement.issued_at,
          status: statement.status, issued_by_name: statement.issued_by_name,
          superseded_by_id: statement.superseded_by_id,
          unknown_at_issue: snap.unknown_at_issue ?? [],
          correction: snap.correction ?? null,
        })
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [issuedId, isAdmin])

  async function issueStatement() {
    if (issueKeyRef.current == null) {
      const nonce = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      issueKeyRef.current = `${donorKey}|${year}|${nonce}`
    }
    setIssuing(true); setIssueErr('')
    try {
      const res = await fetch(apiUrl('/api/giving-statements/issue'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year: Number(year), key: donorKey, by: by || undefined,
          issue_key: issueKeyRef.current,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Couldn't issue the statement.")
      // Confirmed — whether this response minted the claim or replayed one that
      // already existed, the attempt is resolved and the key is spent.
      issueKeyRef.current = null
      window.location.search = `?issued=${body.statement.id}`
    } catch (e) {
      // The key is deliberately NOT cleared: this attempt is unresolved, and
      // the next click must ask about the same claim.
      setIssueErr(e.message || "Couldn't issue the statement.")
    } finally { setIssuing(false) }
  }

  useEffect(() => {
    if (!isAdmin || !donorKey || !year || issuedId) return
    let cancelled = false
    setLoad(true)
    setErr('')
    const q = new URLSearchParams({ key: donorKey, year })
    if (by) q.set('by', by)
    fetch(apiUrl(`/api/giving-statements/donor?${q}`))
      .then(async r => {
        if (r.status === 404) throw new Error('No donations found for this donor in this tax year.')
        if (r.status === 403) throw new Error('admin-only')
        if (!r.ok) throw new Error("Couldn't load the statement. Nothing was lost — please retry.")
        return r.json()
      })
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [donorKey, year, by, isAdmin, issuedId])

  // Defense-in-depth admin gate — sidebar entry is admin-only and the
  // server gates the endpoint, but a non-admin typing the URL should
  // get a clean message rather than a blank statement.
  if (!isAdmin || err === 'admin-only') {
    return (
      <div className="max-w-2xl mx-auto py-16 px-4 text-center">
        <AlertTriangle size={28} className="mx-auto text-amber-600 dark:text-amber-300 mb-3" />
        <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">Admins only</h1>
        <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-2">
          Donor statements are restricted to admins.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
      </div>
    )
  }

  if (err) {
    return (
      <div className="max-w-2xl mx-auto py-16 px-4 text-center">
        <AlertTriangle size={28} className="mx-auto text-rose-700 dark:text-rose-300 mb-3" />
        <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">Couldn't load statement</h1>
        <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-2">{err}</p>
        <Link to="/donations/statements" className="inline-flex items-center gap-1.5 mt-6 text-sm font-semibold text-church-700 dark:text-brass-300 hover:underline">
          <ChevronLeft size={14} /> Back to statements
        </Link>
      </div>
    )
  }

  if (!data) return null
  const { organization: org, donor, lines, total, year: y } = data

  return (
    <>
      {/* Page chrome — hidden on print so only the statement prints. */}
      <div className="print:hidden max-w-3xl mx-auto px-4 pt-6 pb-2 flex items-center justify-between">
        <Link
          to="/donations/statements"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-church-700 dark:text-brass-300 hover:underline"
        >
          <ChevronLeft size={15} /> Back to statements
        </Link>
        <div className="flex items-center gap-2">
          {!issuedId && (
            <button
              type="button"
              onClick={issueStatement}
              disabled={issuing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-brass-700/60 text-brass-800 dark:text-brass-300 text-sm font-semibold hover:bg-brass-50 dark:hover:bg-brass-900/20 disabled:opacity-50 transition-colors"
            >
              {issuing ? <Loader2 size={15} className="animate-spin" /> : <Stamp size={15} />} Issue statement
            </button>
          )}
          {issuedId && (
            <span data-testid="statement-issued-chrome-not-sent" className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70">
              {t('stmt.notSentChip')}
            </span>
          )}
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
          >
            <Printer size={15} /> Print / Save as PDF
          </button>
        </div>
      </div>

      {/* GIV-09 — what this page is, on screen and on paper. A preview is
          live giving; an issued statement is a claim frozen on a date. The
          marker prints, because the difference matters most on the copy the
          donor actually holds. */}
      <div className="max-w-3xl mx-auto px-4">
        {issuedId ? (
          <div data-testid="statement-issued-banner" className="mb-4 rounded-lg border border-brass-600/50 bg-brass-50 dark:bg-brass-900/20 px-4 py-2 text-xs text-brass-900 dark:text-brass-200">
            {/* Print keeps the frozen-claim marker. Screen must also say
                the claim was not emailed — Issued ≠ delivered (STMT-01). */}
            <span className="font-semibold uppercase tracking-wider hidden print:inline">Issued statement</span>
            <span className="font-semibold uppercase tracking-wider print:hidden">{t('stmt.issuedNotSent')}</span>
            {issuedMeta && <> · No. {issuedMeta.statement_no} · issued {new Date(issuedMeta.issued_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              {issuedMeta.issued_by_name ? ` by ${issuedMeta.issued_by_name}` : ''}</>}
            <span data-testid="statement-issued-not-sent" className="block mt-1 print:hidden text-brass-800/90 dark:text-brass-300/90">
              {t('stmt.issuedNotSentBody')}
            </span>
            {issuedMeta?.correction && (
              <span className="block mt-1 font-semibold">
                Corrected statement — supersedes No. {issuedMeta.correction.supersedes_statement_no}.
                {issuedMeta.correction.zero_is_a_claim && (
                  <span className="block font-normal">
                    {issuedMeta.correction.reason} This total is zero because the parish says so, not because anything is missing.
                  </span>
                )}
              </span>
            )}
            {issuedMeta?.status === 'superseded' && (
              <span className="block mt-1 font-semibold text-amber-800 dark:text-amber-300">
                Superseded by statement #{issuedMeta.superseded_by_id}. This remains what was claimed on the date above.
              </span>
            )}
            {issuedMeta?.unknown_at_issue?.length > 0 && (
              <span className="block mt-1 text-brass-800/80 dark:text-brass-300/80">
                Not known when issued: {issuedMeta.unknown_at_issue.join(', ')}.
              </span>
            )}
          </div>
        ) : (
          <div data-testid="statement-preview-banner" className="mb-4 rounded-lg border border-ink-300/60 dark:border-parchment-300/20 bg-parchment-100 dark:bg-ink-800 px-4 py-2 text-xs text-ink-700 dark:text-parchment-200">
            <span className="font-semibold uppercase tracking-wider">Preview — not issued</span>
            <span className="block mt-1 text-ink-500 dark:text-parchment-300/70">
              Figures follow the parish's live giving and will change if a gift is refunded or edited. Issue the statement to freeze what you send.
            </span>
          </div>
        )}
        {/* An issuance that failed is reported HERE, beside the button, and
            never through the page-level error state — the retry has to stay
            reachable, because retrying in place reuses the idempotency key and
            navigating away to try again does not. */}
        {issueErr && (
          <div data-testid="statement-issue-error" role="status" className="print:hidden mb-4 rounded-lg border border-amber-300/70 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-900/20 px-4 py-2 text-xs text-amber-900 dark:text-amber-200">
            <span className="font-semibold">{issueErr}</span>
            <span className="block mt-1">
              Nothing was lost. Press Issue statement again — if it already went through, you will be taken to that statement rather than a second one.
            </span>
          </div>
        )}
      </div>

      {/* The statement itself. max-w-3xl + print:max-w-none so screen
          reads as a centered letter and print fills the page. White
          background + serif body for paper-document feel. */}
      <div className="max-w-3xl mx-auto px-6 sm:px-12 py-8 print:py-0 bg-white text-ink-900 print:text-black rounded-2xl print:rounded-none shadow-warm-md print:shadow-none my-6 print:my-0">
        <LetterheadBanner org={org} />

        {/* Letterhead — org block at top */}
        <header className="text-center pb-6 mb-6 border-b border-ink-200 print:border-ink-400">
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            {org.name ?? '[Church Name]'}
          </h1>
          {org.address && (
            <p className="mt-2 text-sm leading-snug">{renderAddress(org.address)}</p>
          )}
          {org.tax_id && (
            <p className="mt-2 text-xs uppercase tracking-widest text-ink-600">
              EIN: {org.tax_id}
            </p>
          )}
          {org.statement_letterhead && (
            <p className="mt-3 text-xs italic text-ink-600 max-w-xl mx-auto leading-relaxed">
              {org.statement_letterhead}
            </p>
          )}
        </header>

        {/* Date + donor mailing block */}
        <div className="flex flex-col sm:flex-row sm:justify-between gap-6 mb-8 text-sm">
          <div>
            <p className="font-semibold text-ink-700">Statement for</p>
            <p className="mt-1 font-display text-lg font-semibold">{donor.name}</p>
            {donor.address && (
              <p className="mt-1 leading-snug text-ink-700">{renderAddress(donor.address)}</p>
            )}
            {donor.email && (
              <p className="mt-1 text-ink-600">{donor.email}</p>
            )}
          </div>
          <div className="text-right">
            <p className="font-semibold text-ink-700">Tax year</p>
            <p className="mt-1 font-display text-2xl font-semibold">{y}</p>
            <p className="mt-3 text-xs uppercase tracking-widest text-ink-600">Issued</p>
            <p className="text-sm">{todayLong()}</p>
          </div>
        </div>

        {/* Greeting */}
        <p className="text-sm leading-relaxed mb-4">
          Dear {donor.name},
        </p>
        <p className="text-sm leading-relaxed mb-6">
          Thank you for your generous giving to {org.name ?? '[Church Name]'} during
          the {y} tax year. Below is the record of your contributions, provided
          for your tax-filing records.
        </p>

        {/* Itemized table */}
        <table className="w-full text-sm mb-6 border-collapse">
          <thead>
            <tr className="border-b-2 border-ink-300 print:border-ink-500 text-left text-xs uppercase tracking-wider text-ink-600">
              <th className="py-2 pr-2 font-semibold">Date</th>
              <th className="py-2 px-2 font-semibold">Category</th>
              <th className="py-2 px-2 font-semibold">Method</th>
              <th className="py-2 pl-2 font-semibold text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.id} className="border-b border-ink-100 print:border-ink-300">
                <td className="py-2 pr-2">{fmtDateLong(l.date, y)}</td>
                <td className="py-2 px-2 capitalize">{l.category ?? '—'}</td>
                <td className="py-2 px-2 capitalize">{l.method ?? '—'}</td>
                <td className="py-2 pl-2 text-right font-medium tabular-nums">
                  {fmtCurrency(l.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="pt-3 pr-2 text-right font-semibold text-sm">
                Total contributions for {y}
              </td>
              <td className="pt-3 pl-2 text-right font-display text-xl font-semibold tabular-nums">
                {fmtCurrency(total)}
              </td>
            </tr>
          </tfoot>
        </table>

        {/* Required IRS verbiage */}
        <p className="text-xs italic text-ink-600 mb-6 leading-relaxed">
          No goods or services were provided in exchange for these
          contributions, except for any intangible religious benefits.
          {org.tax_id && (
            <> {org.name ?? '[Church Name]'} is a 501(c)(3) tax-exempt
              organization. EIN: {org.tax_id}.</>
          )}
        </p>

        {/* Signatory block */}
        <div className="mt-10">
          <p className="text-sm leading-relaxed mb-8">With gratitude,</p>
          <p className="font-display text-lg font-semibold">
            {org.signatory_name ?? '[Signatory Name]'}
          </p>
          {org.signatory_title && (
            <p className="text-xs uppercase tracking-widest text-ink-600 mt-0.5">
              {org.signatory_title}
            </p>
          )}
          {org.name && (
            <p className="text-sm text-ink-700 mt-0.5">{org.name}</p>
          )}
        </div>
      </div>
    </>
  )
}
