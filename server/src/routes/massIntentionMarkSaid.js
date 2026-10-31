// D-1 — bulk "Mark said" (fulfilled) for Mass intentions.
//
// Admin and the parish secretary (the `staff` login) only. The operator
// names each intention; there is no "all past". Fulfilment day is the day
// they confirm, or — when they leave it blank — the linked Mass's own day.
// It is never today's date. Already-fulfilled rows are not re-stamped.
// One audit row per intention (typed before/after, plus the batch id) is
// written on the same transaction as the change. Undo, in that same
// session's hands, restores the prior row and is audited too. The offering
// is not touched.

import { createHash } from 'node:crypto'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { writeMassIntentionAuditInTx } from '../middleware/auditLog.js'
import { isMassEvent, readMemberId } from './massIntentions.js'
import { orgTodayIso, usableTimeZone } from '../utils/sheetWeek.js'

// `staff` is the parish secretary's login. There is no separate role.
export const MAY_MARK_SAID = ['admin', 'staff']
export const MAX_MARK_SAID = 100

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const REFUSE_ROLE =
  'Only an administrator or the parish secretary can mark intentions said. Nothing was changed.'
export const REFUSE_CONFIRM = 'Confirmation is required. Nothing was changed.'
export const REFUSE_EXPLICIT = 'Choose each intention. Nothing was marked said.'
export const REFUSE_DATE = 'That day could not be read. Nothing was changed.'
export const REFUSE_REQUEST = 'A confirmation id is required. Nothing was changed.'
export const REFUSE_CONFLICT =
  'This confirmation does not match the one already recorded. This one was not applied.'
export const REFUSE_UNDO_CONFLICT =
  'The book changed after these were marked said. Nothing was put back.'
export const REFUSE_UNDO_EMPTY = 'Nothing to put back. Nothing was changed.'
export const REFUSE_FAILED = 'The book did not record this. Nothing was changed.'

const ROW_COLS = `id, status,
            to_char(mass_date, 'YYYY-MM-DD') AS mass_date,
            to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date,
            fulfilled_mass_title,
            to_char(fulfilled_mass_time, 'HH24:MI:SS') AS fulfilled_mass_time,
            calendar_event_id,
            (voided_at IS NOT NULL) AS voided,
            entered_history,
            book_revision,
            stipend::text AS stipend,
            requested_by_client_id,
            intention, note, requested_by`

export function canonicalFulfilmentDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return value
}

// Closed reader. `all`, a past-view flag, a missing list, a duplicate, or a
// non-integer id refuses the whole confirmation — nothing is written.
export function readMarkSaidRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'explicit_selection', error: REFUSE_EXPLICIT }
  }
  if (body.all != null || body.view != null || body.past != null || body.past_scheduled != null) {
    return { ok: false, status: 400, code: 'explicit_selection', error: REFUSE_EXPLICIT }
  }
  if (body.confirm !== true) {
    return { ok: false, status: 400, code: 'confirm_required', error: REFUSE_CONFIRM }
  }
  const requestId = typeof body.request_id === 'string' ? body.request_id.trim().toLowerCase() : ''
  if (!UUID.test(requestId)) {
    return { ok: false, status: 400, code: 'request_id', error: REFUSE_REQUEST }
  }
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_MARK_SAID) {
    return { ok: false, status: 400, code: 'explicit_selection', error: REFUSE_EXPLICIT }
  }
  const items = []
  const seen = new Set()
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, status: 400, code: 'explicit_selection', error: REFUSE_EXPLICIT }
    }
    const id = readMemberId(raw.id)
    if (!Number.isInteger(id)) {
      return { ok: false, status: 400, code: 'explicit_selection', error: REFUSE_EXPLICIT }
    }
    if (seen.has(id)) {
      return { ok: false, status: 400, code: 'explicit_selection', error: REFUSE_EXPLICIT }
    }
    seen.add(id)
    let fulfilled_date = null
    if (raw.fulfilled_date != null && raw.fulfilled_date !== '') {
      fulfilled_date = canonicalFulfilmentDate(raw.fulfilled_date)
      if (!fulfilled_date) {
        return { ok: false, status: 400, code: 'bad_date', error: REFUSE_DATE }
      }
    }
    items.push({ id, fulfilled_date })
  }
  items.sort((a, b) => a.id - b.id)
  return { ok: true, requestId, items, hash: markSaidPayloadHash(items) }
}

export function markSaidPayloadHash(items) {
  const canonical = items.map(i => ({ id: i.id, fulfilled_date: i.fulfilled_date }))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// Digest of the row we left behind. JSON encoding keeps a field boundary
// from looking like the next field (a U+001F join does not). Undo also
// compares book_revision, which changes on every later write, including
// one that puts these values back. The wording is hashed, not stored again.
export function intentionDigest(row) {
  const text = v => (v == null ? null : String(v))
  const fields = [
    ['status', text(row.status)],
    ['mass_date', text(row.mass_date)],
    ['fulfilled_mass_date', text(row.fulfilled_mass_date)],
    ['fulfilled_mass_title', text(row.fulfilled_mass_title)],
    ['fulfilled_mass_time', text(row.fulfilled_mass_time)],
    ['calendar_event_id', row.calendar_event_id == null ? null : String(row.calendar_event_id)],
    ['voided', row.voided === true],
    ['entered_history', row.entered_history === true],
    ['stipend', text(row.stipend)],
    ['requested_by_client_id', row.requested_by_client_id == null ? null : String(row.requested_by_client_id)],
    ['intention', text(row.intention)],
    ['note', text(row.note)],
    ['requested_by', text(row.requested_by)],
  ]
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

// The book returns BIGSERIAL ids as text. The audit snapshot stays a number.
function bookId(id) {
  return String(id)
}

function typedSnapshot(row, { status, fulfilled_mass_date } = {}) {
  const member = row.requested_by_client_id == null ? null : Number(row.requested_by_client_id)
  const event = row.calendar_event_id == null ? null : Number(row.calendar_event_id)
  return {
    id: Number(row.id),
    requested_by_client_id: Number.isInteger(member) && member > 0 ? member : null,
    calendar_event_id: Number.isInteger(event) && event > 0 ? event : null,
    status: status ?? row.status,
    fulfilled_mass_date: fulfilled_mass_date === undefined ? (row.fulfilled_mass_date ?? null) : fulfilled_mass_date,
  }
}

function roleRefuse(req, res) {
  if (!MAY_MARK_SAID.includes(req.user?.role)) {
    res.status(403).json({ error: REFUSE_ROLE, code: 'mark_said_role' })
    return true
  }
  return false
}

async function loadOwnBatch(client, requestId, orgId, userId, { lock }) {
  const { rows } = await client.query(
    `SELECT payload_hash, outcome, undo_outcome, undone_at, actor_user_id
       FROM ochr_mass_intention_mark_batches
      WHERE id = $1 AND organization_id = $2 AND actor_user_id = $3
      ${lock ? 'FOR UPDATE' : ''}`,
    [requestId, orgId, userId]
  )
  return rows[0] || null
}

function replayBody(requestId, outcome) {
  return {
    batch_id: requestId,
    replayed: true,
    marked: Array.isArray(outcome?.marked) ? outcome.marked : [],
    excluded: Array.isArray(outcome?.excluded) ? outcome.excluded : [],
  }
}

// The linked Mass's civil day. Never the clock's today.
function massDay(event) {
  if (!event || !isMassEvent(event)) return null
  return typeof event.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.date) ? event.date : null
}

// SP-160: a Mass that has not happened yet cannot have been said. The
// parish's civil today (ochr_organizations.timezone) is only the upper
// bound here; it is never written as the fulfilment day.
function classify(row, item, event, todayIso) {
  if (row.voided) return { code: 'voided' }
  if (row.status === 'fulfilled') return { code: 'already_fulfilled' }
  if (row.fulfilled_mass_date || row.fulfilled_mass_title || row.fulfilled_mass_time) {
    return { code: 'already_recorded' }
  }
  if (row.status === 'cancelled') return { code: 'cancelled' }
  // R339-1 / R348-1: a reasoned correction latches the row. Ordinary mark
  // said is not that path, for a secretary or an administrator.
  if (row.entered_history === true) return { code: 'history_locked' }
  const fromMass = massDay(event)
  const date = item.fulfilled_date || fromMass
  if (!date) return { code: 'needs_date' }
  if (!todayIso) return { code: 'future_mass' }
  if (date > todayIso || (fromMass && fromMass > todayIso)) return { code: 'future_mass' }
  // L3 canonical history (TARS on #354): the operator confirms the DAY.
  // The linked Mass's title and time are only established for that same
  // day; on a different day they would describe a Mass nobody confirmed,
  // so they stay NULL. The planned calendar_event_id is not touched — it
  // remains the scheduling context, separate from the fulfilment stamp.
  const titled = fromMass && date === fromMass ? event : null
  return {
    date,
    title: titled ? titled.title : null,
    time: titled ? titled.start_time : null,
  }
}

async function applyMark(client, req, parsed) {
  const ids = parsed.items.map(i => i.id)
  const locked = await client.query(
    `SELECT ${ROW_COLS}
       FROM ochr_mass_intentions
      WHERE organization_id = $1 AND id = ANY($2::bigint[])
      ORDER BY id
      FOR UPDATE`,
    [req.organizationId, ids]
  )
  const byId = new Map(locked.rows.map(r => [Number(r.id), r]))
  const eventIds = [...new Set(locked.rows.map(r => r.calendar_event_id).filter(id => id != null))]
  const events = new Map()
  if (eventIds.length) {
    const ev = await client.query(
      `SELECT id,
              to_char(date, 'YYYY-MM-DD') AS date,
              title,
              to_char(start_time, 'HH24:MI:SS') AS start_time,
              type
         FROM ochr_calendar_events
        WHERE organization_id = $1 AND id = ANY($2::int[])`,
      [req.organizationId, eventIds]
    )
    for (const row of ev.rows) events.set(Number(row.id), row)
  }

  const tz = await client.query(`SELECT timezone FROM ochr_organizations WHERE id = $1`, [req.organizationId])
  const todayIso = orgTodayIso(new Date(), usableTimeZone(tz.rows[0]?.timezone))

  const marked = []
  const excluded = []
  const itemRows = []

  for (const item of parsed.items) {
    const row = byId.get(item.id)
    if (!row) {
      excluded.push({ id: bookId(item.id), code: 'not_found' })
      continue
    }
    const event = row.calendar_event_id != null ? events.get(Number(row.calendar_event_id)) : null
    const plan = classify(row, item, event, todayIso)
    if (plan.code) {
      excluded.push({ id: bookId(item.id), code: plan.code })
      itemRows.push({ row, applied: false, code: plan.code, written: null })
      continue
    }
    const updated = await client.query(
      `UPDATE ochr_mass_intentions
          SET status = 'fulfilled',
              fulfilled_mass_date = $3::date,
              fulfilled_mass_title = $4,
              fulfilled_mass_time = $5,
              updated_at = NOW()
        WHERE id = $1 AND organization_id = $2
          AND status IS DISTINCT FROM 'fulfilled'
          AND fulfilled_mass_date IS NULL
          AND fulfilled_mass_title IS NULL
          AND fulfilled_mass_time IS NULL
          AND voided_at IS NULL
          AND entered_history = false
        RETURNING id`,
      [item.id, req.organizationId, plan.date, plan.title, plan.time]
    )
    if (!updated.rows.length) {
      excluded.push({ id: bookId(item.id), code: 'conflict' })
      itemRows.push({ row, applied: false, code: 'conflict', written: null })
      continue
    }
    const after = (await client.query(
      `SELECT ${ROW_COLS}
         FROM ochr_mass_intentions
        WHERE id = $1 AND organization_id = $2`,
      [item.id, req.organizationId]
    )).rows[0]
    const beforeSnap = typedSnapshot(row)
    const afterSnap = typedSnapshot(after)
    await writeMassIntentionAuditInTx(client, req, {
      status: 200,
      snapshot: afterSnap,
      before: beforeSnap,
      batchId: parsed.requestId,
    })
    marked.push({ id: bookId(item.id), fulfilled_date: plan.date })
    itemRows.push({ row, after, applied: true, code: null, written: plan, beforeSnap, afterSnap })
  }

  const outcome = { marked, excluded }
  await client.query(
    `INSERT INTO ochr_mass_intention_mark_batches
       (id, organization_id, actor_user_id, payload_hash, outcome)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [parsed.requestId, req.organizationId, req.user.id, parsed.hash, JSON.stringify(outcome)]
  )
  // Exclusions stay on the batch outcome, which has no foreign key to the
  // intention. An item row exists only when this confirmation recorded the
  // Mass, so a skipped row can still be deleted and an applied row cannot
  // lose its evidence by cascade.
  for (const item of itemRows) {
    if (!item.applied) continue
    const written = item.written
    await client.query(
      `INSERT INTO ochr_mass_intention_mark_items
         (organization_id, batch_id, mass_intention_id, applied, exclusion_code,
          before_snapshot, after_snapshot, prior_status, prior_entered_history,
          prior_calendar_event_id, prior_fulfilled_mass_date, prior_fulfilled_mass_title,
          prior_fulfilled_mass_time, written_fulfilled_mass_date, written_fulfilled_mass_title,
          written_fulfilled_mass_time, after_digest, after_book_revision)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        req.organizationId, parsed.requestId, item.row.id, item.applied, item.code,
        JSON.stringify(item.beforeSnap || typedSnapshot(item.row)),
        JSON.stringify(item.afterSnap || typedSnapshot(item.after || item.row)),
        item.row.status,
        item.row.entered_history === true,
        item.row.calendar_event_id,
        item.row.fulfilled_mass_date,
        item.row.fulfilled_mass_title,
        item.row.fulfilled_mass_time,
        written ? written.date : null,
        written ? written.title : null,
        written ? written.time : null,
        intentionDigest(item.after),
        item.after.book_revision,
      ]
    )
  }
  return outcome
}

async function settleUnique(req, res, parsed) {
  const { rows } = await pool.query(
    `SELECT payload_hash, outcome, actor_user_id
       FROM ochr_mass_intention_mark_batches
      WHERE id = $1 AND organization_id = $2`,
    [parsed.requestId, req.organizationId]
  )
  const row = rows[0]
  if (!row || Number(row.actor_user_id) !== Number(req.user.id)) {
    return res.status(409).json({ error: REFUSE_CONFLICT, code: 'payload_conflict' })
  }
  if (row.payload_hash !== parsed.hash) {
    return res.status(409).json({ error: REFUSE_CONFLICT, code: 'payload_conflict' })
  }
  res.locals.auditNoop = true
  return res.status(200).json(replayBody(parsed.requestId, row.outcome))
}

export async function bulkMarkSaid(req, res) {
  if (roleRefuse(req, res)) return
  const parsed = readMarkSaidRequest(req.body)
  if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error, code: parsed.code })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = await loadOwnBatch(client, parsed.requestId, req.organizationId, req.user.id, { lock: true })
    if (existing) {
      await client.query('COMMIT')
      if (existing.payload_hash !== parsed.hash) {
        return res.status(409).json({ error: REFUSE_CONFLICT, code: 'payload_conflict' })
      }
      res.locals.auditNoop = true
      return res.status(200).json(replayBody(parsed.requestId, existing.outcome))
    }
    const outcome = await applyMark(client, req, parsed)
    await client.query('COMMIT')
    res.locals.auditRecorded = true
    return res.status(200).json({
      batch_id: parsed.requestId,
      replayed: false,
      marked: outcome.marked,
      excluded: outcome.excluded,
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.code === '23505') return settleUnique(req, res, parsed)
    monitor.error('massIntentions.bulkMarkSaid', err, { orgId: req.organizationId })
    return res.status(500).json({ error: REFUSE_FAILED, code: 'mark_said_failed' })
  } finally {
    client.release()
  }
}

export async function undoBulkMarkSaid(req, res) {
  if (roleRefuse(req, res)) return
  const batchId = typeof req.params?.batchId === 'string' ? req.params.batchId.trim().toLowerCase() : ''
  if (!UUID.test(batchId)) return res.status(404).json({ error: 'Not found' })
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: REFUSE_CONFIRM, code: 'confirm_required' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const batch = await loadOwnBatch(client, batchId, req.organizationId, req.user.id, { lock: true })
    if (!batch) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    if (batch.undone_at) {
      await client.query('COMMIT')
      res.locals.auditNoop = true
      const restored = Array.isArray(batch.undo_outcome?.restored) ? batch.undo_outcome.restored : []
      return res.status(200).json({ batch_id: batchId, restored, already: true })
    }
    const items = await client.query(
      `SELECT mass_intention_id, prior_status, prior_entered_history, prior_calendar_event_id,
              to_char(prior_fulfilled_mass_date, 'YYYY-MM-DD') AS prior_fulfilled_mass_date,
              prior_fulfilled_mass_title,
              to_char(prior_fulfilled_mass_time, 'HH24:MI:SS') AS prior_fulfilled_mass_time,
              after_digest, after_book_revision
         FROM ochr_mass_intention_mark_items
        WHERE organization_id = $1 AND batch_id = $2 AND applied = true
        ORDER BY mass_intention_id
        FOR UPDATE`,
      [req.organizationId, batchId]
    )
    if (!items.rows.length) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: REFUSE_UNDO_EMPTY, code: 'undo_empty' })
    }
    const ids = items.rows.map(r => r.mass_intention_id)
    const locked = await client.query(
      `SELECT ${ROW_COLS}
         FROM ochr_mass_intentions
        WHERE organization_id = $1 AND id = ANY($2::bigint[])
        ORDER BY id
        FOR UPDATE`,
      [req.organizationId, ids]
    )
    const byId = new Map(locked.rows.map(r => [Number(r.id), r]))
    const blocked = []
    for (const item of items.rows) {
      const row = byId.get(Number(item.mass_intention_id))
      const revisionMatches = item.after_book_revision != null
        && row?.book_revision != null
        && String(row.book_revision) === String(item.after_book_revision)
      if (!row || !revisionMatches || intentionDigest(row) !== item.after_digest) {
        blocked.push(Number(item.mass_intention_id))
      }
    }
    if (blocked.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: REFUSE_UNDO_CONFLICT, code: 'undo_conflict', ids: blocked })
    }

    await client.query(`SELECT set_config('ochr.intention_undo', '1', true)`)
    const restored = []
    for (const item of items.rows) {
      const row = byId.get(Number(item.mass_intention_id))
      const updated = await client.query(
        `UPDATE ochr_mass_intentions
            SET status = $3,
                fulfilled_mass_date = $4,
                fulfilled_mass_title = $5,
                fulfilled_mass_time = $6,
                entered_history = $7,
                updated_at = NOW()
          WHERE id = $1 AND organization_id = $2
          RETURNING id, status, calendar_event_id, requested_by_client_id,
                    to_char(fulfilled_mass_date, 'YYYY-MM-DD') AS fulfilled_mass_date`,
        [
          item.mass_intention_id, req.organizationId, item.prior_status,
          item.prior_fulfilled_mass_date, item.prior_fulfilled_mass_title,
          item.prior_fulfilled_mass_time, item.prior_entered_history,
        ]
      )
      if (!updated.rows.length) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          error: REFUSE_UNDO_CONFLICT,
          code: 'undo_conflict',
          ids: [Number(item.mass_intention_id)],
        })
      }
      const after = updated.rows[0]
      await writeMassIntentionAuditInTx(client, req, {
        status: 200,
        before: typedSnapshot(row),
        snapshot: typedSnapshot(after),
        batchId,
      })
      restored.push({ id: bookId(item.mass_intention_id) })
    }
    const undoOutcome = { restored }
    await client.query(
      `UPDATE ochr_mass_intention_mark_batches
          SET undone_at = NOW(), undo_outcome = $3::jsonb
        WHERE id = $1 AND organization_id = $2`,
      [batchId, req.organizationId, JSON.stringify(undoOutcome)]
    )
    await client.query(
      `UPDATE ochr_mass_intention_mark_items
          SET undone = true
        WHERE organization_id = $1 AND batch_id = $2 AND applied = true`,
      [req.organizationId, batchId]
    )
    await client.query('COMMIT')
    res.locals.auditRecorded = true
    return res.status(200).json({ batch_id: batchId, restored, already: false })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    monitor.error('massIntentions.undoMarkSaid', err, { orgId: req.organizationId })
    return res.status(500).json({ error: REFUSE_FAILED, code: 'mark_said_failed' })
  } finally {
    client.release()
  }
}
