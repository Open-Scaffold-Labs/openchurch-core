// Public forms surface (Sprint Forms / F.1). Two endpoints, both
// unauthenticated:
//
//   GET  /api/public/forms/:orgSlug/:formSlug         → form to render
//   POST /api/public/forms/:orgSlug/:formSlug/submit  → store a response
//
// Privacy / abuse boundary:
//   - Form must be is_public AND status='open' to surface at all.
//     Drafts and closed forms 404.
//   - Org lookup is by slug, not id — same model as publicEvents.
//     A bad slug 404s without enumerating which orgs exist.
//   - Submit is rate-limited per-IP (20 per 10 minutes). Generous
//     for a parishioner filling out three forms in a row; tight
//     enough that a basic bot wave hits the wall before flooding
//     the response inbox.
//
// The answer validator below mirrors the field types the admin
// validator (routes/forms.js → FIELD_TYPES) accepts. Keep both in
// sync when adding a type.

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// 20 submits per IP per 10 minutes. Hits the parishioner case (one
// person filling a couple of forms back-to-back) generously while
// stopping naive bot floods. Scoped to the submit route so the
// open GET path stays uncapped — parishioners refreshing the form
// page shouldn't trip the limiter.
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    error: 'Too many form submissions from this address. Please try again in a few minutes.',
  },
})

// Mirrors validateFieldSchema in routes/forms.js. Returns null on
// success or the first human-readable error message found.
// The answers that survive to storage: declared fields only, each bounded.
// Long-text fields get the room a paragraph needs; everything else gets a
// line. Arrays (multiselect) keep their shape but not unbounded length.
const ANSWER_MAX  = 2000
const LONG_MAX    = 10000
const ARRAY_MAX   = 50

function pickDeclaredAnswers(fields, answers) {
  const out = {}
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(answers, f.id)) continue
    const v = answers[f.id]
    const cap = f.type === 'long_text' ? LONG_MAX : ANSWER_MAX
    if (Array.isArray(v)) {
      out[f.id] = v.slice(0, ARRAY_MAX)
        .map(x => (typeof x === 'string' ? x.slice(0, cap) : x))
    } else if (typeof v === 'string') {
      out[f.id] = v.slice(0, cap)
    } else {
      out[f.id] = v
    }
  }
  return out
}

function validateAnswers(fields, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return 'answers must be an object'
  }
  for (const f of fields) {
    const v = answers[f.id]
    // Empty array counts as empty for the required check — a
    // required multiselect with no items checked is still "not
    // answered" even though the client wired a touched-but-cleared
    // array through. Without this, an untouched multiselect 400s
    // correctly (undefined) but a touched-then-cleared one ([])
    // silently passes.
    const isEmpty =
      v === undefined ||
      v === null ||
      v === '' ||
      (Array.isArray(v) && v.length === 0)
    if (f.required && isEmpty) {
      return `${f.label} is required`
    }
    if (isEmpty) continue

    switch (f.type) {
      case 'short_text':
      case 'long_text':
        if (typeof v !== 'string') return `${f.label} must be a string`
        break
      case 'email':
        // Pragmatic email shape — full RFC validation belongs at
        // the SMTP layer, not the form layer.
        if (typeof v !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          return `${f.label} must be a valid email address`
        }
        break
      case 'number': {
        // Coerce stringified numbers ("5") to native number so the
        // stored JSONB shape is consistent regardless of whether the
        // client sent JSON numbers or strings (typical for HTML form
        // inputs serialised into JSON). Reject everything that
        // doesn't round-trip to a finite number.
        let n
        if (typeof v === 'number') n = v
        else if (typeof v === 'string' && v.trim() !== '') n = Number(v)
        else n = NaN
        if (!Number.isFinite(n)) return `${f.label} must be a number`
        answers[f.id] = n
        break
      }
      case 'date': {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
          return `${f.label} must be a YYYY-MM-DD date`
        }
        // Shape passes — confirm it's an actual calendar date.
        // 2026-02-31 parses cleanly to JS Date but round-trips to
        // 2026-03-03; compare the ISO date back to the input to
        // catch month/day overflow.
        const parsed = new Date(v + 'T12:00:00Z')
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) {
          return `${f.label} is not a valid calendar date`
        }
        break
      }
      case 'select':
        if (!f.options?.includes(v)) {
          return `${f.label} must be one of the listed options`
        }
        break
      case 'multiselect':
        if (!Array.isArray(v) || v.some(x => !f.options?.includes(x))) {
          return `${f.label} must be a subset of the listed options`
        }
        break
      case 'checkbox':
        if (typeof v !== 'boolean') return `${f.label} must be true or false`
        break
      default:
        return `${f.label} has an unrecognized type`
    }
  }
  return null
}

async function findPublishedForm(orgSlug, formSlug) {
  const { rows } = await pool.query(
    `SELECT f.id, f.organization_id, f.slug, f.title, f.description,
            f.fields, f.is_public, f.status, o.locale AS organization_locale
       FROM ochr_forms f
       JOIN ochr_organizations o ON o.id = f.organization_id
      WHERE o.slug = $1 AND f.slug = $2
        AND f.is_public = TRUE
        AND f.status = 'open'
      LIMIT 1`,
    [orgSlug, formSlug]
  )
  return rows[0] ?? null
}

// GET /:orgSlug/:formSlug — fetch a published form for rendering.
router.get('/:orgSlug/:formSlug', async (req, res) => {
  try {
    const form = await findPublishedForm(req.params.orgSlug, req.params.formSlug)
    if (!form) return res.status(404).json({ error: 'Form not found' })
    // Render shape: drop internal flags the parishioner never needs.
    res.set('Cache-Control', 'public, max-age=60')
    res.json({
      slug: form.slug,
      title: form.title,
      description: form.description,
      fields: form.fields,
      org: { locale: form.organization_locale ?? 'en' },
    })
  } catch (err) {
    monitor.error('publicForms.get', err, { orgSlug: req.params.orgSlug, formSlug: req.params.formSlug })
    res.status(500).json({ error: 'Failed to load form' })
  }
})

// POST /:orgSlug/:formSlug/submit — record a response.
router.post('/:orgSlug/:formSlug/submit', submitLimiter, async (req, res) => {
  try {
    const form = await findPublishedForm(req.params.orgSlug, req.params.formSlug)
    if (!form) return res.status(404).json({ error: 'Form not found' })

    const { answers = {}, respondent_name = null, respondent_email = null } = req.body ?? {}
    const validationError = validateAnswers(form.fields, answers)
    if (validationError) return res.status(400).json({ error: validationError })

    // Store only the keys this form actually declares. validateAnswers walks
    // form.fields and therefore never looks at keys the schema does not
    // mention — so anything extra in the request body rode straight into the
    // jsonb column. Verified 23 Aug: an unauthenticated submit stored
    // {huge, name, INJECTED_KEY} at 50,065 bytes against a one-field form.
    //
    // An allowlist rather than a size check, for the same reason the member
    // roster got one: a cap keeps the row small but still lets a stranger
    // choose what a parish's response inbox contains.
    const stored = pickDeclaredAnswers(form.fields, answers)

    const { rows } = await pool.query(
      `INSERT INTO ochr_form_responses
         (form_id, organization_id, answers, respondent_name, respondent_email,
          ip_address, user_agent)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        form.id,
        form.organization_id,
        JSON.stringify(stored),
        respondent_name ? String(respondent_name).slice(0, 200) : null,
        respondent_email ? String(respondent_email).slice(0, 200) : null,
        req.ip ?? null,
        req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 500) : null,
      ]
    )
    res.status(201).json({ id: rows[0].id, created_at: rows[0].created_at })
  } catch (err) {
    monitor.error('publicForms.submit', err, { orgSlug: req.params.orgSlug, formSlug: req.params.formSlug })
    res.status(500).json({ error: 'Failed to submit form' })
  }
})

export default router
