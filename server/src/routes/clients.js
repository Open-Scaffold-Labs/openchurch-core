import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam, parsePagination } from '../utils/params.js'
import { parseCSVToObjects } from '../utils/csv.js'

const router = Router()

// Columns the CSV importer accepts. Everything else in ochr_clients
// (notes, company, status, calendar_token, timestamps) is out of scope
// for a spreadsheet round-trip — those are app-managed fields.
const IMPORT_COLUMNS = ['name', 'email', 'phone', 'role', 'tags']

// Every query in this router filters by `organization_id = $orgId` so the
// signed-in user only ever sees their own church's members. The FK cascade
// on organization_id (see migrate.js) handles deletion cleanup; we rely on
// it rather than trying to delete cross-tenant rows from here.

// GET /api/clients/stats
router.get('/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                                             AS total,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')     AS new_this_week,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '14 days'
                           AND created_at <  NOW() - INTERVAL '7 days')     AS prev_week,
        COUNT(*) FILTER (WHERE status = 'active')                           AS active
      FROM ochr_clients
      WHERE organization_id = $1
    `, [req.organizationId])
    const r = rows[0]
    const total    = parseInt(r.total)
    const newWeek  = parseInt(r.new_this_week)
    const prevWeek = parseInt(r.prev_week)
    const active   = parseInt(r.active)
    const growth   = prevWeek === 0
      ? (newWeek > 0 ? 100 : 0)
      : Math.round(((newWeek - prevWeek) / prevWeek) * 100)
    res.json({ total, newWeek, active, growth })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load stats' })
  }
})

// GET /api/clients?search=&status=&role=
router.get('/', async (req, res) => {
  try {
    const { search, status, role } = req.query
    const where  = ['organization_id = $1']
    const params = [req.organizationId]
    if (search) {
      params.push(`%${search}%`)
      where.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length} OR company ILIKE $${params.length})`)
    }
    if (status) { params.push(status); where.push(`status = $${params.length}`) }
    if (role)   { params.push(role);   where.push(`role = $${params.length}`) }
    // Optional paging with a hard safety ceiling (see parsePagination) so
    // this list can never stream an unbounded roster. Response stays a bare
    // array — clients/tests depend on that shape.
    const { limit, offset } = parsePagination(req.query)
    params.push(limit, offset)
    const sql = `SELECT * FROM ochr_clients WHERE ${where.join(' AND ')} ORDER BY name LIMIT $${params.length - 1} OFFSET $${params.length}`
    const { rows } = await pool.query(sql, params)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load clients' })
  }
})

// GET /api/clients/:id
router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      'SELECT * FROM ochr_clients WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load client' })
  }
})

// GET /api/clients/:id/donations
// Sprint M / M.1 — full member profile page shows donation history.
// Matches by email (preferred — reliable identity) and falls back to
// donor_name equality when the member has no email or their gifts
// were logged as walk-ins.
//
// Returns: { lines: [...], total, gift_count, by: 'email'|'name' }
//
// Tenant scoping is double: the member must belong to the caller's
// org (404 otherwise), and the donations query also filters by
// organization_id. Two locks beats one for a sensitive read.
router.get('/:id/donations', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const memberQ = await pool.query(
      'SELECT name, email FROM ochr_clients WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!memberQ.rows.length) return res.status(404).json({ error: 'Member not found' })
    const member = memberQ.rows[0]

    // Prefer the email match — it's the giving-statements grouping
    // key and survives donor_name typos. Name match is the fallback
    // for members without an email on file.
    const useEmail = Boolean(member.email)
    const filter = useEmail
      ? 'donor_email = $2'
      : 'donor_name  = $2 AND donor_email IS NULL'
    const matchKey = useEmail ? member.email : member.name

    const { rows } = await pool.query(
      `SELECT id, donor_name, donor_email, donor_address,
              amount, category, method, date, notes
         FROM ochr_donations
        WHERE organization_id = $1
          AND ${filter}
          AND payment_status IS DISTINCT FROM 'refunded'
        ORDER BY date DESC, id DESC
        LIMIT 200`,
      [req.organizationId, matchKey]
    )

    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0)
    res.set('Cache-Control', 'private, max-age=30')
    res.json({
      by:         useEmail ? 'email' : 'name',
      match_key:  matchKey,
      lines:      rows,
      total:      Number(total.toFixed(2)),
      gift_count: rows.length,
    })
  } catch (err) {
    console.error('member donations failed:', err)
    res.status(500).json({ error: 'Failed to load member donations' })
  }
})

// GET /api/clients/:id/checkins (CHK.4)
// A member's attendance history — the services they checked in to,
// newest first. Tenant-scoped on both the member and the check-ins.
router.get('/:id/checkins', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const m = await pool.query(
      'SELECT 1 FROM ochr_clients WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!m.rows.length) return res.status(404).json({ error: 'Member not found' })

    const { rows } = await pool.query(
      `SELECT ci.id, ci.checked_in_at, ci.checked_out_at,
              e.id AS event_id, e.title AS event_title, e.date AS event_date
         FROM ochr_checkins ci
         JOIN ochr_calendar_events e ON e.id = ci.calendar_event_id
        WHERE ci.organization_id = $1 AND ci.client_id = $2
        ORDER BY e.date DESC, ci.checked_in_at DESC
        LIMIT 100`,
      [req.organizationId, id]
    )
    res.set('Cache-Control', 'private, max-age=30')
    res.json({ checkins: rows, count: rows.length })
  } catch (err) {
    console.error('member checkins failed:', err)
    res.status(500).json({ error: 'Failed to load attendance' })
  }
})

// POST /api/clients
router.post('/', async (req, res) => {
  try {
    const { name, company, email, phone, notes, status, role, tags, birth_date, joined_date, avatar } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
    const { rows } = await pool.query(
      `INSERT INTO ochr_clients (organization_id, name, company, email, phone, notes, status, role, tags, birth_date, joined_date, avatar)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.organizationId, name, company, email, phone, notes, status || 'active', role || 'Member', tags,
       birth_date || null, joined_date || null, avatar || null]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create client' })
  }
})

// POST /api/clients/import
// Bulk-imports members from a CSV body. Strict schema — the file must
// have columns matching IMPORT_COLUMNS (name required, rest optional).
// Rows whose email already exists in this org are silently skipped; the
// response reports totals so the UI can show "3 imported, 2 skipped."
router.post('/import', async (req, res) => {
  try {
    const { csv } = req.body ?? {}
    if (typeof csv !== 'string' || !csv.trim()) {
      return res.status(400).json({ error: 'No CSV content provided' })
    }

    const { headers, rows } = parseCSVToObjects(csv)
    if (!headers.length) {
      return res.status(400).json({ error: 'CSV appears to be empty' })
    }
    if (!headers.includes('name')) {
      return res.status(400).json({
        error: `CSV must include a "name" column. Expected columns: ${IMPORT_COLUMNS.join(', ')}.`
      })
    }
    const unknown = headers.filter(h => !IMPORT_COLUMNS.includes(h))
    if (unknown.length) {
      return res.status(400).json({
        error: `Unknown column(s): ${unknown.join(', ')}. Allowed: ${IMPORT_COLUMNS.join(', ')}.`
      })
    }
    if (!rows.length) {
      return res.status(400).json({ error: 'CSV has a header row but no data rows' })
    }

    // Pull existing emails in this org once so we can dedupe in memory
    // without hammering the DB per row. Lower-cased for case-insensitive
    // matching — "Ada@X.com" and "ada@x.com" are the same person.
    const { rows: existing } = await pool.query(
      `SELECT LOWER(email) AS email FROM ochr_clients
        WHERE organization_id = $1 AND email IS NOT NULL AND email <> ''`,
      [req.organizationId]
    )
    const existingEmails = new Set(existing.map(r => r.email))
    const seenInFile     = new Set()

    const results = { imported: 0, skipped: 0, errors: [] }

    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i]
      const line = i + 2 // +1 header row, +1 for 1-indexed line numbers

      const name = (row.name || '').trim()
      if (!name) {
        results.errors.push({ line, message: 'Missing name' })
        continue
      }

      const emailLower = (row.email || '').trim().toLowerCase()
      if (emailLower) {
        if (existingEmails.has(emailLower) || seenInFile.has(emailLower)) {
          results.skipped++
          continue
        }
        seenInFile.add(emailLower)
      }

      try {
        await pool.query(
          `INSERT INTO ochr_clients (organization_id, name, email, phone, role, tags, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
          [
            req.organizationId,
            name,
            row.email ? row.email.trim() : null,
            row.phone ? row.phone.trim() : null,
            row.role  ? row.role.trim()  : 'Member',
            row.tags  ? row.tags.trim()  : null,
          ]
        )
        results.imported++
      } catch (err) {
        console.error(`clients import: line ${line} insert failed:`, err)
        results.errors.push({ line, message: 'Database rejected the row' })
      }
    }

    res.json(results)
  } catch (err) {
    console.error('clients import failed:', err)
    res.status(500).json({ error: 'Failed to import members' })
  }
})

// PATCH /api/clients/:id
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    // Partial-update semantics (audit H1): only fields present in the
    // body are written — a one-field PATCH no longer nulls the rest of
    // the member's record. Allowlist is hardcoded; nothing from the
    // request reaches the SQL text.
    const PATCHABLE = ['name', 'company', 'email', 'phone', 'notes', 'status', 'role', 'tags', 'birth_date', 'joined_date', 'avatar']
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
      `UPDATE ochr_clients
          SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${vals.length + 1} AND organization_id = $${vals.length + 2} RETURNING *`,
      [...vals, id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update client' })
  }
})

// DELETE /api/clients/:id
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await pool.query(
      'DELETE FROM ochr_clients WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete client' })
  }
})

export default router
