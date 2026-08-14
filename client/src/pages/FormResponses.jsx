import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowLeft, AlertTriangle, Download, Mail, FileText, Inbox,
} from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../context/AuthContext'
import { apiUrl } from '../api'
import { todayLocalISO } from '../utils/dates'

// Form response inbox (Sprint Forms / F.4).
//
// /forms/:id/responses — per-form admin inbox. Renders one card per
// submission with respondent + timestamp + a two-column answer grid.
//
// Answer grid walks `form.fields` (not the keys of `answers`) so:
//   - Display order matches the order the admin authored the form
//   - A stale answer for a field that was later removed silently
//     drops instead of appearing as an orphan row with a raw key
//   - A new field added after older submissions shows "—" for
//     responses that pre-date the field, which is the right read
//
// CSV export is fully client-side — proper RFC 4180 escaping,
// multiselect values join with '; ' so they don't split a column.

function fmtTimestamp(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    year:   'numeric', month: 'short', day:    'numeric',
    hour:   'numeric', minute: '2-digit',
  })
}

// Human-readable formatter for a stored answer, used in the on-screen
// grid. Mirrors the F.1 field type set.
function formatAnswerForDisplay(field, value) {
  if (value === undefined || value === null || value === '') return '—'
  switch (field.type) {
    case 'multiselect':
      if (!Array.isArray(value) || value.length === 0) return '—'
      return value.join(', ')
    case 'checkbox':
      return value ? 'Yes' : 'No'
    case 'date':
      // Already YYYY-MM-DD per the schema. Render in the local
      // locale's day form for the inbox. Slice before splitting so a
      // future bug that stores a full ISO timestamp doesn't produce
      // NaN parts and a "Invalid Date" render.
      try {
        const [y, m, d] = String(value).slice(0, 10).split('-').map(Number)
        return new Date(y, m - 1, d).toLocaleDateString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric',
        })
      } catch { return String(value) }
    default:
      return String(value)
  }
}

// RFC 4180 cell escaping with CSV-injection defense (OWASP). Quote-wrap
// when the cell contains a comma / quote / newline; double any internal
// quotes. Prefix a single quote when the cell would otherwise start with
// =, +, -, @, tab, or CR — Excel/Sheets treat those as formula prefixes
// and would otherwise evaluate a respondent-supplied payload against the
// admin's machine on open.
function csvCell(v) {
  if (v === undefined || v === null) return ''
  let s = String(v)
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

// Flatten an answer to a single CSV cell. Multiselect joins with
// '; ' (semicolon + space) so the comma never splits a column. The
// per-type formatting matches the display path so admins see the
// same shape in both surfaces.
function formatAnswerForCsv(field, value) {
  if (value === undefined || value === null) return ''
  if (field.type === 'multiselect') {
    if (!Array.isArray(value)) return ''
    return value.join('; ')
  }
  if (field.type === 'checkbox') return value ? 'Yes' : 'No'
  return String(value)
}

function buildCsv(form, responses) {
  const fields = form.fields ?? []
  const headers = ['Submitted', 'Name', 'Email', ...fields.map(f => f.label)]
  const rows = [headers.map(csvCell).join(',')]
  for (const r of responses) {
    const row = [
      r.created_at,
      r.respondent_name ?? '',
      r.respondent_email ?? '',
      ...fields.map(f => formatAnswerForCsv(f, (r.answers || {})[f.id])),
    ]
    rows.push(row.map(csvCell).join(','))
  }
  return rows.join('\r\n')
}

function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default function FormResponses() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin  = user?.role === 'admin'
  const toast    = useToast()

  const [form, setForm]       = useState(null)
  const [responses, setResp]  = useState(null)
  const [total, setTotal]     = useState(0)
  const [loading, setLoad]    = useState(true)
  const [err, setErr]         = useState('')

  const load = useCallback(() => {
    if (!isAdmin || !id) return
    setLoad(true)
    setErr('')
    // Two requests in parallel — independent on the server side.
    // Each surfaces its own status; the first to fail decides the
    // page state.
    Promise.all([
      fetch(apiUrl(`/api/forms/${id}`))
        .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? 'not-found' : "Couldn't load responses. Nothing was lost — please retry."))),
      fetch(apiUrl(`/api/forms/${id}/responses?limit=200`))
        .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? 'not-found' : "Couldn't load responses. Nothing was lost — please retry."))),
    ])
      .then(([formData, respData]) => {
        setForm(formData)
        setResp(respData.responses ?? [])
        setTotal(respData.total ?? 0)
      })
      .catch(e => setErr(e.message))
      .finally(() => setLoad(false))
  }, [id, isAdmin])

  useEffect(() => { load() }, [load])

  const showingTruncated = useMemo(() => {
    if (!responses) return false
    return total > responses.length
  }, [responses, total])

  function exportCsv() {
    if (!form || !responses) return
    try {
      const csv = buildCsv(form, responses)
      const stamp = todayLocalISO() // local YYYY-MM-DD
      downloadCsv(`${form.slug}-responses-${stamp}.csv`, csv)
      toast.info(`Exported ${responses.length} response${responses.length === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error("Couldn't export responses. Nothing was lost — please retry.")
    }
  }

  if (!isAdmin) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState
            icon={AlertTriangle}
            title="Admins only"
            body="The response inbox is restricted to admins."
          />
        </div>
      </PageWrapper>
    )
  }

  if (loading) {
    return (
      <PageWrapper>
        <div className="max-w-4xl mx-auto space-y-4">
          <SkeletonRowList count={4} />
        </div>
      </PageWrapper>
    )
  }

  if (err === 'not-found') {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState
            icon={AlertTriangle}
            title="Form not found"
            body="This form may have been deleted or belongs to another organization."
            action={{ label: 'Back to forms', onClick: () => navigate('/forms') }}
          />
        </div>
      </PageWrapper>
    )
  }

  if (err) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load responses"
            body={err}
            action={{ label: 'Retry', onClick: load }}
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
        >
          <Link
            to="/forms"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-500 dark:text-parchment-300/70 hover:text-ink-900 dark:hover:text-parchment-100 transition-colors mb-3"
          >
            <ArrowLeft size={12} /> All forms
          </Link>
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <div>
              <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight inline-flex items-center gap-3">
                <FileText size={22} className="text-brass-600 dark:text-brass-300" />
                {form.title}
              </h1>
              <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
                {total} response{total === 1 ? '' : 's'}
                {showingTruncated && ` (showing the latest ${responses.length})`}
              </p>
            </div>
            {responses.length > 0 && (
              <button
                type="button"
                onClick={exportCsv}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
              >
                <Download size={14} /> Export CSV
                {showingTruncated && (
                  <span className="text-[10px] font-normal opacity-80">(latest {responses.length})</span>
                )}
              </button>
            )}
          </div>
        </motion.div>

        {/* Body */}
        {responses.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No responses yet"
            body={`Share the public link from the form list to start collecting responses for "${form.title}".`}
          />
        ) : (
          <ul className="space-y-4">
            {responses.map(r => (
              <li
                key={r.id}
                className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 shadow-warm overflow-hidden"
              >
                {/* Card header — respondent + timestamp */}
                <div className="px-5 py-3 border-b border-parchment-200/60 dark:border-brass-900/25 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0 flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">
                      {r.respondent_name || 'Anonymous'}
                    </p>
                    {r.respondent_email && (
                      <a
                        href={`mailto:${r.respondent_email}`}
                        className="inline-flex items-center gap-1 text-xs text-church-700 dark:text-brass-200 hover:underline"
                      >
                        <Mail size={11} /> {r.respondent_email}
                      </a>
                    )}
                  </div>
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 tabular-nums">
                    {fmtTimestamp(r.created_at)}
                  </p>
                </div>

                {/* Answer grid — walks form.fields so display order
                    matches the form's authored order */}
                <dl className="px-5 py-4 grid grid-cols-1 sm:grid-cols-[160px,1fr] gap-x-4 gap-y-2.5">
                  {(form.fields ?? []).map(f => {
                    const v = (r.answers || {})[f.id]
                    return (
                      <div key={f.id} className="contents">
                        <dt className="text-xs font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70 sm:text-right pt-0.5">
                          {f.label}
                        </dt>
                        <dd className="text-sm text-ink-800 dark:text-parchment-100 whitespace-pre-wrap break-words">
                          {formatAnswerForDisplay(f, v)}
                        </dd>
                      </div>
                    )
                  })}
                </dl>
              </li>
            ))}
          </ul>
        )}

        {showingTruncated && (
          <p className="text-center text-xs text-ink-500 dark:text-parchment-300/70">
            Showing the {responses.length} most recent of {total}. Export CSV captures the same window —
            paginated viewing lands in a future sprint.
          </p>
        )}
      </div>
    </PageWrapper>
  )
}
