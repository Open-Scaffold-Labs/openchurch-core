import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { FileText, Mail, User as UserIcon, AlertTriangle } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'

// Year-end giving statements admin list (Sprint Y / Y.2). Admin-only —
// the server enforces requireRole('admin') on /api/giving-statements,
// and the sidebar/Donations entry that links here is hidden from
// non-admins. If a non-admin somehow lands directly, the 403 surfaces
// a friendly Forbidden state instead of an empty list.
//
// Layout:
//   Year picker (current + previous two calendar years) →
//   summary header (X donors, $Y total) →
//   donor list sorted by total DESC, each linking to /donations/
//   statements/:donorKey?year=X&by=email|name where the print view
//   renders the formal statement.

function fmtCurrency(n) {
  return Number(n).toLocaleString(undefined, {
    style: 'currency', currency: 'USD',
  })
}

// A 200 is not a year of donors. Missing `donors` or a non-numeric
// `total_donors` must stay a failed load — `{ total_donors: 0 }` alone
// used to read as an empty tax year.
function isStatementPreview(body) {
  return Boolean(body)
    && typeof body === 'object'
    && !Array.isArray(body)
    && Array.isArray(body.donors)
    && typeof body.total_donors === 'number'
    && Number.isFinite(body.total_donors)
}

function YearPicker({ year, onChange }) {
  const thisYear = new Date().getFullYear()
  // Three-year rolling window: current, last, year-before. The IRS
  // generally allows three years of amended returns, which is the
  // realistic donor-request window.
  const choices = [thisYear, thisYear - 1, thisYear - 2]
  return (
    <div className="inline-flex rounded-lg border border-parchment-300/70 dark:border-brass-900/40 overflow-hidden">
      {choices.map(y => (
        <button
          key={y}
          type="button"
          onClick={() => onChange(y)}
          className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
            y === year
              ? 'bg-church-900 dark:bg-church-700 text-parchment-50'
              : 'bg-parchment-50 dark:bg-ink-800 text-ink-600 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800/70'
          }`}
        >
          {y}
        </button>
      ))}
    </div>
  )
}

export default function GivingStatements() {
  const { user } = useAuth()
  const { t } = useLocale()
  const isAdmin = user?.role === 'admin'

  const [year, setYear] = useState(() => new Date().getFullYear())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [issued, setIssued] = useState(null)
  const [issuedErr, setIssuedErr] = useState('')
  const [issuedLoading, setIssuedLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    setIssuedErr('')
    setIssuedLoading(true)
    try {
      const [previewResult, issuedResult] = await Promise.allSettled([
        fetch(apiUrl(`/api/giving-statements/preview?year=${year}`)),
        fetch(apiUrl(`/api/giving-statements/issued?year=${year}`)),
      ])
      if (previewResult.status !== 'fulfilled') {
        throw new Error('preview-load-failed')
      }
      const res = previewResult.value
      if (res.status === 403) { setErr('admin-only'); setData(null); setIssued(null); return }
      if (!res.ok) throw new Error('preview-load-failed')
      const preview = await res.json()
      if (!isStatementPreview(preview)) throw new Error('preview-load-failed')
      setData(preview)

      try {
        if (issuedResult.status !== 'fulfilled' || !issuedResult.value.ok) {
          throw new Error('issued-load-failed')
        }
        const body = await issuedResult.value.json()
        setIssued(Array.isArray(body.statements) ? body.statements : [])
      } catch {
        setIssuedErr('failed')
        setIssued(null)
      }
    } catch {
      setErr('failed')
      setData(null)
    } finally {
      setLoading(false)
      setIssuedLoading(false)
    }
  }, [year])

  useEffect(() => { load() }, [load])

  // Non-admins shouldn't even reach this page via the sidebar; this
  // is the defense-in-depth render for someone who typed the URL.
  if (!isAdmin || err === 'admin-only') {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          {/* No stmt.* key names this gate. ins.adminOnly and np.adminsOnly
              speak about insights and notifications, so the sentence stays. */}
          <EmptyState
            icon={AlertTriangle}
            title="Admins only"
            body="Year-end giving statements are restricted to admins. Ask an admin in your church to generate statements for you."
          />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper>
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4"
        >
          <div>
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
              Giving statements
            </h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
              Year-end donor receipts. Pick a tax year, then open any donor to
              preview and print their statement.
            </p>
            <p data-testid="statement-list-not-sent" className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
              {t('stmt.listHonesty')}
            </p>
          </div>
          <YearPicker year={year} onChange={setYear} />
        </motion.div>

        {/* Summary card */}
        {!loading && data && data.total_donors > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.05 }}
            className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 shadow-warm p-5 grid grid-cols-2 gap-4 sm:max-w-md"
          >
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">Donors</p>
              <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 mt-1">
                {data.total_donors}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">Total given</p>
              <p className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 mt-1">
                {fmtCurrency(data.total_amount)}
              </p>
            </div>
          </motion.div>
        )}

        {/* Issued register — frozen claims, not deliveries (STMT-01). */}
        {issuedErr && (
          <EmptyState
            icon={AlertTriangle}
            title={t('load.failedTitle')}
            body={t('load.failedBody')}
            action={{ label: 'Retry', onClick: load }}
          />
        )}
        {!issuedLoading && !issuedErr && issued && issued.length > 0 && (
          <div data-testid="statement-issued-list" className="rounded-2xl border border-brass-600/40 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 overflow-hidden">
            <div className="px-5 py-3 border-b border-parchment-200/70 dark:border-brass-900/30">
              <h2 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">
                {t('stmt.issuedListTitle')}
              </h2>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
                {t('stmt.listHonesty')}
              </p>
            </div>
            <ul className="divide-y divide-parchment-200/60 dark:divide-brass-900/25">
              {issued.map(s => (
                <li key={s.id}>
                  <Link
                    to={`/donations/statements/${encodeURIComponent(s.donor_key)}?issued=${s.id}`}
                    className="flex items-center gap-4 px-5 py-3 hover:bg-parchment-100/60 dark:hover:bg-ink-800/40 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">
                        No. {s.statement_no}
                      </p>
                      <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5 truncate">
                        {s.donor_key}
                      </p>
                    </div>
                    <span data-testid="statement-issued-list-not-sent" className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-brass-800 dark:text-brass-300">
                      {t('stmt.issuedNotSent')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Body */}
        {loading ? (
          <SkeletonRowList count={5} />
        ) : err ? (
          <EmptyState
            icon={AlertTriangle}
            title={t('load.failedTitle')}
            body={t('load.failedBody')}
            action={{ label: 'Retry', onClick: load }}
          />
        ) : data?.total_donors === 0 ? (
          <EmptyState
            icon={FileText}
            title={`No donations in ${year}`}
            body="Statements appear once gifts are logged in the Donations page for that tax year."
          />
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2, delay: 0.1 }}
            className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 overflow-hidden"
          >
            <ul className="divide-y divide-parchment-200/60 dark:divide-brass-900/25">
              {data.donors.map(d => (
                <li key={`${d.by}:${d.donor_key}`}>
                  <Link
                    to={`/donations/statements/${encodeURIComponent(d.donor_key)}?year=${year}&by=${d.by}`}
                    className="flex items-center gap-4 px-5 py-4 hover:bg-parchment-100/60 dark:hover:bg-ink-800/40 transition-colors"
                  >
                    {/* Identity */}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">
                        {d.donor_name || '(unnamed donor)'}
                      </p>
                      <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5 flex items-center gap-1.5 truncate">
                        {d.by === 'email' ? <Mail size={11} /> : <UserIcon size={11} />}
                        <span className="truncate">
                          {d.donor_email ?? 'no email on file — grouped by name'}
                        </span>
                      </p>
                    </div>
                    {/* Gift count */}
                    <div className="hidden sm:block text-right shrink-0">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70">Gifts</p>
                      <p className="text-sm font-semibold text-ink-700 dark:text-parchment-200">
                        {d.gift_count}
                      </p>
                    </div>
                    {/* Total — the load-bearing number */}
                    <div className="text-right shrink-0">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70">Total</p>
                      <p className="font-display text-lg font-semibold text-church-900 dark:text-brass-200">
                        {fmtCurrency(d.total)}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </motion.div>
        )}

        {/* Footnote */}
        {!loading && data && data.total_donors > 0 && (
          <p className="text-xs text-ink-500 dark:text-parchment-300/70 px-1">
            Donors with an email on file group by email; the rest group by
            donor name. Click a row to open the printable statement for that
            donor.
          </p>
        )}
      </div>
    </PageWrapper>
  )
}
