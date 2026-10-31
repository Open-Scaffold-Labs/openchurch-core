import { Router } from 'express'
import { createRequire } from 'node:module'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { publicScheduleLimiter } from '../middleware/rateLimit.js'

const require = createRequire(import.meta.url)
const {
  CALENDAR_MODES,
  SCHEDULE_SKILL_SPEC,
  SCHEDULE_ACTION_TOOLS,
  evaluateModeCFacilityOrTeeBooking,
  generateTenantIcsFeed,
  buildDayViewResourceGrid,
  buildWeekListMobileViewModel,
  buildMonthViewSummaryGrid,
  matchWaitlistForCanceledSlot,
} = require('../lib/openscaffold-schedule/index.js')

const router = Router()
export const publicScheduleRouter = Router()

// TARS S398-SCHED-01/02 hardening of the public surface added in 409159d.
// No product caller uses these public routes yet (no client references), so
// they stay public as a read-only/evaluation surface, but bounded: small
// bodies, capped arrays, and no tool that claims to write anything.
// Moving the POSTs behind requireAuth is the follow-up if a caller appears.
const PUBLIC_ARRAY_CAP = 200
const IMPLEMENTED_MCP_TOOLS = new Set(['schedule.check_availability', 'schedule.fill_waitlist'])
const PUBLIC_MCP_TOOLS = SCHEDULE_ACTION_TOOLS.map(t => (IMPLEMENTED_MCP_TOOLS.has(t.name)
  ? { ...t, available: true }
  : { ...t, available: false, status: 'not_implemented' }))

function publicBodyBounds(req, res, next) {
  // Byte limit is enforced at the parser in app.js (R401-1); this checks array caps.
  const b = req.body || {}
  const input = (b && typeof b.input === 'object' && b.input) || {}
  for (const [src, key] of [[b, 'existing_bookings'], [b, 'assignments'], [b, 'required_roles'],
    [input, 'existing_bookings'], [input, 'bookings'], [input, 'waitlist_entries']]) {
    if (Array.isArray(src[key]) && src[key].length > PUBLIC_ARRAY_CAP) {
      return res.status(400).json({ error: `${key} exceeds ${PUBLIC_ARRAY_CAP} items` })
    }
  }
  next()
}

const DAY_ORDER = `CASE day_of_week
  WHEN 'Sunday'    THEN 0 WHEN 'Monday'   THEN 1 WHEN 'Tuesday' THEN 2
  WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday'  THEN 5
  WHEN 'Saturday'  THEN 6 ELSE 7 END`

// Static SAMPLE RFC 5545 feed (not tokenized, not parish data). The org
// label is fixed; query parameters are ignored so callers cannot inject
// a parish name into a calendar that looks official.
const SAMPLE_ICS = generateTenantIcsFeed({
  orgId: 'sample',
  calendarName: 'OpenChurch sample schedule (static demo, not parish data)',
  bookings: [
    {
      id: 'oc-sample-sunday-service',
      client_name: 'Sample',
      service_name: 'Sample: Sunday Morning Worship',
      starts_at: '2026-10-25T16:00:00.000Z',
      ends_at: '2026-10-25T17:30:00.000Z',
      status: 'tentative',
    },
    {
      id: 'oc-sample-fellowship-dinner',
      client_name: 'Sample',
      service_name: 'Sample: Wednesday Fellowship Hall Dinner',
      starts_at: '2026-10-28T00:30:00.000Z',
      ends_at: '2026-10-28T02:30:00.000Z',
      status: 'tentative',
    },
  ],
})
publicScheduleRouter.get('/feed.ics', (_req, res) => {
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.setHeader('X-OpenChurch-Sample', 'true')
  res.send(SAMPLE_ICS.ics_body)
})

// GET /api/schedule/mode — @openscaffold/schedule v0.1.0 configuration for OpenChurch
publicScheduleRouter.get('/mode', (_req, res) => {
  res.json({
    vertical: 'open-church',
    primary_mode: CALENDAR_MODES.MODE_C_EVENT_FACILITY_TEE,
    secondary_mode: CALENDAR_MODES.MODE_D_SHIFT_ROSTER,
    supported_facility_zones: [
      'sanctuary',
      'fellowship_hall',
      'classroom_wing',
      'youth_room',
      'av_sound_booth',
    ],
    catering_integration: '@openscaffold/catering v0.1.0 (Fellowship Dinners & Parish Banquets)',
    skill: SCHEDULE_SKILL_SPEC,
    mcp_tools: PUBLIC_MCP_TOOLS,
  })
})

// POST /api/schedule/facility-hold — MODE_C_EVENT_FACILITY_TEE evaluation + @openscaffold/catering fellowship dinner link
publicScheduleRouter.post('/facility-hold', publicScheduleLimiter, publicBodyBounds, (req, res) => {
  const b = req.body || {}
  const evaluation = evaluateModeCFacilityOrTeeBooking({
    orgId: String(req.organizationId || b.org_id || 'org_church_1'),
    verticalKey: 'open-church',
    bookingSubtype: b.booking_subtype || 'facility_room_hold',
    candidateStartIso: b.starts_at || '2026-10-28T18:00:00.000Z',
    candidateEndIso: b.ends_at || '2026-10-28T20:00:00.000Z',
    partySize: Number(b.expected_attendance || b.party_size || 60),
    existingBookings: Array.isArray(b.existing_bookings) ? b.existing_bookings : [],
  })

  const includesFellowshipDinner = Boolean(b.includes_fellowship_dinner || Number(b.catering_headcount || 0) > 0)
  const cateringHandoff = includesFellowshipDinner
    ? {
        module: '@openscaffold/catering',
        version: '0.1.0',
        fellowship_dinner_linked: true,
        facility_zone: b.facility_zone || 'fellowship_hall',
        estimated_guests: Number(b.catering_headcount || b.expected_attendance || 60),
        dietary_matrix_enabled: true,
        kitchen_prep_lead_minutes: 90,
      }
    : null

  res.json({
    mode: CALENDAR_MODES.MODE_C_EVENT_FACILITY_TEE,
    facility_zone: b.facility_zone || 'sanctuary',
    av_hold_required: Boolean(b.av_hold_required ?? true),
    evaluation,
    catering_handoff: cateringHandoff,
  })
})

// POST /api/schedule/volunteer-roster — MODE_D_SHIFT_ROSTER volunteer rotation & ministry team check
publicScheduleRouter.post('/volunteer-roster', publicScheduleLimiter, publicBodyBounds, (req, res) => {
  const b = req.body || {}
  const assignments = Array.isArray(b.assignments) ? b.assignments : []
  const requiredRoles = Array.isArray(b.required_roles)
    ? b.required_roles
    : ['worship_leader', 'av_tech', 'usher_greeter', 'nursery_lead']
  const assignedRoles = new Set(assignments.map(a => a.role))
  const missingRoles = requiredRoles.filter(r => !assignedRoles.has(r))

  res.json({
    mode: CALENDAR_MODES.MODE_D_SHIFT_ROSTER,
    service_title: b.service_title || 'Sunday Morning Worship',
    starts_at: b.starts_at || '2026-10-25T16:00:00.000Z',
    total_volunteers_assigned: assignments.length,
    roster_complete: missingRoles.length === 0,
    missing_roles: missingRoles,
    assignments,
  })
})

// GET /api/schedule/mcp & POST /api/schedule/mcp — STD-21 MCP scheduling tools for OpenChurch
publicScheduleRouter.get('/mcp', (_req, res) => {
  res.json({
    protocol: 'STD-14 / STD-21 Two-Door MCP',
    vertical: 'open-church',
    modes: [CALENDAR_MODES.MODE_C_EVENT_FACILITY_TEE, CALENDAR_MODES.MODE_D_SHIFT_ROSTER],
    skill: SCHEDULE_SKILL_SPEC,
    tools: PUBLIC_MCP_TOOLS,
  })
})

publicScheduleRouter.post('/mcp', publicScheduleLimiter, publicBodyBounds, (req, res) => {
  const { tool, input = {} } = req.body || {}
  if (!tool) return res.status(400).json({ error: 'tool name is required' })

  if (tool === 'schedule.check_availability') {
    const evalResult = evaluateModeCFacilityOrTeeBooking({
      orgId: String(req.organizationId || 'org_church_1'),
      verticalKey: 'open-church',
      bookingSubtype: input.booking_subtype || 'facility_room_hold',
      candidateStartIso: input.starts_at || '2026-10-28T18:00:00.000Z',
      candidateEndIso: input.ends_at || '2026-10-28T20:00:00.000Z',
      partySize: Number(input.party_size || 50),
      existingBookings: Array.isArray(input.existing_bookings) ? input.existing_bookings : [],
    })
    return res.json({
      ok: true,
      tool,
      mode: CALENDAR_MODES.MODE_C_EVENT_FACILITY_TEE,
      facility_zone: input.facility_zone || 'fellowship_hall',
      availability: evalResult,
    })
  }

  if (tool === 'schedule.fill_waitlist') {
    const winner = matchWaitlistForCanceledSlot(
      Array.isArray(input.waitlist_entries) ? input.waitlist_entries : [],
      input.canceled_slot || {
        org_id: String(req.organizationId || 'org_church_1'),
        resource_id: 'fellowship_hall',
        starts_at: '2026-10-28T18:00:00.000Z',
        ends_at: '2026-10-28T20:00:00.000Z',
      }
    )
    return res.json({ ok: true, tool, waitlist_winner: winner })
  }

  // S398-SCHED-01: anything that sounds mutating (book/create/move/cascade)
  // has no persistence behind it, so never answer 'confirmed'.
  if (SCHEDULE_ACTION_TOOLS.some(t => t.name === tool)) {
    return res.status(501).json({ ok: false, tool, status: 'not_implemented', error: `${tool} is not available` })
  }
  return res.status(404).json({ error: `Unknown MCP tool: ${tool}` })
})

// GET /api/schedule?search=
router.get('/', async (req, res) => {
  try {
    const { search } = req.query
    const { rows } = search
      ? await pool.query(
          `SELECT * FROM ochr_schedule
           WHERE organization_id = $1
             AND (title ILIKE $2 OR service_type ILIKE $2 OR location ILIKE $2 OR day_of_week ILIKE $2)
           ORDER BY ${DAY_ORDER}, start_time`,
          [req.organizationId, `%${search}%`]
        )
      : await pool.query(
          `SELECT * FROM ochr_schedule WHERE organization_id = $1 ORDER BY ${DAY_ORDER}, start_time`,
          [req.organizationId]
        )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load schedule' })
  }
})

// POST /api/schedule
router.post('/', async (req, res) => {
  try {
    const { title, service_type, day_of_week, start_time, end_time, recurrence, specific_date, location, notes } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
    const { rows } = await pool.query(
      `INSERT INTO ochr_schedule (organization_id, title, service_type, day_of_week, start_time, end_time, recurrence, specific_date, location, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.organizationId, title, service_type, day_of_week, start_time || null, end_time || null, recurrence, specific_date || null, location, notes]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create schedule entry' })
  }
})

// PATCH /api/schedule/:id
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    // Partial-update semantics (audit H1): only fields present in the
    // body are written. Allowlist is hardcoded — nothing from the
    // request reaches the SQL text.
    const PATCHABLE = ['title', 'service_type', 'day_of_week', 'start_time', 'end_time', 'recurrence', 'specific_date', 'location', 'notes']
    const sets = []
    const vals = []
    for (const col of PATCHABLE) {
      if (req.body[col] !== undefined) {
        vals.push(req.body[col] === '' ? null : req.body[col])
        sets.push(`${col} = $${vals.length}`)
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' })

    const { rows } = await pool.query(
      `UPDATE ochr_schedule SET ${sets.join(', ')}
        WHERE id = $${vals.length + 1} AND organization_id = $${vals.length + 2} RETURNING *`,
      [...vals, id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update schedule entry' })
  }
})

// DELETE /api/schedule/:id
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await pool.query(
      'DELETE FROM ochr_schedule WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete schedule entry' })
  }
})

export default router
