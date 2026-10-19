// 107 — GIV-08-004: stamp each refund's assessable impact at freeze.
//
// ochr_period_adjustments.amount stays the raw refund. Frozen
// assessable_base only includes revenue marked assessable=true. M4
// subtracted every APPLIED credit amount from that base, so a refund
// of a restricted gift shrank the diocesan payable. The historical
// source is totals_json.gift_assessable (written at freeze). This
// column copies that fact onto the sidecar and the credit so later
// COA / mapping edits cannot rewrite the bill.
//
// assessable_impact may be 0. It cannot exceed amount. DEFAULT 0 so
// GIV-07 direct inserts and a SETTLED-requires-APPLIED credit of a
// non-assessable refund still write. The bill subtracts this column,
// not amount.

import pool from '../db.js'

const ADJ = 'ochr_period_adjustments'
const CRED = 'ochr_period_adjustment_credits'

async function addImpact(table, checkName) {
  await pool.query(`
    ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS assessable_impact NUMERIC(12,2) NOT NULL DEFAULT 0
  `)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = '${checkName}'
      ) THEN
        ALTER TABLE ${table}
          ADD CONSTRAINT ${checkName}
          CHECK (assessable_impact >= 0 AND assessable_impact <= amount);
      END IF;
    END $$;
  `)

  const { rows: col } = await pool.query(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = 'assessable_impact'`,
    [table]
  )
  if (!col.length) throw new Error(`107: ${table}.assessable_impact is missing`)
  if (col[0].data_type !== 'numeric') {
    throw new Error(`107: ${table}.assessable_impact must be NUMERIC`)
  }
  if (col[0].is_nullable !== 'NO') {
    throw new Error(`107: ${table}.assessable_impact must be NOT NULL`)
  }

  const { rows: chk } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
    [checkName]
  )
  if (!chk.length || !/assessable_impact/.test(chk[0].def) || !/amount/.test(chk[0].def)) {
    throw new Error(`107: ${checkName} is missing or does not bound assessable_impact by amount`)
  }
}

export async function up() {
  console.log('Migration 107: period-adjustment-assessable-impact — applying...')
  await addImpact(ADJ, 'ochr_period_adjustments_assessable_impact_check')
  await addImpact(CRED, 'ochr_period_adjustment_credits_assessable_impact_check')
  console.log('Migration 107: period-adjustment-assessable-impact — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
