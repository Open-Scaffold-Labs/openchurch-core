import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'

// Staff rows carry a GENERATED search_vec. The list endpoint computes its
// own projection and never had the problem; create and update said
// `RETURNING *` and shipped the tsvector on every response — measured 27 Aug
// against the running server.
const STAFF_PUBLIC_COLUMNS = [
  'id', 'organization_id', 'name', 'role', 'pay_rate', 'status', 'created_at',
].join(', ')

const router = Router()

// Verify a staff_id belongs to the caller's org before attaching a shift
// to it. Prevents cross-tenant shift injection by id guessing.
async function assertStaffInOrg(db, staffId, orgId) {
  const { rows } = await db.query(
    'SELECT 1 FROM ochr_payroll_staff WHERE id = $1 AND organization_id = $2',
    [staffId, orgId]
  )
  return rows.length > 0
}

// GET /api/payroll/staff  — list all staff with period totals
router.get('/staff', async (req, res) => {
  try {
    const { start, end } = req.query
    const params = [req.organizationId]
    const dateFilter = start && end
      ? (params.push(start, end), 'AND sh.date >= $2 AND sh.date <= $3')
      : ''
    const { rows } = await pool.query(`
      SELECT
        s.id, s.name, s.role, s.pay_rate, s.status,
        COALESCE(SUM(sh.hours), 0)::NUMERIC(8,2)              AS hours_worked,
        COALESCE(SUM(sh.hours * s.pay_rate), 0)::NUMERIC(10,2) AS total_pay
      FROM ochr_payroll_staff s
      LEFT JOIN ochr_payroll_shifts sh
        ON sh.staff_id = s.id ${dateFilter}
      WHERE s.organization_id = $1
      GROUP BY s.id
      ORDER BY s.name
    `, params)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load staff' })
  }
})

// POST /api/payroll/staff
router.post('/staff', async (req, res) => {
  try {
    const { name, role, pay_rate, status } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
    const { rows } = await pool.query(
      `INSERT INTO ochr_payroll_staff (organization_id, name, role, pay_rate, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${STAFF_PUBLIC_COLUMNS}`,
      [req.organizationId, name, role || 'Staff', pay_rate ?? 0, status || 'active']
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create staff member' })
  }
})

// PATCH /api/payroll/staff/:id
router.patch('/staff/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { name, role, pay_rate, status } = req.body
    const { rows } = await pool.query(
      `UPDATE ochr_payroll_staff SET name=$1, role=$2, pay_rate=$3, status=$4
       WHERE id = $5 AND organization_id = $6 RETURNING ${STAFF_PUBLIC_COLUMNS}`,
      [name, role, pay_rate, status, id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update staff member' })
  }
})

// DELETE /api/payroll/staff/:id
router.delete('/staff/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await pool.query(
      'DELETE FROM ochr_payroll_staff WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete staff member' })
  }
})

// GET /api/payroll/shifts?start=&end=&staff_id=
// Shifts inherit their org from the staff row they belong to — we join
// through payroll_staff and filter on s.organization_id.
router.get('/shifts', async (req, res) => {
  try {
    const { start, end, staff_id } = req.query
    const where  = ['s.organization_id = $1']
    const params = [req.organizationId]
    if (start)    { params.push(start);    where.push(`sh.date >= $${params.length}`) }
    if (end)      { params.push(end);      where.push(`sh.date <= $${params.length}`) }
    if (staff_id) { params.push(staff_id); where.push(`sh.staff_id = $${params.length}`) }
    const { rows } = await pool.query(`
      SELECT sh.*, s.name AS staff_name, s.role AS staff_role, s.pay_rate,
             (sh.hours * s.pay_rate)::NUMERIC(10,2) AS shift_pay
      FROM ochr_payroll_shifts sh
      JOIN ochr_payroll_staff s ON s.id = sh.staff_id
      WHERE ${where.join(' AND ')}
      ORDER BY sh.date DESC, sh.created_at DESC
    `, params)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load shifts' })
  }
})

// POST /api/payroll/shifts
router.post('/shifts', async (req, res) => {
  try {
    const { staff_id, date, hours, type, notes } = req.body
    if (!staff_id || !date || !hours) return res.status(400).json({ error: 'staff_id, date, and hours are required' })
    if (!(await assertStaffInOrg(pool, staff_id, req.organizationId))) {
      return res.status(404).json({ error: 'Staff member not found' })
    }
    const { rows } = await pool.query(
      `INSERT INTO ochr_payroll_shifts (staff_id, date, hours, type, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [staff_id, date, hours, type || 'service', notes]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create shift' })
  }
})

// DELETE /api/payroll/shifts/:id
// Join through staff to ensure the shift belongs to this org before delete.
router.delete('/shifts/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await pool.query(
      `DELETE FROM ochr_payroll_shifts
       WHERE id = $1
         AND staff_id IN (SELECT id FROM ochr_payroll_staff WHERE organization_id = $2)`,
      [id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete shift' })
  }
})

// GET /api/payroll/summary?start=&end=
router.get('/summary', async (req, res) => {
  try {
    const { start, end } = req.query
    const params = [req.organizationId]
    const dateFilter = start && end
      ? (params.push(start, end), 'AND sh.date >= $2 AND sh.date <= $3')
      : ''
    const { rows } = await pool.query(`
      SELECT
        COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'active')            AS staff_count,
        COALESCE(SUM(sh.hours), 0)::NUMERIC(8,2)                           AS total_hours,
        COALESCE(SUM(sh.hours * s.pay_rate), 0)::NUMERIC(10,2)             AS total_payroll,
        COUNT(sh.id)                                                        AS shift_count
      FROM ochr_payroll_staff s
      LEFT JOIN ochr_payroll_shifts sh
        ON sh.staff_id = s.id ${dateFilter}
      WHERE s.organization_id = $1
    `, params)
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load summary' })
  }
})

export default router
