// 082 — Migration Studio (MIG.1): the careful move into a new parish office.
//
// Two tables carry an import from "here is our spreadsheet" to "here is
// the receipt for what happened":
//
//   ochr_import_batches — one row per attempted import. Holds the source
//     headers, the confirmed column mapping, a summary of the review, and
//     — after commit — the durable receipt (who, what, when, how many,
//     what was held back and why). The batch IS the artifact; it outlives
//     the wizard that produced it.
//   ochr_import_rows — every row read from the source file, verbatim
//     (`raw`), plus what the mapping made of it (`normalized`), a status,
//     and a human-readable `issue` explaining any hold. The rows are what
//     the preview shows and what the commit reads — nothing is imported
//     that was not first visible on screen.
//
// Design constraints, in constitutional order:
//   · Preview writes NOTHING authoritative. Batches and their rows are
//     staging; ochr_clients / ochr_funds / ochr_donations are only touched
//     by the explicit admin commit, in one transaction.
//   · No hidden AI anywhere. Mapping suggestions are deterministic header
//     heuristics computed in the route, shown, and confirmable.
//   · The original FILE is not stored — only the parsed rows. The UI says
//     so truthfully; when Vault-backed file storage exists, source-file
//     retention can attach here (batch id is the integration point).
//   · Statuses are calm vocabulary, not pipeline jargon: a row is ready,
//     held (with its reason), a possible duplicate (with its reason),
//     skipped by a person, or imported.
//
// Tenant posture: both tables carry organization_id; rows also prove
// batch ownership through a composite FK (the 044/061 lesson). RLS
// enabled, no policy — app-layer scoping is the control, as everywhere.

import pool from '../db.js'

async function addConstraintIfMissing(name, ddl) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
      ${ddl};
    END IF;
  END $$;`)
}

export async function up() {
  console.log('Migration 082: migration-studio — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_import_batches (
      id               BIGSERIAL PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      kind             TEXT NOT NULL CHECK (kind IN ('members', 'funds', 'gifts')),
      source_name      TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'uploaded'
                         CHECK (status IN ('uploaded', 'mapped', 'committed', 'abandoned')),
      headers          JSONB NOT NULL,
      mapping          JSONB,
      row_count        INTEGER NOT NULL DEFAULT 0,
      summary          JSONB,
      receipt          JSONB,
      created_by       INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      approved_by      INTEGER REFERENCES ochr_users(id) ON DELETE SET NULL,
      committed_at     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_batches_org
                    ON ochr_import_batches(organization_id, created_at DESC)`)

  // Composite-FK target so rows can prove they belong to a batch in the
  // same org.
  await addConstraintIfMissing('ochr_import_batches_id_org_uniq',
    `ALTER TABLE ochr_import_batches ADD CONSTRAINT ochr_import_batches_id_org_uniq UNIQUE (id, organization_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_import_rows (
      id                 BIGSERIAL PRIMARY KEY,
      organization_id    INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      batch_id           BIGINT NOT NULL,
      row_no             INTEGER NOT NULL,
      raw                JSONB NOT NULL,
      normalized         JSONB,
      status             TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'ready', 'held',
                                             'possible_duplicate', 'skipped', 'imported')),
      issue              TEXT,
      decision           TEXT CHECK (decision IS NULL OR decision IN ('import', 'skip')),
      created_record_id  BIGINT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (batch_id, row_no)
    )
  `)

  await addConstraintIfMissing('ochr_import_rows_batch_org_fk',
    `ALTER TABLE ochr_import_rows ADD CONSTRAINT ochr_import_rows_batch_org_fk
       FOREIGN KEY (batch_id, organization_id)
       REFERENCES ochr_import_batches(id, organization_id) ON DELETE CASCADE`)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_rows_batch
                    ON ochr_import_rows(batch_id, status, row_no)`)

  await pool.query(`ALTER TABLE ochr_import_batches ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE ochr_import_rows    ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 082: migration-studio — applied.')
}
