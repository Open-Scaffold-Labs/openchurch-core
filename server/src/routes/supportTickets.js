// Support tickets (SUP.2) — "Report a problem," triaged, so every church
// problem stops going directly to José.
//
//   POST  /api/support-tickets        → submit (ANY authenticated role,
//                                       viewers included — like feedback)
//   GET   /api/support-tickets/mine   → the reporter's own tickets
//   GET   /api/support-tickets        → queue (admin: own org; vendor: all)
//   GET   /api/support-tickets/:id    → one ticket with diagnosis
//   PATCH /api/support-tickets/:id    → triage (closed field allowlist)
//
// Mount (app.js) — NO writeGate, so a viewer can report a problem; the
// mutations beyond POST are role-checked in-handler. auditLog covers every
// 2xx mutation:
//   app.use('/api/support-tickets', requireAuth, auditLog('support_ticket'), supportTicketsRouter)
//
// Taxonomy comes from the Aug 12 handoff verbatim (see migration 065):
// severity critical|high|normal|low, status new|diagnosing|
// waiting_on_parish|in_progress|resolved|closed, classification bug|
// confusion|feature_request|product_insight.
//
// Triage model:
//   · An async diagnostic pass (never blocks the submit response) asks
//     Claude for structured triage — root cause, suspected files, proposed
//     fix, suggested severity + classification. The suggestion is adopted
//     onto the row ONLY while the ticket is untouched (status 'new',
//     severity still default, classification unset); after a human sets
//     anything, AI suggestions never overwrite it. No API key → the ticket
//     simply stays untriaged; submission never depends on AI.
//   · Workflow state is human-owned. Parish admins may resolve/close their
//     own org's tickets and add notes; the vendor (Open Scaffold Labs,
//     env-identified — middleware/superAdmin.js isVendorAdmin) owns
//     severity, classification, assignment, and the full status walk.
//
// Tenant posture: parish admins see only their own org; cross-org probes
// 404 (never 403) so ids aren't enumerable; the vendor read is the one
// legitimately cross-org query set here, same as the FB.2 workbench.
//
// Deliberately ABSENT: self-heal dispatch/callback (Founder Decision
// Ledger: WAIT), and any AI Studio quota coupling — support must never
// compete with bulletin-writing.

import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import pool from '../db.js'
import { requireIntParam, parsePagination } from '../utils/params.js'
import { isVendorAdmin } from '../middleware/superAdmin.js'
import { sendEmail } from '../email/send.js'
import { notify } from '../notifications/transport.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// Same default as AI Studio (small, cheap, known-good); SUPPORT_AI_MODEL
// upgrades the diagnostic independently when the vendor wants deeper triage.
const DIAG_MODEL = process.env.SUPPORT_AI_MODEL || 'claude-haiku-4-5-20251001'

const SEVERITIES      = new Set(['critical', 'high', 'normal', 'low'])
const STATUSES        = new Set(['new', 'diagnosing', 'waiting_on_parish', 'in_progress', 'resolved', 'closed'])
const CLASSIFICATIONS = new Set(['bug', 'confusion', 'feature_request', 'product_insight'])
// The states a parish admin may set on their own org's tickets. The rest
// of the walk (diagnosing, waiting_on_parish, in_progress, assignment,
// severity, classification) is the vendor's triage work.
const ORG_ADMIN_STATUSES = new Set(['resolved', 'closed'])

const MAX_DESCRIPTION = 5000

// ── Diagnostic context (compact, inline — the diagnostic reads this as its
// system prompt; docs/SUPPORT-CONTEXT.md is the maintained long-form copy
// and overrides when bundled) ────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'

const FALLBACK_CONTEXT = `OpenChurch is church management software for liturgical congregations
(Catholic parishes first): React 19 + Vite + Tailwind parish client (client/), separate diocese
client (client-diocese/), Express API (server/src/), Postgres via Supabase. Every table is
prefixed ochr_; every tenant table carries organization_id and every route scopes queries by
req.organizationId from the verified JWT. Roles admin/staff/viewer; writeGate blocks viewer
mutations. Key route files in server/src/routes/: clients (members), calendar/schedule/events,
sacraments (permanent register + drafts + certificates), massIntentions (intention book +
sacristy manifest), donations/funds/pledges (giving + IRS statements), finance (chart of
accounts, ledger, period submissions), diocese/assessments (chancery layer), billing (Stripe
SaaS plans), ai (AI Studio with per-plan quota), packet (Sunday Packet). Client pages in
client/src/pages/, components in client/src/components/, bilingual EN/ES via client/src/i18n.
Migrations: numbered idempotent files in server/src/migrations/. Money math is integer cents.
Liturgical dates are org-timezone-sensitive. Sample data rows carry [Sample] prefixes.`

function loadSupportContext() {
  const candidates = [
    path.join(process.cwd(), 'docs', 'SUPPORT-CONTEXT.md'),
    path.join(process.cwd(), 'SUPPORT-CONTEXT.md'),
  ]
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8') } catch { /* fall through */ }
  }
  return FALLBACK_CONTEXT
}

// ── Email forwarding (best-effort; rides the vendor-neutral seam) ────────
async function forwardToSupport(ticketId, req, description, pageRoute) {
  const to = process.env.SUPPORT_EMAIL
  if (!to) return
  await sendEmail({
    to,
    subject: `[OpenChurch ticket #${ticketId}] ${description.slice(0, 60)}`,
    text: [
      `Ticket #${ticketId}`,
      `Org id: ${req.organizationId}`,
      `User: ${req.user?.name || ''} <${req.user?.email || ''}> (${req.user?.role || '?'})`,
      `Page: ${pageRoute || 'unknown'}`,
      '',
      description,
    ].join('\n'),
  })
}

// ── Diagnostic pass (async — never blocks the submission response) ───────
export async function runDiagnostic(ticketId, description, pageRoute) {
  if (!process.env.ANTHROPIC_API_KEY) return // no key, no triage — never an error state
  const startMs = Date.now()

  const prompt = `You are the triage agent for OpenChurch. A user reported a problem in-app.
Analyze it against the architecture context and return ONLY a JSON object (no markdown fencing):
{
  "severity": "critical" | "high" | "normal" | "low",
  "classification": "bug" | "confusion" | "feature_request" | "product_insight",
  "confidence": "low" | "medium" | "high",
  "root_cause": "one sentence",
  "suspected_files": ["repo-relative paths most likely involved"],
  "proposed_fix": "one sentence",
  "narrative": "2-3 sentences for a human triager"
}
Severity guide: critical = blocks parish operations or risks data loss; high = core workflow
broken, no workaround; normal = bug with a workaround or degraded UX; low = cosmetic/docs.
If it reads like user confusion or a documentation gap rather than a defect, classify
"confusion" with severity "low" and say so in the narrative.

Page the user was on: ${pageRoute || 'unknown'}
Report: ${description}`

  try {
    const client = new Anthropic()
    const response = await client.messages.create({
      model: DIAG_MODEL, max_tokens: 1000, system: loadSupportContext(),
      messages: [{ role: 'user', content: prompt }],
    })
    const text = response.content?.find(b => b.type === 'text')?.text || ''
    let diagnosis
    try { diagnosis = JSON.parse(text) } catch {
      diagnosis = { confidence: 'low', narrative: text.slice(0, 400) }
    }

    // Adopt the AI's suggestions only onto an untouched ticket — the WHERE
    // clause is the guarantee that a human's explicit triage (or any status
    // movement) is never overwritten by a late-arriving diagnostic.
    const sevOk = SEVERITIES.has(diagnosis.severity) ? diagnosis.severity : null
    const clsOk = CLASSIFICATIONS.has(diagnosis.classification) ? diagnosis.classification : null
    const { rowCount } = await pool.query(
      `UPDATE ochr_support_tickets
          SET diagnosis = $2, diagnosis_tokens = $3, diagnosis_duration_ms = $4,
              severity       = COALESCE($5, severity),
              classification = COALESCE($6, classification),
              updated_at = NOW()
        WHERE id = $1 AND status = 'new' AND severity = 'normal' AND classification IS NULL`,
      [ticketId, JSON.stringify(diagnosis),
       JSON.stringify({ input: response.usage?.input_tokens, output: response.usage?.output_tokens }),
       Date.now() - startMs, sevOk, clsOk])

    if (!rowCount) {
      // Ticket already triaged by a human — attach the diagnosis for
      // reference but change nothing else.
      await pool.query(
        `UPDATE ochr_support_tickets
            SET diagnosis = COALESCE(diagnosis, $2), updated_at = NOW()
          WHERE id = $1`,
        [ticketId, JSON.stringify(diagnosis)])
    }
  } catch (err) {
    // A diagnostic failure is a footnote on the ticket, never a state.
    await pool.query(
      `UPDATE ochr_support_tickets
          SET diagnosis = COALESCE(diagnosis, $2), updated_at = NOW()
        WHERE id = $1`,
      [ticketId, JSON.stringify({ error: `Diagnostic failed: ${err.message}` })])
      .catch(e2 => monitor.error('supportTickets.diagnostic.write', e2, { ticketId }))
  }
}

// ── POST /api/support-tickets — any authenticated user ───────────────────
router.post('/', async (req, res) => {
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : ''
  if (description.length < 10) {
    return res.status(400).json({ error: 'Please describe the problem in a sentence or two' })
  }
  if (description.length > MAX_DESCRIPTION) {
    return res.status(400).json({ error: 'Description is too long' })
  }
  const pageRoute = typeof req.body?.page_route === 'string' ? req.body.page_route.slice(0, 200) : null
  const contextBundle = req.body?.context_bundle && typeof req.body.context_bundle === 'object'
    && !Array.isArray(req.body.context_bundle) ? req.body.context_bundle : null

  try {
    const { rows: [ticket] } = await pool.query(
      `INSERT INTO ochr_support_tickets (organization_id, user_id, description, page_route, context_bundle)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
      [req.organizationId, req.user.id, description, pageRoute,
       contextBundle ? JSON.stringify(contextBundle) : null])

    runDiagnostic(ticket.id, description, pageRoute)
      .catch(err => monitor.error('supportTickets.diagnostic', err, { ticketId: ticket.id }))
    forwardToSupport(ticket.id, req, description, pageRoute)
      .catch(err => monitor.error('supportTickets.email', err, { ticketId: ticket.id }))

    res.status(201).json({
      id: ticket.id, status: ticket.status, created_at: ticket.created_at,
      message: 'Thank you — your report was submitted and will be reviewed.',
    })
  } catch (err) {
    monitor.error('supportTickets.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to submit report' })
  }
})

// ── GET /api/support-tickets/mine — the reporter's own reports ────────────
// Any role: closing the loop on "what happened to my report?" without
// exposing the org queue. Deliberately excludes diagnosis (internal triage).
router.get('/mine', async (req, res) => {
  const { limit, offset } = parsePagination(req.query)
  try {
    const { rows } = await pool.query(
      `SELECT id, description, page_route, severity, status, classification,
              resolution_notes, created_at, updated_at
         FROM ochr_support_tickets
        WHERE organization_id = $1 AND user_id = $2
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [req.organizationId, req.user.id, limit, offset])
    res.json({ tickets: rows })
  } catch (err) {
    monitor.error('supportTickets.mine', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load your reports' })
  }
})

// ── GET /api/support-tickets — the queue ─────────────────────────────────
// Admin: own org. Vendor: every org, with org names, filterable. Sorted
// worst-first (severity rank) inside newest-first — the triage order.
router.get('/', async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const { limit, offset } = parsePagination(req.query)
  const vendor = isVendorAdmin(req)
  try {
    const where = []
    const params = []
    if (!vendor) { params.push(req.organizationId); where.push(`t.organization_id = $${params.length}`) }
    if (typeof req.query.status === 'string' && STATUSES.has(req.query.status)) {
      params.push(req.query.status); where.push(`t.status = $${params.length}`)
    }
    if (typeof req.query.severity === 'string' && SEVERITIES.has(req.query.severity)) {
      params.push(req.query.severity); where.push(`t.severity = $${params.length}`)
    }
    if (typeof req.query.classification === 'string' && CLASSIFICATIONS.has(req.query.classification)) {
      params.push(req.query.classification); where.push(`t.classification = $${params.length}`)
    }
    // ?open=1 — the standing triage view: everything not yet resolved/closed.
    if (req.query.open === '1') where.push(`t.status NOT IN ('resolved', 'closed')`)
    // ?org_id= — vendor-only narrowing. For a parish admin the forced
    // own-org clause above already owns the scope, so the param is
    // ignored rather than honored: it can never widen anything.
    if (vendor) {
      const orgFilter = Number.parseInt(req.query.org_id, 10)
      if (Number.isInteger(orgFilter) && orgFilter > 0) {
        params.push(orgFilter); where.push(`t.organization_id = $${params.length}`)
      }
    }
    // ?q= — substring search over the report text (and, for the vendor,
    // the assignee). Parameterized ILIKE; wildcards in the input are
    // escaped so a stray % can't turn into a full-table match pattern.
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const needle = req.query.q.trim().slice(0, 200).replace(/[\\%_]/g, '\\$&')
      params.push(`%${needle}%`)
      where.push(`(t.description ILIKE $${params.length} OR t.assigned_to ILIKE $${params.length})`)
    }
    params.push(limit, offset)

    const { rows } = await pool.query(
      `SELECT t.id, t.organization_id, t.description, t.page_route, t.severity,
              t.status, t.classification, t.assigned_to, t.created_at, t.updated_at,
              (t.diagnosis IS NOT NULL) AS has_diagnosis,
              u.name AS reporter_name, o.name AS org_name
         FROM ochr_support_tickets t
         LEFT JOIN ochr_users u ON u.id = t.user_id
         LEFT JOIN ochr_organizations o ON o.id = t.organization_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE t.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                                 WHEN 'normal' THEN 2 ELSE 3 END,
                 t.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
    res.json({ tickets: rows, vendor })
  } catch (err) {
    monitor.error('supportTickets.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load tickets' })
  }
})

// ── GET /api/support-tickets/:id — 404 (not 403) on cross-org ────────────
router.get('/:id', async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows: [ticket] } = await pool.query(
      `SELECT t.*, u.name AS reporter_name, u.email AS reporter_email, o.name AS org_name
         FROM ochr_support_tickets t
         LEFT JOIN ochr_users u ON u.id = t.user_id
         LEFT JOIN ochr_organizations o ON o.id = t.organization_id
        WHERE t.id = $1`, [id])
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' })
    if (!isVendorAdmin(req) && ticket.organization_id !== req.organizationId) {
      return res.status(404).json({ error: 'Ticket not found' })
    }
    res.json(ticket)
  } catch (err) {
    monitor.error('supportTickets.get', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load ticket' })
  }
})

// ── PATCH /api/support-tickets/:id — triage (closed allowlist) ───────────
// Vendor: full triage — status (any), severity, classification,
// assigned_to, resolution_notes, on any org's ticket.
// Parish admin: own org only — status limited to resolved/closed, plus
// resolution_notes. Everything else in the body is a 400, never ignored.
router.patch('/:id', async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const id = requireIntParam(req, res); if (id === null) return
  const vendor = isVendorAdmin(req)

  const allowed = vendor
    ? ['status', 'severity', 'classification', 'assigned_to', 'resolution_notes']
    : ['status', 'resolution_notes']
  const unknown = Object.keys(req.body ?? {}).filter(k => !allowed.includes(k))
  if (unknown.length) {
    return res.status(400).json({ error: `Cannot update: ${unknown.join(', ')}` })
  }

  const sets = []
  const params = [id]
  const body = req.body ?? {}

  if (body.status !== undefined) {
    if (!STATUSES.has(body.status)) return res.status(400).json({ error: 'Invalid status' })
    if (!vendor && !ORG_ADMIN_STATUSES.has(body.status)) {
      return res.status(400).json({ error: 'Parish admins may set status to resolved or closed' })
    }
    params.push(body.status); sets.push(`status = $${params.length}`)
  }
  if (body.severity !== undefined) {
    if (!SEVERITIES.has(body.severity)) return res.status(400).json({ error: 'Invalid severity' })
    params.push(body.severity); sets.push(`severity = $${params.length}`)
  }
  if (body.classification !== undefined) {
    if (body.classification !== null && !CLASSIFICATIONS.has(body.classification)) {
      return res.status(400).json({ error: 'Invalid classification' })
    }
    params.push(body.classification); sets.push(`classification = $${params.length}`)
  }
  if (body.assigned_to !== undefined) {
    const v = body.assigned_to === null ? null
      : typeof body.assigned_to === 'string' ? body.assigned_to.trim().slice(0, 200) || null : undefined
    if (v === undefined) return res.status(400).json({ error: 'Invalid assigned_to' })
    params.push(v); sets.push(`assigned_to = $${params.length}`)
  }
  if (body.resolution_notes !== undefined) {
    const v = body.resolution_notes === null ? null
      : typeof body.resolution_notes === 'string' ? body.resolution_notes.trim().slice(0, 5000) || null : undefined
    if (v === undefined) return res.status(400).json({ error: 'Invalid resolution_notes' })
    params.push(v); sets.push(`resolution_notes = $${params.length}`)
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' })

  try {
    let scope = ''
    if (!vendor) { params.push(req.organizationId); scope = `AND organization_id = $${params.length}` }
    // Old state first, same scope — so we can tell a real status
    // transition from a re-save and notify the reporter only once.
    const { rows: [before] } = await pool.query(
      `SELECT status, user_id, organization_id, description
         FROM ochr_support_tickets WHERE id = $1 ${vendor ? '' : 'AND organization_id = $2'}`,
      vendor ? [id] : [id, req.organizationId])
    const { rows: [row] } = await pool.query(
      `UPDATE ochr_support_tickets SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 ${scope}
        RETURNING id, status, severity, classification, assigned_to, resolution_notes, updated_at`,
      params)
    if (!row) return res.status(404).json({ error: 'Ticket not found' })

    // Close the reporter's loop: when the status genuinely moved to a
    // state they care about and someone ELSE moved it, tell them.
    // Fire-and-forget through the notifications seam (prefs respected,
    // stub transport in dev) — never blocks or fails the triage save.
    notifyReporter(before, row, req).catch(err =>
      monitor.error('supportTickets.notify', err, { id }))

    res.json(row)
  } catch (err) {
    monitor.error('supportTickets.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update ticket' })
  }
})

const NOTIFY_STATUSES = {
  resolved:          'Resolved',
  closed:            'Closed',
  waiting_on_parish: 'Waiting on you',
}

async function notifyReporter(before, after, req) {
  if (!before?.user_id) return
  if (before.user_id === req.user.id) return // self-updates need no letter
  if (before.status === after.status) return
  const statusLabel = NOTIFY_STATUSES[after.status]
  if (!statusLabel) return

  const { rows: [info] } = await pool.query(
    `SELECT u.email, u.name, o.name AS org_name
       FROM ochr_users u
       JOIN ochr_organizations o ON o.id = $2
      WHERE u.id = $1`,
    [before.user_id, before.organization_id])
  if (!info?.email) return

  await notify({
    organizationId: before.organization_id,
    userId: before.user_id,
    recipient: info.email,
    notification_type: 'support_ticket_update',
    vars: {
      recipient_name: info.name || 'there',
      church_name: info.org_name || 'your parish',
      status_label: statusLabel,
      description_short: before.description.slice(0, 60),
      notes_block: after.resolution_notes
        ? `\n\nNote from the team:\n${after.resolution_notes}` : '',
    },
  })
}

export default router
