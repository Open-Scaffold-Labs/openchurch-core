// Fee schedules — admin CRUD for the offerings & fees catalog (BILL.0).
//
//   GET    /api/fee-schedules            → the catalog (or ?active=true, ?category=)
//   POST   /api/fee-schedules            → create an item
//   PATCH  /api/fee-schedules/:id        → update allowlisted fields
//   DELETE /api/fee-schedules/:id        → deactivate or remove
//
// The catalog is what the invoice composer offers: "Wedding — church use,
// $800 ($400 parishioner)". Vocabulary matters — the settings page is titled
// by the org's billing_label (default "Offerings & Fees"), and nothing here
// or downstream ever calls a sacrament a product.
//
// DELETE is soft when the item has ever been referenced by an invoice line
// (deactivate — history keeps its meaning) and hard only when unreferenced.
// The FK is ON DELETE SET NULL either way, but a catalog that silently
// vanishes from old invoices reads like tampering; deactivation is honest.
//
// Mount (app.js), next to funds:
//   app.use('/api/fee-schedules', requireAuth, writeGate, auditLog('fee_schedule'), feeSchedulesRouter)

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

export const FEE_CATEGORIES = new Set([
  'wedding', 'funeral', 'baptism', 'quinceanera', 'facility', 'stipend', 'other',
])

const SELECT_COLS = `id, name, description, category, amount, parishioner_amount,
                     deposit_amount, pass_through, default_payee, account_code,
                     fund_id, active, sort_order, created_at, updated_at`

// NUMERIC(10,2)-bound money from a request body. Returns:
//   undefined → invalid (caller 400s)   null → clear the column
//   string    → validated 'x.xx' value
function readMoney(v) {
  // undefined (field simply not sent) clears/omits like null — an
  // optional money field a caller never mentioned is not an error.
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 99999999) return undefined
  return (Math.round(n * 100) / 100).toFixed(2)
}

async function fundInOrg(fundId, orgId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM ochr_funds WHERE id = $1 AND organization_id = $2',
    [fundId, orgId]
  )
  return rows.length > 0
}

// GET /api/fee-schedules — the catalog, grouped client-side by category.
router.get('/', async (req, res) => {
  const activeOnly = req.query.active === 'true'
  const category = typeof req.query.category === 'string' && FEE_CATEGORIES.has(req.query.category)
    ? req.query.category : null
  try {
    const where = ['organization_id = $1']
    const params = [req.organizationId]
    if (activeOnly) where.push('active = TRUE')
    if (category) { params.push(category); where.push(`category = $${params.length}`) }

    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS}
         FROM ochr_fee_schedules
        WHERE ${where.join(' AND ')}
        ORDER BY category, sort_order ASC, name ASC`,
      params
    )
    res.json(rows)
  } catch (err) {
    monitor.error('feeSchedules.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load fee schedule' })
  }
})

// POST /api/fee-schedules — create an item.
router.post('/', async (req, res) => {
  const b = req.body ?? {}
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return res.status(400).json({ error: 'Name is required' })
  if (name.length > 120) return res.status(400).json({ error: 'Name is too long' })

  const category = FEE_CATEGORIES.has(b.category) ? b.category : 'other'

  const amount = readMoney(b.amount ?? 0)
  const parishionerAmount = readMoney(b.parishioner_amount)
  const depositAmount = readMoney(b.deposit_amount)
  if (amount === undefined || amount === null) return res.status(400).json({ error: 'Invalid amount' })
  if (parishionerAmount === undefined) return res.status(400).json({ error: 'Invalid parishioner amount' })
  if (depositAmount === undefined) return res.status(400).json({ error: 'Invalid deposit amount' })

  const fundId = b.fund_id == null ? null : Number(b.fund_id)
  if (fundId !== null && (!Number.isInteger(fundId) || fundId <= 0)) {
    return res.status(400).json({ error: 'Invalid fund_id' })
  }

  try {
    if (fundId !== null && !(await fundInOrg(fundId, req.organizationId))) {
      return res.status(400).json({ error: 'Fund not found' })
    }
    const { rows } = await pool.query(
      `INSERT INTO ochr_fee_schedules
         (organization_id, name, description, category, amount, parishioner_amount,
          deposit_amount, pass_through, default_payee, account_code, fund_id,
          active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${SELECT_COLS}`,
      [
        req.organizationId, name,
        (typeof b.description === 'string' && b.description.trim()) || null,
        category, amount, parishionerAmount, depositAmount,
        Boolean(b.pass_through),
        (typeof b.default_payee === 'string' && b.default_payee.trim()) || null,
        (typeof b.account_code === 'string' && b.account_code.trim()) || null,
        fundId,
        b.active === undefined ? true : b.active === true || b.active === 'true',
        Number.isInteger(b.sort_order) ? b.sort_order : 0,
      ]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('feeSchedules.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to create fee item' })
  }
})

// Closed allowlist. Money readers return undefined (invalid) / null (clear) /
// value; everything else follows the massIntentions convention.
const EDITABLE = {
  name:               v => (typeof v === 'string' && v.trim() && v.trim().length <= 120 ? v.trim() : undefined),
  description:        v => (v == null ? null : String(v).trim() || null),
  category:           v => (FEE_CATEGORIES.has(v) ? v : undefined),
  amount:             v => { const m = readMoney(v); return m === null ? undefined : m },
  parishioner_amount: readMoney,
  deposit_amount:     readMoney,
  pass_through:       v => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined),
  default_payee:      v => (v == null ? null : String(v).trim() || null),
  account_code:       v => (v == null ? null : String(v).trim() || null),
  active:             v => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined),
  sort_order:         v => (Number.isInteger(v) ? v : undefined),
}

// PATCH /api/fee-schedules/:id
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const sets = [], params = [id, req.organizationId]

  for (const [col, read] of Object.entries(EDITABLE)) {
    if (!(col in (req.body ?? {}))) continue
    const val = read(req.body[col])
    if (val === undefined) return res.status(400).json({ error: `Invalid ${col}` })
    params.push(val); sets.push(`${col} = $${params.length}`)
  }

  // fund_id is org-validated so it can't ride the generic allowlist.
  if ('fund_id' in (req.body ?? {})) {
    const fundId = req.body.fund_id == null ? null : Number(req.body.fund_id)
    if (fundId !== null && (!Number.isInteger(fundId) || fundId <= 0)) {
      return res.status(400).json({ error: 'Invalid fund_id' })
    }
    if (fundId !== null && !(await fundInOrg(fundId, req.organizationId))) {
      return res.status(400).json({ error: 'Fund not found' })
    }
    params.push(fundId); sets.push(`fund_id = $${params.length}`)
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' })

  try {
    const { rows } = await pool.query(
      `UPDATE ochr_fee_schedules SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND organization_id = $2
        RETURNING ${SELECT_COLS}`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Fee item not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('feeSchedules.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update fee item' })
  }
})

// DELETE /api/fee-schedules/:id — soft when referenced, hard when not.
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows: [ref] } = await pool.query(
      `SELECT 1 FROM ochr_invoice_lines
        WHERE fee_schedule_id = $1 AND organization_id = $2 LIMIT 1`,
      [id, req.organizationId]
    )
    if (ref) {
      const { rowCount } = await pool.query(
        `UPDATE ochr_fee_schedules SET active = FALSE, updated_at = NOW()
          WHERE id = $1 AND organization_id = $2`,
        [id, req.organizationId]
      )
      if (!rowCount) return res.status(404).json({ error: 'Fee item not found' })
      return res.json({ ok: true, deactivated: true })
    }
    const { rowCount } = await pool.query(
      `DELETE FROM ochr_fee_schedules WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Fee item not found' })
    res.json({ ok: true, deactivated: false })
  } catch (err) {
    monitor.error('feeSchedules.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete fee item' })
  }
})

export default router
