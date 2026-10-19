// GIV-08 M4 settle writer.
//
// SETTLED (resolved_at on the OPEN sidecar) is the chancery decision.
// APPLIED (a row in ochr_period_adjustment_credits) is the durable
// economic effect. This writer creates both in one transaction the
// caller already holds, and is idempotent: a second call returns the
// existing credit and does not invent another.
//
// Amount is copied from the adjustment. assessable_impact is the
// freeze-time stamp (107) — also copied, never recomputed from COA.
// NULL impact is UNKNOWN (108). UNKNOWN is not 0: this writer refuses
// before inserting a credit or stamping SETTLED, so APPLIED cannot
// change the payable until the freeze-time fact is known. The caller
// cannot pick either figure. Gift rows, refund facts, and totals_json
// are not touched. A stamp-only UPDATE of resolved_at is refused by
// migration 106's deferred trigger — this module never does that.

const NOTE_MAX = 2000

export function settleNote(raw, fallback = null) {
  if (raw == null) return fallback
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().slice(0, NOTE_MAX)
  return v || null
}

export async function settlePeriodAdjustment(db, {
  dioceseOrgId,
  adjustmentId,
  appliedBy = null,
  note,
}) {
  const { rows: found } = await db.query(
    `SELECT a.id, a.organization_id, a.diocese_org_id, a.submission_id,
            a.donation_id, a.donation_refund_id, a.kind, a.amount,
            a.assessable_impact, a.resolved_at, a.resolution_note,
            s.status AS submission_status
       FROM ochr_period_adjustments a
       JOIN ochr_report_submissions s
         ON s.id = a.submission_id AND s.organization_id = a.organization_id
       JOIN ochr_diocese_affiliations aff
         ON aff.parish_org_id = a.organization_id
        AND aff.diocese_org_id = a.diocese_org_id
        AND aff.status IN ('active', 'suspended')
      WHERE a.id = $1 AND a.diocese_org_id = $2
      FOR UPDATE OF a`,
    [adjustmentId, dioceseOrgId]
  )
  if (!found.length) return { error: 'not_found' }
  const row = found[0]

  if (!['submitted', 'approved'].includes(row.submission_status)) {
    return { error: 'not_frozen' }
  }

  const { rows: existing } = await db.query(
    `SELECT id, organization_id, diocese_org_id, adjustment_id, submission_id,
            donation_id, donation_refund_id, amount, assessable_impact,
            applied_at, applied_by
       FROM ochr_period_adjustment_credits
      WHERE adjustment_id = $1 AND organization_id = $2`,
    [row.id, row.organization_id]
  )

  if (row.resolved_at && existing.length) {
    return {
      ok: true,
      already: true,
      adjustment: row,
      credit: existing[0],
    }
  }

  if (row.assessable_impact == null) {
    return { error: 'assessable_unknown' }
  }

  const { rows: inserted } = await db.query(
    `INSERT INTO ochr_period_adjustment_credits
       (organization_id, diocese_org_id, adjustment_id, submission_id,
        donation_id, donation_refund_id, amount, assessable_impact, applied_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (adjustment_id) DO NOTHING
     RETURNING id, organization_id, diocese_org_id, adjustment_id, submission_id,
               donation_id, donation_refund_id, amount, assessable_impact,
               applied_at, applied_by`,
    [
      row.organization_id, row.diocese_org_id, row.id, row.submission_id,
      row.donation_id, row.donation_refund_id, row.amount,
      row.assessable_impact, appliedBy,
    ]
  )

  let credit = inserted[0] ?? existing[0]
  if (!credit) {
    const { rows: raced } = await db.query(
      `SELECT id, organization_id, diocese_org_id, adjustment_id, submission_id,
              donation_id, donation_refund_id, amount, assessable_impact,
              applied_at, applied_by
         FROM ochr_period_adjustment_credits
        WHERE adjustment_id = $1 AND organization_id = $2`,
      [row.id, row.organization_id]
    )
    credit = raced[0]
  }
  if (!credit) return { error: 'apply_failed' }

  const nextNote = settleNote(note, row.resolution_note)
  if (nextNote === undefined) return { error: 'bad_note' }

  const { rows: settled } = await db.query(
    `UPDATE ochr_period_adjustments
        SET resolved_at = COALESCE(resolved_at, NOW()),
            resolution_note = COALESCE($3, resolution_note)
      WHERE id = $1 AND organization_id = $2 AND diocese_org_id = $4
      RETURNING id, organization_id, diocese_org_id, submission_id,
                donation_id, donation_refund_id, kind, amount,
                assessable_impact, resolved_at, resolution_note`,
    [row.id, row.organization_id, nextNote, dioceseOrgId]
  )
  if (!settled.length) return { error: 'not_found' }

  return {
    ok: true,
    already: Boolean(row.resolved_at && existing.length),
    adjustment: settled[0],
    credit,
  }
}

export async function settleOpenOnSubmission(db, {
  dioceseOrgId,
  submissionId,
  appliedBy = null,
  note,
}) {
  const { rows: owned } = await db.query(
    `SELECT s.id, s.status
       FROM ochr_report_submissions s
       JOIN ochr_diocese_affiliations aff
         ON aff.parish_org_id = s.organization_id
        AND aff.diocese_org_id = s.diocese_org_id
        AND aff.status IN ('active', 'suspended')
      WHERE s.id = $1 AND s.diocese_org_id = $2
      FOR UPDATE OF s`,
    [submissionId, dioceseOrgId]
  )
  if (!owned.length) return { error: 'not_found' }
  if (!['submitted', 'approved'].includes(owned[0].status)) {
    return { error: 'not_frozen' }
  }

  const { rows: open } = await db.query(
    `SELECT id, assessable_impact FROM ochr_period_adjustments
      WHERE submission_id = $1 AND diocese_org_id = $2 AND resolved_at IS NULL
      ORDER BY id
      FOR UPDATE`,
    [submissionId, dioceseOrgId]
  )

  if (open.some(row => row.assessable_impact == null)) {
    return { error: 'assessable_unknown' }
  }

  const results = []
  for (const row of open) {
    const one = await settlePeriodAdjustment(db, {
      dioceseOrgId,
      adjustmentId: row.id,
      appliedBy,
      note,
    })
    if (one.error) return one
    results.push(one)
  }

  if (!results.length) {
    const { rows: already } = await db.query(
      `SELECT a.id, a.organization_id, a.diocese_org_id, a.submission_id,
              a.donation_id, a.donation_refund_id, a.kind, a.amount,
              a.assessable_impact, a.resolved_at, a.resolution_note,
              c.id AS credit_id
         FROM ochr_period_adjustments a
         JOIN ochr_period_adjustment_credits c
           ON c.adjustment_id = a.id AND c.organization_id = a.organization_id
        WHERE a.submission_id = $1 AND a.diocese_org_id = $2
        ORDER BY a.id`,
      [submissionId, dioceseOrgId]
    )
    if (!already.length) return { error: 'nothing_open' }
    return {
      ok: true,
      already: true,
      adjustments: already,
    }
  }

  return {
    ok: true,
    already: results.every(r => r.already),
    results,
  }
}
