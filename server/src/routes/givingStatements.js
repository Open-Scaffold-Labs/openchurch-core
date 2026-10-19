// Year-end giving statements (Sprint Y). Admin-only — gift histories
// are sensitive; only admins (the bookkeeper / treasurer) get to
// query them.
//
// Two endpoints power the admin UI:
//
//   GET /api/giving-statements/preview?year=YYYY
//     → list every donor who gave in <year> with their total + count.
//       The 'donor key' groups by donor_email when present, else by
//       donor_name. The response carries both so the UI can show
//       "John Doe · 3 gifts · $1,250" and link to the per-donor
//       breakdown.
//
//   GET /api/giving-statements/donor?key=...&year=YYYY[&by=email|name]
//     → one donor's line items + computed total for the year. Used
//       by the print-friendly statement page (Y.3). `by` defaults to
//       'email' when the key contains '@' and 'name' otherwise.
//
// Both endpoints scope strictly to req.organizationId. There is no
// public-facing donor-self-serve here — that would require a
// separate auth flow + magic-link or token system.

import { Router } from 'express'
import pool from '../db.js'
import { normalizeDonorEmail } from '../finance/donorIdentity.js'

const router = Router()

// Conservative year window. Donations earlier than 2010 are
// unlikely in this product; we reject to surface typos like
// year=202 quickly.
const MIN_YEAR = 2010

function parseYear(raw) {
  const n = Number(raw)
  if (!Number.isInteger(n)) return null
  const thisYear = new Date().getFullYear()
  if (n < MIN_YEAR || n > thisYear + 1) return null
  return n
}

// GET /api/giving-statements/preview?year=YYYY
// Returns: { year, donors: [{ donor_key, by, donor_name, donor_email,
//            total, gift_count }, ...], total_donors, total_amount }
//
// Donors are listed in descending total order so the high-impact
// givers are visible first — the bookkeeper usually starts the
// statement run from the top of that list.
router.get('/preview', async (req, res) => {
  const year = parseYear(req.query.year)
  if (year === null) {
    return res.status(400).json({ error: 'Invalid year' })
  }

  try {
    // Group by email when present (most reliable identity), else by
    // a 'name:<donor_name>' fallback. The UNION ALL keeps both
    // branches readable + indexable rather than packing into one
    // CASE WHEN expression that would foil the partial index.
    const { rows } = await pool.query(
      `
      WITH email_grouped AS (
        SELECT
          'email' AS by,
          -- Donor identity is the email, CASE-INSENSITIVELY — the same
          -- rule ochr_clients already uses for members (see migration 095's
          -- lower(email) index and directory/memberIdentity.js). Grouping on
          -- the raw column made "Juan@Example.org" and "juan@example.org" two
          -- donors, so one person received two year-end tax statements, each
          -- understating their giving (F5). lower() collapses them into one.
          lower(donor_email) AS donor_key,
          MIN(donor_name) AS donor_name,
          lower(donor_email) AS donor_email,
          SUM(live_amount)::numeric(12,2) AS total,
          COUNT(*)::int AS gift_count
        FROM ochr_donation_live
        WHERE organization_id = $1
          AND EXTRACT(YEAR FROM date)::int = $2
          AND donor_email IS NOT NULL
        -- Option A: the gift stays on the statement. Live total is
        -- gift.amount − Σ(posted refunds), including when that net is 0.
        GROUP BY lower(donor_email)
      ),
      name_grouped AS (
        SELECT
          'name' AS by,
          donor_name AS donor_key,
          donor_name,
          NULL::text AS donor_email,
          SUM(live_amount)::numeric(12,2) AS total,
          COUNT(*)::int AS gift_count
        FROM ochr_donation_live
        WHERE organization_id = $1
          AND EXTRACT(YEAR FROM date)::int = $2
          AND donor_email IS NULL
        GROUP BY donor_name
      )
      SELECT * FROM email_grouped
      UNION ALL
      SELECT * FROM name_grouped
      ORDER BY total DESC, donor_name ASC
      `,
      [req.organizationId, year]
    )

    const total_amount = rows.reduce((sum, r) => sum + Number(r.total), 0)

    res.set('Cache-Control', 'private, max-age=60')
    res.json({
      year,
      donors: rows,
      total_donors: rows.length,
      total_amount: Number(total_amount.toFixed(2)),
    })
  } catch (err) {
    console.error('giving-statements.preview failed:', err)
    res.status(500).json({ error: 'Failed to load giving statements' })
  }
})

// GET /api/giving-statements/donor?key=...&year=YYYY[&by=email|name]
// Returns: { year, donor: {name, email, address}, lines: [...],
//            total, gift_count }
router.get('/donor', async (req, res) => {
  const year = parseYear(req.query.year)
  if (year === null) return res.status(400).json({ error: 'Invalid year' })

  const key = String(req.query.key || '').trim()
  if (!key) return res.status(400).json({ error: 'donor key required' })

  // Default 'by' heuristic — email when the key looks like one,
  // otherwise name. Client can override explicitly via ?by=name to
  // disambiguate edge cases (e.g. a donor named like an email).
  const by = req.query.by === 'name' || req.query.by === 'email'
    ? req.query.by
    : (key.includes('@') ? 'email' : 'name')

  try {
    const filter = by === 'email'
      ? 'lower(donor_email) = lower($3)'
      : 'donor_name  = $3 AND donor_email IS NULL'

    const { rows } = await pool.query(
      `SELECT id, donor_name, donor_email, donor_address,
              amount, refunded_total, live_amount, category, method, date, notes
         FROM ochr_donation_live
        WHERE organization_id = $1
          AND EXTRACT(YEAR FROM date)::int = $2
          AND ${filter}
        ORDER BY date ASC, id ASC`,
      // The key arrives from the grouping above, which now emits the
      // normalised form — but a caller can hand us anything, so it is
      // normalised again here rather than trusted.
      [req.organizationId, year, by === 'email' ? normalizeDonorEmail(key) : key]
    )

    if (rows.length === 0) {
      // 404 rather than empty so the print page can render a clean
      // 'no gifts on file for <donor> in <year>' state instead of an
      // empty statement.
      return res.status(404).json({ error: 'No donations found for this donor + year' })
    }

    // Pull the org's letterhead fields alongside the donor data so
    // the print view (Y.3) renders from a single fetch. Fields may
    // be NULL on orgs that haven't filled in Settings → Org details
    // yet; the client handles the placeholder state.
    const orgQ = await pool.query(
      `SELECT name, address, tax_id, signatory_name, signatory_title, statement_letterhead
         FROM ochr_organizations
        WHERE id = $1`,
      [req.organizationId]
    )
    const org = orgQ.rows[0] ?? {}

    // Prefer the first row's contact block; if a donor's address
    // varies across rows (rare — they moved mid-year), the most
    // recent row's address is the safer mailing target.
    const latest = rows[rows.length - 1]
    const donor = {
      name:    latest.donor_name,
      email:   latest.donor_email,
      address: latest.donor_address,
    }
    const total = rows.reduce((sum, r) => sum + Number(r.live_amount), 0)

    res.set('Cache-Control', 'private, max-age=60')
    res.json({
      year,
      by,
      key,
      donor,
      organization: {
        name:                 org.name ?? null,
        address:              org.address ?? null,
        tax_id:               org.tax_id ?? null,
        signatory_name:       org.signatory_name ?? null,
        signatory_title:      org.signatory_title ?? null,
        statement_letterhead: org.statement_letterhead ?? null,
      },
      lines: rows,
      total: Number(total.toFixed(2)),
      gift_count: rows.length,
    })
  } catch (err) {
    console.error('giving-statements.donor failed:', err)
    res.status(500).json({ error: 'Failed to load donor statement' })
  }
})


// ── GIV-09 · issuance ────────────────────────────────────────────────
//
// PREVIEW ≠ ISSUED. The two GETs above are previews: they answer "what
// would this donor's statement say if we printed it right now", from live
// giving. That is the correct behaviour for a preview and stays.
//
// An ISSUE freezes the claim. Everything a reader needs to reproduce what
// the parish asserted is copied into snapshot_json — the donor block as
// printed, the organization letterhead as printed, every gift line with
// both its amount and its refunded_total at that instant, and the total.
// A later reader of an issued statement never touches ochr_donations,
// ochr_donation_refunds or ochr_organizations, so a refund posted
// tomorrow, a corrected parish address, or a changed tax id cannot
// retroactively alter what was claimed.
//
// UNKNOWN STAYS UNKNOWN. A letterhead field that was NULL at issue time is
// frozen as null and listed in snapshot.unknown_at_issue. It is never
// backfilled from today's organization row: "we did not know the parish's
// tax id when this went out" is itself part of the historical claim.

// 2 — gift lines store the civil day as YYYY-MM-DD. Version 1 rows were
// written while node-pg turned a DATE into a Date, so their line dates are
// the locale text of that Date ("Sun Sep 27"). Those rows stay version 1.
// snapshot_version is already an integer (migration 109); writing 2 needs
// no new migration. The freeze trigger refuses any later rewrite of the
// column or the JSON, so existing rows are not updated.
const SNAPSHOT_VERSION = 2

// The frozen claim. Built only from values already resolved for this
// request — never re-queried later.
function buildSnapshot({ year, by, key, donor, organization, lines, total, correction }) {
  const unknown = []
  for (const [field, value] of Object.entries(organization)) {
    if (value === null || value === undefined) unknown.push(`organization.${field}`)
  }
  if (!donor.address) unknown.push('donor.address')
  if (!donor.email)   unknown.push('donor.email')

  return {
    snapshot_version: SNAPSHOT_VERSION,
    tax_year: year,
    donor_key_kind: by,
    donor_key: key,
    donor: { name: donor.name ?? null, email: donor.email ?? null, address: donor.address ?? null },
    organization: { ...organization },
    lines: lines.map(r => ({
      donation_id:    Number(r.id),
      date:           typeof r.date === 'string' ? r.date.slice(0, 10) : String(r.date).slice(0, 10),
      amount:         String(r.amount),
      refunded_total: String(r.refunded_total ?? '0.00'),
      live_amount:    String(r.live_amount),
      category:       r.category ?? null,
      method:         r.method ?? null,
      notes:          r.notes ?? null,
    })),
    total: total.toFixed(2),
    gift_count: lines.length,
    // What was NOT known when this was issued. Preserved so a later reader
    // can tell "blank because unknown" from "blank because zero".
    unknown_at_issue: unknown,
    // Present only on a corrected successor. Its zero is a DELIBERATE CLAIM —
    // the parish withdrawing an earlier statement — and must never be read as
    // "we did not know". UNKNOWN and ZERO are different answers; this field is
    // what tells them apart on a statement whose total is 0.00.
    ...(correction ? { correction } : {}),
  }
}

// POST /api/giving-statements/issue
// Body: { year, key, by?, issue_key }
//
// issue_key is the caller's idempotency token. The same token returns the
// SAME historical claim (200, replayed) rather than minting a second one;
// a different token is a genuinely distinct issuance, which a parish is
// allowed to make — a donor who lost the first copy gets a second, and
// both remain representable.
router.post('/issue', async (req, res) => {
  const year = parseYear(req.body?.year)
  if (year === null) return res.status(400).json({ error: 'Invalid year' })

  const key = String(req.body?.key || '').trim()
  if (!key) return res.status(400).json({ error: 'donor key required' })

  const issueKey = String(req.body?.issue_key || '').trim()
  if (!issueKey) return res.status(400).json({ error: 'issue_key required' })
  if (issueKey.length > 120) return res.status(400).json({ error: 'issue_key too long' })

  const by = req.body?.by === 'name' || req.body?.by === 'email'
    ? req.body.by
    : (key.includes('@') ? 'email' : 'name')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Replay before doing any work: a retry must not mint a new claim, and
    // must not even consume a statement number.
    const { rows: existing } = await client.query(
      `SELECT ${REPLAY_COLS}
         FROM ochr_giving_statements
        WHERE organization_id = $1 AND issue_key = $2`,
      [req.organizationId, issueKey]
    )
    if (existing.length) {
      const lookupKey = by === 'email' ? normalizeDonorEmail(key) : key
      if (!isSameIssuance(existing[0], { year, lookupKey, by })) {
        await client.query('ROLLBACK')
        return res.status(KEY_CONFLICT.status).json({ error: KEY_CONFLICT.error })
      }
      await client.query('COMMIT')
      return res.status(200).json({ ok: true, replayed: true, statement: existing[0] })
    }

    const frozen = await freezeStatement(client, {
      orgId: req.organizationId, year, key, by, issueKey, user: req.user,
    })
    if (frozen.error) {
      await client.query('ROLLBACK')
      return res.status(frozen.status).json({ error: frozen.error })
    }
    const row = frozen.row

    await client.query('COMMIT')
    res.status(201).json({ ok: true, replayed: false, statement: row })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (isIssueKeyRace(err)) {
      const existing = await rowForKey(req.organizationId, issueKey).catch(() => null)
      const lookupKey = by === 'email' ? normalizeDonorEmail(key) : key
      if (isSameIssuance(existing, { year, lookupKey, by })) {
        return res.status(200).json({ ok: true, replayed: true, statement: existing })
      }
      if (existing) return res.status(KEY_CONFLICT.status).json({ error: KEY_CONFLICT.error })
    }
    console.error('giving-statements.issue failed:', err)
    res.status(500).json({ error: 'Failed to issue statement' })
  } finally {
    client.release()
  }
})

// The pre-flight replay SELECT cannot close the race: two concurrent retries of
// the same issue_key both see no row and both insert. The unique index rejects
// one, which is correct — but the historical claim DOES exist, so the loser must
// read it back as a replay. A 500 there would tell a parish their statement
// failed while it sits in the register, which is the anxiety this product
// treats as a defect.
const ISSUE_KEY_CONFLICT = 'uq_giving_statements_org_issue_key'

function isIssueKeyRace(err) {
  return err && err.code === '23505' && String(err.constraint || '') === ISSUE_KEY_CONFLICT
}

// SAME KEY MAY REPLAY ONLY THE SAME OPERATION.
//
// A key is unique per parish, so a row always comes back — but "a row exists
// with this key" is not the same question as "this is the operation you are
// retrying". Answering the first question answers the second one wrongly:
// superseding statement B with a key already spent on statement A returned 200
// replayed and handed back A — another donor, another total — while B was
// never corrected at all. A parish is told its correction succeeded and shown
// somebody else's tax statement.
//
// So a replay must match the operation, not merely the token. Anything else
// carrying that key is a conflict, and a conflict is never a success.
const REPLAY_COLS = `id, statement_no, status, issued_at, snapshot_version, snapshot_json,
              tax_year, donor_key, donor_key_kind`

const KEY_CONFLICT = { status: 409, error: 'issue_key already used for a different statement' }

// A first-time issuance is the same operation when it is for the same tax year
// and the same donor — and is not a correction, which is a different verb.
function isSameIssuance(row, { year, lookupKey, by }) {
  return row
    && Number(row.tax_year) === Number(year)
    && row.donor_key === lookupKey
    && row.donor_key_kind === by
    && !row.snapshot_json?.correction
}

// A correction is the same operation only when the row IS the successor this
// original already recorded. The relational link is the authority — not the
// key, and not the JSON.
function isSameCorrection(row, orig) {
  return row && orig && orig.superseded_by_id != null
    && Number(orig.superseded_by_id) === Number(row.id)
}

async function rowForKey(orgId, issueKey) {
  const { rows } = await pool.query(
    `SELECT ${REPLAY_COLS}
       FROM ochr_giving_statements
      WHERE organization_id = $1 AND issue_key = $2`,
    [orgId, issueKey]
  )
  return rows[0] ?? null
}

// Re-read an original after a rollback: the winner of a race may have recorded
// its successor since this transaction began.
async function freshOriginal(orgId, id) {
  const { rows } = await pool.query(
    `SELECT id, superseded_by_id FROM ochr_giving_statements
      WHERE id = $1 AND organization_id = $2`,
    [id, orgId]
  )
  return rows[0] ?? null
}

// GET /api/giving-statements/issued?year=YYYY
// The register of what this parish has actually claimed.
router.get('/issued', async (req, res) => {
  const yearRaw = req.query.year
  const year = yearRaw === undefined ? null : parseYear(yearRaw)
  if (yearRaw !== undefined && year === null) return res.status(400).json({ error: 'Invalid year' })
  try {
    const { rows } = await pool.query(
      `SELECT id, tax_year, donor_key, donor_key_kind, statement_no, status,
              issued_at, issued_by_name, superseded_at, superseded_by_id,
              snapshot_json->>'total' AS total
         FROM ochr_giving_statements
        WHERE organization_id = $1
          AND ($2::int IS NULL OR tax_year = $2::int)
        ORDER BY issued_at DESC, id DESC
        LIMIT 500`,
      [req.organizationId, year]
    )
    res.json({ statements: rows })
  } catch (err) {
    console.error('giving-statements.issued failed:', err)
    res.status(500).json({ error: 'Failed to load issued statements' })
  }
})

// GET /api/giving-statements/issued/:id
// Renders ONLY from the frozen snapshot. There is deliberately no join to
// ochr_donations, ochr_donation_refunds or ochr_organizations here: that
// absence is the invariant.
router.get('/issued/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' })
  try {
    const { rows } = await pool.query(
      `SELECT id, tax_year, donor_key, donor_key_kind, statement_no, status,
              snapshot_version, snapshot_json, issued_at, issued_by_name,
              superseded_at, superseded_by_id
         FROM ochr_giving_statements
        WHERE id = $1 AND organization_id = $2`,
      [id, req.organizationId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json({ statement: rows[0] })
  } catch (err) {
    console.error('giving-statements.issued.get failed:', err)
    res.status(500).json({ error: 'Failed to load issued statement' })
  }
})

// Freeze one statement inside an open transaction. Shared by /issue and
// /issued/:id/supersede so a correction is frozen exactly the way an
// original was — one code path, one set of rules.
async function freezeStatement(client, { orgId, year, key, by, issueKey, user, correctionOf }) {
  const filter = by === 'email'
    ? 'lower(donor_email) = lower($3)'
    : 'donor_name  = $3 AND donor_email IS NULL'
  const lookupKey = by === 'email' ? normalizeDonorEmail(key) : key

  const { rows: lines } = await client.query(
    `SELECT id, donor_name, donor_email, donor_address,
            amount, refunded_total, live_amount, category, method, date, notes
       FROM ochr_donation_live
      WHERE organization_id = $1
        AND EXTRACT(YEAR FROM date)::int = $2
        AND ${filter}
      ORDER BY date ASC, id ASC`,
    [orgId, year, lookupKey]
  )
  // A FIRST-TIME issuance with nothing to claim stays invalid — that is an
  // empty statement, and OpenChurch does not issue those (founder decision,
  // 13 Sep). A CORRECTION is the one exception: when the gifts behind an
  // already-issued claim were deleted, the parish must still be able to
  // withdraw what it sent, and the only honest form of that is an explicit
  // zero. `correctionOf` is the opt-in, and it exists nowhere else.
  if (lines.length === 0 && !correctionOf) {
    return { error: 'No donations found for this donor + year', status: 404 }
  }

  const { rows: [org] } = await client.query(
    `SELECT name, address, tax_id, signatory_name, signatory_title, statement_letterhead,
            statement_next_no
       FROM ochr_organizations
      -- NO KEY UPDATE: serializes statement numbering exactly as before, and
      -- does not conflict with the KEY SHARE admission lock every tenant write
      -- takes (migration 114). Only organization HOLD takes FOR UPDATE.
      WHERE id = $1 FOR NO KEY UPDATE`,
    [orgId]
  )

  // WHO THIS IS ABOUT COMES FROM THE LIVE ROWS WHENEVER THERE ARE ANY — an
  // ordinary correction should carry the donor's current name and mailing
  // address, because that is who the corrected statement is being sent to.
  //
  // The frozen identity is the DELETED-SOURCE fallback and nothing wider
  // (founder decision, 13 Sep, approved narrowly). Only when every gift is
  // gone is there no live row to read, and inferring a name from absence is
  // the reconstruction this campaign forbids — so the frozen block off the
  // superseded statement carries forward instead. Widening this to every
  // correction would quietly change ordinary correction semantics.
  const latest = lines.length ? lines[lines.length - 1] : null
  const donorBlock = latest
    ? { name: latest.donor_name, email: latest.donor_email, address: latest.donor_address }
    : { ...(correctionOf?.donor ?? {}) }
  const snapshot = buildSnapshot({
    year, by, key: lookupKey,
    donor: donorBlock,
    organization: {
      name:                 org.name ?? null,
      address:              org.address ?? null,
      tax_id:               org.tax_id ?? null,
      signatory_name:       org.signatory_name ?? null,
      signatory_title:      org.signatory_title ?? null,
      statement_letterhead: org.statement_letterhead ?? null,
    },
    lines,
    total: lines.reduce((sum, r) => sum + Number(r.live_amount), 0),
    correction: correctionOf
      ? {
          supersedes_statement_id: correctionOf.id,
          supersedes_statement_no: correctionOf.statement_no,
          // Says which of the two sources actually supplied the identity, so a
          // reader never has to infer it from whether lines happen to be empty.
          donor_identity_from: latest ? 'live-rows' : 'superseded-statement',
          // Named so a reader never has to guess why a tax statement says 0.00.
          zero_is_a_claim: lines.length === 0,
          reason: lines.length === 0
            ? 'The gifts this statement was issued from are no longer on file. This corrects the earlier statement to zero.'
            : 'Corrects the earlier statement.',
        }
      : undefined,
  })

  const statementNo = `${year}-${String(org.statement_next_no)}`
  await client.query(
    `UPDATE ochr_organizations SET statement_next_no = statement_next_no + 1 WHERE id = $1`,
    [orgId]
  )

  const { rows: [row] } = await client.query(
    `INSERT INTO ochr_giving_statements
       (organization_id, tax_year, donor_key, donor_key_kind, statement_no,
        issue_key, snapshot_version, snapshot_json, issued_by, issued_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, statement_no, status, issued_at, snapshot_version, snapshot_json`,
    [orgId, year, lookupKey, by, statementNo, issueKey,
     SNAPSHOT_VERSION, JSON.stringify(snapshot), user?.id ?? null, user?.name ?? null]
  )
  return { row }
}

// POST /api/giving-statements/issued/:id/supersede
// Body: { issue_key }
//
// A CORRECTION IS A NEW FACT, NOT AN EDIT. One transaction: freeze today's
// truth for the same donor + year as a new statement, then point the
// original at it. The original's snapshot_json is never touched — the
// database would refuse — so "what we said in January" and "what we said
// in March" both survive, linked, and a reader can see which superseded
// which.
router.post('/issued/:id/supersede', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' })
  const issueKey = String(req.body?.issue_key || '').trim()
  if (!issueKey) return res.status(400).json({ error: 'issue_key required' })
  if (issueKey.length > 120) return res.status(400).json({ error: 'issue_key too long' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: [orig] } = await client.query(
      `SELECT id, tax_year, donor_key, donor_key_kind, status, statement_no,
              snapshot_json, superseded_by_id
         FROM ochr_giving_statements
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, req.organizationId]
    )
    if (!orig) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }

    // REPLAY IS CHECKED BEFORE STATUS, AND THE ORDER IS THE WHOLE POINT.
    // Two retries of the same correction serialize on the FOR UPDATE above.
    // The second wakes to status='superseded' — by the FIRST, which carried
    // ITS OWN key. Answering 409 there tells the parish their correction
    // failed while the correction they asked for sits in the register. So the
    // key is consulted first: the same token means "show me the correction I
    // already made", and only a DIFFERENT token is a genuine second attempt to
    // correct an already-corrected statement, which stays 409.
    const { rows: replay } = await client.query(
      `SELECT ${REPLAY_COLS}
         FROM ochr_giving_statements
        WHERE organization_id = $1 AND issue_key = $2`,
      [req.organizationId, issueKey]
    )
    if (replay.length) {
      // Only THIS original's recorded successor is a replay of THIS correction.
      if (!isSameCorrection(replay[0], orig)) {
        await client.query('ROLLBACK')
        return res.status(KEY_CONFLICT.status).json({ error: KEY_CONFLICT.error })
      }
      await client.query('COMMIT')
      return res.status(200).json({ ok: true, replayed: true, superseded_id: orig.id, statement: replay[0] })
    }

    if (orig.status === 'superseded') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Already superseded' })
    }

    const successor = await freezeStatement(client, {
      orgId: req.organizationId,
      year: orig.tax_year,
      key: orig.donor_key,
      by: orig.donor_key_kind,
      issueKey,
      user: req.user,
      // Carries the original's frozen identity. This is also the ONLY opt-in
      // that permits a zero-line statement, so general empty issuance stays
      // impossible: /issue never sets it.
      correctionOf: {
        id: Number(orig.id),
        statement_no: orig.statement_no,
        donor: orig.snapshot_json?.donor ?? {},
      },
    })
    if (successor.error) {
      await client.query('ROLLBACK')
      return res.status(successor.status).json({ error: successor.error })
    }

    await client.query(
      `UPDATE ochr_giving_statements
          SET status = 'superseded', superseded_by_id = $3, superseded_at = NOW()
        WHERE id = $1 AND organization_id = $2`,
      [orig.id, req.organizationId, successor.row.id]
    )

    await client.query('COMMIT')
    res.status(201).json({ ok: true, replayed: false, superseded_id: orig.id, statement: successor.row })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (isIssueKeyRace(err)) {
      const existing = await rowForKey(req.organizationId, issueKey).catch(() => null)
      // The winner may have recorded its successor after this transaction began.
      const fresh = await freshOriginal(req.organizationId, id).catch(() => null)
      if (isSameCorrection(existing, fresh)) {
        return res.status(200).json({ ok: true, replayed: true, superseded_id: id, statement: existing })
      }
      if (existing) return res.status(KEY_CONFLICT.status).json({ error: KEY_CONFLICT.error })
    }
    console.error('giving-statements.supersede failed:', err)
    res.status(500).json({ error: 'Failed to supersede statement' })
  } finally {
    client.release()
  }
})

export default router
