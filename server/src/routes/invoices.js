// Parish invoice routes (BILL.1). The workbench for offerings & fees:
// weddings, funerals, quinceañeras, facility use, stipend pass-throughs.
//
//   GET    /api/invoices                     → list (?status=, ?category=, ?event=, ?client=, ?q=)
//   GET    /api/invoices/:id                 → one invoice, with lines + payments
//   POST   /api/invoices                     → create a DRAFT (optionally with lines)
//   PATCH  /api/invoices/:id                 → edit allowlisted fields (draft only)
//   PUT    /api/invoices/:id/lines           → replace the line set (draft only)
//   POST   /api/invoices/:id/issue           → assign the sequential number, freeze the draft
//   POST   /api/invoices/:id/waive           → forgive some/all of the balance (ADMIN — pastor discretion)
//   POST   /api/invoices/:id/payments        → record money in (deposit or balance)
//   POST   /api/invoices/:id/payments/:paymentId/refund → mark a payment refunded (ADMIN)
//   POST   /api/invoices/:id/cancel          → cancel (draft, or issued with no payments)
//   DELETE /api/invoices/:id                 → delete (draft only — issued invoices are history)
//
// Mount (app.js), after funds:
//   app.use('/api/invoices', requireAuth, writeGate, auditLog('invoice'), invoicesRouter)
//
// Principles carried from the 067–069 schema:
//   - Drafts are clay, issued invoices are stone. Amount-bearing fields are
//     only writable while status = 'draft'; after issue, money moves via
//     payments and waivers, never by editing the bill.
//   - The sequential number is assigned at ISSUE time inside a transaction
//     holding FOR UPDATE on the org row — the same ceremony as certificate
//     numbers. Gaps allowed (a cancelled issued invoice keeps its number),
//     duplicates impossible (UNIQUE org+no backs this up).
//   - Waiving is mercy, not discount math: admin-gated, reason required,
//     recorded with who. 'waived' is terminal and equal in dignity to 'paid'.
//   - amount_paid and status are DENORMALIZED and recomputed inside the same
//     transaction as every payment/refund/waive — this route is the single
//     writer, per the assessment-lines discipline.
//   - No dunning. There is no past_due status and nothing here nags anyone.
//
// All money math happens in integer cents (Postgres NUMERIC arrives as
// strings; floats drift) and is written back as x.toFixed(2).

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam, parsePagination } from '../utils/params.js'
import { requireRole } from '../middleware/auth.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

export const INVOICE_STATUSES = new Set([
  'draft', 'issued', 'partially_paid', 'paid', 'waived', 'cancelled',
])
export const INVOICE_CATEGORIES = new Set([
  'wedding', 'funeral', 'baptism', 'quinceanera', 'facility', 'stipend', 'other',
])
export const PAYMENT_METHODS = new Set(['cash', 'check', 'card', 'online', 'other'])

// ---------------------------------------------------------------- money ----

// NUMERIC(10,2) → integer cents. Accepts numbers or numeric strings from
// pg / request bodies; returns null for garbage so callers can 400.
function toCents(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}
const fromCents = (c) => (c / 100).toFixed(2)

// ------------------------------------------------------------ validators ----

async function clientInOrg(db, clientId, orgId) {
  const { rows } = await db.query(
    'SELECT 1 FROM ochr_clients WHERE id = $1 AND organization_id = $2',
    [clientId, orgId]
  )
  return rows.length > 0
}

async function eventInOrg(db, eventId, orgId) {
  const { rows } = await db.query(
    'SELECT 1 FROM ochr_calendar_events WHERE id = $1 AND organization_id = $2',
    [eventId, orgId]
  )
  return rows.length > 0
}

async function fundInOrg(db, fundId, orgId) {
  const { rows } = await db.query(
    'SELECT 1 FROM ochr_funds WHERE id = $1 AND organization_id = $2',
    [fundId, orgId]
  )
  return rows.length > 0
}

// Validate + normalize a lines array from the request body. Each line may
// reference a fee_schedule item (org-checked; supplies defaults for
// description, price — parishioner price when the payer is a linked member —
// routing, pass-through) or be fully ad hoc. Returns { lines, subtotalCents }
// or { error } for the caller to 400 with.
async function normalizeLines(db, rawLines, orgId, { parishioner = false } = {}) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return { error: 'At least one line is required' }
  }
  if (rawLines.length > 50) return { error: 'Too many lines' }

  const lines = []
  let subtotalCents = 0

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? {}
    let fee = null

    if (raw.fee_schedule_id != null) {
      const feeId = Number(raw.fee_schedule_id)
      if (!Number.isInteger(feeId) || feeId <= 0) return { error: `Line ${i + 1}: invalid fee_schedule_id` }
      const { rows } = await db.query(
        `SELECT id, name, amount, parishioner_amount, pass_through, default_payee,
                account_code, fund_id
           FROM ochr_fee_schedules WHERE id = $1 AND organization_id = $2 AND active`,
        [feeId, orgId]
      )
      if (!rows.length) return { error: `Line ${i + 1}: fee item not found` }
      fee = rows[0]
    }

    const description = (typeof raw.description === 'string' && raw.description.trim())
      || fee?.name
    if (!description) return { error: `Line ${i + 1}: description is required` }

    const qtyN = raw.qty == null ? 1 : Number(raw.qty)
    if (!Number.isFinite(qtyN) || qtyN <= 0 || qtyN > 999) {
      return { error: `Line ${i + 1}: invalid qty` }
    }

    // Price precedence: explicit unit_amount → parishioner price (when the
    // payer is a linked member and the fee has one) → standard fee amount.
    let unitCents = toCents(raw.unit_amount)
    if (unitCents === null && fee) {
      const feePrice = (parishioner && fee.parishioner_amount != null)
        ? fee.parishioner_amount : fee.amount
      unitCents = toCents(feePrice)
    }
    if (unitCents === null) return { error: `Line ${i + 1}: unit_amount is required` }

    const amountCents = Math.round(unitCents * qtyN)
    subtotalCents += amountCents

    const fundId = raw.fund_id ?? fee?.fund_id ?? null
    if (fundId != null && !(await fundInOrg(db, Number(fundId), orgId))) {
      return { error: `Line ${i + 1}: fund not found` }
    }

    lines.push({
      fee_schedule_id: fee?.id ?? null,
      description,
      qty: qtyN,
      unit_amount: fromCents(unitCents),
      amount: fromCents(amountCents),
      pass_through: raw.pass_through != null ? Boolean(raw.pass_through) : Boolean(fee?.pass_through),
      payee: (typeof raw.payee === 'string' && raw.payee.trim()) || fee?.default_payee || null,
      account_code: (typeof raw.account_code === 'string' && raw.account_code.trim()) || fee?.account_code || null,
      fund_id: fundId,
      sort_order: i,
    })
  }

  return { lines, subtotalCents }
}

// ------------------------------------------------------------- recompute ----

// Recompute amount_paid + status from the payments table. Runs inside the
// caller's transaction; the row must already be locked (FOR UPDATE) by the
// caller. Terminal states (waived, cancelled, draft) keep their status —
// only issued/partially_paid/paid float with the payment sum.
async function recomputePaid(db, invoiceId, orgId) {
  const { rows: [inv] } = await db.query(
    `SELECT status, total FROM ochr_invoices WHERE id = $1 AND organization_id = $2`,
    [invoiceId, orgId]
  )
  const { rows: [sum] } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid
       FROM ochr_invoice_payments
      WHERE invoice_id = $1 AND organization_id = $2 AND refunded_at IS NULL`,
    [invoiceId, orgId]
  )
  const paidCents = toCents(sum.paid) ?? 0
  const totalCents = toCents(inv.total) ?? 0

  let status = inv.status
  if (['issued', 'partially_paid', 'paid'].includes(status)) {
    status = paidCents <= 0 ? 'issued'
      : paidCents < totalCents ? 'partially_paid'
      : 'paid'
  }

  await db.query(
    `UPDATE ochr_invoices SET amount_paid = $3, status = $4, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2`,
    [invoiceId, orgId, fromCents(paidCents), status]
  )
  return { paidCents, totalCents, status }
}

// ----------------------------------------------------------------- reads ----

const SELECT_COLS = `i.id, i.invoice_no, i.title, i.category, i.status,
                     i.client_id, i.payer_name, i.payer_email, i.payer_phone,
                     i.calendar_event_id,
                     i.subtotal, i.waived_amount, i.total, i.amount_paid,
                     i.waiver_reason, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
                     i.issued_at, i.notes, i.created_at, i.updated_at,
                     c.name AS payer_member_name,
                     e.title AS event_title, e.date AS event_date`

const FROM_JOIN = `FROM ochr_invoices i
                   LEFT JOIN ochr_clients c
                     ON c.id = i.client_id AND c.organization_id = i.organization_id
                   LEFT JOIN ochr_calendar_events e
                     ON e.id = i.calendar_event_id AND e.organization_id = i.organization_id`

// GET /api/invoices — the workbench list.
router.get('/', async (req, res) => {
  const { limit, offset } = parsePagination(req.query)
  try {
    const where = ['i.organization_id = $1']
    const params = [req.organizationId]

    if (typeof req.query.status === 'string' && INVOICE_STATUSES.has(req.query.status)) {
      params.push(req.query.status); where.push(`i.status = $${params.length}`)
    }
    if (typeof req.query.category === 'string' && INVOICE_CATEGORIES.has(req.query.category)) {
      params.push(req.query.category); where.push(`i.category = $${params.length}`)
    }
    const eventId = Number(req.query.event)
    if (Number.isInteger(eventId) && eventId > 0) {
      params.push(eventId); where.push(`i.calendar_event_id = $${params.length}`)
    }
    const clientId = Number(req.query.client)
    if (Number.isInteger(clientId) && clientId > 0) {
      params.push(clientId); where.push(`i.client_id = $${params.length}`)
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q) {
      const escaped = q.replace(/[\\%_]/g, ch => `\\${ch}`)
      params.push(`%${escaped}%`)
      where.push(`(i.payer_name ILIKE $${params.length} OR i.title ILIKE $${params.length} OR i.invoice_no ILIKE $${params.length})`)
    }

    params.push(limit, offset)
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN}
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    res.json(rows)
  } catch (err) {
    monitor.error('invoices.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load invoices' })
  }
})

// GET /api/invoices/:id — detail with lines + payments.
router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows: [invoice] } = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN}
        WHERE i.id = $1 AND i.organization_id = $2`,
      [id, req.organizationId]
    )
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })

    const [{ rows: lines }, { rows: payments }] = await Promise.all([
      pool.query(
        `SELECT id, fee_schedule_id, description, qty, unit_amount, amount,
                pass_through, payee, account_code, fund_id, sort_order
           FROM ochr_invoice_lines
          WHERE invoice_id = $1 AND organization_id = $2
          ORDER BY sort_order, id`,
        [id, req.organizationId]
      ),
      pool.query(
        `SELECT id, amount, method, payment_ref, is_deposit, received_at,
                received_by, refunded_at, refund_ref, notes
           FROM ochr_invoice_payments
          WHERE invoice_id = $1 AND organization_id = $2
          ORDER BY received_at, id`,
        [id, req.organizationId]
      ),
    ])
    res.json({ ...invoice, lines, payments })
  } catch (err) {
    monitor.error('invoices.get', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load invoice' })
  }
})

// ---------------------------------------------------------------- writes ----

// POST /api/invoices — create a draft.
router.post('/', async (req, res) => {
  const b = req.body ?? {}
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title) return res.status(400).json({ error: 'Title is required' })

  const category = INVOICE_CATEGORIES.has(b.category) ? b.category : 'other'

  const clientId = b.client_id == null ? null : Number(b.client_id)
  if (clientId !== null && (!Number.isInteger(clientId) || clientId <= 0)) {
    return res.status(400).json({ error: 'Invalid client_id' })
  }
  const eventId = b.calendar_event_id == null ? null : Number(b.calendar_event_id)
  if (eventId !== null && (!Number.isInteger(eventId) || eventId <= 0)) {
    return res.status(400).json({ error: 'Invalid calendar_event_id' })
  }

  try {
    if (clientId !== null && !(await clientInOrg(pool, clientId, req.organizationId))) {
      return res.status(400).json({ error: 'Member not found' })
    }
    if (eventId !== null && !(await eventInOrg(pool, eventId, req.organizationId))) {
      return res.status(400).json({ error: 'Event not found' })
    }

    // Payer name falls back to the linked member's name.
    let payerName = typeof b.payer_name === 'string' ? b.payer_name.trim() : ''
    if (!payerName && clientId !== null) {
      const { rows } = await pool.query(
        'SELECT name FROM ochr_clients WHERE id = $1 AND organization_id = $2',
        [clientId, req.organizationId]
      )
      payerName = rows[0]?.name ?? ''
    }
    if (!payerName) return res.status(400).json({ error: 'Payer name is required' })

    const norm = await normalizeLines(pool, b.lines, req.organizationId, {
      parishioner: clientId !== null,
    })
    if (norm.error) return res.status(400).json({ error: norm.error })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [invoice] } = await client.query(
        `INSERT INTO ochr_invoices
           (organization_id, title, category, client_id, payer_name, payer_email,
            payer_phone, calendar_event_id, status, subtotal, waived_amount, total,
            due_date, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, 0, $9, $10, $11, $12)
         RETURNING id`,
        [
          req.organizationId, title, category, clientId, payerName,
          (typeof b.payer_email === 'string' && b.payer_email.trim()) || null,
          (typeof b.payer_phone === 'string' && b.payer_phone.trim()) || null,
          eventId, fromCents(norm.subtotalCents),
          b.due_date || null,
          (typeof b.notes === 'string' && b.notes.trim()) || null,
          req.user.id,
        ]
      )
      for (const l of norm.lines) {
        await client.query(
          `INSERT INTO ochr_invoice_lines
             (organization_id, invoice_id, fee_schedule_id, description, qty,
              unit_amount, amount, pass_through, payee, account_code, fund_id, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [req.organizationId, invoice.id, l.fee_schedule_id, l.description, l.qty,
           l.unit_amount, l.amount, l.pass_through, l.payee, l.account_code,
           l.fund_id, l.sort_order]
        )
      }
      await client.query('COMMIT')
      res.status(201).json({ id: invoice.id })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    monitor.error('invoices.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to create invoice' })
  }
})

// Closed allowlist for PATCH — metadata only; money lives in lines/payments.
const EDITABLE = {
  title:       v => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
  category:    v => (INVOICE_CATEGORIES.has(v) ? v : undefined),
  payer_name:  v => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
  payer_email: v => (v == null ? null : String(v).trim() || null),
  payer_phone: v => (v == null ? null : String(v).trim() || null),
  due_date:    v => (v === null || v === '' ? null : String(v)),
  notes:       v => (v == null ? null : String(v).trim() || null),
}

// PATCH /api/invoices/:id — draft-only metadata edits.
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const sets = [], params = [id, req.organizationId]
  for (const [col, read] of Object.entries(EDITABLE)) {
    if (!(col in (req.body ?? {}))) continue
    const val = read(req.body[col])
    if (val === undefined) return res.status(400).json({ error: `Invalid ${col}` })
    params.push(val); sets.push(`${col} = $${params.length}`)
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' })

  try {
    const { rowCount } = await pool.query(
      `UPDATE ochr_invoices SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND status = 'draft'`,
      params
    )
    if (!rowCount) return res.status(409).json({ error: 'Invoice not found or not a draft' })
    res.json({ ok: true })
  } catch (err) {
    monitor.error('invoices.patch', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update invoice' })
  }
})

// PUT /api/invoices/:id/lines — replace the whole line set (draft only).
router.put('/:id/lines', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [inv] } = await client.query(
      `SELECT client_id FROM ochr_invoices
        WHERE id = $1 AND organization_id = $2 AND status = 'draft' FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!inv) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Invoice not found or not a draft' })
    }

    const norm = await normalizeLines(client, req.body?.lines, req.organizationId, {
      parishioner: inv.client_id !== null,
    })
    if (norm.error) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: norm.error })
    }

    await client.query(
      `DELETE FROM ochr_invoice_lines WHERE invoice_id = $1 AND organization_id = $2`,
      [id, req.organizationId]
    )
    for (const l of norm.lines) {
      await client.query(
        `INSERT INTO ochr_invoice_lines
           (organization_id, invoice_id, fee_schedule_id, description, qty,
            unit_amount, amount, pass_through, payee, account_code, fund_id, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [req.organizationId, id, l.fee_schedule_id, l.description, l.qty,
         l.unit_amount, l.amount, l.pass_through, l.payee, l.account_code,
         l.fund_id, l.sort_order]
      )
    }
    await client.query(
      `UPDATE ochr_invoices SET subtotal = $3, total = $3, updated_at = NOW()
        WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId, fromCents(norm.subtotalCents)]
    )
    await client.query('COMMIT')
    res.json({ ok: true, subtotal: fromCents(norm.subtotalCents) })
  } catch (err) {
    await client.query('ROLLBACK')
    monitor.error('invoices.lines', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update lines' })
  } finally {
    client.release()
  }
})

// POST /api/invoices/:id/issue — the numbering ceremony.
router.post('/:id/issue', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lock the org row: it owns the counter. Then the invoice.
    const { rows: [org] } = await client.query(
      `SELECT invoice_next_no FROM ochr_organizations WHERE id = $1 FOR UPDATE`,
      [req.organizationId]
    )
    const { rows: [inv] } = await client.query(
      `SELECT status, total FROM ochr_invoices
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!inv) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Invoice not found' })
    }
    if (inv.status !== 'draft') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Only drafts can be issued' })
    }
    if ((toCents(inv.total) ?? 0) <= 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Cannot issue a zero invoice — waive it instead' })
    }

    const invoiceNo = String(org.invoice_next_no)
    await client.query(
      `UPDATE ochr_organizations SET invoice_next_no = invoice_next_no + 1 WHERE id = $1`,
      [req.organizationId]
    )
    await client.query(
      `UPDATE ochr_invoices
          SET invoice_no = $3, status = 'issued', issued_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId, invoiceNo]
    )
    await client.query('COMMIT')
    res.json({ ok: true, invoice_no: invoiceNo })
  } catch (err) {
    await client.query('ROLLBACK')
    monitor.error('invoices.issue', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to issue invoice' })
  } finally {
    client.release()
  }
})

// POST /api/invoices/:id/waive — pastor's discretion. Admin only; reason
// required. Amount optional: omitted = forgive the remaining balance.
router.post('/:id/waive', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
  if (!reason) return res.status(400).json({ error: 'A reason is required to waive' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [inv] } = await client.query(
      `SELECT status, subtotal, waived_amount, total, amount_paid
         FROM ochr_invoices WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!inv) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Invoice not found' })
    }
    if (!['draft', 'issued', 'partially_paid'].includes(inv.status)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: `Cannot waive a ${inv.status} invoice` })
    }

    const subtotalCents = toCents(inv.subtotal) ?? 0
    const paidCents = toCents(inv.amount_paid) ?? 0
    const alreadyWaivedCents = toCents(inv.waived_amount) ?? 0
    const remainingCents = subtotalCents - alreadyWaivedCents - paidCents

    let waiveCents = req.body?.amount == null ? remainingCents : toCents(req.body.amount)
    if (waiveCents === null || waiveCents <= 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Invalid waive amount' })
    }
    if (waiveCents > remainingCents) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Waive amount exceeds the remaining balance' })
    }

    const newWaivedCents = alreadyWaivedCents + waiveCents
    const newTotalCents = subtotalCents - newWaivedCents
    // Fully forgiven with nothing paid → 'waived'; otherwise the total
    // shrank and the paid/issued status recomputes against it.
    await client.query(
      `UPDATE ochr_invoices
          SET waived_amount = $3, total = $4,
              waiver_reason = $5, waived_by = $6,
              status = CASE WHEN $4::numeric <= amount_paid AND amount_paid = 0 THEN 'waived'
                            WHEN status = 'draft' THEN 'draft'
                            ELSE status END,
              updated_at = NOW()
        WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId, fromCents(newWaivedCents), fromCents(newTotalCents),
       reason, req.user.id]
    )
    if (inv.status !== 'draft') await recomputePaid(client, id, req.organizationId)
    await client.query('COMMIT')
    res.json({ ok: true, waived: fromCents(waiveCents), total: fromCents(newTotalCents) })
  } catch (err) {
    await client.query('ROLLBACK')
    monitor.error('invoices.waive', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to waive' })
  } finally {
    client.release()
  }
})

// POST /api/invoices/:id/payments — record money in.
router.post('/:id/payments', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const b = req.body ?? {}
  const amountCents = toCents(b.amount)
  if (amountCents === null || amountCents <= 0) {
    return res.status(400).json({ error: 'Invalid amount' })
  }
  const method = PAYMENT_METHODS.has(b.method) ? b.method : 'cash'

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [inv] } = await client.query(
      `SELECT status, total, amount_paid FROM ochr_invoices
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!inv) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Invoice not found' })
    }
    if (!['issued', 'partially_paid'].includes(inv.status)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: `Cannot record a payment on a ${inv.status} invoice` })
    }
    const remainingCents = (toCents(inv.total) ?? 0) - (toCents(inv.amount_paid) ?? 0)
    if (amountCents > remainingCents) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Payment exceeds the remaining balance' })
    }

    const { rows: [payment] } = await client.query(
      `INSERT INTO ochr_invoice_payments
         (organization_id, invoice_id, amount, method, payment_ref, is_deposit,
          received_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [req.organizationId, id, fromCents(amountCents), method,
       (typeof b.payment_ref === 'string' && b.payment_ref.trim()) || null,
       Boolean(b.is_deposit), req.user.id,
       (typeof b.notes === 'string' && b.notes.trim()) || null]
    )
    const { status } = await recomputePaid(client, id, req.organizationId)
    await client.query('COMMIT')
    res.status(201).json({ id: payment.id, status })
  } catch (err) {
    await client.query('ROLLBACK')
    monitor.error('invoices.payment', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to record payment' })
  } finally {
    client.release()
  }
})

// POST /api/invoices/:id/payments/:paymentId/refund — mark refunded (ADMIN).
router.post('/:id/payments/:paymentId/refund', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const paymentId = requireIntParam(req, res, 'paymentId'); if (paymentId === null) return

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT 1 FROM ochr_invoices WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, req.organizationId]
    )
    const { rowCount } = await client.query(
      `UPDATE ochr_invoice_payments
          SET refunded_at = NOW(), refund_ref = $4
        WHERE id = $3 AND invoice_id = $1 AND organization_id = $2 AND refunded_at IS NULL`,
      [id, req.organizationId, paymentId,
       (typeof req.body?.refund_ref === 'string' && req.body.refund_ref.trim()) || null]
    )
    if (!rowCount) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Payment not found or already refunded' })
    }
    const { status } = await recomputePaid(client, id, req.organizationId)
    await client.query('COMMIT')
    res.json({ ok: true, status })
  } catch (err) {
    await client.query('ROLLBACK')
    monitor.error('invoices.refund', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to refund payment' })
  } finally {
    client.release()
  }
})

// POST /api/invoices/:id/cancel — drafts always; issued only if untouched.
router.post('/:id/cancel', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rowCount } = await pool.query(
      `UPDATE ochr_invoices SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND organization_id = $2
          AND (status = 'draft' OR (status = 'issued' AND amount_paid = 0))`,
      [id, req.organizationId]
    )
    if (!rowCount) {
      return res.status(409).json({ error: 'Only drafts or unpaid issued invoices can be cancelled' })
    }
    res.json({ ok: true })
  } catch (err) {
    monitor.error('invoices.cancel', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to cancel invoice' })
  }
})

// DELETE /api/invoices/:id — drafts only; issued invoices are history.
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ochr_invoices
        WHERE id = $1 AND organization_id = $2 AND status = 'draft'`,
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(409).json({ error: 'Only drafts can be deleted' })
    res.json({ ok: true })
  } catch (err) {
    monitor.error('invoices.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete invoice' })
  }
})

export default router
