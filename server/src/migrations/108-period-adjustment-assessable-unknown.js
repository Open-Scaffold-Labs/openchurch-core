// 108 — GIV-08-005: UNKNOWN freeze-time assessability is not zero.
//
// Migration 107 stamped assessable_impact NOT NULL DEFAULT 0. The
// refund writer then COALESCE'd a missing totals_json.gift_assessable
// entry to false. Pre-107 frozen submissions — and GIV-07 sidecar
// inserts that never saw the map — turned UNKNOWN historical
// assessability into a 0 impact. APPLIED then left the payable alone
// for an assessable refund. UNKNOWN ≠ NON-ASSESSABLE.
//
// Frozen evidence is account rollups, not per-gift facts. Live COA
// and mappings can flip after freeze, so this migration does not
// invent a gift's assessability from them. When the freeze map has
// an explicit boolean for that gift, OPEN sidecars are copied from
// that map. When it does not, assessable_impact becomes NULL and
// settle must refuse before a credit can change the payable.
//
// Credits stay NOT NULL. An APPLIED row is a known figure. 107 is
// not rewritten.

import pool from '../db.js'

const ADJ = 'ochr_period_adjustments'
const CRED = 'ochr_period_adjustment_credits'

export async function backfillUnknownAssessableImpact(db = pool) {
  const { rowCount } = await db.query(`
    UPDATE ${ADJ} a
       SET assessable_impact = CASE
             WHEN jsonb_typeof(
                    s.totals_json->'gift_assessable'
                    ->(a.donation_id::text)
                    ->'assessable'
                  ) = 'boolean'
             THEN CASE
               WHEN (s.totals_json->'gift_assessable'
                     ->(a.donation_id::text)
                     ->>'assessable')::boolean
               THEN a.amount
               ELSE 0::NUMERIC(12,2)
             END
             ELSE NULL
           END
      FROM ochr_report_submissions s
     WHERE a.submission_id = s.id
       AND a.organization_id = s.organization_id
       AND a.resolved_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM ${CRED} c
          WHERE c.adjustment_id = a.id
            AND c.organization_id = a.organization_id
       )
  `)
  return rowCount
}

export async function up() {
  console.log('Migration 108: period-adjustment-assessable-unknown — applying...')

  await pool.query(`
    ALTER TABLE ${ADJ}
      ALTER COLUMN assessable_impact DROP NOT NULL,
      ALTER COLUMN assessable_impact DROP DEFAULT
  `)

  await backfillUnknownAssessableImpact(pool)

  const { rows: col } = await pool.query(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = 'assessable_impact'`,
    [ADJ]
  )
  if (!col.length) throw new Error(`108: ${ADJ}.assessable_impact is missing`)
  if (col[0].data_type !== 'numeric') {
    throw new Error(`108: ${ADJ}.assessable_impact must stay NUMERIC`)
  }
  if (col[0].is_nullable !== 'YES') {
    throw new Error(`108: ${ADJ}.assessable_impact must be nullable — UNKNOWN is not 0`)
  }
  if (col[0].column_default != null) {
    throw new Error(`108: ${ADJ}.assessable_impact must have no DEFAULT — omit means UNKNOWN`)
  }

  const { rows: cred } = await pool.query(
    `SELECT is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = 'assessable_impact'`,
    [CRED]
  )
  if (!cred.length) throw new Error(`108: ${CRED}.assessable_impact is missing`)
  if (cred[0].is_nullable !== 'NO') {
    throw new Error(`108: ${CRED}.assessable_impact must stay NOT NULL — APPLIED is a known figure`)
  }

  const { rows: chk } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'ochr_period_adjustments_assessable_impact_check'`
  )
  if (!chk.length || !/assessable_impact/.test(chk[0].def) || !/amount/.test(chk[0].def)) {
    throw new Error('108: adjustments assessable_impact check is missing')
  }

  console.log('Migration 108: period-adjustment-assessable-unknown — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
