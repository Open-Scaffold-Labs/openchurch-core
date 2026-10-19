// Secret columns omitted from a parish artifact.
//
// Applied to a row's own columns, and to a vault snapshot's rows by the
// table that owned them (roots use the entry's entity_table; cascaded
// rows use cascaded[].table). Values are not walked. A jsonb document
// — form answers, an import row, audit metadata — is parish content
// even when an admin-chosen key contains "secret", "hash", or "token".
//
// Three call sites, one list:
//   export  — historical snapshots already stored (no data migration)
//   capture — a new vault row does not keep a second copy of the token
//   restore — a historical snapshot cannot be inserted back onto the row
//
// Counters whose names contain "token" (input_tokens, output_tokens,
// diagnosis_tokens) are not credentials. They are listed in
// ALLOWED_SECRETISH with a reason, and they stay in the artifact.
// token_version is different: it is a session credential on ochr_users
// and it is denied.

// Table → column names. Exact match, not a substring walk.
export const SECRET_COLUMNS = {
  ochr_clients: ['calendar_token', 'swap_token'],
  ochr_checkins: ['security_code', 'security_code_hash'],
  ochr_users: ['password_hash', 'token_version'],
  ochr_organizations: ['kiosk_token', 'ai_api_key_enc'],
  ochr_password_reset_tokens: ['token_hash'],
}

// table.column → why a secret-shaped name is not a credential.
// The schema-classification test requires every matching column to be
// either in SECRET_COLUMNS or here, with a non-empty reason.
export const ALLOWED_SECRETISH = {
  'ochr_ai_audit.input_tokens': 'LLM usage count, not a credential',
  'ochr_ai_audit.output_tokens': 'LLM usage count, not a credential',
  'ochr_ai_ledger.input_tokens': 'LLM usage count, not a credential',
  'ochr_ai_ledger.output_tokens': 'LLM usage count, not a credential',
  'ochr_support_tickets.diagnosis_tokens': 'LLM usage count of the support diagnosis, not a credential',
  'ochr_import_batches.mapping': 'Import column-mapping document. The name matches "pin" only as a substring of "mapping"; it is parish configuration, not a credential',
  'ochr_ai_audit.public_session_id': 'Opaque id for an anonymous AI session. The name matches session_id; it is not a credential column',
  'ochr_ai_ledger.public_session_id': 'Opaque id for an anonymous AI session. The name matches session_id; it is not a credential column',
  'ochr_coa_mappings.source_key': 'Chart-of-accounts source identifier. The name matches key; it is not a credential',
  'ochr_giving_statements.donor_key': 'Giving-statement donor grouping key. The name matches key; it is not a credential',
  'ochr_giving_statements.donor_key_kind': 'Which donor grouping was used. The name matches key; it is not a credential',
  'ochr_giving_statements.issue_key': 'Org-scoped idempotency key for an issued giving statement. The name matches key; it is not a credential',
  'ochr_import_rows.issue_key': 'Import-row issue code. The name matches key; it is not a credential',
  'ochr_setup_marks.item_key': 'Setup checklist item id. The name matches key; it is not a credential',
}

export function isSecretColumn(table, column) {
  const cols = SECRET_COLUMNS[table]
  return Boolean(cols && cols.includes(column))
}

// Shallow copy. Callers still hold the live row (capture) or the stored
// snapshot (restore) and must not see those objects mutated. jsonb
// values are the same reference: they are not copied and not walked.
export function sanitizeRow(table, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row
  const deny = SECRET_COLUMNS[table]
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (deny?.includes(k)) continue
    out[k] = v
  }
  return out
}

// Snapshot shape: { roots: [row...], cascaded: [{ table, row }], relinks }
// Older entries use singular `root` instead of `roots`. Relinks carry no
// row payload ({ table, column, to, ids }) and are left as stored.
export function sanitizeSnapshot(rootTable, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot
  const out = { ...snapshot }
  if (Array.isArray(snapshot.roots)) {
    out.roots = snapshot.roots.map(r => sanitizeRow(rootTable, r))
  }
  if (snapshot.root && typeof snapshot.root === 'object' && !Array.isArray(snapshot.root)) {
    out.root = sanitizeRow(rootTable, snapshot.root)
  }
  if (Array.isArray(snapshot.cascaded)) {
    out.cascaded = snapshot.cascaded.map(c => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return c
      return { ...c, row: sanitizeRow(c.table, c.row) }
    })
  }
  return out
}
