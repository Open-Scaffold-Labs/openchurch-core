import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { apiUrl } from '../api'

// Parishioner-facing public form page (Sprint Forms / F.3).
// Unauthenticated, outside the app shell. Visual shape mirrors
// PublicEvents — same brand mark, same parchment/brass card, same
// quiet "Powered by OpenChurch" footer — so a church can hand out
// /p/<slug>/forms/<formSlug> in a bulletin without parishioners
// feeling they've been thrown into a SaaS.
//
// URL:    /p/:slug/forms/:formSlug
// Data:   GET  /api/public/forms/:slug/:formSlug         → form to render
//         POST /api/public/forms/:slug/:formSlug/submit  → store the response
//
// The 404 path deliberately collapses missing / private / draft /
// closed forms into a single message. Parishioners shouldn't be
// able to enumerate form state by URL-guessing, and admins iterate
// in draft constantly — they don't want every misspelled URL to
// leak "yes, this form exists but isn't published yet."
//
// 429 (rate-limit) gets its own copy because it's a real, recoverable
// state the parishioner can act on ("wait a minute and try again"),
// not a contract violation.

// Common control classes — match the brass-tone palette used on the
// auth pages. Kept inline so this page has no shared-component churn.
const INPUT_CLS = 'w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-brass-400'

function Label({ field }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <label className="block text-sm font-semibold text-ink-800 dark:text-parchment-100" htmlFor={`f_${field.id}`}>
        {field.label}
      </label>
      {field.required && (
        <span className="text-rose-700 dark:text-rose-300 text-xs" aria-hidden="true">*</span>
      )}
    </div>
  )
}

function HelpText({ field }) {
  if (!field.help_text) return null
  return (
    <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">
      {field.help_text}
    </p>
  )
}

// One row per configured field. The 8 supported types each get their
// own rendering, with a shared <Label> + <HelpText> wrapper so the
// label/required/help styling stays uniform.
function Field({ field, value, onChange }) {
  const id = `f_${field.id}`
  const common = { id, name: field.id, required: Boolean(field.required) }

  if (field.type === 'checkbox') {
    // Checkbox wraps the entire row in a <label> so tapping anywhere
    // in the row toggles the box — much friendlier on mobile than
    // hitting the 16x16 box itself.
    return (
      <div>
        <label className="flex items-start gap-3 p-3 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800/60 cursor-pointer">
          <input
            type="checkbox"
            {...common}
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="mt-0.5 rounded border-parchment-400 text-brass-600 focus:ring-brass-400"
          />
          <span className="flex-1">
            <span className="block text-sm font-semibold text-ink-800 dark:text-parchment-100">
              {field.label}
              {field.required && <span className="text-rose-700 dark:text-rose-300 text-xs ml-1" aria-hidden="true">*</span>}
            </span>
            <HelpText field={field} />
          </span>
        </label>
      </div>
    )
  }

  if (field.type === 'multiselect') {
    // Native <select multiple> is a UX disaster on mobile (long-press,
    // tiny rows, no clear "selected" affordance). A checkbox group is
    // bigger, tappable, and screen-reader friendly. Wrap in <fieldset>
    // + <legend> so screen readers announce the group's label once
    // and then read each option, rather than reading every option as
    // an unrelated standalone checkbox.
    const selected = new Set(Array.isArray(value) ? value : [])
    function toggle(opt) {
      const next = new Set(selected)
      if (next.has(opt)) next.delete(opt); else next.add(opt)
      onChange(Array.from(next))
    }
    return (
      <fieldset className="border-0 p-0 m-0">
        <legend className="block text-sm font-semibold text-ink-800 dark:text-parchment-100 p-0">
          {field.label}
          {field.required && (
            <span className="text-rose-700 dark:text-rose-300 text-xs ml-1" aria-hidden="true">*</span>
          )}
        </legend>
        <div className="mt-1.5 space-y-1.5">
          {(field.options ?? []).map((opt) => (
            <label key={opt} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800/60 cursor-pointer text-sm text-ink-800 dark:text-parchment-100">
              <input
                type="checkbox"
                checked={selected.has(opt)}
                onChange={() => toggle(opt)}
                className="rounded border-parchment-400 text-brass-600 focus:ring-brass-400"
              />
              {opt}
            </label>
          ))}
        </div>
        <HelpText field={field} />
      </fieldset>
    )
  }

  if (field.type === 'select') {
    return (
      <div>
        <Label field={field} />
        <select
          {...common}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={`${INPUT_CLS} mt-1.5`}
        >
          <option value="">— Select —</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        <HelpText field={field} />
      </div>
    )
  }

  if (field.type === 'long_text') {
    return (
      <div>
        <Label field={field} />
        <textarea
          {...common}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={`${INPUT_CLS} mt-1.5 resize-none`}
        />
        <HelpText field={field} />
      </div>
    )
  }

  // short_text / email / number / date — single-line input. The
  // browser's native validation surfaces for email/number/date for
  // free; we just map the type through. Email-typed configured
  // fields get the autoComplete hint too so the browser autofill
  // matches the first-class contact email above.
  const htmlType = field.type === 'email' ? 'email'
                : field.type === 'number' ? 'number'
                : field.type === 'date'   ? 'date'
                : 'text'
  const autoComplete = field.type === 'email' ? 'email' : undefined
  return (
    <div>
      <Label field={field} />
      <input
        {...common}
        type={htmlType}
        value={value ?? ''}
        autoComplete={autoComplete}
        onChange={(e) => onChange(field.type === 'number'
          // Keep the answer as a number in state so the JSON we POST
          // matches the server's expected shape without an extra
          // coercion step. Empty input → null so 'required' can fire
          // on truly empty values.
          ? (e.target.value === '' ? null : Number(e.target.value))
          : e.target.value)
        }
        className={`${INPUT_CLS} mt-1.5`}
      />
      <HelpText field={field} />
    </div>
  )
}

export default function PublicForm() {
  const { slug, formSlug } = useParams()
  const [form, setForm]       = useState(null)
  const [loading, setLoad]    = useState(true)
  const [err, setErr]         = useState('')          // '', 'not-found', other
  const [answers, setAnswers] = useState({})
  const [contact, setContact] = useState({ name: '', email: '' })
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr]   = useState('')    // free text or 'rate-limited'
  // sessionStorage-backed so a nervous post-submit reload still shows
  // the thank-you panel for the same session — keyed by the org +
  // form slug so other forms in the same browser stay independent.
  const submittedKey = slug && formSlug ? `ochr:form-submitted:${slug}:${formSlug}` : null
  const [submitted, setSubmitted] = useState(() => {
    if (!submittedKey || typeof window === 'undefined') return false
    try { return window.sessionStorage.getItem(submittedKey) === '1' } catch { return false }
  })

  useEffect(() => {
    if (!slug || !formSlug) return
    let cancelled = false
    fetch(apiUrl(`/api/public/forms/${slug}/${formSlug}`))
      .then(async (r) => {
        if (r.status === 404) throw new Error('not-found')
        if (!r.ok) throw new Error(`Failed (${r.status})`)
        return r.json()
      })
      .then((data) => { if (!cancelled) setForm(data) })
      .catch((e) => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [slug, formSlug])

  function setAnswer(fieldId, value) {
    setAnswers((prev) => ({ ...prev, [fieldId]: value }))
  }

  async function submit(e) {
    e.preventDefault()
    setSubmitErr('')

    // Defense-in-depth for required multiselect — the HTML `required`
    // attribute can't constrain "at least one checkbox in a group,"
    // so a user who touches then clears all options would otherwise
    // only see the 400 after the round trip.
    const fields = form.fields ?? []
    for (const f of fields) {
      if (f.type === 'multiselect' && f.required) {
        const v = answers[f.id]
        if (!Array.isArray(v) || v.length === 0) {
          setSubmitErr(`${f.label} is required`)
          return
        }
      }
    }

    setSubmitting(true)
    try {
      const res = await fetch(apiUrl(`/api/public/forms/${slug}/${formSlug}/submit`), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          answers,
          respondent_name:  contact.name.trim()  || null,
          respondent_email: contact.email.trim() || null,
        }),
      })
      if (res.status === 429) { setSubmitErr('rate-limited'); return }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Submit failed (${res.status})`)
      }
      setSubmitted(true)
      if (submittedKey) {
        try { window.sessionStorage.setItem(submittedKey, '1') } catch { /* sessionStorage disabled is OK */ }
      }
    } catch (e2) {
      setSubmitErr(e2.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-parchment-50 dark:bg-ink-950">
        <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
      </div>
    )
  }

  // 404 — collapsed copy for missing/private/draft/closed/unknown-org.
  // Don't enumerate form state for URL guessers.
  if (err === 'not-found') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-parchment-50 dark:bg-ink-950">
        <div className="text-center max-w-md">
          <AlertTriangle size={28} className="mx-auto text-amber-600 dark:text-amber-300 mb-3" />
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            Form not available
          </h1>
          <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70">
            We couldn't find an open form at <span className="font-mono">/p/{slug}/forms/{formSlug}</span>. It may have closed or the link may be off — double-check the link from your bulletin.
          </p>
        </div>
      </div>
    )
  }

  if (err || !form) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-parchment-50 dark:bg-ink-950">
        <div className="text-center max-w-md">
          <AlertTriangle size={28} className="mx-auto text-rose-700 dark:text-rose-300 mb-3" />
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            Couldn't load the form
          </h1>
          <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70">{err || 'Please try again in a moment.'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-parchment-50 dark:bg-ink-950 px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
        className="w-full max-w-2xl mx-auto"
      >
        {/* Brand mark — same one used on auth + PublicEvents. */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-church-900 dark:bg-brass-200 flex items-center justify-center shadow-warm">
            <svg width="16" height="20" viewBox="0 0 14 18" fill="currentColor" className="text-brass-200 dark:text-church-900">
              <rect x="5.5" y="0" width="3" height="18" rx="1" />
              <rect x="0" y="4" width="14" height="3" rx="1" />
            </svg>
          </div>
        </div>

        {submitted ? (
          // Thank-you panel — the success path is intentionally
          // self-contained so the parishioner has a clear "done"
          // moment and doesn't accidentally re-submit by refreshing.
          <div className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-8 text-center">
            <CheckCircle2 size={32} className="mx-auto text-brass-600 dark:text-brass-300 mb-3" />
            <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
              Thank you
            </h1>
            <p className="mt-2 text-sm text-ink-600 dark:text-parchment-200">
              Your response to <span className="font-semibold">{form.title}</span> was received.
            </p>
          </div>
        ) : (
          <>
            {/* Form header */}
            <div className="text-center mb-8">
              <h1 className="font-display text-3xl md:text-4xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
                {form.title}
              </h1>
              {form.description && (
                <p className="mt-3 text-sm md:text-base text-ink-600 dark:text-parchment-200/80 max-w-xl mx-auto">
                  {form.description}
                </p>
              )}
            </div>

            <form
              onSubmit={submit}
              className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 space-y-5"
            >
              {/* Contact section — first-class above the configured
                  fields. Every form needs a way back to the
                  respondent; making this a designed slot beats
                  asking every admin to remember to add name + email
                  fields by hand. */}
              <div className="space-y-4 pb-5 border-b border-parchment-300/60 dark:border-brass-900/30">
                <div>
                  <label className="block text-sm font-semibold text-ink-800 dark:text-parchment-100" htmlFor="contact_name">
                    Your name
                  </label>
                  <input
                    id="contact_name"
                    type="text"
                    value={contact.name}
                    onChange={(e) => setContact((p) => ({ ...p, name: e.target.value }))}
                    autoComplete="name"
                    className={`${INPUT_CLS} mt-1.5`}
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-ink-800 dark:text-parchment-100" htmlFor="contact_email">
                    Email
                  </label>
                  <input
                    id="contact_email"
                    type="email"
                    value={contact.email}
                    onChange={(e) => setContact((p) => ({ ...p, email: e.target.value }))}
                    autoComplete="email"
                    className={`${INPUT_CLS} mt-1.5`}
                  />
                  <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">
                    Only used to contact you about your response.
                  </p>
                </div>
              </div>

              {(form.fields ?? []).map((field) => (
                <Field
                  key={field.id}
                  field={field}
                  value={answers[field.id]}
                  onChange={(v) => setAnswer(field.id, v)}
                />
              ))}

              {submitErr === 'rate-limited' ? (
                <div className="text-sm text-amber-700 dark:text-amber-200 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-lg p-3">
                  Too many submissions from this network. Please wait a minute and try again.
                </div>
              ) : submitErr ? (
                <div className="text-sm text-rose-700 dark:text-rose-200 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-900/40 rounded-lg p-3">
                  {submitErr}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                {submitting ? 'Submitting…' : 'Submit'}
              </button>
            </form>
          </>
        )}

        <p className="mt-12 text-center text-[11px] text-ink-500 dark:text-parchment-300/50">
          Powered by OpenChurch
        </p>
      </motion.div>
    </div>
  )
}
