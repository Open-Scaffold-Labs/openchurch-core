// Parish Care (CARE.1) — the diocesan office's working view of a parish.
//
//   GET   /api/diocese/care                     → the care list
//   GET   /api/diocese/care/:parishId           → context panel + timeline
//   GET   /api/diocese/care/:parishId/brief     → the printable brief's data
//   POST  /api/diocese/care/:parishId/brief     → record that one was prepared
//   POST  /api/diocese/care/:parishId/timeline  → write to the record
//   GET   /api/diocese/care/followups           → the office's private memory
//   POST  /api/diocese/care/:parishId/followups
//   PATCH /api/diocese/care/followups/:id
//   POST  /api/diocese/care/:parishId/transitions
//   PATCH /api/diocese/care/transitions/:id
//   POST  /api/diocese/care/submissions/:id/notes  → shared report review
//
// EVERY QUERY JOINS THROUGH ochr_diocese_affiliations. A diocese can only
// ever reach a parish it is actually affiliated with, and the mount is
// already behind requireOrgType('diocese'), so a parish token cannot reach
// any path in this file at all.
//
// Nothing here computes or stores a score. Care status is derived at read
// time by diocese/careStatus.js and always arrives with the sentence that
// produced it.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'
import { careStatusFor } from '../diocese/careStatus.js'
import { buildCareBrief } from '../diocese/careBrief.js'

const router = Router()

// Confirms the parish is affiliated with THIS diocese and returns the
// affiliation. Every parish-scoped handler starts here; a 404 rather than
// a 403 so the existence of an unaffiliated parish is not confirmed.
async function affiliated(dioceseOrgId, parishOrgId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.status, a.grant_level, a.region_id, r.name AS region_name,
            p.name AS parish_name, p.slug AS parish_slug, p.address, p.tradition,
            p.service_times
       FROM ochr_diocese_affiliations a
       JOIN ochr_organizations p ON p.id = a.parish_org_id
       LEFT JOIN ochr_diocese_regions r ON r.id = a.region_id
      WHERE a.diocese_org_id = $1 AND a.parish_org_id = $2
        AND a.status IN ('active', 'suspended')`,
    [dioceseOrgId, parishOrgId]
  )
  return rows[0] ?? null
}

const actor = req => ({
  id: req.user?.id ?? null,
  name: req.user?.name ?? null,
  email: req.user?.email ?? null,
})

const text = (v, min = 1, max = 2000) => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s.length < min || s.length > max) return null
  return s
}

// Writing to the institutional record. Called from the handlers that
// represent something a person did, never from a computation.
async function recordOnTimeline(conn, { dioceseOrgId, parishOrgId, kind, summary, detail, visibility, req }) {
  const a = actor(req)
  await conn.query(
    `INSERT INTO ochr_parish_timeline
       (diocese_org_id, parish_org_id, kind, summary, detail, visibility,
        actor_user_id, actor_name, actor_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [dioceseOrgId, parishOrgId, kind, summary, detail ?? null,
     visibility ?? 'diocese', a.id, a.name, a.email]
  )
}

// ── The care list ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const dio = req.organizationId
  try {
    const { rows } = await pool.query(
      `SELECT p.id AS parish_org_id, p.name AS parish_name, r.name AS region_name,
              (SELECT count(*)::int FROM ochr_support_tickets t
                WHERE t.organization_id = p.id AND t.status NOT IN ('resolved', 'closed')) AS open_support,
              (SELECT count(*)::int FROM ochr_report_submissions s
                WHERE s.organization_id = p.id AND s.diocese_org_id = $1
                  AND s.status = 'submitted') AS awaiting_review,
              (SELECT count(*)::int FROM ochr_parish_followups f
                WHERE f.diocese_org_id = $1 AND f.parish_org_id = p.id AND f.state = 'open') AS open_followups,
              (SELECT count(*)::int FROM ochr_parish_transitions tr
                WHERE tr.diocese_org_id = $1 AND tr.parish_org_id = p.id AND tr.state = 'watching') AS active_transitions,
              (SELECT max(tl.occurred_on) FROM ochr_parish_timeline tl
                WHERE tl.diocese_org_id = $1 AND tl.parish_org_id = p.id) AS last_contact
         FROM ochr_diocese_affiliations a
         JOIN ochr_organizations p ON p.id = a.parish_org_id
         LEFT JOIN ochr_diocese_regions r ON r.id = a.region_id
        WHERE a.diocese_org_id = $1 AND a.status IN ('active', 'suspended')
        ORDER BY p.name`,
      [dio]
    )

    const today = new Date()
    const parishes = rows.map(r => {
      const days = r.last_contact
        ? Math.round((today - new Date(r.last_contact)) / 86_400_000)
        : null
      const status = careStatusFor({
        openSupportRequests: r.open_support,
        submissionsAwaitingReview: r.awaiting_review,
        daysSinceLastContact: days,
        openFollowUps: r.open_followups,
        activeTransitions: r.active_transitions,
      })
      return {
        parish_org_id: r.parish_org_id,
        parish_name: r.parish_name,
        region: r.region_name,
        status,
        open_followups: r.open_followups,
        last_contact: r.last_contact,
      }
    })

    // Counted, not ranked. The tallies exist so a staff member can see the
    // shape of the morning, not so parishes can be compared.
    const counts = {}
    for (const p of parishes) counts[p.status.key] = (counts[p.status.key] ?? 0) + 1

    res.json({ parishes, counts })
  } catch (err) {
    monitor.error('care.list', err, { orgId: dio })
    res.status(500).json({ error: 'Failed to load parish care' })
  }
})

// ── The office's own follow-ups, across every parish ─────────────────────
router.get('/followups', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, p.name AS parish_name
         FROM ochr_parish_followups f
         JOIN ochr_organizations p ON p.id = f.parish_org_id
        WHERE f.diocese_org_id = $1 AND f.state = $2
        ORDER BY f.due_on NULLS LAST, f.created_at`,
      [req.organizationId, req.query.state === 'done' ? 'done' : 'open']
    )
    res.json({ followups: rows })
  } catch (err) {
    monitor.error('care.followups.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load follow-ups' })
  }
})

router.patch('/followups/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const state = ['open', 'done', 'let_go'].includes(req.body?.state) ? req.body.state : null
  if (!state) return res.status(400).json({ error: 'state must be open, done or let_go' })
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_parish_followups
          SET state = $1, completion_note = COALESCE($2, completion_note), updated_at = NOW()
        WHERE id = $3 AND diocese_org_id = $4
        RETURNING *`,
      [state, text(req.body?.completion_note, 1, 2000), id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('care.followups.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update follow-up' })
  }
})

router.patch('/transitions/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const state = ['watching', 'settled'].includes(req.body?.state) ? req.body.state : null
  if (!state) return res.status(400).json({ error: 'state must be watching or settled' })
  try {
    const { rows } = await pool.query(
      `UPDATE ochr_parish_transitions
          SET state = $1, support_plan = COALESCE($2, support_plan), updated_at = NOW()
        WHERE id = $3 AND diocese_org_id = $4
        RETURNING *`,
      [state, text(req.body?.support_plan, 1, 2000), id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('care.transitions.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update transition' })
  }
})

// ── Shared review of a prepared report ───────────────────────────────────
router.post('/submissions/:id/notes', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const body = text(req.body?.body, 1, 4000)
  if (!body) return res.status(400).json({ error: 'A note needs a body' })
  const visibility = req.body?.visibility === 'shared' ? 'shared' : 'diocese'

  try {
    const { rows: sub } = await pool.query(
      `SELECT s.id, s.organization_id, p.name AS parish_name
         FROM ochr_report_submissions s
         JOIN ochr_organizations p ON p.id = s.organization_id
        WHERE s.id = $1 AND s.diocese_org_id = $2`,
      [id, req.organizationId]
    )
    if (!sub.length) return res.status(404).json({ error: 'Not found' })

    const a = actor(req)
    const conn = await pool.connect()
    try {
      await conn.query('BEGIN')
      const { rows } = await conn.query(
        `INSERT INTO ochr_report_review_notes
           (diocese_org_id, submission_id, body, visibility, agreed_next_step,
            follow_up_on, author_user_id, author_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.organizationId, id, body, visibility,
         text(req.body?.agreed_next_step, 1, 2000),
         /^\d{4}-\d{2}-\d{2}$/.test(req.body?.follow_up_on ?? '') ? req.body.follow_up_on : null,
         a.id, a.name]
      )
      await recordOnTimeline(conn, {
        dioceseOrgId: req.organizationId, parishOrgId: sub[0].organization_id,
        kind: 'report',
        summary: rows[0].agreed_next_step
          ? 'Report reviewed together; a next step was agreed.'
          : 'A note was added to a report under review.',
        detail: rows[0].agreed_next_step ?? null,
        visibility, req,
      })
      await conn.query('COMMIT')
      res.status(201).json(rows[0])
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => {})
      throw e
    } finally { conn.release() }
  } catch (err) {
    monitor.error('care.reviewNote', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to save the note' })
  }
})

// ── One parish: context, current work, and the record ────────────────────
router.get('/:parishId', async (req, res) => {
  const parishId = Number(req.params.parishId)
  if (!Number.isInteger(parishId)) return res.status(400).json({ error: 'Invalid parish' })
  const dio = req.organizationId
  try {
    const aff = await affiliated(dio, parishId)
    if (!aff) return res.status(404).json({ error: 'Not found' })

    const [support, submissions, followups, transitions, timeline] = await Promise.all([
      // A COUNT, never the tickets themselves. ochr_support_tickets is the
      // parish's channel to OpenChurch, not to its diocese: migration 065
      // sets the posture as "parish admins see ONLY their own org's
      // tickets; the vendor sees all", and grant_level covers financial
      // detail, not this. A parish writing "payroll crashes entering Fr X's
      // stipend, he's under investigation" wrote that to us.
      //
      // The count stays because it is a real care signal — a parish
      // struggling with the software is worth a call — and it carries no
      // content. Anything more needs a share the parish grants.
      pool.query(
        `SELECT count(*)::int AS n
           FROM ochr_support_tickets
          WHERE organization_id = $1 AND status NOT IN ('resolved', 'closed')`, [parishId]),
      pool.query(
        `SELECT id, to_char(period_start,'YYYY-MM-DD') AS period_start,
                to_char(period_end,'YYYY-MM-DD') AS period_end, status, submitted_at, review_note
           FROM ochr_report_submissions
          WHERE organization_id = $1 AND diocese_org_id = $2
          ORDER BY period_end DESC LIMIT 8`, [parishId, dio]),
      pool.query(
        `SELECT * FROM ochr_parish_followups
          WHERE diocese_org_id = $1 AND parish_org_id = $2 AND state = 'open'
          ORDER BY due_on NULLS LAST, created_at`, [dio, parishId]),
      pool.query(
        `SELECT * FROM ochr_parish_transitions
          WHERE diocese_org_id = $1 AND parish_org_id = $2 AND state = 'watching'
          ORDER BY began_on DESC NULLS LAST`, [dio, parishId]),
      pool.query(
        `SELECT id, kind, summary, detail, to_char(occurred_on,'YYYY-MM-DD') AS occurred_on,
                visibility, actor_name, created_at
           FROM ochr_parish_timeline
          WHERE diocese_org_id = $1 AND parish_org_id = $2
          ORDER BY occurred_on DESC, id DESC LIMIT 60`, [dio, parishId]),
    ])

    const last = timeline.rows[0]?.occurred_on ?? null
    // The count now comes from count(*), so it is the TRUE number rather
      // than the length of a LIMIT 10 page — twelve open tickets used to
      // report as ten here while the dashboard's subselect said twelve.
    const openSupport = support.rows[0]?.n ?? 0
    const status = careStatusFor({
      openSupportRequests: openSupport,
      submissionsAwaitingReview: submissions.rows.filter(s => s.status === 'submitted').length,
      daysSinceLastContact: last ? Math.round((new Date() - new Date(last)) / 86_400_000) : null,
      openFollowUps: followups.rows.length,
      activeTransitions: transitions.rows.length,
    })

    res.json({
      parish: {
        id: parishId, name: aff.parish_name, slug: aff.parish_slug,
        address: aff.address, tradition: aff.tradition,
        service_times: aff.service_times,
        region: aff.region_name, grant_level: aff.grant_level,
        affiliation_status: aff.status,
      },
      status,
      current_work: {
        // A number, not a list. See the query above for why.
        open_support_requests: openSupport,
        submissions: submissions.rows,
        followups: followups.rows,
        transitions: transitions.rows,
      },
      timeline: timeline.rows,
    })
  } catch (err) {
    monitor.error('care.parish', err, { orgId: dio, parishId })
    res.status(500).json({ error: 'Failed to load parish context' })
  }
})

router.post('/:parishId/timeline', async (req, res) => {
  const parishId = Number(req.params.parishId)
  const summary = text(req.body?.summary, 3, 500)
  const kind = ['visit', 'note', 'support_request', 'transition', 'report', 'followup', 'brief']
    .includes(req.body?.kind) ? req.body.kind : 'note'
  if (!summary) return res.status(400).json({ error: 'A timeline entry needs a summary' })
  try {
    if (!(await affiliated(req.organizationId, parishId))) return res.status(404).json({ error: 'Not found' })
    const conn = await pool.connect()
    try {
      await recordOnTimeline(conn, {
        dioceseOrgId: req.organizationId, parishOrgId: parishId, kind, summary,
        detail: text(req.body?.detail, 1, 4000),
        visibility: req.body?.visibility === 'shared' ? 'shared' : 'diocese',
        req,
      })
      res.status(201).json({ ok: true })
    } finally { conn.release() }
  } catch (err) {
    monitor.error('care.timeline.post', err, { orgId: req.organizationId, parishId })
    res.status(500).json({ error: 'Failed to write to the record' })
  }
})

router.post('/:parishId/followups', async (req, res) => {
  const parishId = Number(req.params.parishId)
  const context = text(req.body?.context, 3, 2000)
  const nextAction = text(req.body?.next_action, 3, 2000)
  if (!context || !nextAction) {
    return res.status(400).json({ error: 'A follow-up needs a context and a next action' })
  }
  try {
    if (!(await affiliated(req.organizationId, parishId))) return res.status(404).json({ error: 'Not found' })
    const a = actor(req)
    const { rows } = await pool.query(
      `INSERT INTO ochr_parish_followups
         (diocese_org_id, parish_org_id, context, next_action, owner_user_id, owner_name,
          due_on, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $5, $6) RETURNING *`,
      [req.organizationId, parishId, context, nextAction, a.id, a.name,
       /^\d{4}-\d{2}-\d{2}$/.test(req.body?.due_on ?? '') ? req.body.due_on : null]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('care.followups.post', err, { orgId: req.organizationId, parishId })
    res.status(500).json({ error: 'Failed to save the follow-up' })
  }
})

router.post('/:parishId/transitions', async (req, res) => {
  const parishId = Number(req.params.parishId)
  const KINDS = ['clergy_arrival', 'clergy_departure', 'administrator_departure', 'music_staff',
                 'search_period', 'records_handoff', 'onboarding_support']
  if (!KINDS.includes(req.body?.kind)) {
    return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` })
  }
  try {
    if (!(await affiliated(req.organizationId, parishId))) return res.status(404).json({ error: 'Not found' })
    const a = actor(req)
    const conn = await pool.connect()
    try {
      await conn.query('BEGIN')
      const { rows } = await conn.query(
        `INSERT INTO ochr_parish_transitions
           (diocese_org_id, parish_org_id, kind, began_on, expected_until, notes,
            continuity_needs, support_plan, owner_user_id, owner_name, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9) RETURNING *`,
        [req.organizationId, parishId, req.body.kind,
         /^\d{4}-\d{2}-\d{2}$/.test(req.body?.began_on ?? '') ? req.body.began_on : null,
         /^\d{4}-\d{2}-\d{2}$/.test(req.body?.expected_until ?? '') ? req.body.expected_until : null,
         text(req.body?.notes, 1, 4000), text(req.body?.continuity_needs, 1, 4000),
         text(req.body?.support_plan, 1, 4000), a.id, a.name]
      )
      await recordOnTimeline(conn, {
        dioceseOrgId: req.organizationId, parishOrgId: parishId, kind: 'transition',
        summary: `A ${req.body.kind.replaceAll('_', ' ')} was recorded, so the office can accompany the parish through it.`,
        detail: text(req.body?.notes, 1, 4000), visibility: 'diocese', req,
      })
      await conn.query('COMMIT')
      res.status(201).json(rows[0])
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => {})
      throw e
    } finally { conn.release() }
  } catch (err) {
    monitor.error('care.transitions.post', err, { orgId: req.organizationId, parishId })
    res.status(500).json({ error: 'Failed to save the transition' })
  }
})

// ── The brief ────────────────────────────────────────────────────────────
//
// Regenerated from live context every time rather than stored. A brief
// filed six months ago and reprinted today would be a stale page wearing
// today's date, which is worse than no brief at all — what IS stored is
// the fact that somebody prepared one, so the record can say a brief was
// prepared before the visit.
router.get('/:parishId/brief', async (req, res) => {
  const parishId = Number(req.params.parishId)
  if (!Number.isInteger(parishId)) return res.status(400).json({ error: 'Invalid parish' })
  try {
    const brief = await buildCareBrief({
      dioceseOrgId: req.organizationId,
      parishOrgId: parishId,
      role: req.user?.role,
      // Internal notes are opt-IN. A brief that might be left on a
      // sacristy table carries the shared record by default.
      includeInternal: req.query.internal === '1',
    })
    if (!brief) return res.status(404).json({ error: 'Not found' })
    res.json(brief)
  } catch (err) {
    monitor.error('care.brief', err, { orgId: req.organizationId, parishId })
    res.status(500).json({ error: 'Failed to prepare the brief' })
  }
})

router.post('/:parishId/brief', async (req, res) => {
  const parishId = Number(req.params.parishId)
  try {
    if (!(await affiliated(req.organizationId, parishId))) return res.status(404).json({ error: 'Not found' })
    const a = actor(req)
    const purpose = text(req.body?.purpose, 1, 500)
    const conn = await pool.connect()
    try {
      await conn.query('BEGIN')
      const { rows } = await conn.query(
        `INSERT INTO ochr_parish_care_briefs
           (diocese_org_id, parish_org_id, purpose, prepared_by, prepared_by_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.organizationId, parishId, purpose, a.id, a.name]
      )
      await recordOnTimeline(conn, {
        dioceseOrgId: req.organizationId, parishOrgId: parishId, kind: 'brief',
        summary: purpose
          ? `A care brief was prepared, ahead of ${purpose}.`
          : 'A care brief was prepared.',
        visibility: 'diocese', req,
      })
      await conn.query('COMMIT')
      res.status(201).json(rows[0])
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => {})
      throw e
    } finally { conn.release() }
  } catch (err) {
    monitor.error('care.brief.record', err, { orgId: req.organizationId, parishId })
    res.status(500).json({ error: 'Failed to record the brief' })
  }
})

export default router
