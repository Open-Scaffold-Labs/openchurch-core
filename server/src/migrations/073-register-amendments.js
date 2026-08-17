// 073 — Register integrity: a committed record stops behaving like a row.
//
// WHAT WAS WRONG
//
// migrations/049 calls the sacramental register "canonical" and "the
// permanent record". The code disagreed with the comment:
//
//   · DELETE /api/sacraments/:id was a hard DELETE FROM with no tombstone.
//   · PATCH rewrote any field with no reason and no capture of the prior
//     value.
//   · The audit row for a delete carries `{}` as metadata
//     (middleware/auditLog.js), so the name, type, date, minister and
//     godparents were unrecoverable.
//   · That audit row is itself pruned after 30 days on Free.
//   · Any `staff` user could do all of it.
//
// So the one artifact a parish is obliged to keep forever had the same
// mutability as a task, and its change history evaporated in a month.
//
// THE MODEL: VOID BY AMENDMENT, NEVER DELETE
//
// A committed register entry cannot be removed. It can be:
//
//   · CORRECTED — the row changes, and an amendment records what it was
//     before, what it became, who did it, when, and why.
//   · VOIDED — the row stays exactly as it is and is marked void, with a
//     reason and an actor. It leaves the working register and remains in
//     the record.
//
// This is how a paper register is actually corrected: by a dated marginal
// notation in the hand of the person who made it, never by erasure. The
// entry that was wrong is part of the history of the entry that is right.
//
// WHY 'void' RATHER THAN 'delete' MATTERS FOR CASES WE HAVE NOT MET YET
//
// The situations that need this are ones nobody has hit yet and everybody
// eventually does. A baptism entered against the wrong member. A wedding
// recorded at the wrong parish and re-entered correctly at the right one. A
// duplicate created when two volunteers digitised the same page. A record
// entered for a ceremony that did not, in the end, take place. In every one
// of those, "make it go away" is the wrong answer and "mark it void, say
// why, keep it" is the right one — because six months later somebody will
// ask why the register skips a number, and the answer has to be in the book.
//
// RETENTION
//
// Amendments are NEVER pruned. They are register history, not operational
// telemetry, and services/retention.js is documented to say so.

import pool from '../db.js'

export async function up() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_sacrament_amendments (
      id                BIGSERIAL PRIMARY KEY,
      organization_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      sacrament_id      BIGINT  NOT NULL,
      kind              TEXT    NOT NULL CHECK (kind IN ('correction', 'void', 'restore')),
      -- A reason is structurally required. An amendment with no reason is
      -- indistinguishable from the silent overwrite this table exists to
      -- prevent, so the constraint is on the column and not just the route.
      reason            TEXT    NOT NULL CHECK (length(btrim(reason)) >= 3),
      before_json       JSONB   NOT NULL,
      after_json        JSONB,
      -- Actor identity is SNAPSHOT, not just referenced — same reasoning as
      -- member_name in 054. A staff member who leaves the parish must not
      -- take the authorship of a correction with them.
      amended_by        INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      amended_by_name   TEXT,
      amended_by_email  TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sacrament_amendments_record
      ON ochr_sacrament_amendments(organization_id, sacrament_id, created_at DESC)
  `)

  // Composite tenant FK, per the 071 pattern and the CI gate that enforces
  // it. An amendment can only ever point at a record in its own org.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_sacramental_records_id_org_uniq'
      ) THEN
        ALTER TABLE ochr_sacramental_records
          ADD CONSTRAINT ochr_sacramental_records_id_org_uniq UNIQUE (id, organization_id);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ochr_sacrament_amendments_record_fk'
      ) THEN
        ALTER TABLE ochr_sacrament_amendments
          ADD CONSTRAINT ochr_sacrament_amendments_record_fk
          FOREIGN KEY (sacrament_id, organization_id)
          REFERENCES ochr_sacramental_records(id, organization_id) ON DELETE CASCADE;
      END IF;
    END $$;
  `)

  // The actor FK is composite too. The tenant-FK CI gate caught this on
  // the first run of this very migration — amended_by was single-column,
  // which would have let an amendment name a user from another parish.
  // Column-scoped SET NULL (PG15) so deleting a user nulls the actor
  // reference WITHOUT nulling organization_id and orphaning the row; the
  // name and email snapshots are why that stays readable.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_users_id_org_uniq') THEN
        ALTER TABLE ochr_users ADD CONSTRAINT ochr_users_id_org_uniq UNIQUE (id, organization_id);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_sacrament_amendments_amended_by_fkey') THEN
        ALTER TABLE ochr_sacrament_amendments DROP CONSTRAINT ochr_sacrament_amendments_amended_by_fkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_sacrament_amendments_actor_fk') THEN
        ALTER TABLE ochr_sacrament_amendments
          ADD CONSTRAINT ochr_sacrament_amendments_actor_fk
          FOREIGN KEY (amended_by, organization_id)
          REFERENCES ochr_users(id, organization_id) ON DELETE SET NULL (amended_by);
      END IF;
    END $$;
  `)

  await pool.query(`ALTER TABLE ochr_sacrament_amendments ENABLE ROW LEVEL SECURITY`)

  // The void marks on the record itself. Kept here rather than derived from
  // the amendment table so the common read — "is this entry live?" — is a
  // column test and not a join.
  await pool.query(`ALTER TABLE ochr_sacramental_records ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE ochr_sacramental_records ADD COLUMN IF NOT EXISTS voided_reason TEXT`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sacraments_live
      ON ochr_sacramental_records(organization_id, id) WHERE voided_at IS NULL
  `)

  console.log('Migration 073: register amendments — applied.')
}
