// Review candidates are measured copies, not a claim that free text is anonymous.
// Only reliable subject/actor links are selected; text about somebody in an
// unrelated row cannot be attributed automatically and remains unmeasured.
export async function closureReviewReport(client, organizationId, userId) {
  const id = String(userId)
  const { rows: audit } = await client.query(
    `SELECT id, COUNT(*) OVER () AS total FROM ochr_audit_log
      WHERE organization_id = $1 AND entity_type = 'user'
        AND entity_id ~ '^[0-9]+$' AND ltrim(entity_id, '0') = $2
        AND (
          COALESCE(summary, '') NOT IN (
            '', 'Created user', 'Updated user', 'Deleted user',
            'Created user #' || $2, 'Updated user #' || $2, 'Deleted user #' || $2,
            'Closed login #' || $2, 'Closed own login #' || $2,
            'Closed login #' || $2 || ' (already closed)',
            'Closed own login #' || $2 || ' (already closed)',
            'Turned login off #' || $2, 'Turned own login off #' || $2,
            'Turned login off #' || $2 || ' (already off)',
            'Turned own login off #' || $2 || ' (already off)',
            'Turned login back on #' || $2,
            'Turned login back on #' || $2 || ' (already on)'
          )
          OR COALESCE(metadata - ARRAY['role', 'pastoral_lead', 'via', 'already'], '{}'::jsonb) <> '{}'::jsonb
        )
      ORDER BY id LIMIT 50`,
    [organizationId, id]
  )
  const { rows: feedback } = await client.query(
    `SELECT id, COUNT(*) OVER () AS total FROM ochr_feedback_ledger
      WHERE organization_id = $1 AND user_id = $2
        AND (NULLIF(BTRIM(message), '') IS NOT NULL OR NULLIF(BTRIM(route), '') IS NOT NULL)
      ORDER BY id LIMIT 50`,
    [organizationId, userId]
  )
  const { rows: stored } = await client.query(
    `SELECT kind, row_count, disposition, note FROM ochr_login_closure_reviews
      WHERE organization_id = $1 AND user_id = $2 ORDER BY id`,
    [organizationId, userId]
  )
  const auditCount = Number(audit[0]?.total ?? 0)
  const feedbackCount = Number(feedback[0]?.total ?? 0)
  const measured = [
    { kind: 'audit_subject_text', row_count: auditCount,
      disposition: auditCount ? 'retained_for_review' : 'none_found',
      note: 'Linked audit summaries and retained details outside known neutral templates are review candidates; they were not erased.' },
    { kind: 'feedback_text', row_count: feedbackCount,
      disposition: feedbackCount ? 'retained_for_review' : 'none_found',
      note: 'Linked feedback messages and routes were kept for review, not automatically rewritten.' },
    { kind: 'unmapped_text', row_count: null, disposition: 'not_measured',
      note: 'Text without a reliable link to this login has not been attributed or counted. No zero-residue claim is made.' },
  ]
  return {
    reviews: [...stored.filter(r => !measured.some(m => m.kind === r.kind)), ...measured],
    review_refs: [
      ...audit.slice(0, 50).map(r => ({ source: 'audit', id: r.id })),
      ...feedback.slice(0, 50).map(r => ({ source: 'feedback', id: r.id })),
    ],
    review_refs_capped: auditCount > 50 || feedbackCount > 50,
    // Unmapped/provider/backup scope is unresolved even if measured counts are zero.
    review_remaining: true,
  }
}
