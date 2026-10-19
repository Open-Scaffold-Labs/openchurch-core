// Admin-only operational endpoints for keeping the database tidy.
// Mounted at /api/admin/maintenance behind requireAuth +
// requireRole('admin') in app.js.
//
// Today the only endpoint here is the retention prune. It's
// operator-poked; once Vercel cron lands, the cron config flips it
// from manual to scheduled (1 line in vercel.json).

import { requireIntParam } from '../utils/params.js'
import { revokeHeldAccess } from '../auth/organizationHold.js'
import { applyStoredEvent } from '../billing/webhookReceipts.js'
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import pool from '../db.js'
import { pruneOldRecords } from '../services/retention.js'
import { monitor } from '../monitoring/index.js'
import { slugify } from './auth.js'

const router = Router()

router.post('/retention-prune', async (req, res) => {
  try {
    const result = await pruneOldRecords()
    res.json(result)
  } catch (err) {
    monitor.error('maintenance.retention-prune', err)
    res.status(500).json({ error: 'Retention prune failed' })
  }
})

// POST /api/admin/maintenance/organizations — provision an organization
// that is NOT self-service.
//
// THE TRUSTED PATH FOR A DIOCESE. Public signup creates parishes and
// refuses everything else (routes/auth.js), because a chancery is a
// relationship with an organisation rather than a customer who arrives with
// a credit card, and an open door let a stranger stamp a diocese and start
// inviting parishes. This is the door instead: mounted behind requireAuth +
// requireSuperAdmin in app.js, so the caller must be the founder: a live
// login whose user id is listed in SUPER_ADMIN_USER_IDS (F-01,
// middleware/superAdmin.js). An email grants nothing. Nothing configured means nobody
// qualifies and the whole surface 404s — fail-closed, and the 404 keeps its
// existence unadvertised.
//
// Deliberately NOT an onboarding system. No invitation flow, no email, no
// self-serve chancery signup, no UI. It creates the organization and its
// first admin and stops. Everything else a diocese needs already exists
// once it can sign in.
//
// The founding user of a chancery gets pastoral_lead (CARE.3): a diocese
// whose first account cannot read its own pastoral notes is a chancery
// nobody can work in, and they cannot grant it to themselves before there
// is anybody to grant it. They can withdraw it later.
const ORG_TYPES = new Set(['parish', 'diocese'])
const TRADITIONS = new Set(['catholic', 'episcopal', 'lutheran', 'anglican', 'general'])
const MIN_PASSWORD = 8

// POST /api/admin/maintenance/organizations/:id/hold-revocation (Stage 6)
// Re-runs a held organization's access cleanup (logins off, reset/invite and
// push capabilities dropped, calendar/swap links cleared). Needed only if the
// hold's own cleanup reported revocation_complete: false — every user of a
// held organization is refused at sign-in, so nobody inside it can repeat
// the hold. Refuses an organization that is not held. Idempotent.
router.post('/organizations/:id/hold-revocation', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows: [org] } = await pool.query('SELECT held_at FROM ochr_organizations WHERE id = $1', [id])
    if (!org) return res.status(404).json({ error: 'Organization not found' })
    if (!org.held_at) return res.status(409).json({ error: 'Organization is not on hold. Nothing was changed.' })
    await revokeHeldAccess(id)
    // The hold's own audit row said the cleanup was incomplete; record that
    // it has now completed, as a new row (history is not rewritten). The
    // operator belongs to no parish, so no actor id is attached here.
    await pool.query(
      `INSERT INTO ochr_audit_log (organization_id, action, entity_type, entity_id, summary, metadata, request_method, request_path, status_code)
       VALUES ($1, 'hold', 'organization', $2, $3, $4::jsonb, $5, $6, 200)`,
      [id, String(id), `Placed organization on hold #${id} (already on hold) (access cleanup completed by operator)`,
       JSON.stringify({ already: true, cleanup_complete: true, via: 'operator' }), req.method, req.originalUrl]
    ).catch(err => monitor.error('maintenance.holdRevocation.audit', err, { orgId: id }))
    res.json({ held: true, revocation_complete: true })
  } catch (err) {
    monitor.error('maintenance.holdRevocation', err, { orgId: id })
    res.status(500).json({ error: 'Cleanup did not complete. Access stays refused while the organization is held.' })
  }
})

// Billing/giving webhook receipts (Stage 6). Every verified provider event
// is stored before it is applied (billing/webhookReceipts.js). These two
// routes are the reconciliation path for the ones that were not applied:
// 'held' (the organization is on hold), 'failed', or 'received' (stored, not
// yet attempted). Listing never returns the payload. Re-processing applies
// the stored event exactly as a delivery would; it contacts no provider and
// moves no money. A held organization stays held, so its events stay 'held'.
const RECEIPT_STATUSES = new Set(['received', 'applying', 'applied', 'deferred', 'held', 'failed'])
router.get('/billing-events', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null
  if (status !== null && !RECEIPT_STATUSES.has(status)) return res.status(400).json({ error: 'Unknown status' })
  try {
    const { rows } = await pool.query(
      `SELECT id, provider, event_id, event_type, organization_id, status, attempts, last_error,
              received_at, last_attempt_at, applied_at
         FROM ochr_billing_event_receipts
        WHERE ${status ? 'status = $1' : "status <> 'applied'"}
        ORDER BY received_at ASC, id ASC
        LIMIT 500`,
      status ? [status] : [])
    res.json({ events: rows })
  } catch (err) {
    monitor.error('maintenance.billingEvents', err)
    res.status(500).json({ error: 'Failed to list billing events' })
  }
})

router.post('/billing-events/:id/reprocess', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const outcome = await applyStoredEvent(id)
    if (outcome.status === 'missing') return res.status(404).json({ error: 'Billing event not found' })
    if (outcome.inProgress) return res.status(409).json({ id, status: outcome.status, error: 'Another worker is applying this event now.' })
    res.json({ id, status: outcome.status, ...(outcome.duplicate ? { already_applied: true } : {}), ...(outcome.error ? { error: outcome.error } : {}) })
  } catch (err) {
    monitor.error('maintenance.billingEvents.reprocess', err, { receiptId: id })
    res.status(500).json({ error: 'Re-processing did not complete; the stored event is unchanged.' })
  }
})

router.post('/organizations', async (req, res) => {
  const { organizationName, name, email, password } = req.body ?? {}
  const orgType = ORG_TYPES.has(req.body?.organizationType) ? req.body.organizationType : null
  const tradition = TRADITIONS.has(req.body?.tradition) ? req.body.tradition : 'general'

  if (!orgType) return res.status(400).json({ error: `organizationType must be one of: ${[...ORG_TYPES].join(', ')}` })
  if (!organizationName?.trim()) return res.status(400).json({ error: 'organizationName is required' })
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' })
  if (typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' })
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD} characters` })
  }

  const cleanEmail = email.trim().toLowerCase()
  const { rows: dupe } = await pool.query(
    `SELECT 1 FROM ochr_users WHERE email = $1
       -- tenancy: pre-tenancy by nature. This call CREATES the organization the
       -- user will belong to, so there is no caller org to scope by yet, and
       -- email is globally unique across the app.`,
    [cleanEmail]
  )
  if (dupe.length) return res.status(409).json({ error: 'An account with that email already exists' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    let slug = slugify(organizationName) || 'organization'
    const { rows: slugDupe } = await client.query('SELECT 1 FROM ochr_organizations WHERE slug = $1', [slug])
    if (slugDupe.length) slug = `${slug}-${Date.now().toString(36).slice(-4)}`

    const { rows: orgRows } = await client.query(
      'INSERT INTO ochr_organizations (name, slug, org_type, tradition) VALUES ($1, $2, $3, $4) RETURNING id, name, slug, org_type',
      [organizationName.trim(), slug, orgType, tradition]
    )
    const org = orgRows[0]

    const hash = await bcrypt.hash(password, 10)
    const { rows: userRows } = await client.query(
      `INSERT INTO ochr_users (organization_id, email, password_hash, name, role, pastoral_lead)
       VALUES ($1, $2, $3, $4, 'admin', $5) RETURNING id, email, name, role`,
      [org.id, cleanEmail, hash, name.trim(), orgType === 'diocese']
    )

    await client.query('COMMIT')

    // No token is returned. Provisioning is not signing in — whoever this
    // organization belongs to signs in themselves, which also means the
    // operator never holds a session for a customer's chancery.
    monitor.info?.('maintenance.provision', { orgId: org.id, orgType })
    res.status(201).json({ organization: org, user: userRows[0] })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('maintenance.provision', err)
    res.status(500).json({ error: 'Failed to provision organization' })
  } finally {
    client.release()
  }
})

export default router
