// Org-level settings endpoint (Sprint Y / Y.4). Admin-only — the
// letterhead block drives every printed giving statement, payroll
// header, future invoice template, etc. Should not be editable by
// staff/viewers.
//
//   GET   /api/organization          → current org's settings block
//   PATCH /api/organization { ... }  → partial update, returns row
//
// Why per-PATCH-key validation: the patchable surface is small + stable
// (six fields). A whitelist beats an opaque pass-through and keeps an
// admin from accidentally writing to `slug` or `created_at`.

import { Router } from 'express'
import { acceptedParishTimeZone, canonicalParishTimeZone } from '../utils/timezone.js'
import pool from '../db.js'
import { buildOrgExport } from '../services/orgExport.js'
import { monitor } from '../monitoring/index.js'
import { invalidateTradition } from '../traditions/context.js'
import { holdOrganization } from '../auth/organizationHold.js'
import { markStewardship } from '../middleware/auditLog.js'
import { clearSessionCookie } from '../auth/sessionCookie.js'
import { requireRole } from '../middleware/auth.js'

const router = Router()

router.post('/hold', requireRole('admin'), async (req, res) => {
  try {
    const result = await holdOrganization({ organizationId: req.organizationId, actorId: req.user.id, confirm: req.body?.confirm, acknowledgeExportWarning: req.body?.acknowledge_export_warning })
    if (result.status === 200) {
      clearSessionCookie(res)
      markStewardship(res, { action: 'hold', targetId: Number(req.organizationId), already: result.body.already, incomplete: result.body.revocation_complete === false })
    }
    res.status(result.status).json(result.body)
  } catch (err) {
    monitor.error('organization.hold', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to hold organization' })
  }
})

// Only these keys may be PATCHed. Anything else in the body is
// silently dropped — same defense-in-depth pattern as
// notificationPrefs.js.
const PATCHABLE = new Set([
  'name',
  // TRAD.1 — which tradition's vocabulary, seasons and lectionary this
  // org sees. Validated against a closed set, not free text, because a
  // typo here would silently drop the org back to 'general'.
  'tradition',
  // The parish's language (migration 093). Same shape as tradition and for
  // the same reason: a closed set, because an unrecognised value renders
  // English while claiming to be something else, which is the failure mode
  // hardest for the person affected to report.
  'locale',
  // PILOT.4 — a workspace may declare itself fictional. ONE WAY ONLY: see
  // the guard below. Turning it on is a promise about the data; turning it
  // off would be a claim that fictional pastoral notes are real ones.
  'is_demo',
  'address',
  'tax_id',
  'signatory_name',
  'signatory_title',
  'statement_letterhead',
  // Public church-page content (Anchor 5 / A5.1). page_published is a
  // boolean gate; the rest are free text rendered on /p/:slug.
  'tagline',
  'about',
  'service_times',
  'page_published',
  // Reminders (RM.3) — how many hours before an event serving reminders
  // are sent. Integer.
  'reminder_lead_hours',
  // IANA timezone (CHK.7) — the church's local day, used by the kiosk's
  // "today" filters. Validated against the host's tz database.
  'timezone',
])

// Keys that are booleans, not strings — handled separately in the
// PATCH loop (the string trim/length path would reject them).
const BOOLEAN_FIELDS = new Set(['page_published'])
const TRADITIONS_ALLOWED = new Set(['catholic', 'episcopal', 'lutheran', 'anglican', 'general'])
// Matches the CHECK constraint in migration 093. Kept as a literal rather
// than imported from the migration: route validation and schema validation
// are two independent statements of the same rule, and a route that imports
// its rule from the thing it is guarding is not a second opinion.
const LOCALES_ALLOWED = new Set(['en', 'es'])

// Integer fields, clamped to a sane inclusive range so a typo can't
// queue reminders a year out (or in the past).
const INT_FIELDS = { reminder_lead_hours: { min: 1, max: 168 } }

// Soft length caps to keep junk out of the DB. Single line of text for
// most fields; statement_letterhead is multi-line free-text so the
// cap is larger.
const MAX_LEN = {
  name:                  120,
  address:               240,
  tax_id:                40,
  signatory_name:        120,
  signatory_title:       120,
  statement_letterhead:  2000,
  tagline:               200,
  about:                 4000,
  service_times:         1000,
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, address, tax_id,
              signatory_name, signatory_title, statement_letterhead,
              tagline, about, service_times, page_published,
              reminder_lead_hours, timezone, tradition, locale,
              created_at
         FROM ochr_organizations
        WHERE id = $1`,
      [req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    res.set('Cache-Control', 'private, max-age=30')
    res.json(rows[0])
  } catch (err) {
    console.error('organization.get failed:', err)
    res.status(500).json({ error: 'Failed to load organization' })
  }
})

router.patch('/', async (req, res) => {
  // Filter to known-patchable keys + run the length cap. Empty strings
  // are coerced to NULL so admins can clear a field by submitting
  // blank rather than needing a separate DELETE flow.
  const updates = {}
  for (const k of Object.keys(req.body ?? {})) {
    if (!PATCHABLE.has(k)) continue

    // Boolean fields (page_published) take their own path — accept a
    // real boolean or the strings 'true'/'false' so a form checkbox or
    // a JSON bool both work; anything else is a 400.
    if (BOOLEAN_FIELDS.has(k)) {
      const raw = req.body[k]
      if (typeof raw === 'boolean') { updates[k] = raw; continue }
      if (raw === 'true')  { updates[k] = true;  continue }
      if (raw === 'false') { updates[k] = false; continue }
      return res.status(400).json({ error: `${k} must be a boolean` })
    }

    // Integer fields — coerce + clamp to the allowed range.
    if (INT_FIELDS[k]) {
      const n = Number(req.body[k])
      if (!Number.isInteger(n)) {
        return res.status(400).json({ error: `${k} must be an integer` })
      }
      const { min, max } = INT_FIELDS[k]
      updates[k] = Math.min(Math.max(n, min), max)
      continue
    }

    // Empty/blank resets to UTC (the column is NOT NULL). Anything else
    // must be a zone this database can use in AT TIME ZONE. Legacy
    // aliases are stored under the modern name. An offset, a POSIX
    // string, or a name Postgres does not list is a 400 and writes
    // nothing — signup is the path that falls back quietly.
    if (k === 'timezone') {
      const raw = req.body[k]
      if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
        updates[k] = 'UTC'
        continue
      }
      if (typeof raw !== 'string' || !canonicalParishTimeZone(raw)) {
        return res.status(400).json({ error: 'timezone must be a valid IANA timezone' })
      }
      const accepted = await acceptedParishTimeZone(pool, raw)
      if (!accepted.ok) {
        return res.status(400).json({ error: 'timezone must be a valid IANA timezone' })
      }
      updates[k] = accepted.zone
      continue
    }

    // Tradition is a closed set, and it is NOT nullable — clearing it
    // means 'general', which is a real tier rather than an absence.
    if (k === 'is_demo') {
      // Declaring a workspace fictional is allowed at any time. Declaring a
      // fictional one real is not, from here — it would take demo parishes,
      // demo clergy and invented pastoral notes and quietly present them as
      // records about actual people. If a workspace was flagged in error,
      // that is a conversation with support, not a checkbox.
      // Read req.body directly: `v` is declared with `let` further down
      // this loop body, so touching it here is a temporal-dead-zone
      // ReferenceError, which surfaces as a 500 rather than as a mistake.
      if (req.body[k] !== true) {
        return res.status(400).json({
          error: 'A demonstration workspace cannot be marked as real from here. Ask support.',
        })
      }
      updates[k] = true
      continue
    }
    // Locale is NOT nullable — clearing it means English, which is a real
    // answer rather than an absence, exactly like tradition → 'general'.
    if (k === 'locale') {
      const v = String(req.body[k] ?? '').trim() || 'en'
      if (!LOCALES_ALLOWED.has(v)) {
        return res.status(400).json({ error: `locale must be one of: ${[...LOCALES_ALLOWED].join(', ')}` })
      }
      updates[k] = v
      continue
    }
    if (k === 'tradition') {
      const v = String(req.body[k] ?? '').trim() || 'general'
      if (!TRADITIONS_ALLOWED.has(v)) {
        return res.status(400).json({ error: `tradition must be one of: ${[...TRADITIONS_ALLOWED].join(', ')}` })
      }
      updates[k] = v
      continue
    }

    let v = req.body[k]
    if (typeof v === 'string') v = v.trim()
    if (v === '' || v == null) {
      updates[k] = null
      continue
    }
    if (typeof v !== 'string') {
      return res.status(400).json({ error: `${k} must be a string` })
    }
    if (v.length > MAX_LEN[k]) {
      return res.status(400).json({ error: `${k} exceeds max length (${MAX_LEN[k]})` })
    }
    updates[k] = v
  }

  const keys = Object.keys(updates)
  if (keys.length === 0) {
    return res.status(400).json({ error: 'No editable fields in body' })
  }

  // Parameterized SET clause — keys come from a closed allowlist so
  // the column-name interpolation is safe.
  const sets   = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')
  const params = keys.map(k => updates[k])
  params.push(req.organizationId)

  try {
    const { rows } = await pool.query(
      `UPDATE ochr_organizations
          SET ${sets}
        WHERE id = $${params.length} AND held_at IS NULL
        RETURNING id, name, slug, address, tax_id,
                  signatory_name, signatory_title, statement_letterhead,
                  tagline, about, service_times, page_published,
                  reminder_lead_hours, timezone, tradition, locale, locale,
                  created_at`,
      params
    )
    // The tradition cache is a politeness to the database, not a source
    // of truth — drop it so an admin who just switched sees the new
    // vocabulary on the next page load rather than up to a minute later.
    if ('tradition' in updates) invalidateTradition(req.organizationId)
    if (!rows.length) {
      const { rows: held } = await pool.query('SELECT id FROM ochr_organizations WHERE id = $1 AND held_at IS NOT NULL', [req.organizationId])
      return held.length ? res.status(409).json({ error: 'This organization is on hold. Nothing was changed.' }) : res.status(404).json({ error: 'Organization not found' })
    }
    res.json(rows[0])
  } catch (err) {
    console.error('organization.patch failed:', err)
    res.status(500).json({ error: 'Failed to save organization' })
  }
})

// GET /api/organization/export — the complete parish data export.
// "Your data exports anytime" as an endpoint, not a promise. Mounted
// admin-only (see app.js); org-scoped by construction.
router.get('/export', async (req, res) => {
  try {
    const dump = await buildOrgExport(req.organizationId)
    const slug = dump.organization.slug || dump.organization.id
    // charset=utf-8 is load-bearing for parish names with accents — without
    // it, some clients mis-decode the JSON attachment as Latin-1.
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="openchurch-export-${slug}-${dump.exported_at.slice(0, 10)}.json"`
    )
    res.send(JSON.stringify(dump, null, 1))
  } catch (err) {
    monitor.error('organization.export', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Export failed' })
  }
})

export default router
