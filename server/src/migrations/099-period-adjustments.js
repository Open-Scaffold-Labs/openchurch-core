// A refund that lands inside an APPROVED reporting period is recorded as an
// open adjustment against that period — never by rewriting it.
//
// THE CONTRADICTION. Every donation aggregate in this codebase excludes
// refunded gifts (scripts/money-invariants.mjs proves it, 17 of them). A
// submission's totals_json does not: it is a frozen snapshot taken at submit
// time, and computeBases() sums that JSON for status='approved'. So a gift
// given in March, approved in April and refunded in May leaves the parish's
// live giving truth at $0 and the diocese's frozen roll-up — and the bill
// derived from it — still counting the money. Nothing in the system said so.
//
// WHAT THIS TABLE IS, AND IS NOT. It is a record that a frozen result has a
// post-approval financial adjustment REQUIRING RESOLUTION. It is not a
// restatement, not a credit note, not a reopening, and it does not touch
// totals_json, the assessment, or the bill. Those are settlement decisions —
// six candidate models are written up in the open findings register and the
// choice belongs to the founder and the chancery, not to a refund handler.
// Recording the fact commits to none of them: every one of the six needs to
// know that this period has an unresolved adjustment of this size, and none
// of them can be chosen if nobody wrote it down.
//
// WHY NOT SOMEWHERE THAT ALREADY EXISTS.
//   ochr_audit_log — pruned per plan (services/retention.js). An adjustment
//     that is still unresolved when its audit row is deleted would simply
//     vanish, which is the failure this exists to prevent.
//   ochr_report_review_notes — durable, but free text: no amount, no
//     resolved state, and "which approved periods have unresolved
//     adjustments?" would be a LIKE over prose. A number that changes a bill
//     must not be stored as a sentence.
//   A column on ochr_report_submissions — one refund per period only, and a
//     second refund would overwrite the first.
//
// IDEMPOTENCE. UNIQUE (submission_id, donation_id, kind): the refund route
// writes this in the same transaction as the refund UPDATE, and that UPDATE
// is already guarded so only one caller wins. The constraint means a replayed
// or concurrent write cannot produce two adjustments for one refund.
//
// TENANCY. organization_id is the parish, diocese_org_id the chancery, and
// BOTH are ratcheted by composite foreign keys — the pattern migration 071
// established. An adjustment cannot be attached to another parish's gift or
// period, nor filed under another chancery.

import pool from '../db.js'

const TABLE = 'ochr_period_adjustments'

export async function up() {
  // The parish-side ratchet needs a target. ochr_donations already carries
  // UNIQUE (id, organization_id) (migration 071's pattern); submissions carry
  // only (id, diocese_org_id), so add the parish twin. id is already unique,
  // so this cannot fail on existing data — it is a second index over the same
  // rows, not a new constraint on their content.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ochr_report_submissions_id_org_uniq'
      ) THEN
        ALTER TABLE ochr_report_submissions
          ADD CONSTRAINT ochr_report_submissions_id_org_uniq UNIQUE (id, organization_id);
      END IF;
    END $$;
  `)

  // The parish composite is the ratchet: an adjustment cannot be attached to
  // another parish's gift or another parish's period. tenant-fk-audit.mjs
  // failed the first draft of this migration for missing it, which is the
  // gate doing its job.
  //
  // diocese_org_id carries no second FK to the submission. A first draft had
  // one — (submission_id, diocese_org_id) — and it was redundant with the
  // parish composite above (same parent, same row) while reading to the audit
  // as an unprotected reference. The column is never supplied by a caller: the
  // only write path SELECTs it out of the submission row it is attaching to,
  // so it cannot disagree with that row's diocese.
  //
  // donation_id is NOT NULL with no ON DELETE action: a charged gift cannot
  // be hard-deleted anyway (donations.js refuses one with a payment_ref), so
  // NO ACTION adds no new blocker, and it keeps the adjustment tied to the
  // gift that caused it rather than letting it drift into an orphan.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id              BIGSERIAL PRIMARY KEY,
      organization_id INTEGER      NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      diocese_org_id  INTEGER      NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      submission_id   BIGINT       NOT NULL,
      donation_id     BIGINT       NOT NULL,
      kind            TEXT         NOT NULL DEFAULT 'refund',
      amount          NUMERIC(12,2) NOT NULL,
      occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
      resolved_at     TIMESTAMPTZ,
      resolution_note TEXT,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT ochr_period_adjustments_kind_check CHECK (kind IN ('refund')),
      CONSTRAINT ochr_period_adjustments_amount_check CHECK (amount > 0),
      CONSTRAINT ochr_period_adjustments_donation_fk
        FOREIGN KEY (donation_id, organization_id)
        REFERENCES ochr_donations(id, organization_id) ON DELETE CASCADE,
      CONSTRAINT ochr_period_adjustments_submission_fk
        FOREIGN KEY (submission_id, organization_id)
        REFERENCES ochr_report_submissions(id, organization_id) ON DELETE CASCADE
    )
  `)

  // Every ochr_* table carries RLS, enable-only and no policies — the app
  // connects as the table owner, so this changes no behaviour today and
  // leaves nothing for a later audit to find missing. A table holding
  // organization_id and diocese_org_id must not be the one exception.
  await pool.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`)

  // One adjustment per (period, gift, kind).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_period_adjustment_once
      ON ${TABLE} (submission_id, donation_id, kind)
  `)
  // "Which approved periods still have something unresolved?" — the question
  // the chancery and the parish both ask, answered by an index rather than a
  // scan over prose.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_period_adjustments_open
      ON ${TABLE} (diocese_org_id, organization_id, submission_id)
      WHERE resolved_at IS NULL
  `)

  const { rows } = await pool.query(
    `SELECT to_regclass($1) AS t`, [TABLE])
  if (!rows[0]?.t) throw new Error(`099: ${TABLE} was not created`)

  for (const [name, col] of [
    ['ochr_period_adjustments_donation_fk', 'organization_id'],
    ['ochr_period_adjustments_submission_fk', 'organization_id'],
  ]) {
    const { rows: fk } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name])
    if (!fk.length || !fk[0].def.includes(col)) {
      throw new Error(`099: ${name} is not tenant-composite on ${col} — an adjustment could cross a tenant boundary`)
    }
  }

  console.log('Migration 099: period-adjustments — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
