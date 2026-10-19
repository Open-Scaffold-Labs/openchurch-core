// 104 — GIV-06 Atlas OPTION A: a refund is a new linked financial fact.
//
// CLAIM. $100 gift + $30 refund ≠ $70 gift. Three facts: the gift, the
// refund, and the derived net. gift.amount is never rewritten. A refunded
// gift is never omitted from the live books.
//
// WHAT THIS MIGRATION DOES
//
//   1. Creates ochr_donation_refunds — one row per refund, many per gift.
//      Composite tenant FK (donation_id, organization_id) → ochr_donations,
//      the 071 pattern. Amount > 0. Status posted | pending. Org-scoped
//      UNIQUE on refund_ref where present.
//   2. BACKFILLS one full refund row per gift currently stamped
//      payment_status='refunded' (amount = gift.amount, copy refunded_at /
//      refund_ref). Does not invent partials.
//   3. Replaces ochr_parish_ledger so the donation branch includes every
//      gift at gift.amount and posted refunds appear as separate negative
//      facts (source_type='donation_refund'). Period adjustments stay out
//      of the live net — they are the freeze sidecar (099), not books.
//   4. Adds ochr_donation_live, the dual-read cutover view: prefer Σ(posted
//      refund rows); stamp fallback (net=0) only when a gift is stamped
//      refunded and has no posted refund row yet.
//
// THE WRITE-PATH CAP (Σ posted+pending ≤ gift.amount) is enforced by a
// constraint trigger AND by the refund route's SELECT … FOR UPDATE. A
// silent clamp is a lie; over-refund is a hard failure.
//
// Idempotent: CREATE IF NOT EXISTS / CREATE OR REPLACE / backfill NOT EXISTS.

import pool from '../db.js'

const TABLE = 'ochr_donation_refunds'

export async function backfillStampedRefunds(db = pool) {
  // One full fact per currently-stamped gift. amount = gift.amount — never
  // a guessed partial. refund_ref may be NULL (the unique index is partial).
  const { rowCount } = await db.query(`
    INSERT INTO ${TABLE}
      (organization_id, donation_id, amount, status, refunded_at, refund_ref)
    SELECT d.organization_id,
           d.id,
           d.amount,
           'posted',
           COALESCE(d.refunded_at, NOW()),
           d.refund_ref
      FROM ochr_donations d
     WHERE d.payment_status = 'refunded'
       AND NOT EXISTS (
         SELECT 1 FROM ${TABLE} r
          WHERE r.donation_id = d.id
            AND r.organization_id = d.organization_id
       )
  `)
  return rowCount
}

export async function up() {
  console.log('Migration 104: donation-refund-facts — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id              BIGSERIAL PRIMARY KEY,
      organization_id INTEGER       NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      donation_id     INTEGER       NOT NULL,
      amount          NUMERIC(12,2) NOT NULL,
      status          TEXT          NOT NULL DEFAULT 'posted',
      refunded_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      refund_ref      TEXT,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT ochr_donation_refunds_amount_check CHECK (amount > 0),
      CONSTRAINT ochr_donation_refunds_status_check CHECK (status IN ('pending', 'posted')),
      CONSTRAINT ochr_donation_refunds_donation_fk
        FOREIGN KEY (donation_id, organization_id)
        REFERENCES ochr_donations(id, organization_id) ON DELETE CASCADE
    )
  `)
  await pool.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_refunds_org_ref
      ON ${TABLE} (organization_id, refund_ref)
      WHERE refund_ref IS NOT NULL
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_donation_refunds_donation
      ON ${TABLE} (organization_id, donation_id, status)
  `)

  // Hard cap: reserved (posted + pending) refunds cannot exceed the gift.
  // The write path 409s first; this is the database saying the same thing
  // if a future route forgets the lock.
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_donation_refunds_cap()
    RETURNS trigger AS $$
    DECLARE
      gift_amount NUMERIC(12,2);
      reserved    NUMERIC(12,2);
    BEGIN
      SELECT d.amount INTO gift_amount
        FROM ochr_donations d
       WHERE d.id = NEW.donation_id
         AND d.organization_id = NEW.organization_id
         FOR UPDATE;
      IF gift_amount IS NULL THEN
        RAISE EXCEPTION 'refund gift %/% not found', NEW.donation_id, NEW.organization_id
          USING ERRCODE = '23503';
      END IF;
      SELECT COALESCE(SUM(r.amount), 0) INTO reserved
        FROM ochr_donation_refunds r
       WHERE r.donation_id = NEW.donation_id
         AND r.organization_id = NEW.organization_id
         AND r.status IN ('pending', 'posted')
         AND r.id IS DISTINCT FROM NEW.id;
      IF reserved + NEW.amount > gift_amount THEN
        RAISE EXCEPTION 'refunds exceed gift amount'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)
  await pool.query(`
    DROP TRIGGER IF EXISTS ochr_donation_refunds_cap ON ${TABLE}
  `)
  await pool.query(`
    CREATE TRIGGER ochr_donation_refunds_cap
      BEFORE INSERT OR UPDATE OF amount, status, donation_id, organization_id
      ON ${TABLE}
      FOR EACH ROW EXECUTE FUNCTION ochr_donation_refunds_cap()
  `)

  const filled = await backfillStampedRefunds(pool)

  const { rows: orphanStamps } = await pool.query(`
    SELECT count(*)::int AS n
      FROM ochr_donations d
     WHERE d.payment_status = 'refunded'
       AND NOT EXISTS (
         SELECT 1 FROM ${TABLE} r
          WHERE r.donation_id = d.id
            AND r.organization_id = d.organization_id
       )
  `)
  if (orphanStamps[0].n > 0) {
    throw new Error(
      `104: ${orphanStamps[0].n} stamped refunded gift(s) have no refund row after backfill`
    )
  }

  // Live dual-read: prefer posted refund rows; stamp fallback only while a
  // stamped gift still has none (the migrate window). After backfill that
  // window is empty for existing rows.
  await pool.query(`
    CREATE OR REPLACE VIEW ochr_donation_live AS
    SELECT
      d.id, d.organization_id, d.donor_name, d.donor_email, d.donor_address,
      d.amount, d.category, d.method, d.date, d.notes, d.source, d.fund_id,
      d.payment_ref, d.payment_status, d.refunded_at, d.refund_ref, d.created_at,
      COALESCE(p.refunded_total, 0)::NUMERIC(12,2) AS refunded_total,
      (d.amount - COALESCE(
         p.refunded_total,
         CASE WHEN d.payment_status = 'refunded' THEN d.amount ELSE 0 END
       ))::NUMERIC(12,2) AS live_amount
    FROM ochr_donations d
    LEFT JOIN (
      SELECT donation_id, organization_id, SUM(amount) AS refunded_total
        FROM ${TABLE}
       WHERE status = 'posted'
       GROUP BY donation_id, organization_id
    ) p ON p.donation_id = d.id AND p.organization_id = d.organization_id
  `)

  // Parish ledger: every gift stays at gift.amount. Posted refunds are
  // their own negative facts, dated with the gift so live period totals
  // equal Σ(live_amount) of gifts in that period. Stamp fallback emits a
  // synthetic full reversal only when a stamped gift still has no posted
  // row. Period adjustments are NOT in this view.
  await pool.query(`
    CREATE OR REPLACE VIEW ochr_parish_ledger AS
    SELECT
      le.organization_id, le.entry_date, le.account_code, le.amount,
      le.source_type, le.id AS source_id, le.memo
    FROM ochr_ledger_entries le

    UNION ALL

    SELECT
      d.organization_id,
      d.date::date AS entry_date,
      COALESCE(fm.account_code, cm.account_code, '4420') AS account_code,
      d.amount AS amount,
      'donation' AS source_type,
      d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d
    LEFT JOIN ochr_coa_mappings fm
           ON fm.organization_id = d.organization_id
          AND fm.source_type = 'fund'
          AND d.fund_id IS NOT NULL
          AND fm.source_key = d.fund_id::text
    LEFT JOIN ochr_coa_mappings cm
           ON cm.organization_id = d.organization_id
          AND cm.source_type = 'donation_category'
          AND cm.source_key = COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized')

    UNION ALL

    SELECT
      r.organization_id,
      d.date::date AS entry_date,
      COALESCE(fm.account_code, cm.account_code, '4420') AS account_code,
      (-r.amount)::NUMERIC(12,2) AS amount,
      'donation_refund' AS source_type,
      r.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donation_refunds r
    JOIN ochr_donations d
      ON d.id = r.donation_id AND d.organization_id = r.organization_id
    LEFT JOIN ochr_coa_mappings fm
           ON fm.organization_id = d.organization_id
          AND fm.source_type = 'fund'
          AND d.fund_id IS NOT NULL
          AND fm.source_key = d.fund_id::text
    LEFT JOIN ochr_coa_mappings cm
           ON cm.organization_id = d.organization_id
          AND cm.source_type = 'donation_category'
          AND cm.source_key = COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized')
    WHERE r.status = 'posted'

    UNION ALL

    SELECT
      d.organization_id,
      d.date::date AS entry_date,
      COALESCE(fm.account_code, cm.account_code, '4420') AS account_code,
      (-d.amount)::NUMERIC(12,2) AS amount,
      'donation_refund' AS source_type,
      d.id AS source_id,
      COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized') AS memo
    FROM ochr_donations d
    LEFT JOIN ochr_coa_mappings fm
           ON fm.organization_id = d.organization_id
          AND fm.source_type = 'fund'
          AND d.fund_id IS NOT NULL
          AND fm.source_key = d.fund_id::text
    LEFT JOIN ochr_coa_mappings cm
           ON cm.organization_id = d.organization_id
          AND cm.source_type = 'donation_category'
          AND cm.source_key = COALESCE(NULLIF(TRIM(d.category), ''), 'Uncategorized')
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
      COALESCE(m.account_code, '5120') AS account_code,
      (sh.hours * s.pay_rate)::NUMERIC(12,2) AS amount,
      'payroll' AS source_type,
      sh.id AS source_id,
      s.name AS memo
    FROM ochr_payroll_shifts sh
    JOIN ochr_payroll_staff s ON s.id = sh.staff_id
    LEFT JOIN ochr_coa_mappings m
           ON m.organization_id = s.organization_id
          AND m.source_type = 'payroll'
          AND m.source_key = 'wages'
  `)

  const { rows: tableOk } = await pool.query(`SELECT to_regclass($1) AS t`, [TABLE])
  if (!tableOk[0]?.t) throw new Error(`104: ${TABLE} was not created`)

  const { rows: fk } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'ochr_donation_refunds_donation_fk'`)
  if (!fk.length || !fk[0].def.includes('organization_id')) {
    throw new Error('104: donation FK is not tenant-composite — a refund could cross a tenant boundary')
  }

  const { rows: uniq } = await pool.query(
    `SELECT pg_get_indexdef(i.oid) AS def
       FROM pg_class i
      WHERE i.relname = 'uq_donation_refunds_org_ref'`)
  if (!uniq.length || !/refund_ref/.test(uniq[0].def) || !/organization_id/.test(uniq[0].def)) {
    throw new Error('104: org-scoped unique on refund_ref is missing')
  }

  const { rows: ledger } = await pool.query(
    `SELECT pg_get_viewdef('ochr_parish_ledger', true) AS def`)
  const def = ledger[0]?.def || ''
  if (/payment_status IS DISTINCT FROM 'refunded'/.test(def)) {
    throw new Error("104: parish ledger still omits stamped refunds — Option A keeps the gift")
  }
  if (!/donation_refund/.test(def) || !/ochr_donation_refunds/.test(def)) {
    throw new Error('104: parish ledger is missing the posted-refund fact branch')
  }
  if (/ochr_period_adjustments/.test(def)) {
    throw new Error('104: period adjustments must not enter the live ledger')
  }

  const { rows: live } = await pool.query(
    `SELECT pg_get_viewdef('ochr_donation_live', true) AS def`)
  if (!/live_amount/.test(live[0]?.def || '')) {
    throw new Error('104: ochr_donation_live does not expose live_amount')
  }

  console.log(`Migration 104: donation-refund-facts — applied (backfilled ${filled} stamped gift(s)).`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
