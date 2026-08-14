// Tenant FK guards (security hardening — close the last DB-level tenancy gap).
//
// Three join tables linked two tenant entities but carried NO organization_id
// of their own: ochr_attendance, ochr_event_members, ochr_group_members.
// Isolation depended entirely on every JOIN being written correctly, and
// nothing at the DB level stopped a row from linking an event/group in org A
// to a member in org B. This migration:
//
//   1. adds a UNIQUE(id, organization_id) to each parent (ochr_events,
//      ochr_clients, ochr_groups) so they can be composite-FK targets,
//   2. adds organization_id to each join table, backfills it from the parent,
//      deletes any pre-existing cross-tenant rows (contamination the guards
//      are meant to prevent), locks the column NOT NULL, and indexes it,
//   3. adds composite foreign keys so BOTH linked entities must share the
//      row's organization_id — making cross-tenant linkage impossible in the
//      database, not just discouraged in the app.
//
// ochr_translations (polymorphic entity_type/entity_id, currently unused by
// any route) gets a nullable organization_id + index for consistency and
// future use; a composite FK isn't possible for a polymorphic table.
//
// Idempotent: columns use IF NOT EXISTS, constraints are guarded by
// pg_constraint lookups, so a re-run is a no-op.

import pool from '../db.js'

// Add UNIQUE(id, organization_id) to a parent so it can be referenced by a
// composite FK. id is already the PK (unique), but Postgres requires a unique
// constraint on the exact referenced column list.
async function addIdOrgUnique(table) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_id_org_uniq') THEN
      ALTER TABLE ${table} ADD CONSTRAINT ${table}_id_org_uniq UNIQUE (id, organization_id);
    END IF;
  END $$;`)
}

async function addConstraintIfMissing(name, ddl) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
      ${ddl};
    END IF;
  END $$;`)
}

// Add organization_id to a two-parent join table, backfilling from the
// "primary" parent (the one we key the row's org off), removing any rows whose
// two parents disagree on org, then locking + indexing + composite-FK-ing.
async function hardenJoinTable({
  table, primaryParent, primaryFk, secondaryParent, secondaryFk,
}) {
  // 1. Column (nullable first).
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS organization_id INTEGER`)

  // 2. Backfill org from the primary parent.
  await pool.query(
    `UPDATE ${table} j SET organization_id = p.organization_id
       FROM ${primaryParent} p
      WHERE j.${primaryFk} = p.id AND j.organization_id IS NULL`
  )

  // 3. Remove any cross-tenant contamination: rows whose secondary parent
  //    lives in a different org than the (backfilled) row. On clean data this
  //    deletes nothing; on leaked data it removes the corrupt link so the
  //    composite FK below can be added.
  await pool.query(
    `DELETE FROM ${table} j
       USING ${secondaryParent} s
      WHERE j.${secondaryFk} = s.id
        AND s.organization_id IS DISTINCT FROM j.organization_id`
  )
  // Also drop any row we still couldn't attribute (parent vanished mid-flight).
  await pool.query(`DELETE FROM ${table} WHERE organization_id IS NULL`)

  // 4. Lock + index.
  await pool.query(`ALTER TABLE ${table} ALTER COLUMN organization_id SET NOT NULL`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${table}_organization ON ${table}(organization_id)`)

  // 5. Composite FKs — both parents must share the row's org.
  await addConstraintIfMissing(`${table}_${primaryFk}_org_fk`,
    `ALTER TABLE ${table} ADD CONSTRAINT ${table}_${primaryFk}_org_fk
       FOREIGN KEY (${primaryFk}, organization_id)
       REFERENCES ${primaryParent}(id, organization_id) ON DELETE CASCADE`)
  await addConstraintIfMissing(`${table}_${secondaryFk}_org_fk`,
    `ALTER TABLE ${table} ADD CONSTRAINT ${table}_${secondaryFk}_org_fk
       FOREIGN KEY (${secondaryFk}, organization_id)
       REFERENCES ${secondaryParent}(id, organization_id) ON DELETE CASCADE`)
}

export async function up() {
  console.log('Migration 044: tenant-fk-guards — applying...')

  // 1. Parents become composite-FK targets.
  await addIdOrgUnique('ochr_events')
  await addIdOrgUnique('ochr_clients')
  await addIdOrgUnique('ochr_groups')

  // 2. Harden the three join tables.
  await hardenJoinTable({
    table: 'ochr_attendance',
    primaryParent: 'ochr_events',  primaryFk:   'event_id',
    secondaryParent: 'ochr_clients', secondaryFk: 'member_id',
  })
  await hardenJoinTable({
    table: 'ochr_event_members',
    primaryParent: 'ochr_events',  primaryFk:   'event_id',
    secondaryParent: 'ochr_clients', secondaryFk: 'member_id',
  })
  await hardenJoinTable({
    table: 'ochr_group_members',
    primaryParent: 'ochr_groups',  primaryFk:   'group_id',
    secondaryParent: 'ochr_clients', secondaryFk: 'client_id',
  })

  // 3. ochr_translations — polymorphic + currently unused. Nullable org for
  //    consistency; wire it (and lock NOT NULL) when the bilingual side-table
  //    is actually populated, or drop the table in a future migration.
  await pool.query(
    `ALTER TABLE ochr_translations
       ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES ochr_organizations(id) ON DELETE CASCADE`
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_ochr_translations_organization ON ochr_translations(organization_id)`
  )

  console.log('Migration 044: tenant-fk-guards — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
