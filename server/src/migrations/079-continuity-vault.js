// The Continuity Vault, stage one — a deletion stops being destruction.
//
// OpenChurch already had three of the four resilience layers:
//   orgExport.js    — a portable, intelligible copy of a parish's records
//   backupDigest.js — that copy, gzipped and written to backup storage every week
//   retention.js    — an explicit, written-down prune policy
//
// What it did not have was the layer people actually meet: somebody
// clicks Delete on the wrong member, and forty rows of attendance, group
// membership and unavailability go with her, while her baptism quietly
// loses the link to her name. A weekly off-site backup answers that with
// "restore the whole parish to Saturday" — which is not an answer.
//
// This table is the recoverable prior version. Before a protected row is
// deleted, the row, everything the database would have cascaded away with
// it, and every reference that would have been set to NULL are captured
// here as one snapshot. Restoring puts all three back.
//
// Deliberate shapes:
//
//   snapshot is JSONB, not a set of shadow tables. A shadow table has to
//   be migrated in lockstep with the real one forever; the day it drifts
//   is the day the restore writes the wrong columns. JSON captured from
//   the live row cannot drift from the live row.
//
//   deleted_by is ON DELETE SET NULL with a name/email snapshot beside
//   it, so a restore that happens after the deleting user has left still
//   says who did it. Same pattern as ochr_audit_log and the register.
//
//   retention_until is a DATE stamped at capture time rather than
//   computed at read time. If the policy changes next year, entries
//   captured under the old promise keep the old promise.
//
//   restored_at/by make the entry a record of the whole round trip. The
//   audit log records it too, but ochr_audit_log is pruned per plan
//   (30 days on Free) and a recovery is not operational telemetry.
//
// Nothing here claims a parish can never lose anything. It claims that
// these deletions are recoverable, for this long, and that the recovery
// is audited — which is the only part that has been tested.

import pool from '../db.js'

export async function up() {
  console.log('Migration 079: continuity vault — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_vault_entries (
      id               SERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,

      kind             TEXT    NOT NULL,
      entity_table     TEXT    NOT NULL,
      entity_id        TEXT    NOT NULL,
      label            TEXT    NOT NULL,

      snapshot         JSONB   NOT NULL,
      summary          JSONB   NOT NULL DEFAULT '{}',
      reason           TEXT,

      deleted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_by       INTEGER,
      deleted_by_name  TEXT,
      deleted_by_email TEXT,

      retention_until  DATE    NOT NULL,

      restored_at      TIMESTAMPTZ,
      restored_by      INTEGER,
      restored_by_name TEXT
    )
  `)

  // Tenant-safe references to the actor, in the shape migration 071
  // established and scripts/tenant-fk-audit.mjs enforces: the composite
  // key makes it impossible to name a user from another organisation as
  // the person who deleted or restored this parish's record. Column-
  // scoped SET NULL (PG15+) nulls only the user column, so
  // organization_id — which is NOT NULL — survives the user's departure
  // and the name snapshot beside it still says who it was.
  for (const col of ['deleted_by', 'restored_by']) {
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ochr_vault_entries_${col}_fkey') THEN
          ALTER TABLE ochr_vault_entries DROP CONSTRAINT ochr_vault_entries_${col}_fkey;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'ochr_vault_entries_${col}_org_fkey') THEN
          ALTER TABLE ochr_vault_entries
            ADD CONSTRAINT ochr_vault_entries_${col}_org_fkey
            FOREIGN KEY (${col}, organization_id)
            REFERENCES ochr_users(id, organization_id)
            ON DELETE SET NULL (${col});
        END IF;
      END $$;
    `)
  }

  // The two queries the Archive & Recovery view will run: the recoverable
  // list, newest first, and "was this particular thing ever deleted?".
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_vault_org_deleted
      ON ochr_vault_entries(organization_id, deleted_at DESC)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_vault_org_entity
      ON ochr_vault_entries(organization_id, entity_table, entity_id)
  `)
  // The prune pass walks expired, still-unrestored entries.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_vault_retention
      ON ochr_vault_entries(retention_until)
     WHERE restored_at IS NULL
  `)

  // Deny-by-default at the database, the posture every ochr_* table has
  // carried since 071. This table holds a JSONB snapshot of every deleted
  // record in the tenant, so it is the last one that should be readable
  // by a role that is not the app's.
  await pool.query(`ALTER TABLE ochr_vault_entries ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 079: continuity vault — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
