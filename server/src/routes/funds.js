// Giving funds — admin CRUD (GIV.1) + BOOKS-1.1 net-asset class / releases.
//
//   GET    /api/funds                    → all funds (or ?active=true)
//   POST   /api/funds                    → create a fund (optional class)
//   PATCH  /api/funds/:id                → update; class flip refused after gifts
//   DELETE /api/funds/:id                → remove a fund (vault; no gifts)
//   POST   /api/funds/:id/releases       → append-only restriction release
//   GET    /api/funds/:id/rollforward    → opening / gross_contributions / refunds / net_contributions / releases / closing (as-of-date)
//
// Funds are the designations the public give page offers. A church with
// no active funds isn't collecting online gifts yet. All tenant-scoped.

import { Router } from 'express'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'
import { paymentsProvider } from '../payments/index.js'
import { protectedDelete } from '../vault/deleteRoute.js'
import { VaultError } from '../vault/index.js'
import { requireRole } from '../middleware/auth.js'
import { adminCount } from '../finance/deposits.js'

const router = Router()

const SELECT_COLS = `id, name, description, active, sort_order, created_at,
  net_asset_class, restriction_nature, restriction_purpose,
  class_set_at, class_set_by`
const PATCHABLE = new Set(['name', 'description', 'active', 'sort_order',
  'net_asset_class', 'restriction_nature', 'restriction_purpose'])
const CLASSES = new Set(['without_donor_restriction', 'with_donor_restriction'])
const NATURES = new Set(['purpose', 'time', 'perpetual'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function readClassFields(body, { requiredClass = false } = {}) {
  const out = {}
  if (body?.net_asset_class !== undefined) {
    const c = body.net_asset_class
    if (!CLASSES.has(c)) return { error: 'net_asset_class must be without_donor_restriction or with_donor_restriction' }
    out.net_asset_class = c
  } else if (requiredClass) {
    out.net_asset_class = 'without_donor_restriction'
  }
  if (body?.restriction_nature !== undefined) {
    const n = body.restriction_nature
    if (n === null || n === '') out.restriction_nature = null
    else if (!NATURES.has(n)) return { error: 'restriction_nature must be purpose, time, or perpetual' }
    else out.restriction_nature = n
  }
  if (body?.restriction_purpose !== undefined) {
    const p = typeof body.restriction_purpose === 'string' ? body.restriction_purpose.trim() : body.restriction_purpose
    out.restriction_purpose = p || null
  }
  const cls = out.net_asset_class
  if (cls === 'without_donor_restriction') {
    out.restriction_nature = null
    out.restriction_purpose = null
  }
  if (cls === 'with_donor_restriction') {
    if (!out.restriction_nature) return { error: 'restriction_nature is required when the fund has donor restrictions' }
    if (out.restriction_nature === 'purpose' && !out.restriction_purpose) {
      return { error: 'restriction_purpose is required when nature is purpose' }
    }
  }
  return { value: out }
}

async function giftCount(db, fundId, orgId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM ochr_donations
      WHERE fund_id = $1 AND organization_id = $2`,
    [fundId, orgId])
  return rows[0]?.n ?? 0
}

router.get('/', async (req, res) => {
  const activeOnly = req.query.active === 'true'
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS}
         FROM ochr_funds
        WHERE organization_id = $1
          ${activeOnly ? 'AND active = TRUE' : ''}
        ORDER BY sort_order ASC, name ASC`,
      [req.organizationId]
    )
    res.json({ funds: rows, provider: paymentsProvider() })
  } catch (err) {
    monitor.error('funds.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load funds' })
  }
})

router.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() || null : null
  const active = req.body?.active === undefined ? true : req.body.active === true || req.body.active === 'true'
  const sortOrder = Number.isInteger(req.body?.sort_order) ? req.body.sort_order : 0

  if (!name) return res.status(400).json({ error: 'Fund name is required' })
  if (name.length > 80) return res.status(400).json({ error: 'Fund name is too long' })
  const cls = readClassFields(req.body ?? {}, { requiredClass: true })
  if (cls.error) return res.status(400).json({ error: cls.error })
  if (cls.value.net_asset_class === 'with_donor_restriction' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only an administrator can create a fund with donor restrictions. Nothing was saved.' })
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO ochr_funds
         (organization_id, name, description, active, sort_order,
          net_asset_class, restriction_nature, restriction_purpose, class_set_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${SELECT_COLS}`,
      [req.organizationId, name, description, active, sortOrder,
       cls.value.net_asset_class,
       cls.value.restriction_nature ?? null,
       cls.value.restriction_purpose ?? null,
       req.user?.id ?? null]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('funds.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to create fund' })
  }
})

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' })

  const updates = {}
  for (const k of Object.keys(req.body ?? {})) {
    if (!PATCHABLE.has(k)) continue
    let v = req.body[k]
    if (k === 'active') {
      updates[k] = v === true || v === 'true'
    } else if (k === 'sort_order') {
      if (!Number.isInteger(v)) return res.status(400).json({ error: 'sort_order must be an integer' })
      updates[k] = v
    } else if (k === 'name') {
      if (typeof v === 'string') v = v.trim()
      if (!v) return res.status(400).json({ error: 'Fund name cannot be empty' })
      if (v.length > 80) return res.status(400).json({ error: 'Fund name is too long' })
      updates[k] = v
    } else if (k === 'description') {
      updates[k] = (typeof v === 'string' ? v.trim() : v) || null
    } else if (k === 'net_asset_class' || k === 'restriction_nature' || k === 'restriction_purpose') {
      updates[k] = v
    }
  }
  const keys = Object.keys(updates)
  if (!keys.length) return res.status(400).json({ error: 'No editable fields in body' })
  const touchesClass = 'net_asset_class' in updates || 'restriction_nature' in updates || 'restriction_purpose' in updates
  if (touchesClass && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only an administrator can set a fund\'s net-asset class. Nothing was changed.' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const locked = await client.query(
      `SELECT ${SELECT_COLS} FROM ochr_funds
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, req.organizationId])
    if (!locked.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    const current = locked.rows[0]
    const merged = {
      net_asset_class: updates.net_asset_class ?? current.net_asset_class,
      restriction_nature: updates.restriction_nature !== undefined
        ? updates.restriction_nature : current.restriction_nature,
      restriction_purpose: updates.restriction_purpose !== undefined
        ? updates.restriction_purpose : current.restriction_purpose,
    }
    const cls = readClassFields(merged)
    if (cls.error) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: cls.error })
    }
    if (cls.value.net_asset_class !== undefined) {
      updates.net_asset_class = cls.value.net_asset_class
      updates.restriction_nature = cls.value.restriction_nature ?? null
      updates.restriction_purpose = cls.value.restriction_purpose ?? null
    }

    const classChanging = updates.net_asset_class !== undefined
      && updates.net_asset_class !== current.net_asset_class
    if (classChanging) {
      const n = await giftCount(client, id, req.organizationId)
      if (n > 0) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          code: 'class_flip_requires_reclass',
          error: 'This fund already has gifts. Changing its net-asset class needs a reclassification entry, which is not available yet. Nothing was changed.',
        })
      }
      updates.class_set_at = new Date()
      updates.class_set_by = req.user?.id ?? null
    }

    const setKeys = Object.keys(updates)
    const sets = setKeys.map((k, i) => `${k} = $${i + 1}`).join(', ')
    const params = setKeys.map(k => updates[k])
    params.push(id, req.organizationId)
    const { rows } = await client.query(
      `UPDATE ochr_funds SET ${sets}
        WHERE id = $${setKeys.length + 1} AND organization_id = $${setKeys.length + 2}
        RETURNING ${SELECT_COLS}`,
      params)
    await client.query('COMMIT')
    res.json(rows[0])
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    monitor.error('funds.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update fund' })
  } finally {
    client.release()
  }
})

async function refuseDeletingDesignatedFund(req, id) {
  const n = await giftCount(pool, id, req.organizationId)
  if (n > 0) {
    throw new VaultError('fund_has_gifts',
      `This fund has ${n} gift${n === 1 ? '' : 's'} designated to it. Deactivate it instead; ` +
      'deleting it would move those gifts to the general fund in the ledger.')
  }
}
router.delete('/:id', protectedDelete('fund', {
  failure: 'Failed to delete fund', before: refuseDeletingDesignatedFund,
}))

// POST /api/funds/:id/releases — second-admin (or single-admin + reason).
router.post('/:id/releases', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' })
  const amount = Number(req.body?.amount)
  if (!(amount > 0) || !Number.isFinite(amount)) {
    return res.status(400).json({ error: 'amount must be a positive number' })
  }
  const releasedOn = typeof req.body?.released_on === 'string' && ISO_DATE.test(req.body.released_on)
    ? req.body.released_on : null
  if (!releasedOn) return res.status(400).json({ error: 'released_on (YYYY-MM-DD) is required' })
  const memo = typeof req.body?.qualifying_memo === 'string' ? req.body.qualifying_memo.trim() || null : null
  const kind = req.body?.kind === 'reverse' ? 'reverse' : 'release'
  const reversesId = kind === 'reverse' ? Number(req.body?.reverses_release_id) : null
  if (kind === 'reverse' && (!Number.isInteger(reversesId) || reversesId < 1)) {
    return res.status(400).json({ error: 'reverses_release_id is required for a reverse' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const fund = await client.query(
      `SELECT id, net_asset_class FROM ochr_funds
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, req.organizationId])
    if (!fund.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    if (fund.rows[0].net_asset_class !== 'with_donor_restriction') {
      await client.query('ROLLBACK')
      return res.status(400).json({
        code: 'fund_not_restricted',
        error: 'Only a fund with donor restrictions can record a release. Nothing was saved.',
      })
    }

    const admins = await adminCount(client, req.organizationId)
    let approvalMode = 'second_admin'
    let approverId = req.user.id
    let requesterId = Number(req.body?.requester_user_id) || null
    let reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : null

    if (admins <= 1) {
      const single = typeof req.body?.single_admin_reason === 'string'
        ? req.body.single_admin_reason.trim() : ''
      if (!single) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          code: 'single_admin_reason_required',
          error: 'This parish has one administrator. Type a reason to record the release. Nothing was saved.',
        })
      }
      approvalMode = 'single_admin'
      reason = single
      requesterId = req.user.id
      approverId = req.user.id
    } else {
      if (!requesterId || requesterId === req.user.id) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          code: 'second_admin_required',
          error: 'A second administrator must approve this release. Nothing was saved.',
        })
      }
      const { rows: reqUser } = await client.query(
        `SELECT id, role FROM ochr_users WHERE id = $1 AND organization_id = $2`,
        [requesterId, req.organizationId])
      if (!reqUser.length || reqUser[0].role !== 'admin') {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'requester_user_id must be an administrator of this parish' })
      }
    }

    if (kind === 'reverse') {
      const { rows: orig } = await client.query(
        `SELECT id, kind FROM ochr_fund_restriction_releases
          WHERE id = $1 AND organization_id = $2 AND fund_id = $3 FOR UPDATE`,
        [reversesId, req.organizationId, id])
      if (!orig.length || orig[0].kind !== 'release') {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Release to reverse was not found' })
      }
    }

    const { rows } = await client.query(
      `INSERT INTO ochr_fund_restriction_releases
         (organization_id, fund_id, kind, amount, released_on, qualifying_memo,
          requester_user_id, approver_user_id, approval_mode, reason, reverses_release_id)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11)
       RETURNING id, fund_id, kind, amount, released_on, qualifying_memo,
                 requester_user_id, approver_user_id, approval_mode, reason,
                 reverses_release_id, created_at`,
      [req.organizationId, id, kind, amount.toFixed(2), releasedOn, memo,
       requesterId, approverId, approvalMode, reason, reversesId])
    await client.query('COMMIT')
    res.status(201).json(rows[0])
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'That release was already reversed. Nothing was saved.' })
    }
    monitor.error('funds.release', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to record the release' })
  } finally {
    client.release()
  }
})

// GET /api/funds/:id/rollforward?from&to
// As-of-date (TARS #438 P1): recognize gross gifts on gift.date and posted
// refunds/voids on ochr_donation_refunds.refunded_at (not live_amount by gift
// date). Option A: gift.amount is never rewritten; reductions are separate
// facts. Stamp fallback (payment_status='refunded' with no posted row) uses
// COALESCE(d.refunded_at, d.date) — same facts the live view already knows.
router.get('/:id/rollforward', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' })
  const from = typeof req.query.from === 'string' && ISO_DATE.test(req.query.from) ? req.query.from : null
  const to = typeof req.query.to === 'string' && ISO_DATE.test(req.query.to) ? req.query.to : null
  if (!from || !to || to < from) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' })
  }
  try {
    const { rows: funds } = await pool.query(
      `SELECT ${SELECT_COLS} FROM ochr_funds WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId])
    if (!funds.length) return res.status(404).json({ error: 'Not found' })

    // Gross gifts by gift date (ochr_donation_live.amount = gift.amount).
    const { rows: [openGifts] } = await pool.query(
      `SELECT COALESCE(SUM(d.amount),0)::numeric(12,2) AS n
         FROM ochr_donation_live d
        WHERE d.organization_id = $1 AND d.fund_id = $2 AND d.date::date < $3::date`,
      [req.organizationId, id, from])
    const { rows: [periodGifts] } = await pool.query(
      `SELECT COALESCE(SUM(d.amount),0)::numeric(12,2) AS n
         FROM ochr_donation_live d
        WHERE d.organization_id = $1 AND d.fund_id = $2
          AND d.date::date BETWEEN $3::date AND $4::date`,
      [req.organizationId, id, from, to])

    // Posted refund + void facts by their own effective date.
    const refundSql = (bound) => `
      SELECT COALESCE(SUM(x.amount),0)::numeric(12,2) AS n FROM (
        SELECT r.amount
          FROM ochr_donation_refunds r
          JOIN ochr_donations d
            ON d.id = r.donation_id AND d.organization_id = r.organization_id
         WHERE r.organization_id = $1 AND d.fund_id = $2
           AND r.status = 'posted'
           AND ${bound}
        UNION ALL
        SELECT d.amount
          FROM ochr_donations d
         WHERE d.organization_id = $1 AND d.fund_id = $2
           AND d.payment_status = 'refunded'
           AND NOT EXISTS (
             SELECT 1 FROM ochr_donation_refunds r
              WHERE r.donation_id = d.id
                AND r.organization_id = d.organization_id
                AND r.status = 'posted')
           AND ${bound.replace('r.refunded_at', 'COALESCE(d.refunded_at, d.date)')}
      ) x`
    const { rows: [openRef] } = await pool.query(
      refundSql('r.refunded_at::date < $3::date'),
      [req.organizationId, id, from])
    const { rows: [periodRef] } = await pool.query(
      refundSql('r.refunded_at::date BETWEEN $3::date AND $4::date'),
      [req.organizationId, id, from, to])

    const { rows: [openRel] } = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'release' THEN amount ELSE -amount END),0)::numeric(12,2) AS n
         FROM ochr_fund_restriction_releases
        WHERE organization_id = $1 AND fund_id = $2 AND released_on < $3::date`,
      [req.organizationId, id, from])
    const { rows: [periodRel] } = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'release' THEN amount ELSE -amount END),0)::numeric(12,2) AS n
         FROM ochr_fund_restriction_releases
        WHERE organization_id = $1 AND fund_id = $2
          AND released_on BETWEEN $3::date AND $4::date`,
      [req.organizationId, id, from, to])

    const opening = (Number(openGifts.n) - Number(openRef.n) - Number(openRel.n)).toFixed(2)
    const gross_contributions = Number(periodGifts.n).toFixed(2)
    const refunds = Number(periodRef.n).toFixed(2)
    const net_contributions = (Number(gross_contributions) - Number(refunds)).toFixed(2)
    const releases = Number(periodRel.n).toFixed(2)
    // closing = opening + gross − refunds − releases (same as opening + net − releases)
    const closing = (
      Number(opening) + Number(gross_contributions) - Number(refunds) - Number(releases)
    ).toFixed(2)
    res.json({
      fund: funds[0],
      from, to,
      opening,
      gross_contributions,
      refunds,
      net_contributions,
      releases,
      closing,
      // Deprecated alias: equal to net_contributions. Kept so older readers of
      // `contributions` do not break. Do not subtract refunds from this field.
      contributions: net_contributions,
      // coverage flag only until AP exists
      coverage: 'flag_only',
    })
  } catch (err) {
    monitor.error('funds.rollforward', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to build the roll-forward' })
  }
})

export default router
