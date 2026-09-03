// Attendance endpoints (Sprint T). Mounted under
// /api/events/:eventId/attendance via merged params so the event-
// scope check happens once for both GET and POST.
//
//   GET  /api/events/:id/attendance       → roster + marks
//   POST /api/events/:id/attendance       → bulk-set marks for the event
//
// Tenant scoping: the event must belong to req.organizationId or the
// request 404s — never 403 — because we don't want to leak that
// other-org events exist.
//
// Bulk POST shape:
//   { marks: [{ member_id, status }, ...] }
//
// Each mark is UPSERTed on (event_id, member_id) so flipping a row's
// status is one round-trip. Members not in the payload are
// untouched.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'

const router = Router({ mergeParams: true })

const VALID_STATUSES = new Set(['present', 'absent', 'excused'])

// Validate the event belongs to the caller's org. Returns the row on
// success or null otherwise (caller 404s).
async function eventForOrg(eventId, organizationId) {
  const { rows } = await pool.query(
    'SELECT id FROM ochr_events WHERE id = $1 AND organization_id = $2',
    [eventId, organizationId]
  )
  return rows[0] ?? null
}

// GET /api/events/:id/attendance
// Returns the full roster of assigned members + their current
// attendance mark (or null when unmarked). Joined on
// ochr_event_members so we list every member who SHOULD have been
// there, not just ones already marked.
router.get('/', async (req, res) => {
  const eventId = requireIntParam(req, res); if (eventId === null) return
  try {
    const ev = await eventForOrg(eventId, req.organizationId)
    if (!ev) return res.status(404).json({ error: 'Event not found' })

    const { rows } = await pool.query(
      `SELECT em.member_id   AS member_id,
              c.name         AS member_name,
              c.email        AS member_email,
              a.status       AS status,
              a.marked_at    AS marked_at,
              a.marked_by    AS marked_by
         FROM ochr_event_members em
         JOIN ochr_clients c       ON c.id = em.member_id
    LEFT JOIN ochr_attendance a    ON a.event_id  = em.event_id
                                  AND a.member_id = em.member_id
        WHERE em.event_id = $1
     ORDER BY c.name ASC
       -- tenancy: joined through ochr_event_members, which this handler
       -- already constrained to an event owned by the caller's organization.`,
      [eventId]
    )

    // Roll up a small summary so the UI doesn't have to recompute
    // counts every render.
    const summary = { present: 0, absent: 0, excused: 0, unmarked: 0 }
    for (const r of rows) {
      if (r.status === 'present')  summary.present++
      else if (r.status === 'absent')   summary.absent++
      else if (r.status === 'excused')  summary.excused++
      else summary.unmarked++
    }

    res.set('Cache-Control', 'private, max-age=10')
    res.json({ event_id: eventId, roster: rows, summary })
  } catch (err) {
    console.error('attendance.get failed:', err)
    res.status(500).json({ error: 'Failed to load attendance' })
  }
})

// POST /api/events/:id/attendance
// Bulk-set marks for the event. UPSERTs on (event_id, member_id) so
// the client doesn't have to know which marks already exist.
router.post('/', async (req, res) => {
  const eventId = requireIntParam(req, res); if (eventId === null) return
  const marks = Array.isArray(req.body?.marks) ? req.body.marks : null
  if (!marks) return res.status(400).json({ error: 'marks array required' })

  try {
    const ev = await eventForOrg(eventId, req.organizationId)
    if (!ev) return res.status(404).json({ error: 'Event not found' })

    // Filter + validate. Skip silently rather than 400 on a single
    // bad mark — letting the rest of the bulk through is more useful
    // than failing the whole batch when one row is malformed.
    const cleanMarks = marks
      .filter(m => Number.isInteger(m?.member_id) && VALID_STATUSES.has(m?.status))

    if (cleanMarks.length === 0) {
      return res.status(400).json({ error: 'No valid marks in payload' })
    }

    // Sanity: every member_id must already be on the roster for this
    // event. Prevents a malicious client from marking attendance for
    // members of OTHER events / orgs.
    const ids = cleanMarks.map(m => m.member_id)
    const { rows: scopedRows } = await pool.query(
      `SELECT em.member_id FROM ochr_event_members em
        WHERE em.event_id = $1 AND em.member_id = ANY($2::int[])`,
      [eventId, ids]
    )
    const allowed = new Set(scopedRows.map(r => r.member_id))
    const inScope = cleanMarks.filter(m => allowed.has(m.member_id))

    if (inScope.length === 0) {
      return res.status(400).json({ error: 'No marks reference assigned members' })
    }

    // Bulk UPSERT in a single SQL — VALUES placeholder tuples. $1 = event_id,
    // $2 = organization_id (constant), then (member_id, status, marked_by) per
    // row. organization_id is stamped so the composite tenant FKs (migration
    // 044) hold; the event + members were already scoped to this org above.
    const valuesSql = inScope.map((_, i) => `($1, $2, $${i * 3 + 3}, $${i * 3 + 4}, $${i * 3 + 5})`).join(', ')
    const params = [eventId, req.organizationId]
    for (const m of inScope) {
      params.push(m.member_id, m.status, req.user?.id ?? null)
    }
    const { rows } = await pool.query(
      `INSERT INTO ochr_attendance (event_id, organization_id, member_id, status, marked_by)
       VALUES ${valuesSql}
       ON CONFLICT (event_id, member_id) DO UPDATE
         SET status    = EXCLUDED.status,
             marked_at = NOW(),
             marked_by = EXCLUDED.marked_by
       RETURNING member_id, status, marked_at, marked_by`,
      params
    )

    res.status(200).json({
      event_id: eventId,
      updated: rows.length,
      marks: rows,
    })
  } catch (err) {
    console.error('attendance.post failed:', err)
    res.status(500).json({ error: 'Failed to save attendance' })
  }
})

export default router
