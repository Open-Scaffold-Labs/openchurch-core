// Donor identity is the email, matched case-insensitively — and now indexed.
//
// F5: donations were grouped and matched on the RAW donor_email, so
// 'Juan@Example.org' and 'juan@example.org' were two donors. One person got
// two year-end tax statements (each understating their giving), pledges were
// credited only the gifts whose casing happened to match, and a member's own
// gifts under a different casing dropped out of their lifetime history. The
// fix compares lower(donor_email) at every one of those read sites — the
// same rule ochr_clients already uses for members (migration 095).
//
// A plain index on donor_email cannot serve a lower(donor_email) predicate,
// so this adds the functional index those queries need. Without it the
// year-end statement run (per donor) and the pledge-progress and
// member-history lookups fall back to scanning the org's donations.
//
// WHY PARTIAL. `WHERE donor_email IS NOT NULL` mirrors the queries: the
// name-grouped branch of the statement preview handles the no-email donors,
// and every lower(donor_email) lookup is only reached when an email exists.
// The index therefore holds exactly the rows those lookups touch.
//
// NOT CONCURRENTLY, deliberately — consistent with 095. A plain CREATE INDEX
// briefly locks writes to ochr_donations while it builds; on the roster sizes
// this product targets (1-50 parishes) that is milliseconds, and it cannot
// leave an INVALID index behind the way CONCURRENTLY can.

import pool from '../db.js'

export async function up() {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_donations_org_lower_donor_email
      ON ochr_donations (organization_id, lower(donor_email))
      WHERE donor_email IS NOT NULL
  `)

  // Self-assertion, same posture as 090/093/094/095/096. An index that
  // silently did not install would leave the statement run and pledge/member
  // lookups scanning, and nothing on the send or report path would report it.
  const { rows } = await pool.query(`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_donations_org_lower_donor_email'
  `)
  if (!rows.length) throw new Error('097: idx_donations_org_lower_donor_email was not created')
  const def = rows[0].indexdef
  if (!/lower\(/i.test(def)) {
    throw new Error('097: the index is not functional — lower(donor_email) lookups cannot use it')
  }
  if (!/WHERE .*donor_email/i.test(def)) {
    throw new Error('097: the index is not partial on donor_email IS NOT NULL')
  }

  console.log('Migration 097: donor-email-lower-index — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
