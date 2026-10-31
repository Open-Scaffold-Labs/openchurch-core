// R418-1 (TARS HOLD on #418 @ 7eb830ef) — fail-closed guard.
//
// Migration 130 records a deposit reversal whose original sits in an
// already-submitted/approved diocesan period as a row in
// ochr_deposit_period_adjustments. The diocesan rollup, the settle flow and
// the assessment bases read only ochr_period_adjustments (donations), so
// those rows are NOT in what the chancery sees. Until they are wired in,
// every step that would move such a period forward (resubmit, approve,
// settle) or turn it into a bill (assessment create / recompute) refuses
// with 409 deposit_adjustments_pending. Nothing is written.
//
// There is no "resolved" column on the deposit table: no flow can
// incorporate a row yet, so every row counts as unincorporated. Every
// query is scoped by the submission's own parish AND diocese, so another
// tenant's adjustment never blocks this one.

import { endsInYear } from './fiscalPeriod.js'

export const DEPOSIT_ADJUSTMENTS_PENDING = Object.freeze({
  status: 409,
  body: Object.freeze({
    code: 'deposit_adjustments_pending',
    error: "This period has deposit adjustments that aren't in the diocesan rollup yet. " +
      "It can't be submitted, approved or settled until they are. Nothing was changed.",
  }),
})

export const ASSESSMENT_DEPOSIT_ADJUSTMENTS_PENDING = Object.freeze({
  status: 409,
  body: Object.freeze({
    code: 'deposit_adjustments_pending',
    error: "An approved period in this year has deposit adjustments that aren't in the diocesan rollup yet, " +
      "so the assessment can't be built from it. Nothing was changed.",
  }),
})

// The parish's own period (same parish, same diocese, same dates).
export async function periodHasPendingDepositAdjustments(db, { organizationId, dioceseOrgId, periodStart, periodEnd }) {
  const { rows } = await db.query(
    `SELECT 1
       FROM ochr_deposit_period_adjustments a
       JOIN ochr_report_submissions s
         ON s.id = a.submission_id AND s.organization_id = a.organization_id
      WHERE s.organization_id = $1 AND s.diocese_org_id = $2
        AND s.period_start = $3::date AND s.period_end = $4::date
      LIMIT 1`,
    [organizationId, dioceseOrgId, periodStart, periodEnd])
  return rows.length > 0
}

// A submission as the chancery addresses it (id + its own diocese).
export async function submissionHasPendingDepositAdjustments(db, { submissionId, dioceseOrgId }) {
  const { rows } = await db.query(
    `SELECT 1
       FROM ochr_deposit_period_adjustments a
       JOIN ochr_report_submissions s
         ON s.id = a.submission_id AND s.organization_id = a.organization_id
      WHERE s.id = $1 AND s.diocese_org_id = $2
      LIMIT 1`,
    [submissionId, dioceseOrgId])
  return rows.length > 0
}

// The donation-keyed adjustment row's own submission (single settle).
export async function adjustmentSubmissionHasPendingDepositAdjustments(db, { adjustmentId, dioceseOrgId }) {
  const { rows } = await db.query(
    `SELECT 1
       FROM ochr_period_adjustments pa
       JOIN ochr_report_submissions s
         ON s.id = pa.submission_id AND s.organization_id = pa.organization_id
       JOIN ochr_deposit_period_adjustments a
         ON a.submission_id = s.id AND a.organization_id = s.organization_id
      WHERE pa.id = $1 AND pa.diocese_org_id = $2 AND s.diocese_org_id = $2
      LIMIT 1`,
    [adjustmentId, dioceseOrgId])
  return rows.length > 0
}

// Any APPROVED period computeBases would read for this diocese and year.
export async function assessmentYearHasPendingDepositAdjustments(db, { dioceseOrgId, year }) {
  const { rows } = await db.query(
    `SELECT 1
       FROM ochr_report_submissions s
       JOIN ochr_deposit_period_adjustments a
         ON a.submission_id = s.id AND a.organization_id = s.organization_id
      WHERE s.diocese_org_id = $1 AND s.status = 'approved'
        AND ${endsInYear('$2')}
      LIMIT 1`,
    [dioceseOrgId, year])
  return rows.length > 0
}

// ── R418-2: one lock, one order ──────────────────────────────────────────
// The check above is only meaningful if no adjustment can be inserted
// between it and the guarded write. Both sides therefore take ROW LOCKS on
// the affected ochr_report_submissions rows, FOR UPDATE, in ascending id
// order, BEFORE anything else they write:
//   · reversal approval (routes/deposits.js) locks the closed periods it is
//     about to adjust, then inserts the fact and the adjustment rows;
//   · every guarded step locks its period(s) first, then runs the check.
// Whoever locks first wins: a guarded step that comes second sees the
// committed adjustment and refuses; a reversal that comes second waits and
// re-reads the period's status on the latest row version.
//
// Bounded, never an unbounded queue: lock_timeout is set LOCAL to
// DEPOSIT_LOCK_TIMEOUT before the lock, and a wait that runs out raises
// 55P03, answered as 503 deposit_lock_busy (nothing written). No advisory
// key is added, so the #414 (FINANCE, org) / (CHART, owner) scheme is
// untouched: these row locks are taken before any finance write in the
// transaction, and the cutover sign-off takes no row locks (locks.js §3a),
// so no cycle can form between the two schemes.
export const DEPOSIT_LOCK_TIMEOUT = '2s'

export const DEPOSIT_LOCK_BUSY = Object.freeze({
  status: 503,
  body: Object.freeze({
    code: 'deposit_lock_busy',
    error: 'This period is being changed by someone else right now. Nothing was changed. Try again in a moment.',
  }),
})

export const isDepositLockBusy = err => err?.code === '55P03'

export async function setDepositLockTimeout(db) {
  await db.query("SELECT set_config('lock_timeout', $1, true)", [DEPOSIT_LOCK_TIMEOUT])
}

// `where` is a fixed SQL predicate over alias `s` written by the caller,
// never user text; values go through `params`.
export async function lockSubmissionsForDepositCheck(db, where, params) {
  await setDepositLockTimeout(db)
  const { rows } = await db.query(
    `SELECT s.id FROM ochr_report_submissions s WHERE ${where} ORDER BY s.id FOR UPDATE OF s`, params)
  return rows.map(r => r.id)
}

// EVERY period of this diocese and year, whatever its status (R418-3, TARS
// CHANGES @ 55132720). Locking only the approved rows let a concurrent
// chancery approval (which locks its own row, the same lock) flip a
// 'submitted' row to 'approved' between the check and computeBases, so the
// bill was built from a set the guard never checked. Locking the whole year
// makes approval and the assessment serialize on the same rows: an approval
// that comes first commits and is then seen (READ COMMITTED re-reads after
// the wait); one that comes second waits for the bill. Same ascending-id
// order and the same bounded lock_timeout as every other row lock here.
export function lockAssessmentYearPeriods(db, { dioceseOrgId, year }) {
  return lockSubmissionsForDepositCheck(db,
    `s.diocese_org_id = $1 AND ${endsInYear('$2')}`, [dioceseOrgId, year])
}
