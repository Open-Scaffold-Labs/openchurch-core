// 106 — GIV-08 M4: an APPLIED credit is the durable economic effect of
// settling an OPEN period adjustment. SETTLED (resolved_at) is the
// chancery's decision. They stay distinct, and SETTLED cannot exist
// without APPLIED on the money path.
//
// THE MODEL. Founder-locked 2026-09-12: bill/assessment basis =
// approved frozen gross − APPLIED credits. totals_json stays the
// archival snapshot. Original gift and refund facts are not rewritten.
// M1 restatement is forbidden. OPEN remains a condition, not a credit.
//
// WHAT THIS TABLE IS. One credit row per adjustment, amount copied from
// the sidecar (never from the caller). Tenant-composite FKs to the
// adjustment, the frozen period, the gift, and — when known — the
// refund fact. UNIQUE(adjustment_id) is the no-double-apply lock.
// UNIQUE(donation_refund_id) WHERE NOT NULL is the same lock named
// by the refund fact.
//
// SETTLED WITHOUT APPLIED. resolved_at is still the SETTLED stamp on
// ochr_period_adjustments. Two deferred constraint triggers refuse a
// COMMIT that leaves SETTLED without a credit, or that deletes the last
// credit from a SETTLED row. Stamp-only UPDATE resolved_at therefore
// cannot clear OPEN while pretending money moved. Org-level CASCADE
// still works: at COMMIT both rows are gone, so the check is quiet.
//
// WHAT THIS DOES NOT DO. It does not reopen a frozen period, rewrite
// totals_json, fold credits into live giving (GIV-06 Option A), or
// invent GIV-09. Resubmit DELETE of OPEN stays invalidation of a
// replaced snapshot — it never writes a credit.

import pool from '../db.js'

const ADJ = 'ochr_period_adjustments'
const TABLE = 'ochr_period_adjustment_credits'

export async function up() {
  console.log('Migration 106: period-adjustment-credits — applying...')

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ochr_period_adjustments_id_org_uniq'
      ) THEN
        ALTER TABLE ${ADJ}
          ADD CONSTRAINT ochr_period_adjustments_id_org_uniq
          UNIQUE (id, organization_id);
      END IF;
    END $$;
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id                 BIGSERIAL PRIMARY KEY,
      organization_id    INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      diocese_org_id     INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      adjustment_id      BIGINT        NOT NULL,
      submission_id      BIGINT        NOT NULL,
      donation_id        BIGINT        NOT NULL,
      donation_refund_id BIGINT,
      amount             NUMERIC(12,2) NOT NULL,
      applied_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
      applied_by         INTEGER,
      created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT ochr_period_adjustment_credits_amount_check CHECK (amount > 0),
      CONSTRAINT uq_period_adjustment_credit_once UNIQUE (adjustment_id),
      CONSTRAINT ochr_period_adjustment_credits_adjustment_fk
        FOREIGN KEY (adjustment_id, organization_id)
        REFERENCES ${ADJ}(id, organization_id) ON DELETE NO ACTION,
      CONSTRAINT ochr_period_adjustment_credits_submission_fk
        FOREIGN KEY (submission_id, organization_id)
        REFERENCES ochr_report_submissions(id, organization_id) ON DELETE CASCADE,
      CONSTRAINT ochr_period_adjustment_credits_donation_fk
        FOREIGN KEY (donation_id, organization_id)
        REFERENCES ochr_donations(id, organization_id) ON DELETE CASCADE,
      CONSTRAINT ochr_period_adjustment_credits_refund_fk
        FOREIGN KEY (donation_refund_id, organization_id)
        REFERENCES ochr_donation_refunds(id, organization_id) ON DELETE NO ACTION
    )
  `)

  await pool.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_period_adjustment_credit_refund
      ON ${TABLE} (donation_refund_id)
      WHERE donation_refund_id IS NOT NULL
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_period_adjustment_credits_submission
      ON ${TABLE} (diocese_org_id, organization_id, submission_id)
  `)

  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_period_adjustments_settled_requires_applied()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.resolved_at IS NULL THEN
        RETURN NULL;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM ${ADJ} a
         WHERE a.id = NEW.id AND a.organization_id = NEW.organization_id
      ) THEN
        RETURN NULL;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM ${TABLE} c
         WHERE c.adjustment_id = NEW.id
           AND c.organization_id = NEW.organization_id
      ) THEN
        RAISE EXCEPTION 'SETTLED requires an APPLIED credit'
          USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END;
    $$
  `)
  await pool.query(`
    DROP TRIGGER IF EXISTS ochr_period_adjustments_settled_requires_applied
      ON ${ADJ}
  `)
  await pool.query(`
    CREATE CONSTRAINT TRIGGER ochr_period_adjustments_settled_requires_applied
      AFTER INSERT OR UPDATE OF resolved_at ON ${ADJ}
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION ochr_period_adjustments_settled_requires_applied()
  `)

  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_period_adjustment_credits_guards_settled()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM ${ADJ} a
         WHERE a.id = OLD.adjustment_id
           AND a.organization_id = OLD.organization_id
           AND a.resolved_at IS NOT NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM ${TABLE} c
         WHERE c.adjustment_id = OLD.adjustment_id
           AND c.organization_id = OLD.organization_id
      ) THEN
        RAISE EXCEPTION 'Cannot remove the APPLIED credit from a SETTLED adjustment'
          USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END;
    $$
  `)
  await pool.query(`
    DROP TRIGGER IF EXISTS ochr_period_adjustment_credits_guards_settled
      ON ${TABLE}
  `)
  await pool.query(`
    CREATE CONSTRAINT TRIGGER ochr_period_adjustment_credits_guards_settled
      AFTER DELETE ON ${TABLE}
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION ochr_period_adjustment_credits_guards_settled()
  `)

  const { rows } = await pool.query(`SELECT to_regclass($1) AS t`, [TABLE])
  if (!rows[0]?.t) throw new Error(`106: ${TABLE} was not created`)

  const { rows: rls } = await pool.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = $1`, [TABLE])
  if (!rls[0]?.relrowsecurity) {
    throw new Error(`106: ${TABLE} is missing RLS`)
  }

  const { rows: parent } = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'ochr_period_adjustments_id_org_uniq'`)
  if (!parent.length) {
    throw new Error('106: ochr_period_adjustments is missing UNIQUE (id, organization_id)')
  }

  for (const [name, col] of [
    ['ochr_period_adjustment_credits_adjustment_fk', 'organization_id'],
    ['ochr_period_adjustment_credits_submission_fk', 'organization_id'],
    ['ochr_period_adjustment_credits_donation_fk', 'organization_id'],
    ['ochr_period_adjustment_credits_refund_fk', 'organization_id'],
  ]) {
    const { rows: fk } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name])
    if (!fk.length || !fk[0].def.includes(col)) {
      throw new Error(`106: ${name} is not tenant-composite on ${col}`)
    }
  }

  const { rows: uniq } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'uq_period_adjustment_credit_once'`)
  if (!uniq.length || !/adjustment_id/.test(uniq[0].def)) {
    throw new Error('106: UNIQUE (adjustment_id) is missing — a credit could be applied twice')
  }

  const { rows: trig } = await pool.query(
    `SELECT 1 FROM pg_trigger
      WHERE tgname = 'ochr_period_adjustments_settled_requires_applied' AND NOT tgisinternal`)
  if (!trig.length) {
    throw new Error('106: SETTLED-requires-APPLIED trigger is missing')
  }

  console.log('Migration 106: period-adjustment-credits — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
