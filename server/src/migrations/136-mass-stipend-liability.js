// 136 — Mass stipend liability facts + parish-ledger branch (SP-250).
//
// José, 2026-10-27 1:37 PM PT: Ledger option C + W1. Stipends project onto
// liability 2330 (not income/4210). Assessability fails closed (2330 is
// non-assessable; NULL never invents a cut). Void/withdraw of a paid
// intention requires a disposition fact. Donations and year-end statements
// are unchanged. Migration 134 stays reserved; 135 is BOOKS-1.1 on another
// branch — this file stacks on main and is numbered 136.
//
// ADDITIVE. One REPEATABLE READ transaction. Append-only facts (void ≠
// delete) — BEFORE UPDATE/DELETE trigger. Per-org 2330 seed uses the same
// transaction-local hold-guard DISABLE/ENABLE as #435 / migs 120 and 126.
// Recreates ochr_parish_ledger with tip deposit branch + stipend branch.
// No invented cash movement.

import pool from '../db.js'
import { LEDGER_DEPOSIT_BRANCH } from './130-event-deposits.js'

const F = 'ochr_mass_stipend_facts'

export const STIPEND_LIABILITY_CODE = '2330'

export const LEDGER_STIPEND_BRANCH = `
    UNION ALL

    SELECT
      f.organization_id,
      f.effective_date AS entry_date,
      '${STIPEND_LIABILITY_CODE}' AS account_code,
      (CASE WHEN f.kind = 'recorded' THEN f.amount ELSE -f.amount END)::NUMERIC(12,2) AS amount,
      'mass_stipend' AS source_type,
      f.id AS source_id,
      CASE f.kind
        WHEN 'recorded' THEN 'Mass stipend held'
        WHEN 'adjusted' THEN 'Mass stipend amount corrected'
        WHEN 'refunded' THEN 'Mass stipend refunded'
        WHEN 'transferred' THEN 'Mass stipend transferred'
        WHEN 'pastor_applied' THEN 'Mass stipend applied (pastor)'
        ELSE 'Mass stipend'
      END AS memo
    FROM ${F} f
`

const DONATION_ACCOUNT = `COALESCE(
      CASE WHEN d.fund_id IS NOT NULL
           THEN ochr_mapping_account(d.organization_id, 'fund', d.fund_id::text, d.date::date)
      END,
      ochr_mapping_account(
        d.organization_id, 'donation_category',
        COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized'), d.date::date),
      CASE WHEN d.date::date < (SELECT cutover_on FROM ochr_books_cutover) THEN '4420' ELSE NULL END
    )`

const LEDGER_VIEW = `
    CREATE OR REPLACE VIEW ochr_parish_ledger WITH (security_invoker = true) AS
    SELECT
      le.organization_id, le.entry_date, le.account_code, le.amount,
      le.source_type, le.id AS source_id, le.memo
    FROM ochr_ledger_entries le

    UNION ALL

    SELECT
      d.organization_id,
      d.date::date AS entry_date,
      ${DONATION_ACCOUNT} AS account_code,
      d.amount AS amount,
      'donation' AS source_type,
      d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d

    UNION ALL

    SELECT
      r.organization_id,
      d.date::date AS entry_date,
      ${DONATION_ACCOUNT} AS account_code,
      (-r.amount)::NUMERIC(12,2) AS amount,
      'donation_refund' AS source_type,
      r.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donation_refunds r
    JOIN ochr_donations d
      ON d.id = r.donation_id AND d.organization_id = r.organization_id
    WHERE r.status = 'posted'

    UNION ALL

    SELECT
      d.organization_id,
      d.date::date AS entry_date,
      ${DONATION_ACCOUNT} AS account_code,
      (-d.amount)::NUMERIC(12,2) AS amount,
      'donation_refund' AS source_type,
      d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d
    WHERE d.payment_status = 'refunded'
      AND NOT EXISTS (
        SELECT 1 FROM ochr_donation_refunds r
         WHERE r.donation_id = d.id
           AND r.organization_id = d.organization_id
           AND r.status = 'posted'
      )

    UNION ALL

    SELECT
      s.organization_id,
      sh.date::date AS entry_date,
      COALESCE(ochr_mapping_account(s.organization_id, 'payroll', 'wages', sh.date::date), '5120') AS account_code,
      (sh.hours * s.pay_rate)::NUMERIC(12,2) AS amount,
      'payroll' AS source_type,
      sh.id AS source_id,
      s.name AS memo
    FROM ochr_payroll_shifts sh
    JOIN ochr_payroll_staff s ON s.id = sh.staff_id
    ${LEDGER_DEPOSIT_BRANCH}
    ${LEDGER_STIPEND_BRANCH}
  `

async function addConstraintIfMissing(db, name, ddl) {
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
      ${ddl};
    END IF;
  END $$;`)
}

export async function up() {
  console.log('Migration 136: mass-stipend-liability — applying...')
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await client.query(`SET LOCAL lock_timeout = '5s'`)

    await client.query(
      `INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
       SELECT NULL, $1::text, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (SELECT 1 FROM ochr_coa_accounts WHERE organization_id IS NULL AND code = $1::text)`,
      [STIPEND_LIABILITY_CODE, 'Mass Stipends Payable', 'liability', 'Deferred', false, 66])

    // Also seed every existing org chart that already cloned the template.
    // P1 N1 / #435: held orgs refuse ordinary COA writes. DISABLE the hold
    // guard for this seed only; ENABLE commits with the seed (any error
    // rolls both back). Same pattern as migrations 120, 126, and 132.
    await client.query('ALTER TABLE ochr_coa_accounts DISABLE TRIGGER ochr_organization_hold_guard')
    await client.query(
      `INSERT INTO ochr_coa_accounts (organization_id, code, name, acct_type, rollup_group, assessable, sort_order)
       SELECT o.id, $1::text, $2, $3, $4, $5, $6
         FROM ochr_organizations o
        WHERE NOT EXISTS (
          SELECT 1 FROM ochr_coa_accounts c
           WHERE c.organization_id = o.id AND c.code = $1::text)`,
      [STIPEND_LIABILITY_CODE, 'Mass Stipends Payable', 'liability', 'Deferred', false, 66])
    await client.query('ALTER TABLE ochr_coa_accounts ENABLE TRIGGER ochr_organization_hold_guard')

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${F} (
        id                        BIGSERIAL PRIMARY KEY,
        organization_id           INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
        mass_intention_id         BIGINT        NOT NULL,
        kind                      TEXT          NOT NULL,
        amount                    NUMERIC(12,2) NOT NULL,
        effective_date            DATE          NOT NULL,
        transfer_to_intention_id  BIGINT,
        reason                    TEXT,
        recorded_by_user_id       INTEGER,
        idempotency_key           TEXT          NOT NULL,
        created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT ochr_mass_stipend_facts_kind_check
          CHECK (kind IN ('recorded', 'adjusted', 'refunded', 'transferred', 'pastor_applied')),
        CONSTRAINT ochr_mass_stipend_facts_amount_check CHECK (amount > 0),
        CONSTRAINT ochr_mass_stipend_facts_transfer_link
          CHECK ((kind = 'transferred') = (transfer_to_intention_id IS NOT NULL)),
        CONSTRAINT ochr_mass_stipend_facts_reason_required
          CHECK (kind = 'recorded'
                 OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
        CONSTRAINT ochr_mass_stipend_facts_idem_len
          CHECK (length(idempotency_key) > 0 AND length(idempotency_key) <= 160),
        CONSTRAINT ochr_mass_stipend_facts_intention_fk
          FOREIGN KEY (mass_intention_id, organization_id)
          REFERENCES ochr_mass_intentions (id, organization_id) ON DELETE CASCADE,
        CONSTRAINT ochr_mass_stipend_facts_transfer_fk
          FOREIGN KEY (transfer_to_intention_id, organization_id)
          REFERENCES ochr_mass_intentions (id, organization_id),
        CONSTRAINT ochr_mass_stipend_facts_recorded_by_fk
          FOREIGN KEY (recorded_by_user_id, organization_id)
          REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (recorded_by_user_id)
      )
    `)
    // Widen kind CHECK if an earlier 136 draft lacked 'adjusted'.
    await client.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ochr_mass_stipend_facts_kind_check'
           AND pg_get_constraintdef(oid) NOT LIKE '%adjusted%'
      ) THEN
        ALTER TABLE ochr_mass_stipend_facts DROP CONSTRAINT ochr_mass_stipend_facts_kind_check;
        ALTER TABLE ochr_mass_stipend_facts ADD CONSTRAINT ochr_mass_stipend_facts_kind_check
          CHECK (kind IN ('recorded', 'adjusted', 'refunded', 'transferred', 'pastor_applied'));
      END IF;
    END $$;`)

    await addConstraintIfMissing(client, 'ochr_mass_stipend_facts_id_org_uniq',
      `ALTER TABLE ${F} ADD CONSTRAINT ochr_mass_stipend_facts_id_org_uniq UNIQUE (id, organization_id)`)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_mass_stipend_facts_idempotency
      ON ${F} (organization_id, idempotency_key)`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mass_stipend_facts_intention
      ON ${F} (organization_id, mass_intention_id, effective_date)`)
    await client.query(`ALTER TABLE ${F} ENABLE ROW LEVEL SECURITY`)

    // Carolina P1b: append-only (UPDATE/DELETE blocked; correction appends a new fact).
    await client.query(`
      CREATE OR REPLACE FUNCTION ochr_mass_stipend_facts_append_only()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'mass stipend facts are append-only; append a correction or disposition fact instead'
            USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'DELETE' THEN
          IF pg_trigger_depth() <= 1 THEN
            RAISE EXCEPTION 'mass stipend facts are append-only; append a correction or disposition fact instead'
              USING ERRCODE = '55000';
          END IF;
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await client.query(`DROP TRIGGER IF EXISTS ochr_mass_stipend_facts_append_only ON ${F}`)
    await client.query(`CREATE TRIGGER ochr_mass_stipend_facts_append_only
      BEFORE UPDATE OR DELETE ON ${F}
      FOR EACH ROW EXECUTE FUNCTION ochr_mass_stipend_facts_append_only()`)

    const { rows: roles } = await client.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
    for (const { rolname } of roles) {
      await client.query(`REVOKE ALL ON ${F} FROM ${rolname}`)
    }
    await client.query(`DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ${F}`)
    await client.query(`CREATE TRIGGER ochr_organization_hold_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${F}
      FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)

    // Backfill: open intentions that already carry an offering amount get one
    // recorded fact. Voided rows are left without a clearing disposition so
    // period submit stays fail-closed until a human records one (W1). Amount
    // 0.00 is skipped (no liability). Idempotent on the unique recorded index.
    await client.query(`
      INSERT INTO ${F}
        (organization_id, mass_intention_id, kind, amount, effective_date,
         reason, recorded_by_user_id, idempotency_key)
      SELECT mi.organization_id, mi.id, 'recorded', mi.stipend,
             COALESCE(mi.mass_date, mi.created_at::date, CURRENT_DATE),
             NULL, NULL, 'backfill:recorded:' || mi.id::text
        FROM ochr_mass_intentions mi
       WHERE mi.offering_recorded = true
         AND mi.stipend IS NOT NULL AND mi.stipend > 0
         AND mi.voided_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ${F} f
            WHERE f.organization_id = mi.organization_id
              AND f.mass_intention_id = mi.id
              AND f.kind = 'recorded')
      ON CONFLICT DO NOTHING
    `)

    await client.query(LEDGER_VIEW)

    await client.query('COMMIT')
    console.log('Migration 136: mass-stipend-liability — done.')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
