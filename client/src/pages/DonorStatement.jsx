import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ChevronLeft, Printer, AlertTriangle, Loader2 } from 'lucide-react'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'

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

function fmtDateLong(iso) {
  // YYYY-MM-DD only — parse as local so we don't shift across timezones.
  const [y, m, d] = iso.split('T')[0].split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  })
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
  const isAdmin = user?.role === 'admin'

  const [data, setData]     = useState(null)
  const [loading, setLoad]  = useState(true)
  const [err, setErr]       = useState('')

  useEffect(() => {
    if (!isAdmin || !donorKey || !year) return
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
  }, [donorKey, year, by, isAdmin])

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
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
        >
          <Printer size={15} /> Print / Save as PDF
        </button>
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
                <td className="py-2 pr-2">{fmtDateLong(l.date)}</td>
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
