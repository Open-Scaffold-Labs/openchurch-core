#!/usr/bin/env node
// Period-overlap audit — do any of this environment's live reporting
// periods overlap each other?
//
// WHY THIS IS A SCRIPT AND NOT `local-db status`.
//
// Boss Fight I suggested attaching it to local-db status. It does not fit
// there, for the reason local-db is trustworthy: that tool decides its own
// target inside itself and refuses to look at anything but the local
// forge. The local forge is seeded and thrown away — an overlap there means
// nothing. The question "does the data we are about to constrain satisfy
// the constraint" is only interesting about a database with real
// submissions in it, which is precisely the database local-db exists to
// never touch.
//
// So this follows scripts/tenant-fk-audit.mjs instead, which is the
// repository's existing shape for "point a read-only question at any
// environment":
//
//   DATABASE_URL='…' node scripts/period-overlap-audit.mjs
//
// READ-ONLY. It runs one SELECT and takes no locks beyond ordinary read
// semantics. It never writes, and it must never be given a "--fix": which
// of two overlapping periods a parish actually meant is a question for that
// parish and its chancery, and a script that guessed would be resolving a
// billing dispute by coin toss.
//
// THE INVARIANT, stated once:
//
//   For one (organization_id, diocese_org_id), no two rows whose status is
//   'submitted' or 'approved' may have intersecting [period_start,
//   period_end] ranges, bounds inclusive.
//
// 'returned' is deliberately outside it. The chancery's remedy for a wrong
// period is to return it and the parish's is to submit a corrected one,
// which will usually overlap the original; forbidding that would forbid the
// fix. Draft periods are not rows.
//
// Exit 0 = clean, and migration 098 can be applied to this environment.
// Exit 1 = overlaps exist; 098 will refuse, and each pair needs a human.
// Exit 2 = could not ask.

import pg from 'pg'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Load the environment you mean to ask about.')
  process.exit(2)
}

// Say what is being inspected before inspecting it — the same courtesy
// local-db pays, and the reason a wrong-environment answer gets noticed.
let where = 'unknown'
try {
  const u = new URL(url)
  where = `${u.hostname}${u.pathname}`
} catch { /* an unparseable URL will fail at connect anyway */ }

const pool = new pg.Pool({ connectionString: url })

const OVERLAPS = `
  SELECT a.organization_id, a.diocese_org_id,
         a.id AS id_a, a.status AS status_a,
         to_char(a.period_start,'YYYY-MM-DD') AS start_a,
         to_char(a.period_end,  'YYYY-MM-DD') AS end_a,
         b.id AS id_b, b.status AS status_b,
         to_char(b.period_start,'YYYY-MM-DD') AS start_b,
         to_char(b.period_end,  'YYYY-MM-DD') AS end_b
    FROM ochr_report_submissions a
    JOIN ochr_report_submissions b
      ON a.organization_id = b.organization_id
     AND a.diocese_org_id  = b.diocese_org_id
     AND a.id < b.id
     AND a.status IN ('submitted','approved')
     AND b.status IN ('submitted','approved')
     AND a.period_start <= b.period_end
     AND a.period_end   >= b.period_start
   ORDER BY a.organization_id, a.period_start
`

const POPULATION = `
  SELECT status, COUNT(*)::int AS n
    FROM ochr_report_submissions GROUP BY status ORDER BY status
`

const CONSTRAINT = `
  SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conname = 'uq_submission_no_overlap'
`

try {
  console.log(`period-overlap-audit: ${where}`)

  const { rows: pop } = await pool.query(POPULATION)
  const total = pop.reduce((n, r) => n + r.n, 0)
  console.log(`submissions: ${total || 'none'}${pop.length ? ' — ' + pop.map(r => `${r.status} ${r.n}`).join(', ') : ''}`)

  const { rows: c } = await pool.query(CONSTRAINT)
  console.log(`constraint:  ${c.length ? 'uq_submission_no_overlap present (098 applied)' : 'absent (098 not applied here)'}`)

  const { rows } = await pool.query(OVERLAPS)

  if (!rows.length) {
    // Say what a clean result does and does not mean. Zero rows in the
    // table is a clean result and proves nothing about a populated one.
    console.log(total === 0
      ? '\nCLEAN — but the table is empty, so this environment has never exercised the invariant.'
      : `\nCLEAN — no overlapping live periods among ${total} submission(s).`)
    process.exit(0)
  }

  console.error(`\n${rows.length} OVERLAPPING PAIR(S):\n`)
  for (const o of rows) {
    console.error(`  parish ${o.organization_id} / diocese ${o.diocese_org_id}`)
    console.error(`    #${o.id_a} ${o.start_a} – ${o.end_a}  (${o.status_a})`)
    console.error(`    #${o.id_b} ${o.start_b} – ${o.end_b}  (${o.status_b})`)
  }
  console.error(`
Each pair must be resolved before migration 098 can apply here. The way out
is for the chancery to RETURN whichever period is wrong — a returned period
is allowed to overlap, so the corrected one can then be submitted over it.
Do not delete or edit a historical financial period to satisfy a constraint:
the assessable base is billed from these rows.`)
  process.exit(1)
} catch (err) {
  console.error(`period-overlap-audit: could not ask — ${err.message}`)
  process.exit(2)
} finally {
  await pool.end()
}
