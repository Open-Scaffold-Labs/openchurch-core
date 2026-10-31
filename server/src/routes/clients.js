import { Router } from 'express'
import pool from '../db.js'
import { normalizeDonorEmail } from '../finance/donorIdentity.js'
import { requireIntParam, parsePagination } from '../utils/params.js'
import { parseCSVToObjects } from '../utils/csv.js'
import { protectedDelete } from '../vault/deleteRoute.js'
import { requireRole } from '../middleware/auth.js'
import { withOrganizationAdmission } from '../auth/loginDeactivation.js'
import { markStewardship } from '../middleware/auditLog.js'

const router = Router()

// Columns the CSV importer accepts. Everything else in ochr_clients
// (notes, company, status, calendar_token, timestamps) is out of scope
// for a spreadsheet round-trip — those are app-managed fields.
const IMPORT_COLUMNS = ['name', 'email', 'phone', 'role', 'tags']

// Columns a member row is allowed to leave the server with. This is an
// ALLOWLIST on purpose. The router used to say `SELECT *`, which shipped
// every column the table had ever grown — including two bearer credentials:
//
//   calendar_token — gates the personal .ics feed at /api/calendar-sync/:token.ics
//   swap_token     — gates the public swap page at /api/swap/by-token/:token
//
// Both are unauthenticated by design, so the roster was handing every
// signed-in user (viewers included — this router has no role gate) a working
// key to every member's private feed and swap form. search_vec rode along
// too: a tsvector no screen renders, on every row of every page.
//
// A denylist would have fixed today and leaked the next secret column
// somebody adds. Adding a column here is a deliberate act; forgetting to add
// one is a missing field in the UI, which is loud. The reverse — forgetting
// to deny — is silent. Guarded by "list endpoints do not leak per-member
// credentials (LEAK.1)".
//
// Measured on a 300-member parish, one 100-row page: 37 kB with SELECT *,
// 24 kB with the allowlist — 37% of every roster page was the tsvector.
//
// 27 Aug: this closed the LIST path only. POST and PATCH still said
// `RETURNING *`, so creating or editing a member handed the caller the whole
// row — and PATCH on a member whose calendar link had been generated
// returned the LIVE calendar_token. Verified against the running server:
// PATCH /api/clients/20013 came back with the same token the .ics feed is
// gated on. The allowlist now governs every path that returns a member.
const CLIENT_PUBLIC_COLUMNS = [
  'id', 'organization_id', 'name', 'company', 'email', 'phone', 'notes',
  'status', 'role', 'tags', 'preferred_language', 'birth_date', 'joined_date',
  'avatar', 'reminders_opt_out', 'created_at', 'updated_at', 'deidentified_at',
  'mailing_address_line1', 'mailing_address_line2', 'mailing_city',
  'mailing_state', 'mailing_postal',
].join(', ')

// SP-176 (Saint MEM-23): roles below staff read the roster without a
// member's private notes or birth year. Viewers keep month and day as
// birth_month_day (birthday lists), never birth_date. Decided on the LIVE
// role (requireAuth sets req.user.role from the database), so a demotion
// applies on the next request. Allowlist of full readers, so a new role
// starts redacted.
const FULL_MEMBER_READERS = new Set(['admin', 'staff'])
function monthDay(v) {
  if (v == null) return null
  if (v instanceof Date) {
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${m}-${d}`
  }
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(v))
  return m ? `${m[1]}-${m[2]}` : null
}
export function projectMemberForRole(row, role) {
  if (!row || FULL_MEMBER_READERS.has(role)) return row
  const { notes: _notes, birth_date, ...rest } = row
  return { ...rest, birth_month_day: monthDay(birth_date) }
}

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
    const sql = `SELECT ${CLIENT_PUBLIC_COLUMNS} FROM ochr_clients WHERE ${where.join(' AND ')} ORDER BY name LIMIT $${params.length - 1} OFFSET $${params.length}`
    const { rows } = await pool.query(sql, params)
    res.json(rows.map(r => projectMemberForRole(r, req.user?.role)))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load clients' })
  }
})

// GET /api/clients/picker?search=&limit=&include_inactive=1  (SP-052 / R285-2)
// Lookup for the Mass-intention requester link. Fixed projection
// {id, name, status}: no contact, note, birth date or capability field,
// and no caller-chosen columns. status is membership standing only.
// Inactive members are omitted unless include_inactive is exactly "1".
// Session organization only. Name match only. Bounded: limit 1..25
// (default 10). Same auth as the roster it replaces.
router.get('/picker', async (req, res) => {
  try {
    const raw = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
    const n = Number.parseInt(String(req.query.limit ?? '10'), 10)
    const limit = Number.isInteger(n) ? Math.min(Math.max(n, 1), 25) : 10
    const includeInactive = req.query.include_inactive === '1'
    const params = [req.organizationId]
    let where = 'organization_id = $1'
    if (!includeInactive) where += ` AND status IS DISTINCT FROM 'inactive'`
    if (raw) {
      params.push(`%${raw.replace(/[\\%_]/g, m => '\\' + m)}%`)
      where += ` AND name ILIKE $${params.length}`
    }
    params.push(limit)
    const { rows } = await pool.query(
      `SELECT id, name, status FROM ochr_clients WHERE ${where} ORDER BY name, id LIMIT $${params.length}`, params)
    res.json(rows.map(r => ({ id: r.id, name: r.name, status: r.status })))
  } catch (err) {
    console.error('clients picker failed:', err)
    res.status(500).json({ error: 'Failed to load members' })
  }
})

// GET /api/clients/duplicate-check?email=&name=  (Saint SP-255)
// Soft hint for Add/Edit Member. Returns up to 5 matches in this org whose
// email equals (case-insensitive) or name equals (case-insensitive trim).
// Does not block create — the UI warns; CSV import still skips by email.
// Fixed projection {id, name, email, status}. No notes/birth/tokens.
router.get('/duplicate-check', async (req, res) => {
  try {
    const emailRaw = typeof req.query.email === 'string' ? req.query.email.trim() : ''
    const nameRaw  = typeof req.query.name  === 'string' ? req.query.name.trim()  : ''
    const email = emailRaw ? (normalizeDonorEmail(emailRaw) ?? emailRaw.toLowerCase()) : ''
    const name  = nameRaw.slice(0, 120)
    if (!email && !name) return res.json({ matches: [] })

    const params = [req.organizationId]
    const clauses = []
    if (email) {
      params.push(email)
      clauses.push(`(email IS NOT NULL AND LOWER(email) = LOWER($${params.length}))`)
    }
    if (name) {
      params.push(name)
      clauses.push(`(LOWER(BTRIM(name)) = LOWER($${params.length}))`)
    }
    // exclude_id is AND'd outside the match OR-group so it cannot widen results.
    let excludeSql = ''
    const ex = Number.parseInt(String(req.query.exclude_id ?? ''), 10)
    if (Number.isInteger(ex) && ex > 0) {
      params.push(ex)
      excludeSql = ` AND id <> $${params.length}`
    }
    params.push(5)
    const { rows } = await pool.query(
      `SELECT id, name, email, status FROM ochr_clients
        WHERE organization_id = $1 AND (${clauses.join(' OR ')})${excludeSql}
        ORDER BY name, id LIMIT $${params.length}`,
      params,
    )
    res.json({ matches: rows })
  } catch (err) {
    console.error('clients duplicate-check failed:', err)
    res.status(500).json({ error: 'Failed to check for duplicates' })
  }
})

// GET /api/clients/:id
router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rows } = await pool.query(
      `SELECT ${CLIENT_PUBLIC_COLUMNS} FROM ochr_clients WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(projectMemberForRole(rows[0], req.user?.role))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load client' })
  }
})

// The signup sample stores the member as "[Sample] Maria Garcia" and the
// gift as donor_name "Maria Garcia". The marker is a row tag, not part of
// the donor's name — donor_name is kept clean on purpose. One leading
// marker only; this is not a substring or fuzzy match.
const SAMPLE_MARKER = '[Sample] '

function donorNamesForMember(name) {
  if (typeof name !== 'string' || name.length === 0) return []
  const names = [name]
  if (name.startsWith(SAMPLE_MARKER)) {
    const stripped = name.slice(SAMPLE_MARKER.length).trim()
    if (stripped) names.push(stripped)
  }
  return names
}

// GET /api/clients/:id/donations
// The profile is addressed by member id. That id, inside the caller's
// org, is who this read is about. Gifts have no member foreign key, so
// the link is derived and stays inside this org:
//
//   1. Canonical donor key — normalised email, when the member has one.
//      Case-insensitive, same rule as migration 095 / F5.
//   2. Name, only for a gift that carries no email, and only when
//      this member claims that donor_name and no other surviving
//      member of this org claims it. Her own status is not a filter:
//      a unique inactive or de-identified member still sees those
//      gifts. Any other row with that name blocks the link, active
//      or inactive, de-identified or not. Status and de-identification
//      must not move a historical name-only gift onto someone else,
//      and the same gift must not appear on two profiles. Another
//      parish's gift never matches. A gift that already has a
//      different email is a different donor. The sample marker is
//      still the same claim: "[Sample] Maria Garcia" and "Maria Garcia"
//      block each other.
//
// Returns: { lines: [...], total, gift_count, by: 'email'|'name' }
router.get('/:id/donations', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const memberQ = await pool.query(
      'SELECT name, email FROM ochr_clients WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (!memberQ.rows.length) return res.status(404).json({ error: 'Member not found' })
    const member = memberQ.rows[0]

    const emailKey = normalizeDonorEmail(member.email)
    const donorNames = donorNamesForMember(member.name)

    const { rows } = await pool.query(
      `SELECT d.id, d.donor_name, d.donor_email, d.donor_address,
              d.amount, d.refunded_total, d.live_amount, d.category, d.method, d.date, d.notes
         FROM ochr_donation_live d
        WHERE d.organization_id = $1
          AND (
            ($2::text IS NOT NULL AND lower(d.donor_email) = lower($2))
            OR (
              $3::text[] IS NOT NULL
              AND d.donor_email IS NULL
              AND d.donor_name = ANY($3::text[])
              AND (
                SELECT COUNT(*)::int FROM ochr_clients c
                 WHERE c.organization_id = $1
                   AND c.id <> $4
                   AND (c.name = d.donor_name OR c.name = ('[Sample] ' || d.donor_name))
              ) = 0
              AND EXISTS (
                SELECT 1 FROM ochr_clients self
                 WHERE self.organization_id = $1
                   AND self.id = $4
                   AND (self.name = d.donor_name OR self.name = ('[Sample] ' || d.donor_name))
              )
            )
          )
        ORDER BY d.date DESC, d.id DESC
        LIMIT 200`,
      [req.organizationId, emailKey, donorNames.length ? donorNames : null, id]
    )

    const total = rows.reduce((sum, r) => sum + Number(r.live_amount), 0)
    res.set('Cache-Control', 'private, max-age=30')
    res.json({
      by:         emailKey ? 'email' : 'name',
      match_key:  emailKey || member.name,
      lines:      rows,
      total:      Number(total.toFixed(2)),
      gift_count: rows.length,
    })
  } catch (err) {
    console.error('member donations failed:', err)
    res.status(500).json({ error: 'Failed to load member donations' })
  }
})

// GET /api/clients/:id/checkins (CHK.4 / CHK-04)
// A member's attendance history — the services they checked in to,
// newest first. Tenant-scoped on both the member and the check-ins.
// Title/date/time are the stamps written at check-in. NULL is unknown;
// this query does not join the live calendar.
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
              ci.calendar_event_id AS event_id,
              ci.attended_title AS event_title,
              to_char(ci.attended_date, 'YYYY-MM-DD') AS event_date,
              to_char(ci.attended_time, 'HH24:MI') AS attended_time
         FROM ochr_checkins ci
        WHERE ci.organization_id = $1 AND ci.client_id = $2
        ORDER BY ci.attended_date DESC NULLS LAST, ci.checked_in_at DESC
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
    const {
      name, company, email, phone, notes, status, role, tags, birth_date, joined_date, avatar,
      mailing_address_line1, mailing_address_line2, mailing_city, mailing_state, mailing_postal,
    } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
    const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
    const { rows } = await pool.query(
      `INSERT INTO ochr_clients (
         organization_id, name, company, email, phone, notes, status, role, tags,
         birth_date, joined_date, avatar,
         mailing_address_line1, mailing_address_line2, mailing_city, mailing_state, mailing_postal
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING ${CLIENT_PUBLIC_COLUMNS}`,
      [req.organizationId, name, company, email, phone, notes, status || 'active', role || 'Member', tags,
       birth_date || null, joined_date || null, avatar || null,
       clip(mailing_address_line1, 200), clip(mailing_address_line2, 200),
       clip(mailing_city, 100), clip(mailing_state, 40), clip(mailing_postal, 20)]
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

// Explicit, admin-only profile minimization. This is not vaulted Remove.
router.post('/:id/deidentify', requireRole('admin'), async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  if (req.body?.confirm !== 'DEIDENTIFY' || req.body?.acknowledge_history_retained !== true) {
    return res.status(400).json({ error: 'Confirm DEIDENTIFY and acknowledge that parish history and historical names remain.' })
  }
  try {
    // Organization admission first (refuses a held organization with 409),
    // then the profile row: the same lock order as HOLD and login lifecycle.
    const result = await withOrganizationAdmission(req.organizationId, async (client) => {
      // Exclusive for the whole transaction: an audit write about this member
      // that is still open finishes first (and is scrubbed below), and one
      // that starts now drops the contact keys itself (migration 114).
      await client.query('SELECT pg_advisory_xact_lock(ochr_member_minimization_key($1, $2))', [req.organizationId, id])
      const { rows: [profile] } = await client.query('SELECT id, deidentified_at FROM ochr_clients WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, req.organizationId])
      if (!profile) return { status: 404, body: { error: 'Member not found' } }
      await client.query(`INSERT INTO ochr_profile_minimizations (organization_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.organizationId, id])
      await client.query(`UPDATE ochr_clients SET email = NULL, phone = NULL, notes = NULL, avatar = NULL, birth_date = NULL, calendar_token = NULL, swap_token = NULL, mailing_address_line1 = NULL, mailing_address_line2 = NULL, mailing_city = NULL, mailing_state = NULL, mailing_postal = NULL, status = 'inactive', deidentified_at = COALESCE(deidentified_at, NOW()), updated_at = NOW() WHERE id = $1 AND organization_id = $2`, [id, req.organizationId])
      // Audit rows about this member keep the request bodies that created or
      // edited it. Drop the contact keys there too (names stay, by design);
      // the 114 trigger covers rows written later.
      const { rowCount: auditCopies } = await client.query(
        `UPDATE ochr_audit_log
            SET metadata = metadata - 'email' - 'phone' - 'notes' - 'avatar' - 'birth_date'
          WHERE organization_id = $1 AND entity_type = 'client'
            AND entity_id ~ '^[0-9]+$' AND ltrim(entity_id, '0') = $2
            AND metadata ?| ARRAY['email', 'phone', 'notes', 'avatar', 'birth_date']`,
        [req.organizationId, String(id)]
      )
      const { rows: [{ n: vaultCopies }] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM ochr_vault_entries
          WHERE organization_id = $1 AND entity_table = 'ochr_clients' AND entity_id = $2 AND restored_at IS NULL`,
        [req.organizationId, String(id)]
      )
      return { status: 200, body: {
        deidentified: true, already: !!profile.deidentified_at, id,
        contact_fields_cleared: true, calendar_access_revoked: true, parish_history_retained: true,
        audit_contact_copies_minimized: auditCopies,
        // Audit rows about OTHER records (imports, forms, gifts, groups) can
        // quote this member's details too; they were not searched or counted.
        other_audit_copies: 'not_measured',
        // Verified payment-provider events are kept for reconciliation
        // (ochr_billing_event_receipts) and can name a donor; not searched.
        billing_event_receipts: 'not_measured',
        // Earlier vault captures of this member keep their snapshot; the
        // minimization marker refuses restoring contact data from them.
        vault_snapshots_retained: vaultCopies,
        vault_capture_created: false, provider_status: 'not_contacted', backup_status: 'not_erased', all_copies_erased: false,
      } }
    })
    if (result.status === 200) markStewardship(res, { action: 'deidentify', targetId: id, already: result.body.already })
    res.status(result.status).json(result.body)
  } catch (err) {
    console.error('clients.deidentify failed:', err)
    res.status(500).json({ error: 'Failed to minimize member contact data' })
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
    const PATCHABLE = ['name', 'company', 'email', 'phone', 'notes', 'status', 'role', 'tags', 'birth_date', 'joined_date', 'avatar', 'mailing_address_line1', 'mailing_address_line2', 'mailing_city', 'mailing_state', 'mailing_postal']
    // A present name must be a non-blank string, stored trimmed — the same
    // rule POST and CSV import already apply. Before, '' became NULL and
    // hit the NOT NULL constraint (500), and '   ' was saved as a blank
    // member name that every list and header then showed as empty.
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
        return res.status(400).json({ error: 'Name is required' })
      }
      req.body.name = req.body.name.trim()
    }
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
        WHERE id = $${vals.length + 1} AND organization_id = $${vals.length + 2} AND deidentified_at IS NULL
        RETURNING ${CLIENT_PUBLIC_COLUMNS}`,
      [...vals, id, req.organizationId]
    )
    if (!rows.length) {
      const { rows: minimized } = await pool.query('SELECT id FROM ochr_clients WHERE id = $1 AND organization_id = $2 AND deidentified_at IS NOT NULL', [id, req.organizationId])
      return minimized.length ? res.status(409).json({ error: 'This profile contact data has been minimized and cannot be restored by editing.' }) : res.status(404).json({ error: 'Not found' })
    }
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update client' })
  }
})

// DELETE /api/clients/:id — protected by the Continuity Vault.
//
// This is the delete the vault was built for. Postgres would cascade away
// attendance, group membership, unavailability and notifications, and
// null out the link on her baptism, her pledge and her invoices. The
// capture holds all of it, and a restore reconnects the ones that
// survived with a hole in them.
router.delete('/:id', protectedDelete('member', { failure: 'Failed to delete client' }))

export default router
