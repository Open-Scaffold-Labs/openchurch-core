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
import pool from '../db.js'
import { buildOrgExport } from '../services/orgExport.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// Only these keys may be PATCHed. Anything else in the body is
// silently dropped — same defense-in-depth pattern as
// notificationPrefs.js.
const PATCHABLE = new Set([
  'name',
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

// Timezone is validated against the runtime's IANA database rather than
// a length cap — an unknown zone would silently break the kiosk's date
// math, so it's rejected at write time.
function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// Keys that are booleans, not strings — handled separately in the
// PATCH loop (the string trim/length path would reject them).
const BOOLEAN_FIELDS = new Set(['page_published'])

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
              reminder_lead_hours, timezone,
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

    // Timezone must be a real IANA zone; empty/blank resets to UTC
    // rather than NULL (the column is NOT NULL DEFAULT 'UTC').
    if (k === 'timezone') {
      let v = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k]
      if (v === '' || v == null) { updates[k] = 'UTC'; continue }
      if (typeof v !== 'string' || !isValidTimeZone(v)) {
        return res.status(400).json({ error: 'timezone must be a valid IANA timezone' })
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
        WHERE id = $${params.length}
        RETURNING id, name, slug, address, tax_id,
                  signatory_name, signatory_title, statement_letterhead,
                  tagline, about, service_times, page_published,
                  reminder_lead_hours, timezone,
                  created_at`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
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
    res.setHeader('Content-Type', 'application/json')
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
