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
import { isSafeHttpsLogoUrl, isSafeAccentHex } from '../public/branding.js'
import {
  saveDraft, updateLookOnly, publishDraft, unpublishSite, revertPublished,
  adminSitePayload, getSiteRow, listPublishHistory, parseExpectedRevision, requireSiteConfirm,
} from '../website/repo.js'
import { libraryCatalog } from '../website/siteDocument.js'

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
  // OC-WEB-1 PR-B — public branding. Validated with the same helpers the
  // public resolver uses (https logo, #RRGGBB accent); empty clears to NULL.
  'public_display_name',
  'public_logo_url',
  'public_accent_hex',
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
  public_display_name:   120,
  public_logo_url:       500,
  public_accent_hex:     7,
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, address, tax_id,
              signatory_name, signatory_title, statement_letterhead,
              tagline, about, service_times, page_published,
              public_display_name, public_logo_url, public_accent_hex,
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

    // Public branding (OC-WEB-1 PR-B). Empty clears. Logo must be https
    // without userinfo; accent must be #RRGGBB (stored uppercased). Same
    // rules as resolvePublicBranding so admin write and public read agree.
    if (k === 'public_logo_url') {
      let v = req.body[k]
      if (typeof v === 'string') v = v.trim()
      if (v === '' || v == null) { updates[k] = null; continue }
      if (typeof v !== 'string') {
        return res.status(400).json({ error: 'public_logo_url must be a string' })
      }
      if (!isSafeHttpsLogoUrl(v)) {
        return res.status(400).json({
          error: 'public_logo_url must be an https URL without credentials',
        })
      }
      updates[k] = v
      continue
    }
    if (k === 'public_accent_hex') {
      let v = req.body[k]
      if (typeof v === 'string') v = v.trim()
      if (v === '' || v == null) { updates[k] = null; continue }
      if (typeof v !== 'string' || !isSafeAccentHex(v)) {
        return res.status(400).json({
          error: 'public_accent_hex must be a #RRGGBB hex color',
        })
      }
      updates[k] = v.toUpperCase()
      continue
    }

    // Argus N452-3 — strip C0 controls + DEL from the public display
    // name so titles/document.title stay printable. Empty after strip → NULL.
    if (k === 'public_display_name') {
      let v = req.body[k]
      if (typeof v === 'string') {
        v = v.replace(/[\u0000-\u001F\u007F]/g, '').trim()
      }
      if (v === '' || v == null) { updates[k] = null; continue }
      if (typeof v !== 'string') {
        return res.status(400).json({ error: 'public_display_name must be a string' })
      }
      if (v.length > MAX_LEN.public_display_name) {
        return res.status(400).json({
          error: `public_display_name exceeds max length (${MAX_LEN.public_display_name})`,
        })
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
                  public_display_name, public_logo_url, public_accent_hex,
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
    // N451-1 CHECKs — surface as 400 rather than a bare 500 so the admin
    // UI can show the same message the route validators already use.
    if (err?.code === '23514') {
      const c = err.constraint || ''
      if (c.includes('public_accent_hex')) {
        return res.status(400).json({ error: 'public_accent_hex must be a #RRGGBB hex color' })
      }
      if (c.includes('public_logo_url')) {
        return res.status(400).json({ error: 'public_logo_url must be an https URL without credentials' })
      }
    }
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

// ── OC-WEB-1 PR-C/D: site document ──────────────────────────────────────────
// Tenant-scoped via req.organizationId. Anonymous visitors never see draft_doc.
// Publish copies the stored draft; it does not accept a document in the body.

async function loadHeldOrg(organizationId) {
  const { rows } = await pool.query(
    `SELECT slug, page_published
       FROM ochr_organizations
      WHERE id = $1 AND held_at IS NULL
      LIMIT 1`,
    [organizationId],
  )
  return rows[0] ?? null
}

function actorUserId(req) {
  const id = req.user?.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    const err = new Error('Reload the page before saving. Nothing was changed.')
    err.status = 400
    err.code = 'site_actor_invalid'
    throw err
  }
  return id
}

function respondSiteError(res, err, logLabel) {
  if (err?.status === 400 || err?.status === 409) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    })
  }
  if (err?.code === '23514') {
    return res.status(400).json({ error: 'Invalid look or reserved field', code: 'site_doc_invalid' })
  }
  if (err?.code === '23503') {
    return res.status(400).json({
      error: 'This login cannot change the parish page. Nothing was changed.',
      code: 'site_actor_invalid',
    })
  }
  console.error(`${logLabel} failed:`, err)
  monitor.error(logLabel, err, { orgId: res.req?.organizationId })
  return res.status(500).json({ error: 'Failed to save site document' })
}

async function siteResponse(organizationId, row, org) {
  const history = row ? await listPublishHistory(organizationId) : []
  return adminSitePayload(row, {
    slug: org.slug,
    pagePublished: org.page_published === true,
    history,
  })
}

router.get('/site', async (req, res) => {
  try {
    const org = await loadHeldOrg(req.organizationId)
    const row = await getSiteRow(req.organizationId)
    const history = row ? await listPublishHistory(req.organizationId) : []
    res.json({
      site: adminSitePayload(row, {
        slug: org?.slug,
        pagePublished: org?.page_published === true,
        history,
      }),
      catalog: libraryCatalog(),
    })
  } catch (err) {
    console.error('organization.site.get failed:', err)
    monitor.error('organization.site.get', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load site document' })
  }
})

router.put('/site', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const org = await loadHeldOrg(req.organizationId)
    if (!org) return res.status(404).json({ error: 'Organization not found' })
    // Publish is its own confirmed action. This route only saves the draft.
    if ('published' in body || 'published_doc' in body || body.publish === true) {
      return res.status(400).json({
        error: 'Publishing is a separate confirmed action',
      })
    }
    if ('custom_domain' in body && body.custom_domain != null) {
      return res.status(400).json({
        error: 'Custom domains are not enabled (reserved for a later release)',
      })
    }
    // Atlas P1 / Argus N460-1 — never fall back to whole body as draftDoc.
    // look-only updates must not wipe pages; empty body is 400.
    const hasDraft = Object.prototype.hasOwnProperty.call(body, 'draft')
      || Object.prototype.hasOwnProperty.call(body, 'doc')
    const lookId = body.look_id ?? body.lookId
    const hasLook = lookId != null && String(lookId).trim() !== ''
    if (!hasDraft && !hasLook) {
      return res.status(400).json({ error: 'Provide draft, doc, or look_id' })
    }
    const expectedRevision = parseExpectedRevision(body)
    let row
    if (hasDraft) {
      const draftDoc = Object.prototype.hasOwnProperty.call(body, 'draft')
        ? body.draft
        : body.doc
      row = await saveDraft({
        organizationId: req.organizationId,
        draftDoc,
        lookId: hasLook ? lookId : null,
        slug: org.slug,
        expectedRevision,
      })
    } else {
      row = await updateLookOnly({
        organizationId: req.organizationId,
        lookId,
        expectedRevision,
      })
    }
    res.json({ site: await siteResponse(req.organizationId, row, org) })
  } catch (err) {
    respondSiteError(res, err, 'organization.site.put')
  }
})

async function runPublishAction(req, res, logLabel, fn) {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const org = await loadHeldOrg(req.organizationId)
    if (!org) return res.status(404).json({ error: 'Organization not found' })
    if ('custom_domain' in body && body.custom_domain != null) {
      return res.status(400).json({
        error: 'Custom domains are not enabled (reserved for a later release)',
      })
    }
    requireSiteConfirm(body)
    const expectedRevision = parseExpectedRevision(body)
    const actor = actorUserId(req)
    const row = await fn({
      organizationId: req.organizationId,
      actorUserId: actor,
      expectedRevision,
      slug: org.slug,
    })
    // SP-307: unpublish clears page_published; reload so the admin payload
    // matches the row visitors will see (stale org would still say true).
    const orgFresh = await loadHeldOrg(req.organizationId)
    res.json({ site: await siteResponse(req.organizationId, row, orgFresh || org) })
  } catch (err) {
    respondSiteError(res, err, logLabel)
  }
}

router.post('/site/publish', (req, res) => (
  runPublishAction(req, res, 'organization.site.publish', publishDraft)
))

router.post('/site/unpublish', (req, res) => (
  runPublishAction(req, res, 'organization.site.unpublish', unpublishSite)
))

router.post('/site/revert', (req, res) => (
  runPublishAction(req, res, 'organization.site.revert', revertPublished)
))


export default router
