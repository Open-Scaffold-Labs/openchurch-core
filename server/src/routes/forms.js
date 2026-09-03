// Forms — admin CRUD + response inbox (Sprint Forms / F.1).
//
// Mounted in app.js under:
//   requireAuth → requireRole('admin') → auditLog('form')
// so every non-GET goes through the audit log and only admins can
// touch the surface.
//
// Tenant scope is enforced at the query layer — every WHERE clause
// includes organization_id = req.organizationId. A direct-id read or
// write against a form belonging to another org returns 404, not
// 403, to avoid leaking the existence of forms in other tenants.
//
// Field-schema validator (FIELD_TYPES) is the contract F.3 (public
// render) and F.4 (response inbox UI) both rely on. Keep it in
// sync if you add a new field type — the public submit validator
// in publicForms.js consumes the same shape.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { protectedDelete } from '../vault/deleteRoute.js'

const router = Router()

// Eight supported field types. New types added here must also be
// taught to the answer validator in publicForms.js.
export const FIELD_TYPES = new Set([
  'short_text',
  'long_text',
  'email',
  'number',
  'date',
  'select',
  'multiselect',
  'checkbox',
])

// Normalize a title into a URL-safe slug. Same shape as auth's
// slugify but local to this file — duplicating six lines beats
// reaching into another route module.
function slugify(title) {
  return (title || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

// Validate the fields array supplied on create/update. Returns the
// first error message found, or null on success. Each field shape:
//   { id: string, type: <FIELD_TYPES>, label: string, required?: bool,
//     options?: string[]  (required for select / multiselect) }
export function validateFieldSchema(fields) {
  if (!Array.isArray(fields)) return 'fields must be an array'
  const seenIds = new Set()
  const seenLabels = new Set()
  for (const f of fields) {
    if (!f || typeof f !== 'object') return 'each field must be an object'
    if (!f.id || typeof f.id !== 'string') return 'each field needs an id (string)'
    if (seenIds.has(f.id)) return `duplicate field id: ${f.id}`
    seenIds.add(f.id)
    if (!FIELD_TYPES.has(f.type)) return `unknown field type: ${f.type}`
    if (!f.label || typeof f.label !== 'string') return `field ${f.id} needs a label`
    // Duplicate label check is case-insensitive + whitespace-trimmed.
    // Two questions both labelled "Email" render confusingly downstream
    // and almost always mean the admin meant one of them to be
    // different.
    const labelKey = f.label.trim().toLowerCase()
    if (seenLabels.has(labelKey)) return `duplicate field label: ${f.label}`
    seenLabels.add(labelKey)
    if (f.type === 'select' || f.type === 'multiselect') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        return `field ${f.id} (${f.type}) needs non-empty options`
      }
      if (f.options.some(o => typeof o !== 'string')) {
        return `field ${f.id} options must be strings`
      }
    }
  }
  return null
}

// Allowed status transitions are open — any → any. Restricting them
// can come later if a use case appears; for v1 admins want to flip
// freely between draft/open/closed.
const STATUSES = new Set(['draft', 'open', 'closed'])

// GET /api/forms — list with response counts.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      // Includes f.fields so the admin builder UI (F.2) can bind to
      // the edit modal directly off the list response — one round
      // trip per page open instead of one for the list and one per
      // edit click. Field payloads are small (a handful of objects
      // per form) so the bandwidth tradeoff is trivial.
      `SELECT f.id, f.slug, f.title, f.description, f.fields,
              f.is_public, f.status, f.created_at, f.updated_at,
              COALESCE(r.response_count, 0) AS response_count
         FROM ochr_forms f
         LEFT JOIN (
           SELECT form_id, COUNT(*)::int AS response_count
             FROM ochr_form_responses
            GROUP BY form_id
         ) r ON r.form_id = f.id
        WHERE f.organization_id = $1
        ORDER BY f.created_at DESC`,
      [req.organizationId]
    )
    res.json({ forms: rows })
  } catch (err) {
    monitor.error('forms.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load forms' })
  }
})

// POST /api/forms — create a form.
router.post('/', async (req, res) => {
  const {
    title,
    description = null,
    fields = [],
    is_public = false,
    status = 'draft',
    slug: explicitSlug,
  } = req.body ?? {}

  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title is required' })
  }
  if (!STATUSES.has(status)) {
    return res.status(400).json({ error: 'status must be draft, open, or closed' })
  }
  const schemaError = validateFieldSchema(fields)
  if (schemaError) return res.status(400).json({ error: schemaError })

  // A form going straight to status='open' with no fields would serve
  // an empty page that accepts `{}` submissions — never what the admin
  // meant. Keep the door open for the equivalent flow (create draft,
  // add fields, PATCH to open) which is gated by the same check below.
  if (status === 'open' && fields.length === 0) {
    return res.status(400).json({ error: 'cannot open a form with no fields' })
  }

  // Slug resolution. If the admin passed an explicit slug, honor it
  // strictly — silently falling back to the title-derived slug when
  // their input slugifies to empty would hide a typo. The title path
  // only runs when no slug was passed at all.
  let slug
  if (explicitSlug !== undefined && explicitSlug !== null && explicitSlug !== '') {
    slug = slugify(explicitSlug)
    if (!slug) return res.status(400).json({ error: 'slug must contain at least one alphanumeric character' })
  } else {
    slug = slugify(title)
    if (!slug) return res.status(400).json({ error: 'title must contain at least one alphanumeric character' })
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO ochr_forms
         (organization_id, slug, title, description, fields, is_public, status, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING id, slug, title, description, fields, is_public, status,
                 created_at, updated_at`,
      [
        req.organizationId, slug, title.trim(), description,
        JSON.stringify(fields), Boolean(is_public), status,
        req.user.id,
      ]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    // 23505 = unique_violation. Surface as 409 so the UI can prompt
    // the admin to pick a different slug instead of seeing a 500.
    if (err?.code === '23505') {
      return res.status(409).json({ error: `A form with slug "${slug}" already exists` })
    }
    monitor.error('forms.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to create form' })
  }
})

// GET /api/forms/:id — read one.
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, slug, title, description, fields, is_public, status,
              created_at, updated_at
         FROM ochr_forms
        WHERE id = $1 AND organization_id = $2
        LIMIT 1`,
      [req.params.id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Form not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('forms.get', err, { id: req.params.id, orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load form' })
  }
})

// PATCH /api/forms/:id — partial update.
router.patch('/:id', async (req, res) => {
  const { title, description, fields, is_public, status, slug } = req.body ?? {}

  if (status !== undefined && !STATUSES.has(status)) {
    return res.status(400).json({ error: 'status must be draft, open, or closed' })
  }
  if (fields !== undefined) {
    const schemaError = validateFieldSchema(fields)
    if (schemaError) return res.status(400).json({ error: schemaError })
  }

  // Same "no-empty open form" rule as POST. The effective field set
  // is whatever this PATCH supplies, falling back to whatever's
  // already stored — an admin can validly flip status='open' on a
  // draft that already has fields without re-sending them.
  if (status === 'open') {
    let effectiveFields = fields
    if (effectiveFields === undefined) {
      const existing = await pool.query(
        `SELECT fields FROM ochr_forms
          WHERE id = $1 AND organization_id = $2
          LIMIT 1`,
        [req.params.id, req.organizationId]
      )
      if (!existing.rows.length) return res.status(404).json({ error: 'Form not found' })
      effectiveFields = existing.rows[0].fields
    }
    if (!Array.isArray(effectiveFields) || effectiveFields.length === 0) {
      return res.status(400).json({ error: 'cannot open a form with no fields' })
    }
  }

  // Build a dynamic SET clause from the fields that were actually
  // supplied. Keeps the SQL aligned with REST semantics — omitted
  // properties are left untouched. `cast` is appended after the
  // placeholder for columns Postgres needs help typing (e.g. jsonb
  // columns when we pass a stringified JSON literal).
  const sets = []
  const values = [req.params.id, req.organizationId]
  function add(col, val, cast = '') {
    values.push(val)
    sets.push(`${col} = $${values.length}${cast}`)
  }
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title must be a non-empty string' })
    }
    add('title', title.trim())
  }
  if (description !== undefined) add('description', description)
  if (fields !== undefined)      add('fields', JSON.stringify(fields), '::jsonb')
  if (is_public !== undefined)   add('is_public', Boolean(is_public))
  if (status !== undefined)      add('status', status)
  if (slug !== undefined) {
    const normalized = slugify(slug)
    if (!normalized) return res.status(400).json({ error: 'slug must contain at least one alphanumeric character' })
    add('slug', normalized)
  }
  if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' })
  sets.push(`updated_at = NOW()`)

  try {
    const { rows } = await pool.query(
      `UPDATE ochr_forms SET ${sets.join(', ')}
        WHERE id = $1 AND organization_id = $2
        RETURNING id, slug, title, description, fields, is_public, status,
                  created_at, updated_at`,
      values
    )
    if (!rows.length) return res.status(404).json({ error: 'Form not found' })
    res.json(rows[0])
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Another form with that slug already exists' })
    }
    monitor.error('forms.patch', err, { id: req.params.id, orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to update form' })
  }
})

// DELETE /api/forms/:id — cascades responses via ON DELETE CASCADE, so
// one click can take two hundred people's answers with it. Protected by
// the Continuity Vault; the responses come back with the form.
router.delete('/:id', protectedDelete('form', {
  notFound: 'Form not found', failure: 'Failed to delete form',
}))

// GET /api/forms/:id/responses — paginated response inbox.
//   ?limit (default 50, max 200)
//   ?offset (default 0)
router.get('/:id/responses', async (req, res) => {
  const limit  = Math.min(Math.max(parseInt(req.query.limit,  10) || 50, 1), 200)
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)

  try {
    // Tenant-scope check first: confirm the form belongs to this
    // org. Without this a guess at someone else's form_id could
    // page through their inbox.
    const formQ = await pool.query(
      `SELECT id FROM ochr_forms WHERE id = $1 AND organization_id = $2 LIMIT 1`,
      [req.params.id, req.organizationId]
    )
    if (!formQ.rows.length) return res.status(404).json({ error: 'Form not found' })

    const { rows } = await pool.query(
      `SELECT id, answers, respondent_name, respondent_email,
              ip_address, user_agent, created_at
         FROM ochr_form_responses
        WHERE form_id = $1 AND organization_id = $2
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [req.params.id, req.organizationId, limit, offset]
    )

    const countQ = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_form_responses
        WHERE form_id = $1 AND organization_id = $2`,
      [req.params.id, req.organizationId]
    )

    res.json({
      responses: rows,
      total: countQ.rows[0].n,
      limit,
      offset,
    })
  } catch (err) {
    monitor.error('forms.responses.list', err, { id: req.params.id, orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load responses' })
  }
})

export default router
