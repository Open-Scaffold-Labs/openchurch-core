// The two references migration 082 left single-column.
//
// 082 created ochr_import_batches with
//
//   created_by  INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL
//   approved_by INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL
//
// which says only "some user", not "a user of this parish". Every other
// actor reference in the schema has been composite since 071, and
// scripts/tenant-fk-audit.mjs fails the build over exactly this pair —
// it is what turned main red on 8333c21.
//
// It matters more here than the empty table suggests. An import batch
// names the person who uploaded a membership or giving file and the
// person who approved committing it: the provenance of records that
// arrive in bulk, and the only answer to "who let this in?". A
// cross-tenant id in either column would attribute one diocese's import
// to another diocese's staff member, in the audit trail, permanently.
//
// The composite key makes that unrepresentable rather than merely
// unlikely. Column-scoped SET NULL (PG15+) nulls only the user column, so
// organization_id — NOT NULL — survives the user's departure and the
// batch stays attached to its parish.
//
// 082 could not simply be corrected: it is already recorded in the ledger
// (and already applied against production by a dev server boot), so its
// up() will never run again. The repair has to be its own migration.

import pool from '../db.js'

const COLUMNS = ['created_by', 'approved_by']

export async function up() {
  console.log('Migration 083: import batch tenant FKs — applying...')

  for (const col of COLUMNS) {
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ochr_import_batches_${col}_fkey') THEN
          ALTER TABLE ochr_import_batches DROP CONSTRAINT ochr_import_batches_${col}_fkey;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'ochr_import_batches_${col}_org_fkey') THEN
          ALTER TABLE ochr_import_batches
            ADD CONSTRAINT ochr_import_batches_${col}_org_fkey
            FOREIGN KEY (${col}, organization_id)
            REFERENCES ochr_users(id, organization_id)
            ON DELETE SET NULL (${col});
        END IF;
      END $$;
    `)
  }

  // The audit reads pg_constraint, so assert against it rather than
  // trusting the DO block to have taken. A silent no-op here would leave
  // the ledger claiming a repair that never happened.
  const { rows } = await pool.query(`
    SELECT count(*)::int AS n
      FROM pg_constraint
     WHERE conrelid = 'ochr_import_batches'::regclass
       AND contype  = 'f'
       AND conname IN ('ochr_import_batches_created_by_org_fkey',
                       'ochr_import_batches_approved_by_org_fkey')
  `)
  if (rows?.[0]?.n !== COLUMNS.length) {
    throw new Error(
      `Migration 083: expected ${COLUMNS.length} composite actor FKs, found ${rows?.[0]?.n ?? 0}`,
    )
  }

  console.log('Migration 083: import batch tenant FKs — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
