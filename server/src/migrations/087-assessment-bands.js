// 087 — tiered assessment rates, and a base year that can lag.
//
// Two things a real Episcopal diocese needs that the model could not
// express. Both came out of reading actual published diocesan formulas
// rather than reasoning about what a formula probably looks like.
//
// TIERED RATES. `rate_bps` is one number. The Diocese of Maine charges
// 5% on the first $10,000 of Qualifying Normal Operating Income and 15%
// above it. That cannot be written down here at all, so a diocese with a
// graduated formula either cannot use OpenChurch or has to enter a rate
// that is wrong for every parish.
//
// `bands` is a marginal ladder, the way income tax brackets work:
//
//   [{ upto: 10000, rate_bps: 500 }, { upto: null, rate_bps: 1500 }]
//
// The same mechanism expresses an EXEMPTION, which is why it is worth
// having one mechanism rather than two: the churchwide assessment exempts
// the first $200,000 of diocesan income and charges 15% above it, which
// is a first band at zero.
//
//   [{ upto: 200000, rate_bps: 0 }, { upto: null, rate_bps: 1500 }]
//
// The top band's `upto` must be null. A ladder that stops leaves income
// above the last rung silently unassessed — a bill quietly too small,
// which nobody notices until an auditor does.
//
// BASE YEAR. Maine assesses on the parochial report "submitted two years
// prior to the assessment year". We assessed on submissions closing
// within the assessment year itself. Those are different years, and the
// difference is the whole bill.
//
// `base_year` is stored, not derived from an offset, so a diocese that
// changes its rule next year does not silently rewrite what last year's
// assessment was calculated from. Backfilled to fiscal_year, which is
// exactly what every existing row already meant.
//
// BREAKDOWN. Each line keeps the slice-by-slice working. A parish that
// adds the bands up by hand must arrive at the number on the invoice, and
// a diocese explaining an assessment over the phone should not have to
// reconstruct it. Slices are rounded to cents individually and summed, so
// what is shown adds up to what is owed — rounding the total separately
// would produce a bill that is a penny off from its own explanation.

import pool from '../db.js'

export async function up() {
  console.log('Migration 087: assessment bands + base year — applying...')

  await pool.query(`
    ALTER TABLE ochr_assessments
      ADD COLUMN IF NOT EXISTS bands     JSONB,
      ADD COLUMN IF NOT EXISTS base_year TEXT
  `)

  // Every existing assessment meant "the base is this same year".
  await pool.query(`
    UPDATE ochr_assessments SET base_year = fiscal_year WHERE base_year IS NULL
  `)

  await pool.query(`
    ALTER TABLE ochr_assessment_lines
      ADD COLUMN IF NOT EXISTS breakdown JSONB
  `)

  console.log('Migration 087: assessment bands + base year — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
