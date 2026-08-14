import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'
import {
  syncEventReminders, syncSeriesReminders,
  cancelEventReminders, cancelSeriesReminders,
  notifyAssignmentAdded,
} from '../notifications/calendarReminders.js'
import { resolveLiturgicalContext, resolveLiturgicalBatch } from './liturgical.js'

const router = Router()

const MAX_RECURRENCE_COUNT = 26   // half a year of weekly occurrences
const ALLOWED_FREQ = new Set(['weekly'])

// Add N whole days to a YYYY-MM-DD string and return YYYY-MM-DD. Pure
// calendar-day math (UTC noon avoids any DST edge), used to compute a
// recurring occurrence's date so we can stamp its liturgical context.
function addDaysISO(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Coerce an incoming group_id into a clean int-or-null. '' (the
// modal's "No group" option) and undefined both mean "unset".
function normalizeGroupId(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// Tenant guard for group_id. A4.3 lets an event point at a group;
// since group_id isn't org-scoped at the FK level, verify the group
// belongs to the caller's org before we let it land — otherwise a
// crafted request could link an event to another church's group.
// Returns true for null (no group) so callers can guard unconditionally.
async function groupBelongsToOrg(groupId, orgId) {
  if (groupId === null) return true
  const { rows } = await pool.query(
    'SELECT 1 FROM ochr_groups WHERE id = $1 AND organization_id = $2',
    [groupId, orgId]
  )
  return rows.length > 0
}

// GET /api/calendar/conflicts
//   Pre-flight overlap check used by the modal as the admin types
//   date/time/assignees. Returns the events on the same date whose
//   time range overlaps and whose assigned_to roster shares at
//   least one member with the candidate event.
//
// Params:
//   date        — YYYY-MM-DD (required)
//   start_time  — HH:MM (required)
//   end_time    — HH:MM (required)
//   assigned_to — comma-separated member ids (required for any conflicts)
//   exclude_id  — when editing, the row's own id so it doesn't
//                 self-conflict
//
// Empty-arg cases all return { conflicts: [] } rather than 400 so
// the client doesn't need to gate the call on a fully-filled form.
router.get('/conflicts', async (req, res) => {
  const date       = req.query.date
  const startTime  = req.query.start_time
  const endTime    = req.query.end_time
  const assigned   = String(req.query.assigned_to || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0)
  const excludeId  = req.query.exclude_id ? Number(req.query.exclude_id) : null

  // 10s private cache. The conflict UI debounces on form input, so
  // a 10s window covers the typical "user typing then re-submitting
  // the same time slot" loop without dragging real conflicts behind
  // a stale cache. Short enough that admins editing assignments
  // see the new picture on next save.
  res.set('Cache-Control', 'private, max-age=10')

  if (!date || !startTime || !endTime || !assigned.length) {
    return res.json({ conflicts: [] })
  }

  try {
    // Same-org, same-date, time-overlap. Standard overlap test:
    // a.start < b.end AND a.end > b.start.
    const { rows: candidates } = await pool.query(
      `SELECT id, title, date, start_time, end_time, assigned_to
         FROM ochr_calendar_events
        WHERE organization_id = $1
          AND date = $2
          AND start_time < $3
          AND end_time   > $4
          AND ($5::int IS NULL OR id <> $5)`,
      [req.organizationId, date, endTime, startTime, excludeId]
    )

    // JSONB intersection in JS is simpler than a JSONB ?| operator
    // here because we also need the per-event intersection set for
    // the response.
    const targetSet = new Set(assigned)
    const conflicts = []
    for (const c of candidates) {
      const candidateAssigned = Array.isArray(c.assigned_to) ? c.assigned_to : []
      const intersecting = candidateAssigned.filter(id => targetSet.has(id))
      if (!intersecting.length) continue
      conflicts.push({
        id:         c.id,
        title:      c.title,
        date:       c.date,
        start_time: c.start_time,
        end_time:   c.end_time,
        conflicting_member_ids: intersecting,
      })
    }

    if (!conflicts.length) return res.json({ conflicts: [] })

    // Single member-name lookup for the union of all conflicting ids.
    const allIds = [...new Set(conflicts.flatMap(c => c.conflicting_member_ids))]
    const { rows: members } = await pool.query(
      'SELECT id, name FROM ochr_clients WHERE id = ANY($1::int[]) AND organization_id = $2',
      [allIds, req.organizationId]
    )
    const nameById = new Map(members.map(m => [m.id, m.name]))

    for (const c of conflicts) {
      c.conflicting_members = c.conflicting_member_ids.map(id => ({
        id,
        name: nameById.get(id) ?? `Member #${id}`,
      }))
      delete c.conflicting_member_ids
    }

    res.json({ conflicts })
  } catch (err) {
    monitor.error('calendar.conflicts', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to compute conflicts' })
  }
})

// GET /api/calendar/conflicts/scan?weeks=N
//
// Multi-week double-booking scanner (Anchor 3 / VS.3 — admin
// planner view). Walks every event in the next N weeks (default 4,
// max 26), joins each event against any later same-date sibling
// whose time range overlaps, and reports the pair if at least one
// assignee is on both rosters.
//
// Design choices:
//   - Pair each conflict ONCE: the self-join uses a.id < b.id so a
//     real two-event conflict yields a single row, not two.
//   - The JSONB-array intersection runs in JS — the SQL self-join
//     handles the cheap date+time filter, and the intersection is
//     small (few hundred candidate pairs at worst). Keeps the SQL
//     readable and avoids wedging jsonb_array_elements into a
//     JOIN ON clause.
//   - Member names are hydrated in a single follow-up SELECT, not
//     N+1 queries from the loop.
//   - Cache 30s: the schedule changes via admin writes which this
//     same response will read on next request; a short private
//     cache absorbs back-to-back tab clicks without going stale.
router.get('/conflicts/scan', async (req, res) => {
  const weeks = Math.min(Math.max(Number(req.query.weeks) || 4, 1), 26)

  res.set('Cache-Control', 'private, max-age=30')

  try {
    const { rows: pairs } = await pool.query(
      `SELECT a.id AS a_id, a.title AS a_title, a.date AS event_date,
              a.start_time AS a_start, a.end_time AS a_end, a.assigned_to AS a_assigned,
              b.id AS b_id, b.title AS b_title,
              b.start_time AS b_start, b.end_time AS b_end, b.assigned_to AS b_assigned
         FROM ochr_calendar_events a
         JOIN ochr_calendar_events b
           ON a.id < b.id
          AND a.date = b.date
          AND a.organization_id = b.organization_id
          AND a.start_time < b.end_time
          AND b.start_time < a.end_time
        WHERE a.organization_id = $1
          AND a.date >= CURRENT_DATE
          AND a.date <  CURRENT_DATE + ($2::int * INTERVAL '1 week')
          AND jsonb_array_length(a.assigned_to) > 0
          AND jsonb_array_length(b.assigned_to) > 0
        ORDER BY a.date ASC, a.start_time ASC`,
      [req.organizationId, weeks]
    )

    const conflicts = []
    const memberIdSet = new Set()
    for (const p of pairs) {
      const aA = Array.isArray(p.a_assigned) ? p.a_assigned : []
      const bA = Array.isArray(p.b_assigned) ? p.b_assigned : []
      const inter = aA.filter(id => bA.includes(id))
      if (inter.length === 0) continue
      conflicts.push({
        date: p.event_date,
        events: [
          { id: p.a_id, title: p.a_title, start_time: p.a_start, end_time: p.a_end },
          { id: p.b_id, title: p.b_title, start_time: p.b_start, end_time: p.b_end },
        ],
        _member_ids: inter,
      })
      inter.forEach(id => memberIdSet.add(id))
    }

    // Hydrate names — one round-trip, tenant-scoped.
    let nameMap = new Map()
    if (memberIdSet.size > 0) {
      const { rows: members } = await pool.query(
        `SELECT id, name FROM ochr_clients
          WHERE id = ANY($1::int[]) AND organization_id = $2`,
        [Array.from(memberIdSet), req.organizationId]
      )
      nameMap = new Map(members.map(m => [m.id, m.name]))
    }
    for (const c of conflicts) {
      c.members = c._member_ids.map(id => ({ id, name: nameMap.get(id) ?? 'Unknown' }))
      delete c._member_ids
    }

    const today = new Date()
    const end   = new Date(today)
    end.setDate(end.getDate() + weeks * 7)

    res.json({
      weeks_scanned: weeks,
      scanned_from:  today.toISOString().slice(0, 10),
      scanned_to:    end.toISOString().slice(0, 10),
      conflicts,
    })
  } catch (err) {
    monitor.error('calendar.conflictsScan', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to scan conflicts' })
  }
})

// GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/', async (req, res) => {
  try {
    const { start, end } = req.query
    const { rows } = start && end
      ? await pool.query(
          `SELECT * FROM ochr_calendar_events
           WHERE organization_id = $1 AND date >= $2 AND date <= $3
           ORDER BY date, start_time`,
          [req.organizationId, start, end]
        )
      : await pool.query(
          `SELECT * FROM ochr_calendar_events WHERE organization_id = $1 ORDER BY date, start_time`,
          [req.organizationId]
        )
    res.json(rows)
  } catch (err) {
    monitor.error('calendar.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load events' })
  }
})

// POST /api/calendar
//   { title, date, start_time, end_time, type, assigned_to,
//     recurrence?: { freq: 'weekly', interval: 1..N, count: 1..26 } }
//
// When recurrence is provided, transactionally insert N occurrences
// at interval-week strides from the seed date. The first row's id
// stamps every row's recurrence_parent_id (including its own) so
// "delete the whole series" is one WHERE clause.
router.post('/', async (req, res) => {
  const { title, date, start_time, end_time, type, assigned_to, recurrence, group_id } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
  if (!date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Date, start time, and end time are required' })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' })
  }

  const groupId = normalizeGroupId(group_id)
  if (!(await groupBelongsToOrg(groupId, req.organizationId))) {
    return res.status(400).json({ error: 'Invalid group_id' })
  }

  // Validate the recurrence shape before opening a transaction.
  let count = 1, intervalWeeks = 1
  if (recurrence) {
    const { freq, interval, count: c } = recurrence
    if (!ALLOWED_FREQ.has(freq)) {
      return res.status(400).json({ error: `Invalid recurrence.freq (allowed: ${[...ALLOWED_FREQ].join(', ')})` })
    }
    intervalWeeks = Number(interval ?? 1)
    if (!Number.isInteger(intervalWeeks) || intervalWeeks < 1 || intervalWeeks > 8) {
      return res.status(400).json({ error: 'recurrence.interval must be 1–8' })
    }
    count = Number(c ?? 1)
    if (!Number.isInteger(count) || count < 1 || count > MAX_RECURRENCE_COUNT) {
      return res.status(400).json({ error: `recurrence.count must be 1–${MAX_RECURRENCE_COUNT}` })
    }
  }

  // Single-row fast path — no transaction overhead for the common case.
  if (count === 1) {
    try {
      // Auto-map liturgical context (LIT.1) so the schedule row carries
      // its own season/color/feast for reminders, the public feed, and
      // check-in — not just the client-side render.
      const lit = await resolveLiturgicalContext(date, req.organizationId)
      const { rows } = await pool.query(
        `INSERT INTO ochr_calendar_events
           (organization_id, title, date, start_time, end_time, type, assigned_to, group_id,
            liturgical_season, liturgical_color, feast_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [req.organizationId, title, date, start_time, end_time, type || 'event', JSON.stringify(assigned_to || []), groupId,
         lit.season, lit.color, lit.feast_name]
      )
      await syncEventReminders(req.organizationId, rows[0].id)
      // Every assignee on a brand-new event is newly added.
      await notifyAssignmentAdded(req.organizationId, rows[0].id, assigned_to || [])
      return res.status(201).json(rows[0])
    } catch (err) {
      monitor.error('calendar.create', err, { orgId: req.organizationId })
      return res.status(500).json({ error: 'Failed to create event' })
    }
  }

  // Multi-occurrence series. Transactional so we never leave half a
  // series in the DB if any insert fails.
  //
  // Liturgical context (LIT.1) is computed per-occurrence — each date
  // gets its own season/color/feast — but resolved in a SINGLE batched
  // override lookup before the loop so a 26-week series doesn't pay
  // 26 sequential pooler round-trips.
  const occurrenceDates = Array.from({ length: count }, (_, i) => addDaysISO(date, i * intervalWeeks * 7))
  const litMap = await resolveLiturgicalBatch(occurrenceDates, req.organizationId)
  const litFor = (d) => litMap.get(d) ?? { season: null, color: null, feast_name: null }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Insert the seed first; capture its id so we can stamp every
    // subsequent occurrence (and the seed itself) with parent_id = seed.id.
    const seedLit = litFor(date)
    const seedRes = await client.query(
      `INSERT INTO ochr_calendar_events
         (organization_id, title, date, start_time, end_time, type, assigned_to, group_id,
          liturgical_season, liturgical_color, feast_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.organizationId, title, date, start_time, end_time, type || 'event', JSON.stringify(assigned_to || []), groupId,
       seedLit.season, seedLit.color, seedLit.feast_name]
    )
    const seed = seedRes.rows[0]
    await client.query(
      'UPDATE ochr_calendar_events SET recurrence_parent_id = $1 WHERE id = $1',
      [seed.id]
    )

    // Subsequent occurrences. Date arithmetic in SQL via INTERVAL so
    // we don't have to re-implement the calendar correctly in JS.
    for (let i = 1; i < count; i++) {
      const offsetDays = i * intervalWeeks * 7
      const occLit = litFor(occurrenceDates[i])
      await client.query(
        `INSERT INTO ochr_calendar_events
           (organization_id, title, date, start_time, end_time, type, assigned_to, recurrence_parent_id, group_id,
            liturgical_season, liturgical_color, feast_name)
         VALUES ($1, $2, ($3::date + ($4 || ' days')::interval)::date, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          req.organizationId, title, date, String(offsetDays),
          start_time, end_time, type || 'event',
          JSON.stringify(assigned_to || []),
          seed.id,
          groupId,
          occLit.season, occLit.color, occLit.feast_name,
        ]
      )
    }
    await client.query('COMMIT')

    // Return the seed with its parent_id reflected so the client
    // can display the recurring badge immediately.
    const finalRes = await pool.query(
      'SELECT * FROM ochr_calendar_events WHERE id = $1',
      [seed.id]
    )
    await syncSeriesReminders(req.organizationId, seed.id)
    // One "you've been added" notice per member for the series (via the
    // seed), not one per occurrence.
    await notifyAssignmentAdded(req.organizationId, seed.id, assigned_to || [])
    res.status(201).json(finalRes.rows[0])
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('calendar.create.series', err, { orgId: req.organizationId, count, intervalWeeks })
    res.status(500).json({ error: 'Failed to create recurring series' })
  } finally {
    client.release()
  }
})

// POST /api/calendar/auto-fill-rotation
//   { recurrence_parent_id, member_ids: [ordered] }
//
// Volunteer-scheduling depth, VS.1 — one-shot rotation auto-fill.
// Walks every FUTURE occurrence of a recurring series in date order
// and appends the next member from member_ids round-robin to each
// occurrence's assigned_to. Design choices:
//   - Future only. Back-filling a rotation onto dates that already
//     happened isn't useful, and would surprise the admin.
//   - Append, not replace. Existing assignees (other roles on the
//     same service) are kept; the rotation just adds one more name.
//   - Idempotent per member. If the rotation member is already on an
//     occurrence, it's left as-is and counted as skipped — re-running
//     the same fill doesn't double-add.
//   - member_ids is treated as an ORDERED set: order drives the
//     round-robin, duplicates are dropped.
router.post('/auto-fill-rotation', async (req, res) => {
  const parentId = Number(req.body?.recurrence_parent_id)
  if (!Number.isInteger(parentId) || parentId < 1) {
    return res.status(400).json({ error: 'recurrence_parent_id is required' })
  }
  // Normalize member_ids → ordered list of positive ints, dupes dropped.
  const seen = new Set()
  const memberIds = []
  for (const v of (Array.isArray(req.body?.member_ids) ? req.body.member_ids : [])) {
    const n = Number(v)
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); memberIds.push(n) }
  }
  if (memberIds.length === 0) {
    return res.status(400).json({ error: 'member_ids must list at least one member' })
  }

  const client = await pool.connect()
  try {
    // Tenant guard on the members — an admin must not be able to
    // rotation-assign another org's members by guessing ids. Keep
    // only the valid ones, preserving the caller's order.
    const { rows: validRows } = await client.query(
      'SELECT id FROM ochr_clients WHERE id = ANY($1::int[]) AND organization_id = $2',
      [memberIds, req.organizationId]
    )
    const validSet = new Set(validRows.map(m => m.id))
    const rotation = memberIds.filter(id => validSet.has(id))
    if (rotation.length === 0) {
      return res.status(400).json({ error: 'None of those members belong to your church' })
    }

    // Future occurrences of the series, in date order. The series is
    // keyed by recurrence_parent_id; organization_id is the tenant lock.
    const { rows: events } = await client.query(
      `SELECT id, assigned_to, to_char(date, 'YYYY-MM-DD') AS date_str
         FROM ochr_calendar_events
        WHERE recurrence_parent_id = $1
          AND organization_id = $2
          AND date >= CURRENT_DATE
        ORDER BY date ASC, start_time ASC`,
      [parentId, req.organizationId]
    )
    if (events.length === 0) {
      return res.status(404).json({ error: 'No upcoming occurrences found for this series' })
    }

    // VS.4a — pull the rotation members' blackout ranges overlapping the
    // series window in one query, then test membership in JS against the
    // 'YYYY-MM-DD' occurrence dates. ISO date strings compare correctly
    // with <=, so no Date/timezone math is needed.
    const minDate = events[0].date_str
    const maxDate = events[events.length - 1].date_str
    const { rows: blocks } = await client.query(
      `SELECT client_id,
              to_char(start_date, 'YYYY-MM-DD') AS s,
              to_char(end_date,   'YYYY-MM-DD') AS e
         FROM ochr_member_unavailability
        WHERE organization_id = $1
          AND client_id = ANY($2::int[])
          AND end_date   >= $3::date
          AND start_date <= $4::date`,
      [req.organizationId, rotation, minDate, maxDate]
    )
    const unavailByClient = new Map()
    for (const b of blocks) {
      if (!unavailByClient.has(b.client_id)) unavailByClient.set(b.client_id, [])
      unavailByClient.get(b.client_id).push({ s: b.s, e: b.e })
    }
    const isUnavailable = (cid, day) =>
      (unavailByClient.get(cid) || []).some(b => b.s <= day && day <= b.e)

    await client.query('BEGIN')
    let assigned = 0
    let skipped  = 0
    let unfilled = 0
    // NV.2 — track the first occurrence each newly-assigned member lands
    // on, so we send one "you've been added" notice per member (not one
    // per occurrence in the series).
    const firstAssignedFor = new Map()
    for (let i = 0; i < events.length; i++) {
      const ev      = events[i]
      const day     = ev.date_str
      const current = Array.isArray(ev.assigned_to) ? ev.assigned_to : []
      const intended = rotation[i % rotation.length]

      // Idempotent: the intended rotation member is already on this
      // occurrence — nothing to do.
      if (current.includes(intended)) { skipped++; continue }

      // Pick the first member, scanning from the intended slot in
      // rotation order, who is available that day and not already
      // assigned. Substitution keeps coverage when the intended person
      // is blacked out instead of leaving an empty slot.
      let chosen = null
      for (let k = 0; k < rotation.length; k++) {
        const cand = rotation[(i + k) % rotation.length]
        if (current.includes(cand)) continue
        if (isUnavailable(cand, day)) continue
        chosen = cand
        break
      }
      if (chosen === null) { unfilled++; continue }

      await client.query(
        'UPDATE ochr_calendar_events SET assigned_to = $1 WHERE id = $2 AND organization_id = $3',
        [JSON.stringify([...current, chosen]), ev.id, req.organizationId]
      )
      if (!firstAssignedFor.has(chosen)) firstAssignedFor.set(chosen, ev.id)
      assigned++
    }
    await client.query('COMMIT')

    // Rotation changed assignees on future occurrences — re-sync their
    // serving reminders.
    await syncSeriesReminders(req.organizationId, parentId)

    // NV.2 — one immediate "you've been added" notice per newly-assigned
    // member, referencing the first occurrence they serve.
    for (const [memberId, eventId] of firstAssignedFor) {
      await notifyAssignmentAdded(req.organizationId, eventId, [memberId])
    }

    res.json({ occurrences: events.length, assigned, skipped, unfilled })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('calendar.autoFillRotation', err, { orgId: req.organizationId, parentId })
    res.status(500).json({ error: 'Failed to auto-fill rotation' })
  } finally {
    client.release()
  }
})

// PATCH /api/calendar/:id
//   ?scope=following → propagate the edit to this row + every later
//                      sibling sharing the same parent_id (date >=
//                      target's date). Date is intentionally NOT
//                      propagated — fanning out a date change is
//                      ambiguous (do you shift everything by the
//                      offset?). Admins who want to move a whole
//                      series should delete + recreate.
//   default          → single-occurrence edit (existing behavior).
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const followingScope = req.query.scope === 'following'
  try {
    const { title, date, start_time, end_time, type, assigned_to, group_id } = req.body

    const groupId = normalizeGroupId(group_id)
    if (!(await groupBelongsToOrg(groupId, req.organizationId))) {
      return res.status(400).json({ error: 'Invalid group_id' })
    }

    if (followingScope) {
      // Resolve target's parent_id + date so we can build the
      // sibling-and-later WHERE clause. Same-tenant guard ensures
      // we never reach into another org's series even if the
      // request supplied a foreign id.
      const { rows: target } = await pool.query(
        'SELECT id, recurrence_parent_id, date, assigned_to FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
        [id, req.organizationId]
      )
      if (!target.length) return res.status(404).json({ error: 'Not found' })
      const parentId = target[0].recurrence_parent_id
      // NV.2 — members newly added by this edit (relative to the target
      // occurrence's prior roster) get an immediate notice.
      const prevTargetIds = Array.isArray(target[0].assigned_to) ? target[0].assigned_to : []
      const addedFollowing = (assigned_to || []).filter(x => !prevTargetIds.includes(x))
      if (!parentId) {
        // Caller asked for series-scope on a non-recurring row.
        // Fall through to the single-row UPDATE so the request
        // still does something sensible.
        const lit = await resolveLiturgicalContext(date, req.organizationId)
        const { rows } = await pool.query(
          `UPDATE ochr_calendar_events
              SET title=$1, date=$2, start_time=$3, end_time=$4, type=$5, assigned_to=$6, group_id=$7,
                  liturgical_season=$8, liturgical_color=$9, feast_name=$10
           WHERE id = $11 AND organization_id = $12 RETURNING *`,
          [title, date, start_time, end_time, type, JSON.stringify(assigned_to || []), groupId,
           lit.season, lit.color, lit.feast_name, id, req.organizationId]
        )
        if (!rows.length) return res.status(404).json({ error: 'Not found' })
        await syncEventReminders(req.organizationId, id)
        await notifyAssignmentAdded(req.organizationId, id, addedFollowing)
        return res.json(rows[0])
      }

      // Batch-update every sibling at or after the target's date.
      // Notice `date` is intentionally absent from the SET clause —
      // see comment at the top of this handler. liturgical_* are
      // omitted for the SAME reason: each sibling's stored date is
      // unchanged, so its computed liturgical context is unchanged.
      // If date propagation ever lands here, recompute per-sibling.
      const result = await pool.query(
        `UPDATE ochr_calendar_events
            SET title=$1, start_time=$2, end_time=$3, type=$4, assigned_to=$5, group_id=$6
          WHERE recurrence_parent_id = $7
            AND organization_id = $8
            AND date >= $9
          RETURNING *`,
        [title, start_time, end_time, type, JSON.stringify(assigned_to || []), groupId,
         parentId, req.organizationId, target[0].date]
      )
      if (!result.rows.length) return res.status(404).json({ error: 'Not found' })
      // Return the row that was actually requested as the response
      // body — keeps the API shape symmetric with single-row PATCH.
      const updated = result.rows.find(r => r.id === id) ?? result.rows[0]
      await syncSeriesReminders(req.organizationId, parentId)
      // NV.2 + LIT.2 caveat: the immediate notice fires only once, against
      // the target occurrence, even though the edit added the member to
      // every sibling at-or-after the target date. The scheduled reminders
      // (above) ARE per-sibling and pick up each row's own feast, so the
      // member still hears the right liturgical day per service. Worth
      // revisiting either as N notices or a "N services starting M-d"
      // digest once we have a clearer signal on which one users prefer.
      await notifyAssignmentAdded(req.organizationId, id, addedFollowing)
      return res.json(updated)
    }

    // Single-row PATCH (existing behavior). Capture the prior roster so
    // we can fire an immediate notice only for members newly added.
    const { rows: prevRows } = await pool.query(
      'SELECT assigned_to FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    // Re-map liturgical context (LIT.1) since the date may have moved.
    const lit = await resolveLiturgicalContext(date, req.organizationId)
    const { rows } = await pool.query(
      `UPDATE ochr_calendar_events
          SET title=$1, date=$2, start_time=$3, end_time=$4, type=$5, assigned_to=$6, group_id=$7,
              liturgical_season=$8, liturgical_color=$9, feast_name=$10
       WHERE id = $11 AND organization_id = $12 RETURNING *`,
      [title, date, start_time, end_time, type, JSON.stringify(assigned_to || []), groupId,
       lit.season, lit.color, lit.feast_name, id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    await syncEventReminders(req.organizationId, id)
    const prevIds = Array.isArray(prevRows[0]?.assigned_to) ? prevRows[0].assigned_to : []
    const added = (assigned_to || []).filter(x => !prevIds.includes(x))
    await notifyAssignmentAdded(req.organizationId, id, added)
    res.json(rows[0])
  } catch (err) {
    monitor.error('calendar.update', err, { orgId: req.organizationId, id, followingScope })
    res.status(500).json({ error: 'Failed to update event' })
  }
})

// DELETE /api/calendar/:id
//   ?scope=series → delete every row sharing the target's parent_id
//                   (= the whole series, including the seed).
//   default       → delete just that one occurrence.
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const seriesScope = req.query.scope === 'series'
  try {
    if (seriesScope) {
      // Look up the target's parent_id so we know which series to wipe.
      // If the row isn't recurring, we still delete just it (graceful).
      const { rows: target } = await pool.query(
        'SELECT recurrence_parent_id FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
        [id, req.organizationId]
      )
      if (!target.length) return res.status(404).json({ error: 'Not found' })
      const parentId = target[0].recurrence_parent_id
      if (!parentId) {
        // Not actually a series — fall through to single-row delete.
        const result = await pool.query(
          'DELETE FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
          [id, req.organizationId]
        )
        if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
        await cancelEventReminders(req.organizationId, id)
        return res.status(204).end()
      }
      // Cancel reminders for the whole series BEFORE deleting, while the
      // occurrence ids still resolve.
      await cancelSeriesReminders(req.organizationId, parentId)
      const result = await pool.query(
        'DELETE FROM ochr_calendar_events WHERE recurrence_parent_id = $1 AND organization_id = $2',
        [parentId, req.organizationId]
      )
      if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
      return res.status(204).end()
    }

    const result = await pool.query(
      'DELETE FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    await cancelEventReminders(req.organizationId, id)
    res.status(204).end()
  } catch (err) {
    monitor.error('calendar.delete', err, { orgId: req.organizationId, id, seriesScope })
    res.status(500).json({ error: 'Failed to delete event' })
  }
})

export default router
