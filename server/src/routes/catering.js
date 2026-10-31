// Parish hall and wedding hospitality (OC-CAT-1).
//
// Holds a room, checks it against the parish Mass schedule and the
// register, records expected deposit amounts, and prepares a hall
// agreement. Payments are on hold: this router does not create a
// payment, a deposit fact, or a ledger row.
//
// The sacramental register is read and, when the office asks, linked.
// Nothing here writes ochr_sacramental_records.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { requireRole } from '../middleware/auth.js'
import { monitor } from '../monitoring/index.js'
import { depositPosition, fromCents } from '../finance/deposits.js'
import {
  CATERING_UPSTREAM, VERTICAL_KEY, SPACE_KINDS, EVENT_KINDS,
  buildMilestoneScheduleAndContract, buildBanquetEventOrder, lockGuaranteedHeadcount,
  isIsoInstant,
} from '../lib/catering/contract.js'
import { civilDatesTouched, evaluateBookingConflicts } from '../lib/catering/conflicts.js'
import { ESIGN_UPSTREAM, newSigningToken, hashSigningToken, sealToken, unsealToken, tokenFingerprint, sentLinkExpired, signLinkExpired } from '../lib/esign/hallTokens.js'
import { resolveLiturgicalBatch } from './liturgical.js'
import { agreementCounselPending } from '../lib/esign/hallConsent.js'

const router = Router()

const HOLD_MS = 14 * 24 * 60 * 60 * 1000

function fail(res, status, code) {
  res.status(status).json({ code, payments: 'on_hold' })
}

function trimText(raw, max) {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t || t.length > max) return null
  return t
}

function countOrNull(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'boolean') return null
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null
  if (s == null || !/^\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isSafeInteger(n) || n < 0 || n > 100000) return null
  return n
}

async function withTx(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* the original error is the one to report */ }
    throw err
  } finally {
    client.release()
  }
}

async function loadSpace(db, orgId, spaceId) {
  const { rows } = await db.query(
    `SELECT id, name, space_kind, vertical_key
       FROM ochr_cat_spaces
      WHERE id = $1 AND organization_id = $2`,
    [spaceId, orgId])
  return rows[0] ?? null
}

async function loadBooking(db, orgId, bookingId) {
  const { rows } = await db.query(
    `SELECT b.id, b.space_id, b.event_kind, b.host_name, b.occasion,
            b.starts_at, b.ends_at, b.status, b.marriage_record_id, b.expected_guests,
            b.vertical_key, b.cancelled_at, s.name AS space_name, s.space_kind,
            o.name AS parish_name, o.timezone AS time_zone
       FROM ochr_cat_bookings b
       JOIN ochr_cat_spaces s ON s.id = b.space_id AND s.organization_id = b.organization_id
       JOIN ochr_organizations o ON o.id = b.organization_id
      WHERE b.id = $1 AND b.organization_id = $2`,
    [bookingId, orgId])
  return rows[0] ?? null
}

async function orgFacts(db, orgId) {
  const { rows } = await db.query(
    `SELECT name, timezone FROM ochr_organizations WHERE id = $1`, [orgId])
  return { name: rows[0]?.name || '', timeZone: rows[0]?.timezone || null }
}

async function orgZone(db, orgId) {
  return (await orgFacts(db, orgId)).timeZone
}

async function voidAgreements(db, orgId, bookingId, reason) {
  const { rows } = await db.query(
    `SELECT id, status, contract_sha256
       FROM ochr_cat_agreements
      WHERE booking_id = $1 AND organization_id = $2 AND status <> 'voided'
      FOR UPDATE`,
    [bookingId, orgId])
  for (const row of rows) {
    await db.query(
      `UPDATE ochr_cat_agreements
          SET status = 'voided', token_hash = NULL, token_sealed = NULL
        WHERE id = $1 AND organization_id = $2 AND status <> 'voided'`,
      [row.id, orgId])
    await db.query(
      `INSERT INTO ochr_cat_agreement_events (organization_id, agreement_id, kind, payload)
       VALUES ($1,$2,'request.voided',$3::jsonb)`,
      [orgId, row.id, JSON.stringify({ reason, contract_sha256: row.contract_sha256, prior_status: row.status })])
  }
  return rows
}

async function contextFor(db, orgId, space, start, end, ignoreSacramentId) {
  const timeZone = await orgZone(db, orgId)
  const touched = civilDatesTouched(start, end, timeZone)
  const startDate = touched[0]
  const endDate = touched[touched.length - 1]
  const { rows: scheduleRows } = await db.query(
    `SELECT id, title, service_type, day_of_week, start_time::text AS start_time,
            end_time::text AS end_time, recurrence, specific_date::text AS specific_date, location
       FROM ochr_schedule
      WHERE organization_id = $1`, [orgId])
  const { rows: calendarRows } = await db.query(
    `SELECT id, title, date::text AS date, start_time::text AS start_time,
            end_time::text AS end_time, type
       FROM ochr_calendar_events
      WHERE organization_id = $1 AND date BETWEEN $2::date AND $3::date`,
    [orgId, startDate, endDate])
  const { rows: sacramentRows } = await db.query(
    `SELECT id, type, date::text AS date, place, voided_at
       FROM ochr_sacramental_records
      WHERE organization_id = $1
        AND date BETWEEN $2::date AND $3::date
        AND type IN ('marriage', 'burial')
        AND voided_at IS NULL`,
    [orgId, startDate, endDate])
  let liturgicalRows = null
  try {
    const batch = await resolveLiturgicalBatch(touched, orgId)
    liturgicalRows = touched.map(date => {
      const info = batch.get(date)
      if (!info) return null
      return {
        date,
        season: info.season ?? null,
        feast_name: info.feast_name ?? null,
        liturgical_color: info.color ?? info.liturgical_color ?? null,
      }
    }).filter(Boolean)
  } catch (err) {
    monitor.error('catering.liturgical', err, { orgId })
    liturgicalRows = null
  }
  const { rows: overlaps } = await db.query(
    `SELECT id, event_kind, host_name, starts_at, ends_at
       FROM ochr_cat_bookings
      WHERE organization_id = $1 AND space_id = $2 AND status = 'held'
        AND during && tstzrange($3, $4, '[)')`,
    [orgId, space.id, start.toISOString(), end.toISOString()])
  const judged = evaluateBookingConflicts({
    space,
    bookingStart: start,
    bookingEnd: end,
    timeZone,
    scheduleRows,
    calendarRows,
    sacramentRows,
    liturgicalRows,
    ignoreSacramentId,
  })
  const bookingConflicts = overlaps.map(row => ({
    source: 'booking',
    title: row.host_name,
    event_kind: row.event_kind,
    starts_at: new Date(row.starts_at).toISOString(),
    ends_at: new Date(row.ends_at).toISOString(),
  }))
  return { ...judged, time_zone: timeZone, conflicts: [...bookingConflicts, ...judged.conflicts] }
}

function bookingJson(row, extra = {}) {
  return {
    id: row.id,
    space_id: row.space_id,
    space_name: row.space_name,
    space_kind: row.space_kind,
    event_kind: row.event_kind,
    host_name: row.host_name,
    occasion: row.occasion,
    starts_at: new Date(row.starts_at).toISOString(),
    ends_at: new Date(row.ends_at).toISOString(),
    parish_name: row.parish_name || '',
    time_zone: row.time_zone || null,
    status: row.status,
    marriage_record_id: row.marriage_record_id,
    expected_guests: row.expected_guests,
    vertical_key: row.vertical_key,
    payments: 'on_hold',
    ...extra,
  }
}

router.get('/modules', (_req, res) => {
  res.json({
    vertical_key: VERTICAL_KEY,
    payments: 'on_hold',
    catering: CATERING_UPSTREAM,
    esign: ESIGN_UPSTREAM,
  })
})

router.get('/spaces', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, space_kind, vertical_key
         FROM ochr_cat_spaces
        WHERE organization_id = $1
        ORDER BY name, id`, [req.organizationId])
    res.json({ payments: 'on_hold', spaces: rows })
  } catch (err) {
    monitor.error('catering.spaces.list', err, { orgId: req.organizationId })
    fail(res, 500, 'load_failed')
  }
})

router.post('/spaces', async (req, res) => {
  const name = trimText(req.body?.name, 120)
  const spaceKind = req.body?.space_kind
  if (!name) return fail(res, 400, 'name')
  if (!SPACE_KINDS.includes(spaceKind)) return fail(res, 400, 'space_kind')
  try {
    const { rows } = await pool.query(
      `INSERT INTO ochr_cat_spaces (organization_id, name, space_kind, vertical_key)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, space_kind, vertical_key`,
      [req.organizationId, name, spaceKind, VERTICAL_KEY])
    res.status(201).json({ payments: 'on_hold', space: rows[0] })
  } catch (err) {
    monitor.error('catering.spaces.create', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

router.get('/bookings', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.space_id, b.event_kind, b.host_name, b.occasion,
              b.starts_at, b.ends_at, b.status, b.marriage_record_id, b.expected_guests,
              b.vertical_key, b.cancelled_at, s.name AS space_name, s.space_kind,
              o.name AS parish_name, o.timezone AS time_zone
         FROM ochr_cat_bookings b
         JOIN ochr_cat_spaces s ON s.id = b.space_id AND s.organization_id = b.organization_id
         JOIN ochr_organizations o ON o.id = b.organization_id
        WHERE b.organization_id = $1
        ORDER BY b.starts_at, b.id`, [req.organizationId])
    res.json({ payments: 'on_hold', bookings: rows.map(row => bookingJson(row)) })
  } catch (err) {
    monitor.error('catering.bookings.list', err, { orgId: req.organizationId })
    fail(res, 500, 'load_failed')
  }
})

router.post('/bookings', async (req, res) => {
  const spaceId = Number(req.body?.space_id)
  const eventKind = req.body?.event_kind
  const host = trimText(req.body?.host_name, 200)
  const occasion = typeof req.body?.occasion === 'string' ? req.body.occasion.trim().slice(0, 200) : null
  if (!Number.isSafeInteger(spaceId) || spaceId <= 0) return fail(res, 400, 'space')
  if (!EVENT_KINDS.includes(eventKind)) return fail(res, 400, 'event_kind')
  if (!host) return fail(res, 400, 'host_name')
  if (!isIsoInstant(req.body?.starts_at) || !isIsoInstant(req.body?.ends_at)) return fail(res, 400, 'when')
  const start = new Date(req.body.starts_at)
  const end = new Date(req.body.ends_at)
  if (!(end > start) || end - start > HOLD_MS) return fail(res, 400, 'when')
  const guests = req.body?.expected_guests == null || req.body.expected_guests === ''
    ? null : countOrNull(req.body.expected_guests)
  if (req.body?.expected_guests != null && req.body.expected_guests !== '' && guests == null) {
    return fail(res, 400, 'expected_guests')
  }
  const marriageId = req.body?.marriage_record_id == null || req.body.marriage_record_id === ''
    ? null : Number(req.body.marriage_record_id)
  if (marriageId != null && (!Number.isSafeInteger(marriageId) || marriageId <= 0)) {
    return fail(res, 400, 'marriage')
  }
  try {
    const created = await withTx(async (db) => {
      const space = await loadSpace(db, req.organizationId, spaceId)
      if (!space) return { status: 404, code: 'space' }
      if (marriageId != null) {
        const { rows } = await db.query(
          `SELECT id, type FROM ochr_sacramental_records
            WHERE id = $1 AND organization_id = $2`,
          [marriageId, req.organizationId])
        if (!rows.length) return { status: 404, code: 'marriage' }
        if (rows[0].type !== 'marriage') return { status: 409, code: 'not_marriage' }
      }
      const ctx = await contextFor(db, req.organizationId, space, start, end, marriageId)
      if (ctx.conflicts.length) return { status: 409, code: 'conflict', context: ctx }
      const { rows } = await db.query(
        `INSERT INTO ochr_cat_bookings
           (organization_id, space_id, event_kind, host_name, occasion, starts_at, ends_at,
            marriage_record_id, expected_guests, vertical_key, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [req.organizationId, spaceId, eventKind, host, occasion || null, start.toISOString(), end.toISOString(),
         marriageId, guests, VERTICAL_KEY, req.user.id])
      const booking = await loadBooking(db, req.organizationId, rows[0].id)
      return { status: 201, booking, context: ctx }
    })
    if (created.status !== 201) {
      return res.status(created.status).json({
        code: created.code, payments: 'on_hold', conflicts: created.context?.conflicts ?? [],
        unplaced: created.context?.unplaced ?? [],
        warnings: created.context?.warnings ?? [],
        time_zone: created.context?.time_zone ?? null,
        liturgical: created.context?.liturgical ?? null,
        liturgical_status: created.context?.liturgical_status ?? 'unknown',
      })
    }
    res.status(201).json({
      ...bookingJson(created.booking),
      conflicts: [],
      warnings: created.context.warnings ?? [],
      unplaced: created.context.unplaced,
      liturgical: created.context.liturgical,
      liturgical_status: created.context.liturgical_status,
    })
  } catch (err) {
    if (err?.code === '23P01') return fail(res, 409, 'conflict')
    monitor.error('catering.bookings.create', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

router.get('/bookings/:id', async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  try {
    const booking = await loadBooking(pool, req.organizationId, id)
    if (!booking) return fail(res, 404, 'booking')
    const { rows: milestones } = await pool.query(
      `SELECT id, kind, label, amount_cents, to_char(due_on, 'YYYY-MM-DD') AS due_on, status,
              event_deposit_payment_id
         FROM ochr_cat_milestones
        WHERE booking_id = $1 AND organization_id = $2
        ORDER BY due_on, id`, [id, req.organizationId])
    const facts = await orgFacts(pool, req.organizationId)
    const { rows: beos } = await pool.query(
      `SELECT table_count, chair_count, layout, kitchen_notes, allergen_notes, outside_caterer,
              guaranteed_count, locked_at
         FROM ochr_cat_beos
        WHERE booking_id = $1 AND organization_id = $2`, [id, req.organizationId])
    const { rows: agreements } = await pool.query(
      `SELECT id, status, contract_sha256, email_verified, sent_at, signed_at, signer_name, token_sealed,
              contract_en, contract_es
         FROM ochr_cat_agreements
        WHERE booking_id = $1 AND organization_id = $2
        ORDER BY id`, [id, req.organizationId])
    const withHeld = []
    for (const m of milestones) {
      let held = null
      if (m.event_deposit_payment_id) {
        try {
          const pos = await depositPosition(pool, req.organizationId, m.event_deposit_payment_id)
          held = fromCents(pos.held)
        } catch (err) {
          monitor.error('catering.milestone.held', err, { orgId: req.organizationId })
          held = null
        }
      }
      withHeld.push({ ...m, amount: fromCents(m.amount_cents), deposit_held: held })
    }
    let context = null
    if (booking.status === 'held') {
      const space = { id: booking.space_id, name: booking.space_name, space_kind: booking.space_kind }
      context = await contextFor(pool, req.organizationId, space, new Date(booking.starts_at), new Date(booking.ends_at), booking.marriage_record_id)
    }
    res.json({
      ...bookingJson(booking, { parish_name: facts.name, time_zone: facts.timeZone }),
      milestones: withHeld,
      beo: beos[0] ? buildBanquetEventOrder({
        booking: { ...booking, starts_at: new Date(booking.starts_at).toISOString(), ends_at: new Date(booking.ends_at).toISOString() },
        beo: beos[0],
        parishName: facts.name,
        timeZone: facts.timeZone,
      }) : null,
      // TARS r5: an expired link is not offered for copying. link_expired
      // tells the office to renew it (Replace link) instead.
      agreements: agreements.map(a => {
        const linkExpired = signLinkExpired(a)
        return {
          id: a.id,
          status: a.status,
          contract_sha256: a.contract_sha256,
          email_verified: a.email_verified,
          sent_at: a.sent_at,
          signed_at: a.signed_at,
          signer_name: a.signer_name,
          counsel_pending: agreementCounselPending(a.contract_en, a.contract_es),
          link_expired: linkExpired,
          copy_path: req.user?.role === 'admin' && a.token_sealed && !linkExpired
            ? copyPath(unsealToken(a.token_sealed))
            : null,
        }
      }),
      unplaced: context?.unplaced ?? [],
      warnings: context?.warnings ?? [],
      liturgical: context?.liturgical ?? null,
      liturgical_status: context?.liturgical_status ?? (booking.status === 'held' ? 'unknown' : 'known'),
      payments: 'on_hold',
    })
  } catch (err) {
    monitor.error('catering.bookings.read', err, { orgId: req.organizationId })
    fail(res, 500, 'load_failed')
  }
})

function copyPath(token) {
  if (!token) return null
  return `/sign/hall/${encodeURIComponent(token)}`
}

router.post('/bookings/:id/cancel', async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  try {
    const released = await withTx(async (db) => {
      // Argus N1: lock the hold, then the agreement rows, and only then
      // read whether one is signed. Under READ COMMITTED an unlocked read
      // could miss a signature that commits a moment later, and the void
      // below would then cancel a signed agreement without the admin check.
      const { rows: held } = await db.query(
        `SELECT id FROM ochr_cat_bookings WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [id, req.organizationId])
      if (!held.length) return { status: 404, code: 'booking' }
      const booking = await loadBooking(db, req.organizationId, id)
      if (!booking) return { status: 404, code: 'booking' }
      if (booking.status !== 'held') return { status: 200, booking }
      const { rows: locked } = await db.query(
        `SELECT id, status FROM ochr_cat_agreements
          WHERE booking_id = $1 AND organization_id = $2 AND status <> 'voided'
          FOR UPDATE`,
        [id, req.organizationId])
      const open = locked.filter(row => row.status === 'signed')
      if (open.length && req.user?.role !== 'admin') return { status: 403, code: 'admin' }
      if (open.length && req.body?.confirm_signed !== true) return { status: 409, code: 'confirm_signed' }
      await voidAgreements(db, req.organizationId, id, 'hold_released')
      await db.query(
        `UPDATE ochr_cat_bookings
            SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, NOW())
          WHERE id = $1 AND organization_id = $2 AND status = 'held'`,
        [id, req.organizationId])
      return { status: 200, booking: await loadBooking(db, req.organizationId, id) }
    })
    if (released.code) return fail(res, released.status, released.code)
    res.status(released.status).json({ ...bookingJson(released.booking), payments: 'on_hold' })
  } catch (err) {
    monitor.error('catering.bookings.cancel', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

router.post('/bookings/:id/marriage', async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  const recordId = Number(req.body?.record_id)
  if (!Number.isSafeInteger(recordId) || recordId <= 0) return fail(res, 400, 'marriage')
  try {
    const linked = await withTx(async (db) => {
      const booking = await loadBooking(db, req.organizationId, id)
      if (!booking) return { status: 404, code: 'booking' }
      const before = await db.query(
        `SELECT id, type, date, place, minister, notes, updated_at
           FROM ochr_sacramental_records
          WHERE id = $1 AND organization_id = $2`,
        [recordId, req.organizationId])
      if (!before.rows.length) return { status: 404, code: 'marriage' }
      if (before.rows[0].type !== 'marriage') return { status: 409, code: 'not_marriage' }
      await db.query(
        `UPDATE ochr_cat_bookings
            SET marriage_record_id = $3
          WHERE id = $1 AND organization_id = $2`,
        [id, req.organizationId, recordId])
      const after = await db.query(
        `SELECT id, type, date, place, minister, notes, updated_at
           FROM ochr_sacramental_records
          WHERE id = $1 AND organization_id = $2`,
        [recordId, req.organizationId])
      return { status: 200, before: before.rows[0], after: after.rows[0] }
    })
    if (linked.status !== 200) return fail(res, linked.status, linked.code)
    const same = JSON.stringify(linked.before) === JSON.stringify(linked.after)
    res.json({
      payments: 'on_hold',
      marriage_record_id: recordId,
      register_unchanged: same,
    })
  } catch (err) {
    monitor.error('catering.marriage', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

router.put('/bookings/:id/milestones', async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  const booking = await loadBooking(pool, req.organizationId, id)
  if (!booking) return fail(res, 404, 'booking')
  const built = buildMilestoneScheduleAndContract({
    eventKind: booking.event_kind,
    hostName: booking.host_name,
    spaceName: booking.space_name,
    startsAt: new Date(booking.starts_at).toISOString(),
    endsAt: new Date(booking.ends_at).toISOString(),
    milestones: req.body?.milestones,
  })
  if (!built.ok) return fail(res, 400, built.code)
  try {
    await withTx(async (db) => {
      const { rows: open } = await db.query(
        `SELECT status FROM ochr_cat_agreements
          WHERE booking_id = $1 AND organization_id = $2 AND status IN ('sent', 'signed')`,
        [id, req.organizationId])
      if (open.length) {
        const err = new Error('frozen')
        err.status = 409
        err.code = 'frozen'
        throw err
      }
      await db.query(
        `DELETE FROM ochr_cat_milestones WHERE booking_id = $1 AND organization_id = $2`,
        [id, req.organizationId])
      for (const line of built.schedule) {
        await db.query(
          `INSERT INTO ochr_cat_milestones
             (organization_id, booking_id, kind, label, amount_cents, due_on)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.organizationId, id, line.kind, line.label, line.amount_cents, line.due_on])
      }
    })
    res.json({ payments: 'on_hold', milestones: built.schedule, contract_sha256: built.contract_sha256 })
  } catch (err) {
    if (err?.code === 'frozen' || err?.code === '55000') return fail(res, 409, 'frozen')
    monitor.error('catering.milestones', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

router.post('/bookings/:id/milestones/:milestoneId/deposit', async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  const milestoneId = Number(req.params.milestoneId)
  const paymentId = Number(req.body?.payment_id)
  if (!Number.isSafeInteger(milestoneId) || milestoneId <= 0) return fail(res, 400, 'milestone')
  if (!Number.isSafeInteger(paymentId) || paymentId <= 0) return fail(res, 400, 'payment')
  try {
    const { rows: pays } = await pool.query(
      `SELECT id, is_deposit FROM ochr_invoice_payments
        WHERE id = $1 AND organization_id = $2`,
      [paymentId, req.organizationId])
    if (!pays.length) return fail(res, 404, 'payment')
    if (!pays[0].is_deposit) return fail(res, 409, 'not_deposit')
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_deposit_facts WHERE organization_id = $1`,
      [req.organizationId])
    const { rows } = await pool.query(
      `UPDATE ochr_cat_milestones
          SET event_deposit_payment_id = $3
        WHERE id = $1 AND organization_id = $2 AND booking_id = $4
        RETURNING id, event_deposit_payment_id`,
      [milestoneId, req.organizationId, paymentId, id])
    if (!rows.length) return fail(res, 404, 'milestone')
    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ochr_deposit_facts WHERE organization_id = $1`,
      [req.organizationId])
    res.json({
      payments: 'on_hold',
      milestone_id: rows[0].id,
      event_deposit_payment_id: rows[0].event_deposit_payment_id,
      deposit_facts_unchanged: before.rows[0].n === after.rows[0].n,
    })
  } catch (err) {
    monitor.error('catering.depositLink', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

function beoInput(body) {
  const tableCount = countOrNull(body?.table_count)
  const chairCount = countOrNull(body?.chair_count)
  if (tableCount == null || chairCount == null) return null
  const text = (v) => typeof v === 'string' ? v.trim().slice(0, 2000) : ''
  const guaranteed = body?.guaranteed_count == null || body.guaranteed_count === ''
    ? null : countOrNull(body.guaranteed_count)
  if (body?.guaranteed_count != null && body.guaranteed_count !== '' && guaranteed == null) return null
  return {
    table_count: tableCount,
    chair_count: chairCount,
    layout: text(body?.layout),
    kitchen_notes: text(body?.kitchen_notes),
    allergen_notes: text(body?.allergen_notes),
    outside_caterer: text(body?.outside_caterer),
    guaranteed_count: guaranteed,
  }
}

router.put('/bookings/:id/beo', async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  const input = beoInput(req.body)
  if (!input) return fail(res, 400, 'beo')
  try {
    const saved = await withTx(async (db) => {
      const booking = await loadBooking(db, req.organizationId, id)
      if (!booking) return { status: 404, code: 'booking' }
      const { rows: existing } = await db.query(
        `SELECT guaranteed_count, locked_at FROM ochr_cat_beos
          WHERE booking_id = $1 AND organization_id = $2`,
        [id, req.organizationId])
      let guaranteed = input.guaranteed_count
      if (existing[0]?.locked_at) {
        const locked = lockGuaranteedHeadcount({
          lockedAt: existing[0].locked_at,
          currentCount: existing[0].guaranteed_count,
          nextCount: input.guaranteed_count ?? existing[0].guaranteed_count,
        })
        if (!locked.ok) return { status: 409, code: locked.code }
        guaranteed = existing[0].guaranteed_count
      }
      const { rows } = await db.query(
        `INSERT INTO ochr_cat_beos
           (organization_id, booking_id, table_count, chair_count, layout, kitchen_notes,
            allergen_notes, outside_caterer, guaranteed_count, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (organization_id, booking_id) DO UPDATE
           SET table_count = EXCLUDED.table_count,
               chair_count = EXCLUDED.chair_count,
               layout = EXCLUDED.layout,
               kitchen_notes = EXCLUDED.kitchen_notes,
               allergen_notes = EXCLUDED.allergen_notes,
               outside_caterer = EXCLUDED.outside_caterer,
               guaranteed_count = $9,
               updated_at = NOW()
         RETURNING table_count, chair_count, layout, kitchen_notes, allergen_notes,
                   outside_caterer, guaranteed_count, locked_at`,
        [req.organizationId, id, input.table_count, input.chair_count, input.layout,
         input.kitchen_notes, input.allergen_notes, input.outside_caterer, guaranteed])
      return {
        status: 200,
        beo: buildBanquetEventOrder({
          booking: {
            ...booking,
            starts_at: new Date(booking.starts_at).toISOString(),
            ends_at: new Date(booking.ends_at).toISOString(),
          },
          beo: rows[0],
          ...(await orgFacts(db, req.organizationId).then(f => ({ parishName: f.name, timeZone: f.timeZone }))),
        }),
      }
    })
    if (saved.status !== 200) return fail(res, saved.status, saved.code)
    res.json({ payments: 'on_hold', beo: saved.beo })
  } catch (err) {
    monitor.error('catering.beo', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

router.post('/bookings/:id/beo/lock', async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  const nextCount = countOrNull(req.body?.guaranteed_count)
  if (nextCount == null) return fail(res, 400, 'guaranteed_count')
  try {
    const saved = await withTx(async (db) => {
      const { rows } = await db.query(
        `SELECT guaranteed_count, locked_at FROM ochr_cat_beos
          WHERE booking_id = $1 AND organization_id = $2
          FOR UPDATE`,
        [id, req.organizationId])
      if (!rows.length) return { status: 404, code: 'beo' }
      const decision = lockGuaranteedHeadcount({
        lockedAt: rows[0].locked_at,
        currentCount: rows[0].guaranteed_count,
        nextCount,
      })
      if (!decision.ok) return { status: 409, code: decision.code, guaranteed_count: rows[0].guaranteed_count }
      if (decision.unchanged) return { status: 200, guaranteed_count: rows[0].guaranteed_count, locked_at: rows[0].locked_at }
      const updated = await db.query(
        `UPDATE ochr_cat_beos
            SET guaranteed_count = $3, locked_at = NOW(), locked_by_user_id = $4, updated_at = NOW()
          WHERE booking_id = $1 AND organization_id = $2
          RETURNING guaranteed_count, locked_at`,
        [id, req.organizationId, decision.guaranteed_count, req.user.id])
      return { status: 200, ...updated.rows[0] }
    })
    if (saved.status !== 200) {
      return res.status(saved.status).json({
        code: saved.code, payments: 'on_hold', guaranteed_count: saved.guaranteed_count ?? null,
      })
    }
    res.json({
      payments: 'on_hold',
      guaranteed_count: saved.guaranteed_count,
      locked_at: saved.locked_at,
    })
  } catch (err) {
    monitor.error('catering.beo.lock', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

async function currentContract(db, orgId, booking) {
  const { rows } = await db.query(
    `SELECT kind, label, amount_cents, to_char(due_on, 'YYYY-MM-DD') AS due_on
       FROM ochr_cat_milestones
      WHERE booking_id = $1 AND organization_id = $2
      ORDER BY due_on, id`,
    [booking.id, orgId])
  const facts = await orgFacts(db, orgId)
  return buildMilestoneScheduleAndContract({
    eventKind: booking.event_kind,
    hostName: booking.host_name,
    spaceName: booking.space_name,
    parishName: facts.name,
    timeZone: facts.timeZone,
    startsAt: new Date(booking.starts_at).toISOString(),
    endsAt: new Date(booking.ends_at).toISOString(),
    milestones: rows.map(r => ({ ...r, amount: fromCents(r.amount_cents) })),
  })
}

// SP-241 / SP-247: a replaced link starts its own 30 days. Without this,
// replacing an expired link handed out a link that was born expired.
// signed_at is a record and is never moved; sent_at is the link clock
// for both sent and signed (signed view) agreements and always restarts.
async function mintSigningToken(db, orgId, agreementId) {
  const token = newSigningToken(orgId)
  const { rows } = await db.query(
    `UPDATE ochr_cat_agreements
        SET token_hash = $3, token_sealed = $4, sent_at = NOW()
      WHERE id = $1 AND organization_id = $2
      RETURNING status`,
    [agreementId, orgId, hashSigningToken(token), sealToken(token)])
  await db.query(
    `INSERT INTO ochr_cat_agreement_events (organization_id, agreement_id, kind, payload)
     VALUES ($1,$2,'token.rotated',$3::jsonb)`,
    [orgId, agreementId, JSON.stringify({
      token_fingerprint: tokenFingerprint(token),
      link_clock_restarted: true,
      status: rows[0]?.status ?? null,
    })])
  return token
}

router.post('/bookings/:id/agreement', async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  try {
    const prepared = await withTx(async (db) => {
      const booking = await loadBooking(db, req.organizationId, id)
      if (!booking) return { status: 404, code: 'booking' }
      const built = await currentContract(db, req.organizationId, booking)
      if (!built.ok) return { status: 400, code: built.code }
      const { rows: existing } = await db.query(
        `SELECT id, status FROM ochr_cat_agreements
          WHERE booking_id = $1 AND organization_id = $2 AND status IN ('draft', 'sent', 'signed')
          ORDER BY id DESC LIMIT 1`,
        [id, req.organizationId])
      if (existing[0]?.status === 'signed' || existing[0]?.status === 'sent') {
        return { status: 409, code: 'already_sent' }
      }
      if (existing[0]?.status === 'draft') {
        const updated = await db.query(
          `UPDATE ochr_cat_agreements
              SET contract_en = $3, contract_es = $4, contract_sha256 = $5
            WHERE id = $1 AND organization_id = $2 AND status = 'draft'
            RETURNING id, status, contract_sha256, contract_en, contract_es`,
          [existing[0].id, req.organizationId, built.contract.en, built.contract.es, built.contract_sha256])
        return { status: 200, agreement: updated.rows[0] }
      }
      const inserted = await db.query(
        `INSERT INTO ochr_cat_agreements
           (organization_id, booking_id, status, contract_en, contract_es, contract_sha256)
         VALUES ($1,$2,'draft',$3,$4,$5)
         RETURNING id, status, contract_sha256, contract_en, contract_es`,
        [req.organizationId, id, built.contract.en, built.contract.es, built.contract_sha256])
      return { status: 201, agreement: inserted.rows[0] }
    })
    if (!prepared.agreement) return fail(res, prepared.status, prepared.code)
    res.status(prepared.status).json({
      payments: 'on_hold',
      id: prepared.agreement.id,
      status: prepared.agreement.status,
      contract_sha256: prepared.agreement.contract_sha256,
      contract_en: prepared.agreement.contract_en,
      contract_es: prepared.agreement.contract_es,
      counsel_pending: agreementCounselPending(prepared.agreement.contract_en, prepared.agreement.contract_es),
    })
  } catch (err) {
    monitor.error('catering.agreement', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

router.post('/bookings/:id/agreement/send', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  const confirm = typeof req.body?.contract_sha256 === 'string' ? req.body.contract_sha256 : ''
  try {
    const sent = await withTx(async (db) => {
      const booking = await loadBooking(db, req.organizationId, id)
      if (!booking) return { status: 404, code: 'booking' }
      if (booking.status !== 'held') return { status: 409, code: 'not_held' }
      const { rows } = await db.query(
        `SELECT id, status, contract_sha256, contract_en, contract_es, token_sealed, sent_at
           FROM ochr_cat_agreements
          WHERE booking_id = $1 AND organization_id = $2 AND status IN ('draft', 'sent')
          ORDER BY id DESC LIMIT 1
          FOR UPDATE`,
        [id, req.organizationId])
      if (!rows.length) return { status: 404, code: 'agreement' }
      const row = rows[0]
      if (row.contract_sha256 !== confirm) return { status: 409, code: 'sha_mismatch' }
      // Vesper R1 / SP-236: Approve on an agreement already issued hands back
      // the link the family already has. Replacing it is /rotate, with an
      // explicit confirm. A new token is minted here only if none is kept.
      // SP-241: a kept link that has expired is not handed back as if it
      // still works. A new one is minted, with its own 30 days, and the
      // office is told it is new (renewed) so it is sent to the family.
      // TARS r5: the counsel gate comes before any new link or renewal.
      // A live kept link is handed back (the family can read or decline);
      // nothing new is minted while counsel's wording is missing.
      const pending = agreementCounselPending(row.contract_en, row.contract_es)
      if (row.status === 'sent') {
        const expired = sentLinkExpired(row.sent_at)
        const kept = !expired && row.token_sealed ? unsealToken(row.token_sealed) : null
        if (kept) return { status: 200, copy_path: copyPath(kept), agreement_id: row.id, already_issued: true }
        if (pending) return { status: 409, code: 'counsel_pending' }
        const token = await mintSigningToken(db, req.organizationId, row.id)
        if (expired) return { status: 200, copy_path: copyPath(token), agreement_id: row.id, renewed: true }
        return { status: 200, copy_path: copyPath(token), agreement_id: row.id, already_issued: true }
      }
      // Counsel's wording is not supplied: the link is not issued.
      if (pending) return { status: 409, code: 'counsel_pending' }
      const token = newSigningToken(req.organizationId)
      const approval = {
        action: 'catering.send_event_contract_and_deposit_link',
        contract_sha256: row.contract_sha256,
        payments: 'on_hold',
        deposit_link: null,
      }
      await db.query(
        `INSERT INTO ochr_cat_agreement_events (organization_id, agreement_id, kind, payload)
         VALUES ($1,$2,'approval.recorded',$3::jsonb)`,
        [req.organizationId, row.id, JSON.stringify(approval)])
      await db.query(
        `INSERT INTO ochr_cat_agreement_events (organization_id, agreement_id, kind, payload)
         VALUES ($1,$2,'email.not_sent',$3::jsonb)`,
        [req.organizationId, row.id, JSON.stringify({
          email_verified: false,
          method: 'copy_link',
          token_fingerprint: tokenFingerprint(token),
        })])
      await db.query(
        `UPDATE ochr_cat_agreements
            SET status = 'sent', sent_at = NOW(), token_hash = $3, token_sealed = $4, email_verified = FALSE
          WHERE id = $1 AND organization_id = $2 AND status = 'draft'`,
        [row.id, req.organizationId, hashSigningToken(token), sealToken(token)])
      return { status: 200, copy_path: copyPath(token), agreement_id: row.id, approval }
    })
    if (!sent.copy_path && sent.status !== 200) return fail(res, sent.status, sent.code)
    if (sent.code) return fail(res, sent.status, sent.code)
    res.json({
      payments: 'on_hold',
      agreement_id: sent.agreement_id,
      copy_path: sent.copy_path,
      already_issued: sent.already_issued === true,
      renewed: sent.renewed === true,
      email_verified: false,
      deposit_link: null,
    })
  } catch (err) {
    monitor.error('catering.agreement.send', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

router.post('/bookings/:id/agreement/rotate', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  try {
    const rotated = await withTx(async (db) => {
      const booking = await loadBooking(db, req.organizationId, id)
      if (!booking) return { status: 404, code: 'booking' }
      if (booking.status !== 'held') return { status: 409, code: 'not_held' }
      const { rows } = await db.query(
        `SELECT id, status, contract_en, contract_es FROM ochr_cat_agreements
          WHERE booking_id = $1 AND organization_id = $2 AND status IN ('sent', 'signed')
          ORDER BY id DESC LIMIT 1
          FOR UPDATE`,
        [id, req.organizationId])
      if (!rows.length) return { status: 404, code: 'agreement' }
      // TARS r5: a new signing link is not issued while counsel's wording is
      // missing; the link the family has is left as it is (read/decline).
      // A signed agreement's link only re-opens the signed copy, and its
      // record (status, signed_at, signer, text) is never touched here.
      if (rows[0].status === 'sent' && agreementCounselPending(rows[0].contract_en, rows[0].contract_es)) {
        return { status: 409, code: 'counsel_pending' }
      }
      // The link the family holds stops working. The office says so first.
      if (req.body?.confirm_replace !== true) return { status: 409, code: 'confirm_replace' }
      const token = await mintSigningToken(db, req.organizationId, rows[0].id)
      return { status: 200, copy_path: copyPath(token), agreement_id: rows[0].id }
    })
    if (rotated.code) return fail(res, rotated.status, rotated.code)
    res.json({
      payments: 'on_hold',
      agreement_id: rotated.agreement_id,
      copy_path: rotated.copy_path,
      email_verified: false,
    })
  } catch (err) {
    monitor.error('catering.agreement.rotate', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

router.post('/bookings/:id/agreement/void', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res, 'id')
  if (id == null) return
  const reason = trimText(req.body?.reason, 500)
  if (!reason) return fail(res, 400, 'reason')
  try {
    const voided = await withTx(async (db) => {
      const { rows } = await db.query(
        `SELECT id, status FROM ochr_cat_agreements
          WHERE booking_id = $1 AND organization_id = $2 AND status <> 'voided'
          FOR UPDATE`,
        [id, req.organizationId])
      if (!rows.length) return { status: 404, code: 'agreement' }
      if (rows.some(row => row.status === 'signed') && req.body?.confirm_signed !== true) {
        return { status: 409, code: 'confirm_signed' }
      }
      const done = await voidAgreements(db, req.organizationId, id, reason)
      return { status: 200, agreement_id: done[0]?.id ?? null }
    })
    if (voided.code) return fail(res, voided.status, voided.code)
    res.json({ payments: 'on_hold', agreement_id: voided.agreement_id, status: 'voided' })
  } catch (err) {
    monitor.error('catering.agreement.void', err, { orgId: req.organizationId })
    fail(res, 500, 'save_failed')
  }
})

export default router
