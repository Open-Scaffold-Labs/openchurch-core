// 105 — GIV-07: a period adjustment is one sidecar row per refund fact.
//
// THE DEFECT. UNIQUE (submission_id, donation_id, kind) plus INSERT
// ON CONFLICT DO NOTHING dropped a second distinct partial refund from
// ochr_period_adjustments while ochr_donation_refunds kept both.
// totals_json correctly stayed frozen. The freeze sidecar must name the
// refund fact, not the gift+kind pair.
//
// WHAT THIS DOES
//   1. UNIQUE (id, organization_id) on ochr_donation_refunds so it can
//      be a composite-FK parent (071 pattern).
//   2. donation_refund_id BIGINT, nullable. Backfill where the refund
//      fact is unambiguous. Leave NULL when it is not — UNKNOWN, not a
//      guessed chronology. The column is BIGINT, not UUID:
//      ochr_donation_refunds.id is BIGSERIAL (GIV-06). A UUID here
//      would invent a second identity for the same fact.
//   3. Tenant-composite FK (donation_refund_id, organization_id) →
//      ochr_donation_refunds. MATCH SIMPLE: a NULL refund id is not
//      enforced, which is how UNKNOWN rows stay.
//   4. Drop uq_period_adjustment_once. UNIQUE (submission_id,
//      donation_refund_id) so the SAME refund is idempotent and
//      DISTINCT refunds both persist. PostgreSQL UNIQUE treats NULLs
//      as distinct, so multiple UNKNOWN rows may coexist.
//
// Does not reopen a frozen period. Does not touch totals_json. Does
// not fold adjustments into live net. RLS stays on the existing table.

import pool from '../db.js'

const TABLE = 'ochr_period_adjustments'

// Map an existing sidecar row to a refund fact only when the join is
// unambiguous: exactly one refund for the gift, or exactly one refund
// whose amount equals this adjustment. Two refunds of the same amount
// stay UNKNOWN — we do not pick the earlier one by timestamp.
export async function backfillAdjustmentRefundIds(db = pool) {
  const { rowCount } = await db.query(`
    UPDATE ${TABLE} a
       SET donation_refund_id = mapped.refund_id
      FROM (
        SELECT a2.id AS adjustment_id, r.id AS refund_id
          FROM ${TABLE} a2
          JOIN ochr_donation_refunds r
            ON r.donation_id = a2.donation_id
           AND r.organization_id = a2.organization_id
         WHERE a2.donation_refund_id IS NULL
           AND (
             (SELECT count(*) FROM ochr_donation_refunds r2
               WHERE r2.donation_id = a2.donation_id
                 AND r2.organization_id = a2.organization_id) = 1
             OR (
               r.amount = a2.amount
               AND (SELECT count(*) FROM ochr_donation_refunds r3
                     WHERE r3.donation_id = a2.donation_id
                       AND r3.organization_id = a2.organization_id
                       AND r3.amount = a2.amount) = 1
             )
           )
      ) mapped
     WHERE a.id = mapped.adjustment_id
       AND a.donation_refund_id IS NULL
  `)
  return rowCount
}

export async function up() {
  console.log('Migration 105: period-adjustment-per-refund — applying...')

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ochr_donation_refunds_id_org_uniq'
      ) THEN
        ALTER TABLE ochr_donation_refunds
          ADD CONSTRAINT ochr_donation_refunds_id_org_uniq
          UNIQUE (id, organization_id);
      END IF;
    END $$;
  `)

  await pool.query(`
    ALTER TABLE ${TABLE}
      ADD COLUMN IF NOT EXISTS donation_refund_id BIGINT
  `)

  const filled = await backfillAdjustmentRefundIds(pool)

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ochr_period_adjustments_refund_fk'
      ) THEN
        ALTER TABLE ${TABLE}
          ADD CONSTRAINT ochr_period_adjustments_refund_fk
          FOREIGN KEY (donation_refund_id, organization_id)
          REFERENCES ochr_donation_refunds(id, organization_id)
          ON DELETE NO ACTION;
      END IF;
    END $$;
  `)

  await pool.query(`DROP INDEX IF EXISTS uq_period_adjustment_once`)

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_period_adjustment_per_refund'
      ) THEN
        ALTER TABLE ${TABLE}
          ADD CONSTRAINT uq_period_adjustment_per_refund
          UNIQUE (submission_id, donation_refund_id);
      END IF;
    END $$;
  `)

  const { rows: col } = await pool.query(`
    SELECT data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = 'donation_refund_id'
  `, [TABLE])
  if (!col.length) throw new Error('105: donation_refund_id is missing')
  if (col[0].data_type !== 'bigint') {
    throw new Error('105: donation_refund_id must be BIGINT to match ochr_donation_refunds.id')
  }
  if (col[0].is_nullable !== 'YES') {
    throw new Error('105: donation_refund_id must stay nullable so unmapped rows remain UNKNOWN')
  }

  const { rows: old } = await pool.query(
    `SELECT 1 FROM pg_class WHERE relname = 'uq_period_adjustment_once'`)
  if (old.length) throw new Error('105: uq_period_adjustment_once is still present')

  const { rows: uniq } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'uq_period_adjustment_per_refund'`)
  if (!uniq.length || !/donation_refund_id/.test(uniq[0].def) || !/submission_id/.test(uniq[0].def)) {
    throw new Error('105: unique on (submission_id, donation_refund_id) is missing')
  }

  const { rows: fk } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'ochr_period_adjustments_refund_fk'`)
  if (!fk.length || !fk[0].def.includes('organization_id')) {
    throw new Error('105: refund FK is not tenant-composite — an adjustment could cross a tenant boundary')
  }

  const { rows: parent } = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'ochr_donation_refunds_id_org_uniq'`)
  if (!parent.length) {
    throw new Error('105: ochr_donation_refunds is missing UNIQUE (id, organization_id)')
  }

  const { rows: rls } = await pool.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = $1`, [TABLE])
  if (!rls[0]?.relrowsecurity) {
    throw new Error('105: ochr_period_adjustments lost RLS')
  }

  console.log(`Migration 105: period-adjustment-per-refund — applied (backfilled ${filled} unambiguous row(s)).`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
