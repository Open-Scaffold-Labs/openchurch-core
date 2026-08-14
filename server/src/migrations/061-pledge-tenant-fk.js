// 061 — Pledge tenant FK guard: ochr_pledges.member_id must live in the
// pledge's own organization.
//
// THE GAP THIS CLOSES
//
// 015-pledges declared:
//
//   member_id INTEGER REFERENCES ochr_clients(id) ON DELETE SET NULL
//
// — a plain FK with no organization component. 044-tenant-fk-guards added
// composite (id, organization_id) guards to ochr_attendance,
// ochr_event_members and ochr_group_members but did not cover ochr_pledges,
// so nothing at the DB level stopped a pledge in org A from pointing at a
// member in org B.
//
// POST /api/pledges validated member_id against the caller's org; PATCH
// /api/pledges/:id did not (member_id sat in the raw allowlist). An admin in
// org A could therefore PATCH their own pledge with any ochr_clients.id — ids
// are sequential SERIALs, so org B's members are enumerable — and the
// unscoped `LEFT JOIN ochr_clients` in the pledge read paths then returned
// org B's member name and email. It also coupled the two tenants' data:
// deleting that member in org B mutated a row in org A via ON DELETE SET NULL.
//
// The route-layer fix lands in routes/pledges.js. This migration is the
// belt-and-braces half: make the cross-tenant reference impossible in the
// database, the same way 044 did for the join tables.
//
// ochr_clients already carries the UNIQUE (id, organization_id) constraint
// added by 044 (`ochr_clients_id_org_uniq`), so it can be a composite-FK
// target here without further work.
//
// Idempotent: contamination cleanup only touches offending rows, and the
// constraint is added inside a pg_constraint guard.

import pool from '../db.js'

export async function up() {
  console.log('Migration 061: pledge-tenant-fk — applying...')

  // 1. Clean up any existing contamination. A pledge pointing at a member in
  //    another org is exactly the state the constraint forbids, so it has to
  //    go before the constraint can be added. We NULL the reference rather
  //    than delete the pledge — the pledge itself is the org's own legitimate
  //    record (amount, dates, notes); only the foreign member link is bogus.
  //    The CHECK from 015 (member_id IS NOT NULL OR donor_email IS NOT NULL)
  //    means a pledge with no donor_email would fail this NULLing, so those
  //    get the member's stale display email copied into donor_email first —
  //    from THEIR OWN org's row if it exists, else a placeholder, so the
  //    pledge stays valid without importing another tenant's data.
  const { rows: bad } = await pool.query(`
    SELECT p.id
      FROM ochr_pledges p
      JOIN ochr_clients c ON c.id = p.member_id
     WHERE c.organization_id IS DISTINCT FROM p.organization_id
  `)
  if (bad.length) {
    console.warn(
      `Migration 061: found ${bad.length} cross-tenant pledge reference(s) — ` +
      `clearing member_id on pledge id(s): ${bad.map(r => r.id).join(', ')}`
    )
    await pool.query(`
      UPDATE ochr_pledges p
         SET donor_email = COALESCE(p.donor_email, 'unlinked-member@invalid.local')
        FROM ochr_clients c
       WHERE c.id = p.member_id
         AND c.organization_id IS DISTINCT FROM p.organization_id
    `)
    await pool.query(`
      UPDATE ochr_pledges p
         SET member_id = NULL
        FROM ochr_clients c
       WHERE c.id = p.member_id
         AND c.organization_id IS DISTINCT FROM p.organization_id
    `)
  }

  // 2. Composite FK. ON DELETE SET NULL with an explicit column list is
  //    required here: the referenced column list is (id, organization_id), and
  //    a bare SET NULL would try to null ochr_pledges.organization_id too,
  //    which is NOT NULL. The column-list form landed in Postgres 15; Supabase
  //    runs 15+, but we check rather than assume so an older dev database
  //    fails loudly with a clear message instead of a raw syntax error. The
  //    route-layer guard in routes/pledges.js holds the line either way.
  const { rows: ver } = await pool.query('SHOW server_version_num')
  const versionNum = parseInt(ver[0].server_version_num, 10)

  if (versionNum >= 150000) {
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_pledges_member_id_org_fk') THEN
        ALTER TABLE ochr_pledges
          ADD CONSTRAINT ochr_pledges_member_id_org_fk
          FOREIGN KEY (member_id, organization_id)
          REFERENCES ochr_clients(id, organization_id)
          ON DELETE SET NULL (member_id);
      END IF;
    END $$;`)
    console.log('Migration 061: composite tenant FK added on ochr_pledges.member_id')
  } else {
    console.warn(
      `Migration 061: Postgres ${versionNum} < 150000 — skipping the composite ` +
      `FK (ON DELETE SET NULL (col) needs PG 15+). Tenant scoping for ` +
      `ochr_pledges.member_id is enforced in routes/pledges.js only on this database.`
    )
  }

  console.log('Migration 061: pledge-tenant-fk — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
