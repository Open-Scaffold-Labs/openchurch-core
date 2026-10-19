// A receipt describes measured scopes, never a promise that every copy is gone.
export default function ClosureReceipt({ receipt, t }) {
  if (!receipt) return null
  const kinds = new Set(['audit_subject_text', 'feedback_text', 'audit_ip', 'amendment_snapshot', 'vault_snapshot', 'timeline_actor', 'giving_statement_issuer', 'unmapped_text', 'provider', 'backup'])
  const states = new Set(['retained_for_review', 'none_found', 'speculative', 'unknown', 'not_configured', 'cleared', 'not_measured'])
  return (
    <section role="status" className="text-sm text-ink-700 dark:text-parchment-200 bg-parchment-100/80 dark:bg-ink-800/50 border border-parchment-300/60 rounded-lg px-3 py-3 space-y-2">
      {receipt.access_revoked === true && <p>{t('team.closureAccess')}</p>}
      {receipt.live_profile_processed === true && <p>{t('team.closureProfile')}</p>}
      <p>{t('team.closureRemaining')}</p>
      {Array.isArray(receipt.reviews) ? (
        <ul className="space-y-2">
          {receipt.reviews.map((row, index) => {
            const kind = kinds.has(row?.kind) ? row.kind : 'other'
            const measured = !['unmapped_text', 'provider', 'backup', 'other'].includes(kind) &&
              Number.isSafeInteger(row?.row_count) && row.row_count >= 0
            return <li key={index}>
              <p className="font-semibold">{t('team.receipt.kind.' + kind)}</p>
              <p>{measured ? t('team.receipt.count', { n: row.row_count }) : t('team.receipt.unknownCount')}</p>
              <p>{t('team.receipt.state.' + (states.has(row?.disposition) ? row.disposition : 'unknown'))}</p>
              <p>{t('team.receipt.note.' + kind)}</p>
            </li>
          })}
        </ul>
      ) : <p>{t('team.receipt.notLoaded')}</p>}
    </section>
  )
}

