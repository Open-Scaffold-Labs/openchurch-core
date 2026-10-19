// GIV-09 — an issued giving statement is a historical claim.
//
// THE DEFECT THIS CLOSES. The year-end statement a parish hands a donor for
// their taxes had no persistence of any kind. GET /api/giving-statements/donor
// re-derived every figure from ochr_donation_live — a VIEW whose live_amount is
// (amount - refunded_total) computed at read time — and read the letterhead
// block (name, address, TAX ID, signatory) live from ochr_organizations. So the
// statement issued in January silently became a different tax claim when a
// refund posted in March, or when the parish corrected its own address.
//
// WHAT AN ISSUANCE FREEZES. snapshot_json carries the whole claim as it was
// made: the donor block as printed, the organization letterhead as printed,
// every gift line with its amount AND its refunded_total at that instant, and
// the computed total. Nothing in it is a reference to mutable state — a later
// reader reproduces the historical claim without touching ochr_donations,
// ochr_donation_refunds, or ochr_organizations at all.
//
// WHY A TRIGGER AND NOT A CONVENTION. Invariant: an issued artifact cannot be
// rewritten. A route can forget; a trigger cannot. ochr_giving_statements_frozen
// refuses any UPDATE that touches the frozen columns. Only the issuance
// lifecycle (status, superseded_at, superseded_by_id) may move, which is how a
// correction is recorded without destroying what was originally claimed.
//
// DISTINCT ISSUANCES STAY REPRESENTABLE. There is deliberately NO unique index
// on (org, tax_year, donor). A parish may legitimately issue the same donor's
// 2026 statement twice — the donor lost the first one. Duplicate protection is
// by explicit issue_key instead, so an accidental retry collapses onto the same
// historical claim while an intentional reissue is a new one.
//
// WHAT THIS DOES NOT DO. It does not store rendered PDFs, replace the live
// preview, touch ochr_donations / ochr_donation_refunds / ochr_period_*, or
// change GIV-06/07/08 semantics. Preview stays live and stays labelled preview.

import pool from '../db.js'

const TABLE = 'ochr_giving_statements'

export async function up() {
  console.log('Migration 109: issued-giving-statements — applying...')

  // The per-org statement counter, mirroring invoice_next_no.
  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS statement_next_no INTEGER NOT NULL DEFAULT 1
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id                BIGSERIAL PRIMARY KEY,
      organization_id   INTEGER     NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      tax_year          INTEGER     NOT NULL,
      donor_key         TEXT        NOT NULL,
      donor_key_kind    TEXT        NOT NULL,
      statement_no      TEXT        NOT NULL,
      issue_key         TEXT        NOT NULL,
      status            TEXT        NOT NULL DEFAULT 'issued',
      snapshot_version  INTEGER     NOT NULL DEFAULT 1,
      snapshot_json     JSONB       NOT NULL,
      issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      issued_by         INTEGER,
      issued_by_name    TEXT,
      superseded_at     TIMESTAMPTZ,
      superseded_by_id  BIGINT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_giving_statements_kind_check
        CHECK (donor_key_kind IN ('email', 'name')),
      CONSTRAINT ochr_giving_statements_status_check
        CHECK (status IN ('issued', 'superseded')),
      CONSTRAINT ochr_giving_statements_year_check
        CHECK (tax_year BETWEEN 2010 AND 2100),
      -- A superseded row must name its successor, and only a superseded row may.
      CONSTRAINT ochr_giving_statements_supersede_pairing_check
        CHECK ((status = 'superseded') = (superseded_by_id IS NOT NULL)),
      CONSTRAINT ochr_giving_statements_supersede_stamp_check
        CHECK ((superseded_by_id IS NULL) = (superseded_at IS NULL)),
      -- A statement cannot supersede itself.
      CONSTRAINT ochr_giving_statements_no_self_supersede_check
        CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
    )
  `)

  await pool.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`)

  // Tenant-scoped self reference: the successor must belong to the same parish.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_giving_statements_id_org_uniq') THEN
        ALTER TABLE ${TABLE} ADD CONSTRAINT ochr_giving_statements_id_org_uniq UNIQUE (id, organization_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_giving_statements_successor_fk') THEN
        ALTER TABLE ${TABLE} ADD CONSTRAINT ochr_giving_statements_successor_fk
          FOREIGN KEY (superseded_by_id, organization_id)
          REFERENCES ${TABLE} (id, organization_id) ON DELETE RESTRICT;
      END IF;
      -- ATTRIBUTION IS DELIBERATELY SPLIT, AND THIS IS NOT AN OVERSIGHT.
      -- issued_by is an OPERATIONAL pointer and stays nullable: a parish must
      -- be able to delete a departed user, and ON DELETE SET NULL is what lets
      -- that happen. issued_by_name is the HISTORICAL attribution and IS in the
      -- frozen column list below, so the statement keeps saying who issued it
      -- long after the account is gone.
      -- Do not "fix" this by adding issued_by to the frozen list: the freeze
      -- trigger fires on the FK's own SET NULL, so deleting any user who ever
      -- issued a statement would fail. The test
      -- "deleting the issuing user keeps the historical attribution" pins both
      -- halves of this.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_giving_statements_issued_by_fk') THEN
        ALTER TABLE ${TABLE} ADD CONSTRAINT ochr_giving_statements_issued_by_fk
          FOREIGN KEY (issued_by, organization_id)
          REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (issued_by);
      END IF;
    END $$
  `)

  // Retry of the same issuance is the same historical claim, not a new one.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_giving_statements_org_issue_key
      ON ${TABLE} (organization_id, issue_key)
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_giving_statements_org_no
      ON ${TABLE} (organization_id, statement_no)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_giving_statements_lookup
      ON ${TABLE} (organization_id, tax_year, donor_key_kind, donor_key, issued_at DESC)
  `)

  // THE TEETH. An issued statement is historical truth; the frozen columns may
  // never move. Only the issuance lifecycle may. A route that "corrects" a
  // statement by UPDATEing its snapshot is refused by the database.
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_giving_statements_frozen()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.snapshot_json    IS DISTINCT FROM OLD.snapshot_json
      OR NEW.snapshot_version IS DISTINCT FROM OLD.snapshot_version
      OR NEW.tax_year         IS DISTINCT FROM OLD.tax_year
      OR NEW.donor_key        IS DISTINCT FROM OLD.donor_key
      OR NEW.donor_key_kind   IS DISTINCT FROM OLD.donor_key_kind
      OR NEW.statement_no     IS DISTINCT FROM OLD.statement_no
      OR NEW.issue_key        IS DISTINCT FROM OLD.issue_key
      OR NEW.issued_at        IS DISTINCT FROM OLD.issued_at
      OR NEW.issued_by_name   IS DISTINCT FROM OLD.issued_by_name
      OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
      THEN
        RAISE EXCEPTION
          'issued giving statement % is historical truth and cannot be rewritten', OLD.id
          USING ERRCODE = '23514';
      END IF;
      -- Issuance is one-way: a superseded statement never returns to issued.
      IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
        RAISE EXCEPTION
          'issued giving statement % is already superseded', OLD.id
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_giving_statements_frozen_trg ON ${TABLE}`)
  await pool.query(`
    CREATE TRIGGER ochr_giving_statements_frozen_trg
      BEFORE UPDATE ON ${TABLE}
      FOR EACH ROW EXECUTE FUNCTION ochr_giving_statements_frozen()
  `)

  // A historical claim is not deleted to make a correction. Superseding is the
  // correction path; org CASCADE still removes a whole parish cleanly.
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_giving_statements_no_delete()
    RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM ochr_organizations WHERE id = OLD.organization_id) THEN
        RAISE EXCEPTION
          'issued giving statement % cannot be deleted — supersede it instead', OLD.id
          USING ERRCODE = '23514';
      END IF;
      RETURN OLD;
    END $$ LANGUAGE plpgsql
  `)
  await pool.query(`DROP TRIGGER IF EXISTS ochr_giving_statements_no_delete_trg ON ${TABLE}`)
  await pool.query(`
    CREATE TRIGGER ochr_giving_statements_no_delete_trg
      BEFORE DELETE ON ${TABLE}
      FOR EACH ROW EXECUTE FUNCTION ochr_giving_statements_no_delete()
  `)

  console.log('Migration 109: issued-giving-statements — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch(err => { console.error(err); process.exit(1) })
}
