// Migration Studio (MIG.1) — a human-reviewed path for bringing a
// parish's basic records into OpenChurch.
//
//   GET    /api/imports                → batch history (org)
//   POST   /api/imports                → parse a CSV into a staged batch
//   GET    /api/imports/:id            → one batch (mapping, summary, receipt)
//   GET    /api/imports/:id/rows       → the rows (?status=, paginated)
//   PUT    /api/imports/:id/mapping    → confirm mapping → validate + preview
//   PATCH  /api/imports/:id/rows/:rowId → a person's decision on one row
//   POST   /api/imports/:id/commit     → ADMIN: the explicit, atomic import
//   POST   /api/imports/:id/abandon    → close a batch without importing
//
// Mount (app.js):
//   app.use('/api/imports', requireAuth, writeGate, auditLog('import_batch'), importsRouter)
//
// The rules this file exists to keep:
//   · Nothing before commit touches ochr_clients / ochr_funds /
//     ochr_donations. Upload, mapping, validation, and review all live in
//     the staging tables from migration 081.
//   · The commit is one transaction. A failure rolls the whole thing
//     back — there is no half-imported state to explain to a secretary.
//   · Only an admin commits. Staff may prepare and review (writeGate),
//     which is the office's real division of labor.
//   · Duplicate detection is explainable or it doesn't exist: every
//     possible-duplicate row carries the sentence that made it one, and
//     nothing is ever merged — the choices are import anyway, skip, or
//     leave it for follow-up. (True merging needs a person and the
//     member's own record; this model doesn't support it safely, so the
//     Studio doesn't offer it.)
//   · No AI touches this path. Mapping suggestions are deterministic
//     header heuristics, shown and confirmable.
//   · The original file is NOT stored — only the parsed rows, kept with
//     the batch as its working record. The UI says exactly that.
//   · The parsed rows are not kept forever either (MIG.1.1). They are the
//     parish's roster/giving history in a second place; thirty days after
//     an import finishes or closes they are removed, and the receipt,
//     counts, reasons and audit history stay. `rows_available` on every
//     batch response says which side of that line a batch is on.
//   · Every message a person reads comes from server/src/i18n/messages.js
//     with a stable key and both languages. A parish working in Spanish
//     must not get English at the moment something goes wrong.

import { Router } from 'express'
import pool from '../db.js'
import { normalizeDonorEmail } from '../finance/donorIdentity.js'
import { parseCSV, detectSeparator } from '../utils/csv.js'
import { requireIntParam, parsePagination } from '../utils/params.js'
import { requireRole } from '../middleware/auth.js'
import { monitor } from '../monitoring/index.js'
import { msg, issue as issueMsg, localize } from '../i18n/messages.js'
import { captureAndDeleteMany } from '../vault/index.js'
import { faultKind } from '../utils/faultKind.js'

const router = Router()

// Thirty days, chosen against a parish's actual calendar rather than a
// round number: two monthly bookkeeping cycles close inside the window,
// which is when somebody would notice an import had gone wrong and go
// looking at the rows. Long enough to survive a holiday weekend or a
// volunteer's schedule; short enough that a committed batch is not a
// permanent second copy of the roster.
//
// Widen it if field use argues for it — the number lives here, the policy
// sentence is generated from it, and the interface asks the server rather
// than restating it, so one edit moves all three.
export const IMPORT_ROWS_RETENTION_DAYS = 30

const MAX_CSV_CHARS = 5 * 1024 * 1024
const MAX_ROWS = 5000
const MAX_HEADERS = 60

// ── What each import kind accepts ───────────────────────────────────────────
// `fields` are the destination slots the mapping step offers. Labels live
// client-side (bilingual); the keys here are the contract.

export const KINDS = {
  members: {
    fields: ['name', 'email', 'phone', 'role', 'tags'],
    required: ['name'],
  },
  funds: {
    fields: ['name', 'description'],
    required: ['name'],
  },
  gifts: {
    fields: ['donor_name', 'donor_email', 'amount', 'date', 'fund', 'method', 'notes'],
    required: ['donor_name', 'amount', 'date'],
  },
}

// ── Deterministic mapping suggestions ───────────────────────────────────────
// Lowercased, de-punctuated header → destination field. Ambiguous headers
// simply get no suggestion; a person decides.

const SYNONYMS = {
  members: {
    name: 'name', fullname: 'name', member: 'name', membername: 'name',
    parishioner: 'name', displayname: 'name',
    email: 'email', emailaddress: 'email', mail: 'email',
    phone: 'phone', phonenumber: 'phone', telephone: 'phone', mobile: 'phone', cell: 'phone',
    role: 'role', type: 'role',
    tags: 'tags', groups: 'tags', ministries: 'tags',
  },
  funds: {
    name: 'name', fund: 'name', fundname: 'name', designation: 'name', purpose: 'name',
    description: 'description', notes: 'description', memo: 'description',
  },
  gifts: {
    donor: 'donor_name', donorname: 'donor_name', name: 'donor_name', giver: 'donor_name',
    member: 'donor_name', family: 'donor_name',
    email: 'donor_email', donoremail: 'donor_email',
    amount: 'amount', gift: 'amount', giftamount: 'amount', donation: 'amount', total: 'amount',
    date: 'date', giftdate: 'date', donationdate: 'date', given: 'date', receiveddate: 'date',
    fund: 'fund', fundname: 'fund', designation: 'fund', purpose: 'fund', category: 'fund',
    method: 'method', paymenttype: 'method', paymentmethod: 'method',
    notes: 'notes', memo: 'notes', comment: 'notes',
  },
}

function suggestMapping(kind, headers) {
  const dict = SYNONYMS[kind]
  const taken = new Set()
  const mapping = {}
  for (const h of headers) {
    const key = h.toLowerCase().replace(/[^a-z0-9]/g, '')
    const dest = dict[key]
    mapping[h] = dest && !taken.has(dest) ? dest : null
    if (dest && !taken.has(dest)) taken.add(dest)
  }
  return mapping
}

// The key two names are compared BY — not the name itself, which is
// stored exactly as the parish typed it.
//
// Accents are folded because a roster exported from old software and a
// roster typed by a volunteer will not agree about them, and «María
// González» and «Maria Gonzalez» are one person to everybody except a
// string comparison. Case and runs of whitespace go for the same reason.
// Punctuation stays: "St. Anne" and "St Anne" are a judgement call, and
// silently merging them is the kind of cleverness that loses trust.
//
// This is a COMPARISON key only. Nothing is ever written folded, and no
// two records are ever merged on the strength of it — a match becomes a
// possible duplicate with a sentence, and a person decides.
export function fold(value) {
  return String(value ?? '')
    .normalize('NFD')                 // separate the letter from its accent
    .replace(/\p{Diacritic}/gu, '')   // …and drop the accent
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// ── Value normalizers ───────────────────────────────────────────────────────

function normalizeDate(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) // ISO
  if (m) return checkDate(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/) // US M/D/YYYY
  if (m) return checkDate(+m[3], +m[1], +m[2])
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/) // M/D/YY
  if (m) return checkDate(+m[3] >= 50 ? 1900 + +m[3] : 2000 + +m[3], +m[1], +m[2])
  return null
}
function checkDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function normalizeMoney(v) {
  const s = String(v ?? '').trim().replace(/[$,\s]/g, '')
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0 || n > 9999999) return null
  return Math.round(n * 100) / 100
}

const GIFT_METHODS = new Set(['cash', 'check', 'card', 'online', 'other'])
function normalizeMethod(v) {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return 'cash'
  if (GIFT_METHODS.has(s)) return s
  if (/cheque|chk/.test(s)) return 'check'
  if (/credit|debit|visa|master/.test(s)) return 'card'
  if (/ach|bank|transfer|stripe|paypal|venmo|web/.test(s)) return 'online'
  return 'other'
}

// ── Row validation + duplicate detection per kind ───────────────────────────
// Each returns { normalized, status, issue, issue_key, issue_vars }.
// Statuses: ready | held | possible_duplicate.
//
// The sentence is built from a catalogue key, and the key and its
// variables are stored beside it — so the same held row reads in Spanish
// for a Spanish-speaking secretary without anything being translated at
// request time. The variables are the parish's own data (a name, an
// email, a fund) and are interpolated, never translated.

function checkMember(values, ctx) {
  const name = (values.name ?? '').trim()
  if (!name) return { normalized: values, status: 'held', ...issueMsg('row.name_missing') }
  const email = (values.email ?? '').trim()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { normalized: { ...values, name }, status: 'held', ...issueMsg('row.email_malformed', { email }) }
  }
  const normalized = { name, email: email || null, phone: (values.phone ?? '').trim() || null, role: (values.role ?? '').trim() || null, tags: (values.tags ?? '').trim() || null }
  const emailKey = fold(email)
  if (emailKey && ctx.existingEmails.has(emailKey)) {
    return { normalized, status: 'possible_duplicate', ...issueMsg('dup.member_email_exists', { email }) }
  }
  if (emailKey && ctx.fileEmails.has(emailKey)) {
    return { normalized, status: 'possible_duplicate', ...issueMsg('dup.member_email_in_file', { email }) }
  }
  const nameKey = fold(name)
  if (ctx.fileNames?.has(nameKey)) {
    return { normalized, status: 'possible_duplicate', ...issueMsg('dup.member_name_in_file', { name }) }
  }
  if (ctx.existingNames.has(nameKey)) {
    return { normalized, status: 'possible_duplicate', ...issueMsg('dup.member_name_exists', { name }) }
  }
  if (emailKey) ctx.fileEmails.add(emailKey)
  ctx.fileNames?.add(nameKey)
  return { normalized, status: 'ready', issue: null, issue_key: null, issue_vars: null }
}

function checkFund(values, ctx) {
  const name = (values.name ?? '').trim()
  if (!name) return { normalized: values, status: 'held', ...issueMsg('row.fund_name_missing') }
  const normalized = { name, description: (values.description ?? '').trim() || null }
  const key = fold(name)
  if (ctx.existingFunds.has(key)) {
    return { normalized, status: 'possible_duplicate', ...issueMsg('dup.fund_exists', { name }) }
  }
  if (ctx.fileFunds.has(key)) {
    return { normalized, status: 'possible_duplicate', ...issueMsg('dup.fund_in_file', { name }) }
  }
  ctx.fileFunds.add(key)
  return { normalized, status: 'ready', issue: null, issue_key: null, issue_vars: null }
}

function checkGift(values, ctx) {
  const donor = (values.donor_name ?? '').trim()
  if (!donor) return { normalized: values, status: 'held', ...issueMsg('row.giver_missing') }
  const amount = normalizeMoney(values.amount)
  if (amount === null) {
    return { normalized: { ...values, donor_name: donor }, status: 'held', ...issueMsg('row.amount_unreadable', { value: values.amount ?? '' }) }
  }
  const date = normalizeDate(values.date)
  if (date === null) {
    return { normalized: { ...values, donor_name: donor }, status: 'held', ...issueMsg('row.date_unreadable', { value: values.date ?? '' }) }
  }
  const fundName = (values.fund ?? '').trim()
  let fundId = null
  if (fundName) {
    fundId = ctx.fundIdByName.get(fold(fundName)) ?? null
    if (fundId === null) {
      return {
        normalized: { donor_name: donor, amount, date, fund: fundName },
        status: 'held',
        ...issueMsg('row.fund_unknown', { fund: fundName }),
      }
    }
  }
  const email = normalizeDonorEmail(values.donor_email) ?? ''
  const normalized = {
    donor_name: donor, donor_email: email || null, amount, date,
    fund: fundName || null, fund_id: fundId,
    method: normalizeMethod(values.method), notes: (values.notes ?? '').trim() || null,
  }
  const dupKey = `${fold(donor)}|${date}|${amount.toFixed(2)}`
  if (ctx.existingGifts.has(dupKey)) {
    return { normalized, status: 'possible_duplicate', ...issueMsg('dup.gift_exists', { amount: amount.toFixed(2), donor, date }) }
  }
  if (ctx.fileGifts.has(dupKey)) {
    return { normalized, status: 'possible_duplicate', ...issueMsg('dup.gift_in_file') }
  }
  ctx.fileGifts.add(dupKey)
  return { normalized, status: 'ready', issue: null, issue_key: null, issue_vars: null }
}

// The (date, amount) pairs a gift file actually contains, deduplicated.
// This is what bounds the duplicate lookup below: the importer only needs to
// know about existing gifts that could possibly collide, and a gift can only
// collide if it shares BOTH a date and an amount with a row in the file.
//
// Rows whose date or amount won't parse are skipped — checkGift holds those
// before it ever reaches the duplicate check, so they can't match anything.
export function giftCandidateKeys(rowValues) {
  const seen = new Set()
  const dates = [], amounts = []
  for (const values of rowValues) {
    const amount = normalizeMoney(values.amount)
    if (amount === null) continue
    const date = normalizeDate(values.date)
    if (date === null) continue
    const key = `${date}|${amount.toFixed(2)}`
    if (seen.has(key)) continue
    seen.add(key)
    dates.push(date)
    amounts.push(amount.toFixed(2))
  }
  return { dates, amounts }
}

// Existing-data context, loaded once per validation pass.
//
// `candidates` is only used by the gifts branch. It used to load the parish's
// ENTIRE donations table into a JS Set on every preview — a parish five years
// into weekly giving has six figures of rows, all of them materialised as
// strings in the API process to check a two-hundred-row spreadsheet. The
// import that most needs to work is the first one after a migration, which is
// exactly when the table is largest.
//
// Measured on five years of weekly giving from 400 households (104,000 gifts)
// against a 200-row file covering eight Sundays:
//
//     old — whole ledger      104,000 rows   48.5 ms
//     new — bounded by file     2,000 rows   15.1 ms
//
// The milliseconds are the smaller half. 52x fewer rows cross the wire and
// become JS strings in a Set inside a serverless function with a fixed memory
// ceiling — that, not query time, is what would have failed first.
//
// Now the lookup is bounded by the file: only gifts sharing a (date, amount)
// pair with something in the file can possibly be duplicates, so only those
// come back. The dup key itself is unchanged — still folded name, date, and
// amount, still compared in JS — so the same files produce the same verdicts.
//
// Note on what the tests can and cannot see here. The join is a PRE-filter;
// correctness lives in the JS key. Widening the join (matching on date alone,
// or amount alone) therefore leaves every verdict identical and the suite
// green — it is a performance regression, not a correctness one, and no test
// will ever catch it. Narrowing it, or dropping the org scope, changes
// verdicts and is guarded ("a gift already in the ledger is flagged, and only
// the right one is"). Anyone tuning this join is on their own for speed and
// covered for correctness; that asymmetry is deliberate, not an oversight.
async function loadContext(kind, orgId, candidates = null) {
  if (kind === 'members') {
    // Folded in JS rather than in SQL: Postgres can do this with the
    // `unaccent` extension, which is not installed on every deployment
    // target and would make duplicate detection silently weaker wherever
    // it is missing. A parish roster is small; folding it here is free
    // and behaves identically everywhere.
    const { rows } = await pool.query(
      `SELECT name, COALESCE(email, '') AS email
         FROM ochr_clients WHERE organization_id = $1`, [orgId])
    return {
      existingNames: new Set(rows.map(r => fold(r.name))),
      existingEmails: new Set(rows.map(r => fold(r.email)).filter(Boolean)),
      fileEmails: new Set(),
      fileNames: new Set(),
    }
  }
  if (kind === 'funds') {
    const { rows } = await pool.query(
      `SELECT name FROM ochr_funds WHERE organization_id = $1`, [orgId])
    return { existingFunds: new Set(rows.map(r => fold(r.name))), fileFunds: new Set() }
  }
  // gifts
  const { dates = [], amounts = [] } = candidates ?? {}
  const [{ rows: gifts }, { rows: funds }] = await Promise.all([
    // No candidate pairs (an all-unreadable file) means nothing can collide,
    // so skip the query entirely rather than sending two empty arrays.
    dates.length
      ? pool.query(
          `SELECT d.donor_name, to_char(d.date, 'YYYY-MM-DD') AS date, d.amount
             FROM ochr_donations d
             JOIN (SELECT DISTINCT * FROM unnest($2::date[], $3::numeric[]))
                  AS want(date, amount)
               ON want.date = d.date AND want.amount = d.amount
            WHERE d.organization_id = $1`,
          [orgId, dates, amounts])
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT id, name FROM ochr_funds WHERE organization_id = $1`, [orgId]),
  ])
  return {
    existingGifts: new Set(gifts.map(g => `${fold(g.donor_name)}|${g.date}|${Number(g.amount).toFixed(2)}`)),
    fileGifts: new Set(),
    fundIdByName: new Map(funds.map(f => [fold(f.name), f.id])),
  }
}

const CHECKERS = { members: checkMember, funds: checkFund, gifts: checkGift }

// ── Batch reads ─────────────────────────────────────────────────────────────

// rows_purged_at / rows_purged_count are part of every batch read, not an
// extra query: withRowAvailability() answers "are the rows still here?"
// from this row, and a column list that quietly omitted them made every
// purged batch report itself as available. The first version of this file
// did exactly that, and only the retention tests noticed.
const BATCH_COLS = `id, kind, source_name, status, headers, mapping, row_count,
                    summary, receipt, created_by, approved_by, committed_at,
                    rows_purged_at, rows_purged_count,
                    undone_at, undone_by_name, undo_summary,
                    created_at, updated_at`

async function loadBatch(id, orgId) {
  const { rows: [b] } = await pool.query(
    `SELECT ${BATCH_COLS} FROM ochr_import_batches WHERE id = $1 AND organization_id = $2`,
    [id, orgId])
  return b ?? null
}

// Whether the rows read from the file are still here, said plainly.
//
// This is the difference between an interface that can explain itself and
// one that shows an empty review screen and lets a person conclude their
// import was lost. `rows_available` is the question anybody actually has;
// the date and the count are the evidence behind the answer.
//
// A purged batch is NOT relabelled. Its status still says what happened
// to the import — committed, abandoned — because that is what a person
// will look for a year later.
function withRowAvailability(batch) {
  const purged = Boolean(batch.rows_purged_at)
  const anchor = batch.committed_at ?? batch.updated_at ?? batch.created_at
  const until = anchor ? new Date(new Date(anchor).getTime() + IMPORT_ROWS_RETENTION_DAYS * 86400000) : null
  return {
    ...batch,
    rows_available: !purged,
    rows_purged_at: batch.rows_purged_at ?? null,
    rows_purged_count: batch.rows_purged_count ?? null,
    // Only meaningful while they are still here. A date in the past on a
    // batch that still has its rows would be a promise we had broken.
    rows_available_until: purged ? null : (until ? until.toISOString().slice(0, 10) : null),
    retention_days: IMPORT_ROWS_RETENTION_DAYS,
    // Undo needs the staged rows to know what it created, so it is
    // available for exactly as long as they are — one window, not two.
    can_undo: batch.status === 'committed' && !purged && !batch.undone_at,
    undone_at: batch.undone_at ?? null,
    undone_by_name: batch.undone_by_name ?? null,
    undo_summary: batch.undo_summary ?? null,
  }
}

// The policy, in the parish's language, for the Studio copy and the
// receipt. One sentence, one place — so the interface cannot promise
// something the prune does not do.
function retentionNotice() {
  return {
    days: IMPORT_ROWS_RETENTION_DAYS,
    ...localize('import.retention_notice', { days: IMPORT_ROWS_RETENTION_DAYS }),
  }
}

// GET /api/imports — history, newest first.
router.get('/', async (req, res) => {
  const { limit, offset } = parsePagination(req.query)
  try {
    const { rows } = await pool.query(
      `SELECT ${BATCH_COLS} FROM ochr_import_batches
        WHERE organization_id = $1
        ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.organizationId, limit, offset])
    res.json({ batches: rows.map(withRowAvailability), retention: retentionNotice() })
  } catch (err) {
    monitor.error('imports.list', err, { orgId: req.organizationId })
    res.status(500).json(msg('import.history_failed'))
  }
})

// POST /api/imports — parse a CSV into a staged batch. Writes staging only.
router.post('/', async (req, res) => {
  const kind = req.body?.kind
  if (!KINDS[kind]) return res.status(400).json(msg('import.kind_invalid'))
  const sourceName = typeof req.body?.source_name === 'string'
    ? req.body.source_name.trim().slice(0, 200) : ''
  const csv = req.body?.csv
  if (typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json(msg('import.file_empty'))
  }
  if (csv.length > MAX_CSV_CHARS) {
    return res.status(400).json(msg('import.file_too_large'))
  }

  // Detect the separator rather than assuming a comma: Excel on a
  // Spanish or European system writes semicolons from a menu item that
  // still says CSV.
  const separator = detectSeparator(csv)
  let parsed
  try { parsed = parseCSV(csv, separator) } catch {
    return res.status(400).json(msg('import.file_unreadable'))
  }
  if (!parsed.length) return res.status(400).json(msg('import.file_empty'))
  const headers = parsed[0].map(h => String(h ?? '').trim()).filter(Boolean)
  if (!headers.length || headers.length > MAX_HEADERS) {
    return res.status(400).json(msg('import.headings_missing'))
  }
  // One column, for an import that needs several. Whatever this file
  // separates its values with, it is not something we read — and the
  // heading is usually the proof, sitting there as "Donor^Amount^Date".
  //
  // Deliberately not conditional on the heading containing a separator we
  // recognise: the whole point is that we do NOT recognise it. A caret,
  // a middle dot, a fixed-width export — all of them arrive as one
  // column, and all of them used to sail through here and fail three
  // screens later complaining about an unmapped field, which told the
  // person nothing about what was actually wrong.
  //
  // Members and funds need only a name, so a genuine one-column list of
  // people or funds is legitimate and passes untouched.
  if (headers.length === 1 && KINDS[kind].required.length > 1) {
    return res.status(400).json(msg('import.one_column', { heading: headers[0].slice(0, 60) }))
  }
  const dataRows = parsed.slice(1)
  if (!dataRows.length) return res.status(400).json(msg('import.no_rows'))
  if (dataRows.length > MAX_ROWS) {
    return res.status(400).json(msg('import.too_many_rows', { max: MAX_ROWS }))
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [batch] } = await client.query(
      `INSERT INTO ochr_import_batches
         (organization_id, kind, source_name, headers, row_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.organizationId, kind, sourceName || 'spreadsheet',
       JSON.stringify(headers), dataRows.length, req.user.id])

    const payload = dataRows.map((cells, i) => {
      const raw = {}
      headers.forEach((h, c) => { raw[h] = cells[c] != null ? String(cells[c]) : '' })
      return { row_no: i + 1, raw }
    })
    await client.query(
      `INSERT INTO ochr_import_rows (organization_id, batch_id, row_no, raw)
       SELECT $1, $2, v.row_no, v.raw
         FROM jsonb_to_recordset($3::jsonb) AS v(row_no int, raw jsonb)`,
      [req.organizationId, batch.id, JSON.stringify(payload)])
    await client.query('COMMIT')

    res.status(201).json({
      id: batch.id,
      headers,
      suggested_mapping: suggestMapping(kind, headers),
      fields: KINDS[kind].fields,
      required: KINDS[kind].required,
      row_count: dataRows.length,
      sample_rows: payload.slice(0, 5).map(p => p.raw),
      // Shown so a person can see we read their file the way they wrote
      // it, rather than trusting that we guessed right.
      separator: separator === '\t' ? 'tab' : separator,
      // Said at the start, not buried in a receipt at the end: the person
      // uploading is the person entitled to know how long their parish's
      // rows will sit here.
      retention: retentionNotice(),
    })
  } catch (err) {
    await client.query('ROLLBACK')
    monitor.error('imports.create', err, { orgId: req.organizationId })
    res.status(500).json(msg('import.read_failed'))
  } finally {
    client.release()
  }
})

// GET /api/imports/:id
router.get('/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const batch = await loadBatch(id, req.organizationId)
    if (!batch) return res.status(404).json(msg('import.not_found'))
    res.json({
      ...withRowAvailability(batch),
      fields: KINDS[batch.kind].fields,
      required: KINDS[batch.kind].required,
      retention: retentionNotice(),
    })
  } catch (err) {
    monitor.error('imports.get', err, { orgId: req.organizationId, id })
    res.status(500).json(msg('import.load_failed'))
  }
})

// GET /api/imports/:id/rows?status=
router.get('/:id/rows', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const { limit, offset } = parsePagination(req.query)
  try {
    const batch = await loadBatch(id, req.organizationId)
    if (!batch) return res.status(404).json(msg('import.not_found'))
    const params = [id, req.organizationId]
    let statusClause = ''
    if (typeof req.query.status === 'string' &&
        ['pending', 'ready', 'held', 'possible_duplicate', 'skipped', 'imported'].includes(req.query.status)) {
      params.push(req.query.status)
      statusClause = `AND status = $${params.length}`
    }
    params.push(limit, offset)
    if (batch.rows_purged_at) {
      // Not an empty list. An empty list would read as "your file had no
      // rows", which is a different and alarming thing to be told.
      return res.status(410).json({
        ...msg('import.rows_purged', { days: IMPORT_ROWS_RETENTION_DAYS }),
        rows: [],
        rows_available: false,
        rows_purged_at: batch.rows_purged_at,
        rows_purged_count: batch.rows_purged_count,
      })
    }
    const { rows } = await pool.query(
      `SELECT id, row_no, raw, normalized, status, issue, issue_key, issue_vars,
              decision, created_record_id
         FROM ochr_import_rows
        WHERE batch_id = $1 AND organization_id = $2 ${statusClause}
        ORDER BY row_no
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
    res.json({
      rows: rows.map(r => ({
        ...r,
        // Both languages, rendered from the stored key and the row's own
        // values. The values are the parish's data and are never
        // translated — only placed.
        issue_i18n: r.issue_key ? localize(r.issue_key, r.issue_vars ?? {}) : null,
      })),
      rows_available: true,
    })
  } catch (err) {
    monitor.error('imports.rows', err, { orgId: req.organizationId, id })
    res.status(500).json(msg('import.rows_load_failed'))
  }
})

// PUT /api/imports/:id/mapping — confirm the mapping; validate everything.
// Re-runnable while uncommitted; re-running resets per-row decisions
// (the review they belonged to no longer exists).
router.put('/:id/mapping', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const mapping = req.body?.mapping
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return res.status(400).json(msg('import.mapping_required'))
  }
  try {
    const batch = await loadBatch(id, req.organizationId)
    if (!batch) return res.status(404).json(msg('import.not_found'))
    if (batch.status === 'committed' || batch.status === 'abandoned') {
      return res.status(409).json(msg('import.closed'))
    }

    const { fields, required } = KINDS[batch.kind]
    const headers = batch.headers
    // Every mapping key must be a real source column; every value a real
    // destination (or null = leave that column out, visibly).
    const clean = {}
    const used = new Set()
    for (const h of headers) {
      const dest = mapping[h] ?? null
      if (dest !== null) {
        if (!fields.includes(dest)) return res.status(400).json(msg('import.field_unsupported', { field: dest }))
        if (used.has(dest)) return res.status(400).json(msg('import.field_duplicated', { field: dest }))
        used.add(dest)
      }
      clean[h] = dest
    }
    const missing = required.filter(f => !used.has(f))
    if (missing.length) {
      return res.status(400).json(msg('import.required_unmapped', { fields: missing.join(', ') }))
    }

    // Rows first, then the context. The order matters: for gifts the context
    // query is bounded BY the file's contents, so it can't be built until the
    // file has been read.
    const { rows: allRows } = await pool.query(
      `SELECT id, row_no, raw FROM ochr_import_rows
        WHERE batch_id = $1 AND organization_id = $2 ORDER BY row_no`,
      [id, req.organizationId])

    const mappedRows = allRows.map(r => {
      const values = {}
      for (const [h, dest] of Object.entries(clean)) {
        if (dest) values[dest] = r.raw[h]
      }
      return { id: r.id, values }
    })

    // Validate every row in one pass against a context loaded once.
    const candidates = batch.kind === 'gifts'
      ? giftCandidateKeys(mappedRows.map(r => r.values))
      : null
    const ctx = await loadContext(batch.kind, req.organizationId, candidates)
    const check = CHECKERS[batch.kind]

    const results = mappedRows.map(r => {
      const { normalized, status, issue, issue_key, issue_vars } = check(r.values, ctx)
      return { id: r.id, normalized, status, issue, issue_key, issue_vars: issue_vars ?? null }
    })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE ochr_import_rows r
            SET normalized = v.normalized, status = v.status, issue = v.issue,
                issue_key = v.issue_key, issue_vars = v.issue_vars,
                decision = NULL, created_record_id = NULL
           FROM jsonb_to_recordset($1::jsonb)
                AS v(id bigint, normalized jsonb, status text, issue text,
                     issue_key text, issue_vars jsonb)
          WHERE r.id = v.id AND r.batch_id = $2 AND r.organization_id = $3`,
        [JSON.stringify(results), id, req.organizationId])

      const summary = {
        total: results.length,
        ready: results.filter(x => x.status === 'ready').length,
        held: results.filter(x => x.status === 'held').length,
        possible_duplicate: results.filter(x => x.status === 'possible_duplicate').length,
        ignored_columns: headers.filter(h => clean[h] === null),
      }
      await client.query(
        `UPDATE ochr_import_batches
            SET mapping = $3, summary = $4, status = 'mapped', updated_at = NOW()
          WHERE id = $1 AND organization_id = $2`,
        [id, req.organizationId, JSON.stringify(clean), JSON.stringify(summary)])
      await client.query('COMMIT')
      res.json({ ok: true, summary, retention: retentionNotice() })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    // `fault` is the open question, not decoration. This route flakes about
    // one run in seventeen and the two remaining candidates — a caught query
    // error, or a pool.connect() timeout at PG_POOL_MAX=5 — are currently
    // indistinguishable from outside: same 500, same message. Sixteen clean
    // runs did not reproduce it, so the next occurrence has to identify
    // itself or it teaches nothing either.
    const fault = faultKind(err)
    monitor.error('imports.mapping', err, { orgId: req.organizationId, id, fault })
    res.status(500).json({ ...msg('import.mapping_failed'), fault })
  }
})

// PATCH /api/imports/:id/rows/:rowId — one person's decision on one row.
//   { decision: 'import' | 'skip' | null }
// 'import' is only meaningful on a possible duplicate (import anyway);
// 'skip' works on any reviewable row; null clears a decision.
router.patch('/:id/rows/:rowId', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const rowId = requireIntParam(req, res, 'rowId'); if (rowId === null) return
  const decision = req.body?.decision ?? null
  if (decision !== null && !['import', 'skip'].includes(decision)) {
    return res.status(400).json(msg('row.decision_invalid'))
  }
  try {
    const batch = await loadBatch(id, req.organizationId)
    if (!batch) return res.status(404).json(msg('import.not_found'))
    if (batch.status !== 'mapped') return res.status(409).json(msg('import.review_not_open'))

    const { rows: [row] } = await pool.query(
      `SELECT status FROM ochr_import_rows
        WHERE id = $1 AND batch_id = $2 AND organization_id = $3`,
      [rowId, id, req.organizationId])
    if (!row) return res.status(404).json(msg('row.not_found'))
    if (!['ready', 'held', 'possible_duplicate'].includes(row.status)) {
      return res.status(409).json(msg('row.not_reviewable'))
    }
    if (decision === 'import' && row.status !== 'possible_duplicate') {
      return res.status(400).json(msg('row.import_anyway_only_duplicates'))
    }
    await pool.query(
      `UPDATE ochr_import_rows SET decision = $4
        WHERE id = $1 AND batch_id = $2 AND organization_id = $3`,
      [rowId, id, req.organizationId, decision])
    res.json({ ok: true })
  } catch (err) {
    monitor.error('imports.rowDecision', err, { orgId: req.organizationId, id, rowId })
    res.status(500).json(msg('row.decision_failed'))
  }
})

// ── The commit — admin-only, explicit, atomic ───────────────────────────────

async function insertRecord(client, kind, orgId, n) {
  if (kind === 'members') {
    const { rows: [r] } = await client.query(
      `INSERT INTO ochr_clients (organization_id, name, email, phone, role, tags, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING id`,
      [orgId, n.name, n.email, n.phone, n.role || 'Member', n.tags])
    return r.id
  }
  if (kind === 'funds') {
    const { rows: [r] } = await client.query(
      `INSERT INTO ochr_funds (organization_id, name, description, active)
       VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [orgId, n.name, n.description])
    return r.id
  }
  // gifts — source 'import' so a batch's gifts stay traceable; everything
  // downstream treats non-'online' rows identically to manual entry.
  const { rows: [r] } = await client.query(
    `INSERT INTO ochr_donations
       (organization_id, donor_name, donor_email, amount, date, fund_id, method, notes, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'import') RETURNING id`,
    [orgId, n.donor_name, n.donor_email, n.amount, n.date, n.fund_id, n.method, n.notes])
  return r.id
}

// requireRole('admin') answers a bare "Forbidden", which tells a
// secretary nothing about what to do next. The rule here is not a
// mystery — staff prepare and review, an administrator approves — so the
// refusal says that, in the reader's language. The role is still read
// live from the database, never from the token.
async function approvalGate(req, res, next) {
  if (!req.user?.id || !req.organizationId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const { rows } = await pool.query(
      'SELECT role FROM ochr_users WHERE id = $1 AND organization_id = $2',
      [req.user.id, req.organizationId])
    if (!rows.length) return res.status(401).json({ error: 'User no longer exists' })
    req.user.role = rows[0].role
    if (rows[0].role !== 'admin') return res.status(403).json(msg('import.approval_forbidden'))
    return next()
  } catch (err) {
    monitor.error('imports.approvalGate', err, { orgId: req.organizationId })
    return res.status(500).json({ error: 'Authorization check failed' })
  }
}

router.post('/:id/commit', approvalGate, async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [batch] } = await client.query(
      `SELECT * FROM ochr_import_batches
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, req.organizationId])
    if (!batch) {
      await client.query('ROLLBACK')
      return res.status(404).json(msg('import.not_found'))
    }
    if (batch.status !== 'mapped') {
      await client.query('ROLLBACK')
      return res.status(409).json(msg('import.not_reviewed'))
    }
    // A batch whose staged rows have expired cannot be approved: there is
    // nothing left to import, and the honest answer names the retention
    // window rather than reporting an empty batch.
    if (batch.rows_purged_at) {
      await client.query('ROLLBACK')
      return res.status(409).json(msg('import.rows_purged_cannot_commit', { days: IMPORT_ROWS_RETENTION_DAYS }))
    }

    const { rows: allRows } = await client.query(
      `SELECT id, row_no, normalized, status, issue, issue_key, decision
         FROM ochr_import_rows
        WHERE batch_id = $1 AND organization_id = $2
        ORDER BY row_no FOR UPDATE`,
      [id, req.organizationId])

    const toImport = []
    const skipped = []
    const heldForFollowUp = []
    const dupLeftForReview = []
    for (const r of allRows) {
      if (r.decision === 'skip') { skipped.push(r); continue }
      if (r.status === 'ready') { toImport.push(r); continue }
      if (r.status === 'possible_duplicate') {
        if (r.decision === 'import') toImport.push(r)
        else dupLeftForReview.push(r)
        continue
      }
      heldForFollowUp.push(r) // held rows never import
    }
    if (!toImport.length) {
      await client.query('ROLLBACK')
      return res.status(400).json(msg('import.nothing_ready'))
    }

    const imported = []
    for (const r of toImport) {
      const recordId = await insertRecord(client, batch.kind, req.organizationId, r.normalized)
      imported.push({ id: r.id, recordId })
    }
    await client.query(
      `UPDATE ochr_import_rows r
          SET status = 'imported', created_record_id = v.record_id
         FROM jsonb_to_recordset($1::jsonb) AS v(id bigint, record_id bigint)
        WHERE r.id = v.id AND r.batch_id = $2 AND r.organization_id = $3`,
      [JSON.stringify(imported.map(x => ({ id: x.id, record_id: x.recordId }))), id, req.organizationId])
    if (skipped.length) {
      await client.query(
        `UPDATE ochr_import_rows SET status = 'skipped'
          WHERE batch_id = $1 AND organization_id = $2 AND id = ANY($3::bigint[])`,
        [id, req.organizationId, skipped.map(r => r.id)])
    }

    const { rows: [orgRow] } = await client.query(
      'SELECT name FROM ochr_organizations WHERE id = $1', [req.organizationId])
    const { rows: [creator] } = await client.query(
      `SELECT name, email FROM ochr_users WHERE id = $1
       -- tenancy: batch.created_by is server-written and the batch was org-verified before this line. Scoped transitively through a parent this handler already checked.`, [batch.created_by])

    // Group follow-up reasons by their catalogue KEY, not by the rendered
    // sentence. Grouping by the sentence splits "the fund X is not in the
    // list" into one line per fund, which turns a receipt into a second
    // copy of the file; and it is untranslatable, because the sentence is
    // already baked. The key groups, and carries both languages.
    const issueCounts = new Map()
    for (const r of [...heldForFollowUp, ...dupLeftForReview]) {
      const key = r.issue_key || 'row.not_reviewable'
      issueCounts.set(key, (issueCounts.get(key) || 0) + 1)
    }

    const receipt = {
      parish: orgRow?.name ?? null,
      kind: batch.kind,
      source_name: batch.source_name,
      row_count: batch.row_count,
      imported: imported.length,
      skipped: skipped.length,
      held_for_follow_up: heldForFollowUp.length,
      duplicates_left_for_review: dupLeftForReview.length,
      duplicates_imported_anyway: toImport.filter(r => r.status === 'possible_duplicate').length,
      follow_up_reasons: [...issueCounts.entries()].map(([key, count]) => {
        // Rendered without row-specific values: a receipt reports how many
        // rows needed a fund that did not exist, not which fund each one
        // named. The rows carry that, for as long as they are kept.
        const generic = localize(key, {
          email: '—', name: '—', fund: '—', value: '—', amount: '—', donor: '—', date: '—',
        })
        return { reason: generic.en, reason_key: key, count, message: generic }
      }),
      ignored_columns: batch.summary?.ignored_columns ?? [],
      prepared_by: creator ? { name: creator.name, email: creator.email } : null,
      approved_by: { name: req.user.name ?? null, email: req.user.email ?? null },
      committed_at: new Date().toISOString(),
      // The protection statement the receipt prints. Kept truthful here,
      // in one place, so the UI can never over-promise.
      protection: {
        records: 'Imported members, funds, and gifts are ordinary parish records: they are covered by the same Archive & Recovery protection as records created in OpenChurch, and every later change to them is audited.',
        source_file: 'The original file was not stored. Keep your own copy of the file.',
        // The retention promise printed ON the receipt, so a person
        // reading it in six months knows why the rows are gone and that
        // this page is not.
        staged_rows: `The rows the Studio read from the file are kept for ${IMPORT_ROWS_RETENTION_DAYS} days after this import finished, then removed. This receipt, the counts above, and the reasons anything was held stay with the parish permanently.`,
      },
      retention_days: IMPORT_ROWS_RETENTION_DAYS,
    }

    await client.query(
      `UPDATE ochr_import_batches
          SET status = 'committed', receipt = $3, approved_by = $4,
              committed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId, JSON.stringify(receipt), req.user.id])
    await client.query('COMMIT')
    // `id` in the response body also gives the audit middleware its
    // entity_id — the commit lands in the log against this batch.
    res.json({
      ok: true, id, receipt,
      ...msg('import.committed', { imported: imported.length }),
      // `error` is the wrong word on a success. msg() supplies it for the
      // failure shape; strip it here rather than teach every client that
      // a 200 with an `error` field is fine.
      error: undefined,
    })
  } catch (err) {
    await client.query('ROLLBACK')
    monitor.error('imports.commit', err, { orgId: req.organizationId, id })
    res.status(500).json(msg('import.commit_failed'))
  } finally {
    client.release()
  }
})

// ── Undo a whole import ─────────────────────────────────────────────────────
//
// The mistake this exists for is a mapping error, not a mouse slip: the
// phone column mapped to `role`, approved, four hundred members now
// quietly wrong. Nobody restores four hundred records one at a time, so
// without this they live with it.
//
// The important design choice: undo does NOT delete. Every record goes
// through the Continuity Vault exactly as if a person had removed it one
// by one — captured with everything that would cascade, everything that
// would be orphaned, and a 400-day window to put any of them back. Undo
// is therefore itself undoable, which is the only version of a bulk
// reversal that is safe to offer a parish.
//
// And it refuses to touch anything a person has edited since. If somebody
// corrected a member's email the day after the import, that correction is
// theirs, not the import's, and taking it away would make undo the second
// mistake rather than the fix for the first. Those records are counted,
// named in the summary, and left exactly alone.

// What the import wrote, so we can tell an untouched record from an
// edited one. Compared field by field against the row's normalized values
// rather than by a timestamp: ochr_donations and ochr_funds carry no
// updated_at, and a timestamp would in any case call a record "changed"
// after an edit that changed nothing.
const UNDO_SHAPES = {
  members: {
    kind: 'member', table: 'ochr_clients',
    cols: ['name', 'email', 'phone', 'tags'],
    from: n => ({ name: n.name, email: n.email, phone: n.phone, tags: n.tags }),
  },
  funds: {
    kind: 'fund', table: 'ochr_funds',
    cols: ['name', 'description'],
    from: n => ({ name: n.name, description: n.description }),
  },
  gifts: {
    kind: 'donation', table: 'ochr_donations',
    cols: ['donor_name', 'donor_email', 'amount', 'date', 'fund_id'],
    from: n => ({ donor_name: n.donor_name, donor_email: n.donor_email,
                  amount: n.amount, date: n.date, fund_id: n.fund_id }),
  },
}

const sameValue = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined || b === ''
  if (b === null || b === undefined) return a === '' || a === null
  if (a instanceof Date) return String(a.toISOString().slice(0, 10)) === String(b).slice(0, 10)
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return String(a).trim() === String(b).trim()
}

router.post('/:id/undo', approvalGate, async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const batch = await loadBatch(id, req.organizationId)
    if (!batch) return res.status(404).json(msg('import.not_found'))
    if (batch.status !== 'committed') return res.status(409).json(msg('undo.not_committed'))
    if (batch.undone_at) {
      return res.status(409).json(msg('undo.already_undone',
        { date: new Date(batch.undone_at).toISOString().slice(0, 10) }))
    }
    // Undo needs the rows to know what it created. They expire on the
    // same window as everything else, and after that the honest answer
    // is that these are ordinary parish records now.
    if (batch.rows_purged_at) {
      return res.status(409).json(msg('undo.window_closed', { days: IMPORT_ROWS_RETENTION_DAYS }))
    }

    const shape = UNDO_SHAPES[batch.kind]
    const { rows: imported } = await pool.query(
      `SELECT id, row_no, normalized, created_record_id
         FROM ochr_import_rows
        WHERE batch_id = $1 AND organization_id = $2
          AND status = 'imported' AND created_record_id IS NOT NULL
        ORDER BY row_no`,
      [id, req.organizationId])

    // Read every created record in ONE query rather than one per row. Undoing
    // a two-thousand-row import used to cost one SELECT plus a whole vault
    // transaction per record — six thousand-odd serial round trips inside a
    // serverless function with a request timeout. It did not merely run
    // slowly; it ran out of time PART WAY THROUGH, with some records vaulted,
    // the rest still live, and the batch never marked undone.
    //
    // Measured end to end on a 500-row member import:
    //
    //     old   2,878 ms   500 vault entries
    //     new   1,648 ms     1 vault entry
    //
    // The milliseconds are the smaller half again. 500 entries meant the
    // Archive & Recovery list was 500 rows of one mistake, and putting the
    // import back was 500 clicks that all had to succeed. One entry restores
    // all 500 in 187 ms.
    const liveById = new Map()
    if (imported.length) {
      const { rows: live } = await pool.query(
        `SELECT id, ${shape.cols.join(', ')} FROM ${'"' + shape.table + '"'}
          WHERE id = ANY($1::int[]) AND organization_id = $2`,
        [imported.map(r => Number(r.created_record_id)), req.organizationId])
      for (const row of live) liveById.set(Number(row.id), row)
    }

    // Sort into three piles in memory. The comparison is unchanged — field by
    // field against what the import wrote — because a record somebody has
    // edited since is theirs, not the import's.
    const toRemove = [], editedSince = [], alreadyGone = []
    for (const r of imported) {
      const live = liveById.get(Number(r.created_record_id))
      if (!live) { alreadyGone.push(r.row_no); continue }
      const wrote = shape.from(r.normalized ?? {})
      const untouched = shape.cols.every(c => sameValue(live[c], wrote[c]))
      if (!untouched) { editedSince.push({ row_no: r.row_no, id: r.created_record_id }); continue }
      toRemove.push({ row_no: r.row_no, id: Number(r.created_record_id) })
    }

    // One transaction, owned here: the vault capture and the batch's own
    // "undone" stamp become true together or neither does. Before this, the
    // stamp was a separate statement after the loop — so a crash in the gap
    // left the records in the vault and the batch still offering to undo
    // them, and the second click wrote a receipt saying it removed nothing.
    let summary, receipt
    const conn = await pool.connect()
    try {
      await conn.query('BEGIN')

      let vaultEntry = null
      if (toRemove.length) {
        vaultEntry = await captureAndDeleteMany({
          kind: shape.kind, ids: toRemove.map(r => r.id), orgId: req.organizationId,
          user: req.user, reason: `Import #${id} undone`, conn,
        })
        // null means the rows vanished between the read above and the lock
        // inside the vault. Nothing was captured and nothing was deleted, so
        // they belong in `already_gone`, not in `removed`.
        if (!vaultEntry) {
          alreadyGone.push(...toRemove.map(r => r.row_no))
          toRemove.length = 0
        }
      }

      summary = {
        removed: toRemove.length,
        left_alone_because_edited: editedSince.length,
        already_gone: alreadyGone.length,
        edited_rows: editedSince.map(e => e.row_no),
        // One vault entry for the whole undo rather than one per record.
        // "Put this import back" is the only restore anybody actually wants,
        // and N entries made it N clicks that all had to succeed.
        vault_entry_id: vaultEntry?.entry_id ?? null,
        undone_at: new Date().toISOString(),
      }

      // The receipt is the artifact; it has to tell the whole story.
      receipt = {
        ...(batch.receipt ?? {}),
        undone: {
          at: summary.undone_at,
          by: { name: req.user.name ?? null, email: req.user.email ?? null },
          removed: summary.removed,
          left_alone_because_edited: editedSince.length,
          vault_entry_id: summary.vault_entry_id,
          note: 'The records this import created were moved to Archive & Recovery, where an administrator can put any of them back. Records somebody had edited since the import were left exactly as they are.',
        },
      }

      await conn.query(
        `UPDATE ochr_import_batches
            SET undone_at = NOW(), undone_by = $3, undone_by_name = $4,
                undo_summary = $5, receipt = $6, updated_at = NOW()
          WHERE id = $1 AND organization_id = $2`,
        [id, req.organizationId, req.user.id, req.user.name ?? null,
         JSON.stringify(summary), JSON.stringify(receipt)])

      await conn.query('COMMIT')
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      conn.release()
    }

    res.json({
      ok: true, id, summary, receipt,
      ...msg('undo.done', { removed: summary.removed, kept: editedSince.length }),
      error: undefined,
    })
  } catch (err) {
    monitor.error('imports.undo', err, { orgId: req.organizationId, id })
    res.status(500).json(msg('undo.failed'))
  }
})

// POST /api/imports/:id/abandon — close without importing. History keeps it.
router.post('/:id/abandon', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const { rowCount } = await pool.query(
      `UPDATE ochr_import_batches SET status = 'abandoned', updated_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND status IN ('uploaded', 'mapped')`,
      [id, req.organizationId])
    if (!rowCount) return res.status(409).json(msg('import.already_closed'))
    res.json({ ok: true })
  } catch (err) {
    monitor.error('imports.abandon', err, { orgId: req.organizationId, id })
    res.status(500).json(msg('import.close_failed'))
  }
})

export default router
