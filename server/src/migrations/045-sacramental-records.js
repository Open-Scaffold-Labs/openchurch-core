// ochr_sacramental_records (SAC.1) — the parish sacramental register.
//
// A church-specific differentiator: a per-member record of the sacraments
// received (baptism, first communion, confirmation, marriage, …) — the
// canonical parish register that generic ChMS tools (Breeze, ChurchTrac)
// don't model. Each record is tenant-scoped and optionally linked to a
// member (client_id); client_id is ON DELETE SET NULL so removing a member
// doesn't erase the historical register entry (the record stays in the
// parish's books, just detached). Same-org linkage is enforced in the route
// (the member is validated against organization_id before write), matching
// the app-level scoping pattern used by pledges/tasks.
//
//   type   — one of the seven sacraments (CHECK, not enum, so the list is a
//            constraint replace rather than a type migration if it evolves).
//   date   — when it was celebrated (nullable; some historical records are
//            year-only or unknown, captured in notes).
//   minister / place / certificate_no / notes — the register fields.

import pool from '../db.js'

const TYPES = [
  'baptism',
  'reconciliation',
  'first_communion',
  'confirmation',
  'marriage',
  'holy_orders',
  'anointing',
]

export async function up() {
  console.log('Migration 045: sacramental-records — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_sacramental_records (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      client_id        INTEGER REFERENCES ochr_clients(id) ON DELETE SET NULL,
      type             TEXT NOT NULL CHECK (type IN (${TYPES.map(t => `'${t}'`).join(', ')})),
      date             DATE,
      minister         TEXT,
      place            TEXT,
      certificate_no   TEXT,
      notes            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // A member's sacramental timeline (hot path on MemberDetail) and the
  // parish-wide register (org + date DESC).
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sacraments_org_client ON ochr_sacramental_records(organization_id, client_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sacraments_org_date   ON ochr_sacramental_records(organization_id, date DESC)`)

  // RLS enabled with no policy — the same blanket backstop every ochr_*
  // table carries in prod (tenancy is enforced in the route layer; advisors
  // flag rls_disabled_in_public otherwise).
  await pool.query(`ALTER TABLE ochr_sacramental_records ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 045: sacramental-records — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
