// Sacramental register routes (SAC.1). Tenant-scoped records of the
// sacraments a member has received — the parish register.
//
//   GET    /api/sacraments?client_id=ID  → one member's timeline
//   GET    /api/sacraments                → parish-wide register (paginated)
//   POST   /api/sacraments                → add a record
//   PATCH  /api/sacraments/:id            → edit allowlisted fields
//   DELETE /api/sacraments/:id            → remove a record
//
// All queries scope on organization_id. Writes are staff/admin (writeGate at
// the mount); viewers read. When a record is linked to a member, the member
// is validated against the caller's org first, so an admin can't attach a
// record to another church's member by guessing an id.

import { Router } from 'express'
import pool from '../db.js'
import { requireIntParam, parsePagination } from '../utils/params.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

export const SACRAMENT_TYPES = new Set([
  'baptism',
  'reconciliation',
  'first_communion',
  'confirmation',
  'marriage',
  'holy_orders',
  'anointing',
  'burial',   // a rite, not a sacrament — but the register records it (070)
])

// Columns a PATCH may touch, and how to read each from the body. Closed
// allowlist so a caller can never set organization_id or an unknown column.
const EDITABLE = {
  type:           v => (SACRAMENT_TYPES.has(v) ? v : undefined),
  date:           v => (v === null || v === '' ? null : String(v)),
  minister:       v => (v == null ? null : String(v).trim() || null),
  place:          v => (v == null ? null : String(v).trim() || null),
  certificate_no: v => (v == null ? null : String(v).trim() || null),
  notes:          v => (v == null ? null : String(v).trim() || null),
}

// Confirm a client belongs to the caller's org. Returns true/false.
async function clientInOrg(clientId, orgId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM ochr_clients WHERE id = $1 AND organization_id = $2',
    [clientId, orgId]
  )
  return rows.length > 0
}

// meta_attributes (SAC.5) — closed allowlist of structured sub-fields.
// Anything else in the payload is rejected, not silently stored: the
// register is canonical and doesn't grow junk keys.
//   godparents / sponsors — arrays of non-empty names (≤10, each ≤200 chars)
//   spouse_client_id      — member id, validated against the caller's org
// Returns { value } (a plain object, possibly {}) or { error }.
async function parseMetaAttributes(input, orgId) {
  if (input == null) return { value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'meta_attributes must be an object' }
  }
  const out = {}
  for (const [key, val] of Object.entries(input)) {
    if (key === 'godparents' || key === 'sponsors') {
      if (val == null) continue
      if (!Array.isArray(val) || val.length > 10) {
        return { error: `${key} must be an array of at most 10 names` }
      }
      const names = val.map(v => String(v ?? '').trim()).filter(Boolean)
      if (names.some(n => n.length > 200)) return { error: `${key} names must be 200 characters or fewer` }
      if (names.length) out[key] = names
    } else if (key === 'spouse_client_id') {
      if (val == null) continue
      const cid = Number(val)
      if (!Number.isInteger(cid) || cid <= 0 || !(await clientInOrg(cid, orgId))) {
        return { error: 'spouse_client_id must be a member of your church' }
      }
      out.spouse_client_id = cid
    } else {
      return { error: `Unknown meta_attributes key: ${key}` }
    }
  }
  return { value: out }
}

// One list of register columns, in one place. This file used to carry three
// hand-written copies, and two of them had silently dropped meta_attributes —
// so godparents and sponsors saved fine, echoed back fine on write, and then
// vanished on reload. The certificate could never print them.
//
// `date` is special-cased because it needs to_char() to survive the wire as a
// plain YYYY-MM-DD string rather than a timestamp the client has to re-parse.
const REGISTER_COLS = [
  'id', 'client_id', 'type', 'minister', 'place',
  'certificate_no', 'notes', 'meta_attributes', 'created_at', 'updated_at',
]
const cols = (p = '') =>
  [`to_char(${p}date, 'YYYY-MM-DD') AS date`, ...REGISTER_COLS.map(c => `${p}${c}`)].join(', ')

// Unprefixed, for INSERT/UPDATE ... RETURNING.
const SELECT_COLS = cols()
// Prefixed, for the queries that JOIN ochr_clients to resolve member_name.
const SELECT_COLS_S = cols('s.')

// GET /api/sacraments?client_id=ID  (member timeline)
// GET /api/sacraments               (parish register, paginated, ?type= filter)
router.get('/', async (req, res) => {
  const { limit, offset } = parsePagination(req.query)
  const clientId = req.query.client_id != null ? Number(req.query.client_id) : null
  const typeFilter = typeof req.query.type === 'string' && SACRAMENT_TYPES.has(req.query.type)
    ? req.query.type : null

  try {
    const where = ['s.organization_id = $1']
    const params = [req.organizationId]
    if (Number.isInteger(clientId) && clientId > 0) {
      params.push(clientId); where.push(`s.client_id = $${params.length}`)
    }
    if (typeFilter) {
      params.push(typeFilter); where.push(`s.type = $${params.length}`)
    }
    // Keyword search across the member's name, minister, place, and
    // certificate number. LIKE metacharacters are escaped so a stray % or _
    // is treated literally.
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q) {
      const escaped = q.replace(/[\\%_]/g, ch => `\\${ch}`)
      params.push(`%${escaped}%`)
      const p = `$${params.length}`
      where.push(`(c.name ILIKE ${p} OR s.minister ILIKE ${p} OR s.place ILIKE ${p} OR s.certificate_no ILIKE ${p})`)
    }
    params.push(limit, offset)
    // LEFT JOIN so the parish-register view can show the member's name; the
    // join is org-matched so a detached (client_id NULL) record just yields a
    // null name rather than crossing tenants.
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS_S},
              COALESCE(c.name, s.member_name) AS member_name
         FROM ochr_sacramental_records s
         LEFT JOIN ochr_clients c
                ON c.id = s.client_id AND c.organization_id = s.organization_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.date DESC NULLS LAST, s.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    res.json({ records: rows })
  } catch (err) {
    monitor.error('sacraments.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load sacramental records' })
  }
})

// GET /api/sacraments/anniversaries?days=30 — upcoming sacramental
// anniversaries for ACTIVE, linked members, within the next N days. Only
// full-year anniversaries (years >= 1) count. Defined BEFORE '/:id' so the
// literal path isn't swallowed by the id param.
router.get('/anniversaries', async (req, res) => {
  let days = Number.parseInt(req.query.days, 10)
  if (!Number.isInteger(days) || days < 1) days = 30
  if (days > 90) days = 90

  try {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const end = new Date(today); end.setDate(end.getDate() + days)

    // The distinct calendar months the window touches (≤ 4), so the scan is
    // bounded rather than reading the whole register.
    const months = new Set()
    for (let d = new Date(today); d <= end; d.setDate(d.getDate() + 1)) months.add(d.getMonth() + 1)

    const { rows } = await pool.query(
      `SELECT s.id, s.client_id AS member_id, s.type,
              to_char(s.date, 'YYYY-MM-DD') AS date, c.name AS member_name
         FROM ochr_sacramental_records s
         JOIN ochr_clients c
           ON c.id = s.client_id AND c.organization_id = s.organization_id AND c.status = 'active'
        WHERE s.organization_id = $1 AND s.date IS NOT NULL
          AND s.type <> 'burial'  -- no burial "anniversaries" — see migration 070
          AND EXTRACT(MONTH FROM s.date) = ANY($2::int[])
        LIMIT 2000`,
      [req.organizationId, [...months]]
    )

    const pad = n => String(n).padStart(2, '0')
    const out = []
    for (const r of rows) {
      const [y, m, d] = r.date.split('-').map(Number)
      let annYear = today.getFullYear()
      let next = new Date(annYear, m - 1, d); next.setHours(0, 0, 0, 0)
      if (next < today) { annYear += 1; next = new Date(annYear, m - 1, d); next.setHours(0, 0, 0, 0) }
      const years = annYear - y
      if (years < 1) continue            // future-dated or same-year: not an anniversary yet
      if (next >= today && next <= end) {
        out.push({
          id: r.id, member_id: r.member_id, member_name: r.member_name,
          type: r.type, date: r.date,
          next_date: `${annYear}-${pad(m)}-${pad(d)}`, years,
        })
      }
    }
    out.sort((a, b) => (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : 0))
    res.json({ anniversaries: out })
  } catch (err) {
    monitor.error('sacraments.anniversaries', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load anniversaries' })
  }
})

// ── Register digitization drafts (SAC.6) ─────────────────────────
// Staging area for CSV/OCR imports of the paper register. Drafts are
// reviewed side-by-side and only an explicit commit writes into the
// permanent register. All literal /drafts paths sit above '/:id'.

const DRAFT_SOURCES  = new Set(['csv', 'ocr', 'manual'])
const DRAFT_STATUSES = new Set(['pending', 'committed', 'discarded'])
const DRAFT_FIELDS   = new Set(['client_id', 'type', 'date', 'minister', 'place', 'certificate_no', 'notes', 'meta_attributes'])

const DRAFT_COLS = `id, source, raw_payload, draft, status, committed_record_id,
                    created_by, created_at, updated_at`

// Light shape-check for a draft object: unknown keys are rejected, but
// values stay loose — strict validation (types, org membership) runs at
// commit time, which is the only path into the register.
function sanitizeDraft(input) {
  if (input == null) return { value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'draft must be an object' }
  for (const key of Object.keys(input)) {
    if (!DRAFT_FIELDS.has(key)) return { error: `Unknown draft field: ${key}` }
  }
  return { value: input }
}

// GET /api/sacraments/drafts?status=pending
router.get('/drafts', async (req, res) => {
  const { limit, offset } = parsePagination(req.query)
  const status = typeof req.query.status === 'string' && DRAFT_STATUSES.has(req.query.status)
    ? req.query.status : 'pending'
  try {
    const { rows } = await pool.query(
      `SELECT ${DRAFT_COLS} FROM ochr_sacramental_drafts
        WHERE organization_id = $1 AND status = $2
        ORDER BY id ASC
        LIMIT $3 OFFSET $4`,
      [req.organizationId, status, limit, offset]
    )
    res.json({ drafts: rows })
  } catch (err) {
    monitor.error('sacraments.drafts.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load drafts' })
  }
})

// POST /api/sacraments/drafts — bulk-stage rows ({ drafts: [...] }, ≤200)
router.post('/drafts', async (req, res) => {
  const incoming = Array.isArray(req.body?.drafts) ? req.body.drafts : null
  if (!incoming || incoming.length === 0) return res.status(400).json({ error: 'Provide a drafts array' })
  if (incoming.length > 200) return res.status(400).json({ error: 'At most 200 drafts per batch' })

  const prepared = []
  for (const [i, item] of incoming.entries()) {
    const source = DRAFT_SOURCES.has(item?.source) ? item.source : 'csv'
    const raw = item?.raw_payload != null && typeof item.raw_payload === 'object' ? item.raw_payload : {}
    const draft = sanitizeDraft(item?.draft)
    if (draft.error) return res.status(400).json({ error: `Row ${i + 1}: ${draft.error}` })
    prepared.push({ source, raw, draft: draft.value })
  }

  try {
    const out = []
    for (const row of prepared) {
      const { rows } = await pool.query(
        `INSERT INTO ochr_sacramental_drafts
           (organization_id, source, raw_payload, draft, created_by)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
         RETURNING ${DRAFT_COLS}`,
        [req.organizationId, row.source, JSON.stringify(row.raw), JSON.stringify(row.draft), req.user?.id ?? null]
      )
      out.push(rows[0])
    }
    res.status(201).json({ drafts: out })
  } catch (err) {
    monitor.error('sacraments.drafts.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to stage drafts' })
  }
})

// PATCH /api/sacraments/drafts/:id — edit a pending draft, or discard it
router.patch('/drafts/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' })

  const sets = []
  const params = []
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'draft')) {
    const draft = sanitizeDraft(req.body.draft)
    if (draft.error) return res.status(400).json({ error: draft.error })
    params.push(JSON.stringify(draft.value)); sets.push(`draft = $${params.length}::jsonb`)
  }
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'status')) {
    if (req.body.status !== 'discarded') {
      return res.status(400).json({ error: 'Status can only be set to discarded here — use commit for committing' })
    }
    params.push('discarded'); sets.push(`status = $${params.length}`)
  }
  if (!sets.length) return res.status(400).json({ error: 'No editable fields provided' })
  sets.push('updated_at = NOW()')

  try {
    params.push(id, req.organizationId)
    const { rows } = await pool.query(
      `UPDATE ochr_sacramental_drafts SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND organization_id = $${params.length} AND status = 'pending'
        RETURNING ${DRAFT_COLS}`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Draft not found or no longer pending' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('sacraments.drafts.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update draft' })
  }
})

// POST /api/sacraments/drafts/:id/commit — strict-validate, write the
// register row, mark the draft committed. The only path from staging
// into ochr_sacramental_records.
router.post('/drafts/:id/commit', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' })

  // The register (ochr_sacramental_records) is canonical, so committing a
  // draft must be all-or-nothing and race-safe: two concurrent commits of
  // the same draft must not both write a permanent record. We run the read
  // → insert → mark inside one transaction and SELECT ... FOR UPDATE the
  // draft, so the second commit blocks until the first commits and then
  // sees status='committed' → 409 instead of double-writing.
  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')

    const { rows: found } = await conn.query(
      `SELECT ${DRAFT_COLS} FROM ochr_sacramental_drafts
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!found.length) { await conn.query('ROLLBACK'); return res.status(404).json({ error: 'Draft not found' }) }
    const d = found[0]
    if (d.status !== 'pending') { await conn.query('ROLLBACK'); return res.status(409).json({ error: `Draft is already ${d.status}` }) }

    const draft = d.draft ?? {}
    if (!SACRAMENT_TYPES.has(draft.type)) {
      await conn.query('ROLLBACK')
      return res.status(400).json({ error: `type must be one of: ${[...SACRAMENT_TYPES].join(', ')}` })
    }

    let resolvedClientId = null
    if (draft.client_id != null) {
      const cid = Number(draft.client_id)
      if (!Number.isInteger(cid) || cid <= 0 || !(await clientInOrg(cid, req.organizationId))) {
        await conn.query('ROLLBACK')
        return res.status(400).json({ error: 'client_id must be a member of your church' })
      }
      resolvedClientId = cid
    }

    const meta = await parseMetaAttributes(draft.meta_attributes, req.organizationId)
    if (meta.error) { await conn.query('ROLLBACK'); return res.status(400).json({ error: meta.error }) }

    const date          = draft.date ? String(draft.date) : null
    const minister      = draft.minister != null ? String(draft.minister).trim() || null : null
    const place         = draft.place != null ? String(draft.place).trim() || null : null
    const certificateNo = draft.certificate_no != null ? String(draft.certificate_no).trim() || null : null
    const notes         = draft.notes != null ? String(draft.notes).trim() || null : null

    const { rows: created } = await conn.query(
      `INSERT INTO ochr_sacramental_records
         (organization_id, client_id, type, date, minister, place, certificate_no, notes, meta_attributes, member_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
               (SELECT name FROM ochr_clients WHERE id = $2 AND organization_id = $1))
       RETURNING ${SELECT_COLS}`,
      [req.organizationId, resolvedClientId, draft.type, date, minister, place, certificateNo, notes,
       JSON.stringify(meta.value)]
    )

    const { rows: updated } = await conn.query(
      `UPDATE ochr_sacramental_drafts
          SET status = 'committed', committed_record_id = $1, updated_at = NOW()
        WHERE id = $2 AND organization_id = $3
        RETURNING ${DRAFT_COLS}`,
      [created[0].id, id, req.organizationId]
    )

    await conn.query('COMMIT')
    res.status(201).json({ record: created[0], draft: updated[0] })
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {})
    monitor.error('sacraments.drafts.commit', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to commit draft' })
  } finally {
    conn.release()
  }
})

// GET /api/sacraments/:id — a single record (with member name), for the
// certificate view. Org-scoped; 404 if it isn't this church's record.
router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS_S},
              COALESCE(c.name, s.member_name) AS member_name
         FROM ochr_sacramental_records s
         LEFT JOIN ochr_clients c
                ON c.id = s.client_id AND c.organization_id = s.organization_id
        WHERE s.id = $1 AND s.organization_id = $2`,
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('sacraments.get', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load record' })
  }
})

// POST /api/sacraments
router.post('/', async (req, res) => {
  const type = req.body?.type
  if (!SACRAMENT_TYPES.has(type)) {
    return res.status(400).json({ error: `type must be one of: ${[...SACRAMENT_TYPES].join(', ')}` })
  }
  const clientId = req.body?.client_id != null ? Number(req.body.client_id) : null
  const date = req.body?.date ? String(req.body.date) : null
  const minister = req.body?.minister != null ? String(req.body.minister).trim() || null : null
  const place = req.body?.place != null ? String(req.body.place).trim() || null : null
  const certificateNo = req.body?.certificate_no != null ? String(req.body.certificate_no).trim() || null : null
  const notes = req.body?.notes != null ? String(req.body.notes).trim() || null : null

  try {
    let resolvedClientId = null
    if (Number.isInteger(clientId) && clientId > 0) {
      if (!(await clientInOrg(clientId, req.organizationId))) {
        return res.status(404).json({ error: 'Member not found in your church' })
      }
      resolvedClientId = clientId
    }

    const meta = await parseMetaAttributes(req.body?.meta_attributes, req.organizationId)
    if (meta.error) return res.status(400).json({ error: meta.error })

    const { rows } = await pool.query(
      `INSERT INTO ochr_sacramental_records
         (organization_id, client_id, type, date, minister, place, certificate_no, notes, meta_attributes, member_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
               (SELECT name FROM ochr_clients WHERE id = $2 AND organization_id = $1))
       RETURNING ${SELECT_COLS}`,
      [req.organizationId, resolvedClientId, type, date, minister, place, certificateNo, notes,
       JSON.stringify(meta.value)]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('sacraments.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save sacramental record' })
  }
})

// PATCH /api/sacraments/:id
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return

  const sets = []
  const params = []
  for (const [col, read] of Object.entries(EDITABLE)) {
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, col)) {
      const val = read(req.body[col])
      if (val === undefined) return res.status(400).json({ error: `Invalid value for ${col}` })
      params.push(val); sets.push(`${col} = $${params.length}`)
    }
  }

  try {
    // Structured sub-fields — validated + replaced wholesale (a PATCH
    // sends the full desired meta object, not a merge).
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'meta_attributes')) {
      const meta = await parseMetaAttributes(req.body.meta_attributes, req.organizationId)
      if (meta.error) return res.status(400).json({ error: meta.error })
      params.push(JSON.stringify(meta.value)); sets.push(`meta_attributes = $${params.length}::jsonb`)
    }

    // Optional re-link to a (validated) member.
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'client_id')) {
      const cid = req.body.client_id != null ? Number(req.body.client_id) : null
      if (cid == null) {
        params.push(null); sets.push(`client_id = $${params.length}`)
      } else if (Number.isInteger(cid) && cid > 0 && (await clientInOrg(cid, req.organizationId))) {
        params.push(cid); sets.push(`client_id = $${params.length}`)
        // Re-stamp the identity snapshot to the newly linked member
        // (clientInOrg validated org membership above; the qualified
        // org match keeps the subquery honest regardless).
        sets.push(`member_name = (SELECT c.name FROM ochr_clients c WHERE c.id = $${params.length} AND c.organization_id = ochr_sacramental_records.organization_id)`)
      } else {
        return res.status(404).json({ error: 'Member not found in your church' })
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No editable fields provided' })
    sets.push(`updated_at = NOW()`)

    params.push(id, req.organizationId)
    const { rows } = await pool.query(
      `UPDATE ochr_sacramental_records SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND organization_id = $${params.length}
        RETURNING ${SELECT_COLS}`,
      params
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    monitor.error('sacraments.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update sacramental record' })
  }
})

// DELETE /api/sacraments/:id
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM ochr_sacramental_records WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    monitor.error('sacraments.delete', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to delete sacramental record' })
  }
})

export default router
