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
import { requireRole } from '../middleware/auth.js'

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

// The subject name a caller supplied, normalised. Separate from the member
// link on purpose: an unlinked historic entry names someone who may have
// died in 1953, and requiring a member row for them would put the dead on
// the parish roster to make a certificate print.
function readSubjectName(raw) {
  if (raw == null) return null
  const name = String(raw).trim()
  return name === '' ? null : name
}

// Register dates are strict YYYY-MM-DD, and a real calendar day at that.
//
// They used to be handed to Postgres as whatever string arrived, and the
// pooler's DateStyle is MDY. So a DD/MM paper register digitised as
// "10/05/1953" stored 5 October for a 10 May baptism — every entry moved to
// the wrong month with no error anywhere — and "1953" on its own was a 500.
// A date the parser has to guess at is refused; the message says what is
// accepted. Whether a year-only date should ever be storable is a register
// policy question, not something a parser should decide by rounding.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DATE_FORMAT_ERROR = 'date must be YYYY-MM-DD (for example 1953-05-10). "10/05/1953" is ambiguous and a bare year is not a date.'
function readRegisterDate(raw) {
  if (raw == null || raw === '') return { value: null }
  const s = String(raw).trim()
  if (!ISO_DATE.test(s)) return { error: DATE_FORMAT_ERROR }
  const [y, m, d] = s.split('-').map(Number)
  // Round-trip through a UTC Date so 1953-02-30 is caught here as a 400
  // rather than in Postgres as a 500. setUTCFullYear (not Date.UTC) so a
  // four-digit year below 0100 is not silently read as 19xx.
  const dt = new Date(0); dt.setUTCFullYear(y, m - 1, d)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { error: DATE_FORMAT_ERROR }
  }
  return { value: s }
}

// Columns a PATCH may touch, and how to read each from the body. Closed
// allowlist so a caller can never set organization_id or an unknown column.
const EDITABLE = {
  type:           v => (SACRAMENT_TYPES.has(v) ? v : undefined),
  // undefined → 400. Same strictness as POST and commit: a date correction
  // that Postgres has to guess at is the same defect on the write side.
  date:           v => readRegisterDate(v).value,
  minister:       v => (v == null ? null : String(v).trim() || null),
  place:          v => (v == null ? null : String(v).trim() || null),
  certificate_no: v => (v == null ? null : String(v).trim() || null),
  notes:          v => (v == null ? null : String(v).trim() || null),
  // A misspelling in the original register notation is corrected HERE, which
  // means it goes through readReason and lands in the amendment history like
  // any other change to the book. It is deliberately not editable from the
  // member record: renaming a person is not correcting a register entry.
  member_name:    v => readSubjectName(v),
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
  // REG.1 — a voided entry is still returned wherever it is asked for by
  // id; callers decide how to render it. Hiding the marks would make a
  // void look like an ordinary entry.
  'voided_at', 'voided_reason',
]
const cols = (p = '') =>
  [`to_char(${p}date, 'YYYY-MM-DD') AS date`, ...REGISTER_COLS.map(c => `${p}${c}`)].join(', ')

// ── HISTORICAL SUBJECT IDENTITY ─────────────────────────────────────────
//
// A sacramental record names the person the sacrament was administered to,
// AS RECORDED AT THE TIME. That is not the same fact as the current name of
// the member it happens to be linked to, and the two must not be confused:
//
//   Maria Ruiz is baptised in 2019 and the entry says Maria Ruiz.
//   She marries in 2026 and her member record becomes Maria Ruiz Garcia.
//   Her BAPTISMAL certificate still reads Maria Ruiz, because that is who
//   was baptised, under the name the register recorded.
//
// The resolver used to read COALESCE(c.name, s.member_name) — the live
// member name first — so renaming a member silently rewrote every
// sacramental record and certificate that pointed at them. The order is now
// reversed. The snapshot is the record; the live name survives only as a
// fallback for rows predating migration 054's backfill.
//
// The member link is still valuable — lookup, navigation, household context,
// tying a historical entry to the person in front of you — it is simply not
// the identity on the record.
//
// This is a data-integrity and historical-fidelity rule for OpenChurch. It is
// NOT a claim about canon law, which differs by tradition.
const SUBJECT_NAME = 'COALESCE(s.member_name, c.name) AS member_name'

// Unprefixed, for INSERT/UPDATE ... RETURNING and for the amendment
// snapshot, which must carry the stored name so a correction to it shows up
// in the record's history like any other change.
const SELECT_COLS = cols() + ', member_name'
// Prefixed, for the queries that JOIN ochr_clients. These pair with
// SUBJECT_NAME above, so the raw column is deliberately absent here.
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
    // Keyword search across the subject's name, minister, place, and
    // certificate number. LIKE metacharacters are escaped so a stray % or _
    // is treated literally.
    //
    // The name searched is the same expression the list DISPLAYS
    // (SUBJECT_NAME): the recorded snapshot, live member name only as the
    // pre-054 fallback. It used to be c.name alone, which meant an unlinked
    // historic subject could not be found by name at all, and a renamed
    // member's baptism turned up under a name nobody was baptised with while
    // the row on screen showed a name that did not contain the query.
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q) {
      const escaped = q.replace(/[\\%_]/g, ch => `\\${ch}`)
      params.push(`%${escaped}%`)
      const p = `$${params.length}`
      where.push(`(COALESCE(s.member_name, c.name) ILIKE ${p} OR s.minister ILIKE ${p} OR s.place ILIKE ${p} OR s.certificate_no ILIKE ${p})`)
    }

    // Voided entries leave the working register but never the record.
    // ?include_voided=1 shows them — a parish auditing its own book, or a
    // dean inspecting it, needs to see what was retired and why.
    if (req.query.include_voided !== '1' && req.query.include_voided !== 'true') {
      where.push('s.voided_at IS NULL')
    }
    params.push(limit, offset)
    // LEFT JOIN so the parish-register view can show the member's name; the
    // join is org-matched so a detached (client_id NULL) record just yields a
    // null name rather than crossing tenants.
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS_S}, ${SUBJECT_NAME}
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
          AND s.voided_at IS NULL  -- a retired entry has nothing to congratulate anyone on
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
// member_name is here because this is the DIGITISATION path — the one built
// for transcribing a paper register — and without it a CSV or OCR import
// could stage the date, the minister, the place and the certificate number
// of a 1953 baptism but not the name of the person baptised, unless that
// person happened to be a current member.
const DRAFT_FIELDS   = new Set(['client_id', 'member_name', 'type', 'date', 'minister', 'place', 'certificate_no', 'notes', 'meta_attributes'])

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

    // Strict here, not at staging: a draft may hold the raw text of the
    // paper page ("10/05/1953"), but the register does not take it until a
    // human has resolved which day that was.
    const dateRead = readRegisterDate(draft.date)
    if (dateRead.error) { await conn.query('ROLLBACK'); return res.status(400).json({ error: dateRead.error }) }
    const date          = dateRead.value
    const minister      = draft.minister != null ? String(draft.minister).trim() || null : null
    const place         = draft.place != null ? String(draft.place).trim() || null : null
    const certificateNo = draft.certificate_no != null ? String(draft.certificate_no).trim() || null : null
    const notes         = draft.notes != null ? String(draft.notes).trim() || null : null

    let memberName = readSubjectName(draft.member_name)
    if (memberName == null && resolvedClientId != null) {
      const { rows: c } = await conn.query(
        'SELECT name FROM ochr_clients WHERE id = $1 AND organization_id = $2',
        [resolvedClientId, req.organizationId]
      )
      memberName = c[0]?.name ?? null
    }
    if (memberName == null) {
      await conn.query('ROLLBACK')
      return res.status(400).json({
        error: 'This draft names no subject. Add the name as written in the register, or link a member, before committing it.',
      })
    }

    const { rows: created } = await conn.query(
      `INSERT INTO ochr_sacramental_records
         (organization_id, client_id, type, date, minister, place, certificate_no, notes, meta_attributes, member_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING ${SELECT_COLS}`,
      [req.organizationId, resolvedClientId, draft.type, date, minister, place, certificateNo, notes,
       JSON.stringify(meta.value), memberName]
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
      `SELECT ${SELECT_COLS_S}, ${SUBJECT_NAME}
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
  const subjectName = readSubjectName(req.body?.member_name)
  const dateRead = readRegisterDate(req.body?.date)
  if (dateRead.error) return res.status(400).json({ error: dateRead.error })
  const date = dateRead.value
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

    // An entry that names nobody can never produce a truthful certificate,
    // and Pass 6 observed exactly that shipping as a printable document. The
    // subject comes from the linked member if there is one, or from the name
    // the caller recorded. One of the two is required — but a MEMBER is not,
    // because historic register digitisation involves people who are not
    // current members and some of whom died decades ago.
    let memberName = subjectName
    if (memberName == null && resolvedClientId != null) {
      const { rows: c } = await pool.query(
        'SELECT name FROM ochr_clients WHERE id = $1 AND organization_id = $2',
        [resolvedClientId, req.organizationId]
      )
      memberName = c[0]?.name ?? null
    }
    if (memberName == null) {
      return res.status(400).json({
        error: 'A sacramental record must name its subject: link a member, or supply member_name.',
      })
    }

    const { rows } = await pool.query(
      `INSERT INTO ochr_sacramental_records
         (organization_id, client_id, type, date, minister, place, certificate_no, notes, meta_attributes, member_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING ${SELECT_COLS}`,
      [req.organizationId, resolvedClientId, type, date, minister, place, certificateNo, notes,
       JSON.stringify(meta.value), memberName]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    monitor.error('sacraments.create', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save sacramental record' })
  }
})


// ── Register integrity (REG.1) ───────────────────────────────────────────
//
// A committed register entry is not a row that can be rewritten or removed.
// It is corrected by amendment and retired by voiding, and both leave a
// dated, attributed, reasoned trace. See migration 073 for the why.

const MIN_REASON = 3
const MAX_REASON = 1000

function readReason(req) {
  const raw = req.body?.reason
  if (typeof raw !== 'string') return { error: 'A reason is required to change the register' }
  const reason = raw.trim()
  if (reason.length < MIN_REASON) return { error: `Reason must be at least ${MIN_REASON} characters` }
  if (reason.length > MAX_REASON) return { error: `Reason exceeds ${MAX_REASON} characters` }
  return { reason }
}

// The full prior row, snapshotted into the amendment. Selected with the
// same column list the API returns so an amendment can be replayed and
// read without knowing the schema of the day it was written.
async function snapshot(conn, id, orgId) {
  const { rows } = await conn.query(
    // SELECT_COLS, not cols() — the snapshot must carry member_name or a
    // correction to the recorded name lands in the history with
    // before: null, which is worse than no history: it reads as though the
    // entry never named anyone. Caught by running it, not by reading it.
    `SELECT ${SELECT_COLS}
       FROM ochr_sacramental_records
      WHERE id = $1 AND organization_id = $2
      FOR UPDATE`,
    [id, orgId]
  )
  return rows[0] ?? null
}

async function writeAmendment(conn, { orgId, sacramentId, kind, reason, before, after, user }) {
  await conn.query(
    `INSERT INTO ochr_sacrament_amendments
       (organization_id, sacrament_id, kind, reason, before_json, after_json,
        amended_by, amended_by_name, amended_by_email)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
    [orgId, sacramentId, kind, reason,
     JSON.stringify(before), after ? JSON.stringify(after) : null,
     user?.id ?? null, user?.name ?? null, user?.email ?? null]
  )
}

// PATCH /api/sacraments/:id
router.patch('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return

  // A correction to the register must say why. This is the whole
  // difference between an amendment and a silent overwrite.
  const r = readReason(req)
  if (r.error) return res.status(400).json({ error: r.error })

  // A correction may not empty the register of its subject — linked or not.
  // This used to be allowed when a member link remained, on the theory that
  // the link could still answer who this is. It cannot: the link points at a
  // present-day roster row that can be renamed, merged or deleted, and the
  // moment it is, the entry names nobody. A register entry says who was
  // baptised; it does not defer the question to another table.
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'member_name')
      && readSubjectName(req.body.member_name) == null) {
    return res.status(400).json({
      error: 'A sacramental record must name its subject. Give the name as recorded in the register.',
    })
  }

  const sets = []
  const params = []
  for (const [col, read] of Object.entries(EDITABLE)) {
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, col)) {
      const val = read(req.body[col])
      if (val === undefined) {
        // The date message names the accepted format; "invalid value" would
        // send the transcriber back to guess which of MDY/DMY was wanted.
        return res.status(400).json({ error: col === 'date' ? DATE_FORMAT_ERROR : `Invalid value for ${col}` })
      }
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
        // The snapshot is NOT re-stamped here, and that is the point.
        // Linking a 1994 baptism to the member it belongs to is discovering a
        // relationship; it is not evidence that the register said something
        // other than what it says. Relinking used to overwrite the recorded
        // name with the current member's, which is the same defect as the
        // resolver having the live name first — just on the write side.
        // A name genuinely recorded wrong is corrected by sending
        // member_name, which goes through the amendment history with a
        // reason attached.
      } else {
        return res.status(404).json({ error: 'Member not found in your church' })
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No editable fields provided' })
    sets.push(`updated_at = NOW()`)

    // The snapshot, the write and the amendment are one transaction. A
    // correction that landed without its amendment would be exactly the
    // silent overwrite this replaced.
    const conn = await pool.connect()
    try {
      await conn.query('BEGIN')
      const before = await snapshot(conn, id, req.organizationId)
      if (!before) { await conn.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
      if (before.voided_at) {
        await conn.query('ROLLBACK')
        return res.status(409).json({
          error: 'This entry is void and cannot be corrected. Restore it first, or add a new entry.',
        })
      }

      // A row with no stored snapshot (pre-054, never backfilled) has been
      // showing its linked member's name through the COALESCE fallback. If
      // this correction moves or removes that link, the name it has been
      // showing is written down FIRST — otherwise the entry silently adopts
      // the new member's name, and the history reads null → null as though
      // it never named anyone. Rows that already carry a snapshot are left
      // alone: relinking those must not re-stamp (see the note above).
      const touchesLink = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'client_id')
      const suppliesName = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'member_name')
      if (touchesLink && before.member_name == null && !suppliesName) {
        const { rows: c } = before.client_id == null ? { rows: [] } : await conn.query(
          'SELECT name FROM ochr_clients WHERE id = $1 AND organization_id = $2',
          [before.client_id, req.organizationId]
        )
        const shown = c[0]?.name ?? null
        if (shown == null) {
          // A true orphan: no snapshot and no member to read one from. The
          // relink is not allowed to define who was baptised — the caller
          // has to say what the register page says.
          await conn.query('ROLLBACK')
          return res.status(400).json({
            error: 'A sacramental record must name its subject. This entry has no recorded name — supply member_name as written in the register before changing its member link.',
          })
        }
        params.push(shown); sets.push(`member_name = $${params.length}`)
        // The amendment's "before" is what the record SAID, and it said
        // this name (via the fallback) — not null.
        before.member_name = shown
      }

      params.push(id, req.organizationId)
      const { rows } = await conn.query(
        `UPDATE ochr_sacramental_records SET ${sets.join(', ')}
          WHERE id = $${params.length - 1} AND organization_id = $${params.length}
          RETURNING ${SELECT_COLS}`,
        params
      )
      await writeAmendment(conn, {
        orgId: req.organizationId, sacramentId: id, kind: 'correction',
        reason: r.reason, before, after: rows[0], user: req.user,
      })
      await conn.query('COMMIT')
      res.json(rows[0])
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      conn.release()
    }
  } catch (err) {
    monitor.error('sacraments.update', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to update sacramental record' })
  }
})

// DELETE /api/sacraments/:id — refused, on purpose.
//
// A register entry cannot be deleted. Every reason someone reaches for
// delete — wrong member, duplicate from a digitisation pass, a ceremony
// that did not happen, an entry made at the wrong parish — is a reason to
// VOID: keep the entry, mark it void, say why. Six months later somebody
// asks why the register skips a number, and the answer has to be in the
// book rather than in somebody's memory.
//
// 405 rather than 403: this is not a permissions problem that a bigger
// role would solve. The operation does not exist for anyone.
router.delete('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  res.set('Allow', 'GET, PATCH')
  res.status(405).json({
    error: 'Register entries are never deleted. Void the entry instead — it stays in the record, marked void, with your reason.',
    void_endpoint: `/api/sacraments/${id}/void`,
  })
})

// POST /api/sacraments/:id/void — retire an entry without erasing it.
//
// Admin-only. Correcting a typo is ordinary parish work; retiring an entry
// from the register is the kind of decision a parish should be able to
// name a person for.
router.post('/:id/void', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const r = readReason(req)
  if (r.error) return res.status(400).json({ error: r.error })

  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')
    const before = await snapshot(conn, id, req.organizationId)
    if (!before) { await conn.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    if (before.voided_at) {
      await conn.query('ROLLBACK')
      return res.status(409).json({ error: 'This entry is already void' })
    }

    const { rows } = await conn.query(
      `UPDATE ochr_sacramental_records
          SET voided_at = NOW(), voided_reason = $1, updated_at = NOW()
        WHERE id = $2 AND organization_id = $3
        RETURNING ${SELECT_COLS}`,
      [r.reason, id, req.organizationId]
    )
    await writeAmendment(conn, {
      orgId: req.organizationId, sacramentId: id, kind: 'void',
      reason: r.reason, before, after: rows[0], user: req.user,
    })
    await conn.query('COMMIT')
    res.json(rows[0])
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {})
    monitor.error('sacraments.void', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to void register entry' })
  } finally {
    conn.release()
  }
})

// POST /api/sacraments/:id/restore — voiding is itself reversible, and the
// reversal is itself an amendment. A parish that voids the wrong entry
// must not have to live with it, and must not be able to hide having done
// it either.
router.post('/:id/restore', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const r = readReason(req)
  if (r.error) return res.status(400).json({ error: r.error })

  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')
    const before = await snapshot(conn, id, req.organizationId)
    if (!before) { await conn.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    if (!before.voided_at) {
      await conn.query('ROLLBACK')
      return res.status(409).json({ error: 'This entry is not void' })
    }

    const { rows } = await conn.query(
      `UPDATE ochr_sacramental_records
          SET voided_at = NULL, voided_reason = NULL, updated_at = NOW()
        WHERE id = $1 AND organization_id = $2
        RETURNING ${SELECT_COLS}`,
      [id, req.organizationId]
    )
    await writeAmendment(conn, {
      orgId: req.organizationId, sacramentId: id, kind: 'restore',
      reason: r.reason, before, after: rows[0], user: req.user,
    })
    await conn.query('COMMIT')
    res.json(rows[0])
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {})
    monitor.error('sacraments.restore', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to restore register entry' })
  } finally {
    conn.release()
  }
})

// GET /api/sacraments/:id/amendments — the marginal notations, in order.
// Readable by any role that can read the register: a history nobody can
// see is not a history.
router.get('/:id/amendments', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `SELECT id, kind, reason, before_json, after_json,
              amended_by, amended_by_name, amended_by_email, created_at
         FROM ochr_sacrament_amendments
        WHERE sacrament_id = $1 AND organization_id = $2
        ORDER BY created_at ASC, id ASC`,
      [id, req.organizationId]
    )
    res.json({ amendments: rows })
  } catch (err) {
    monitor.error('sacraments.amendments', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to load amendments' })
  }
})

export default router
