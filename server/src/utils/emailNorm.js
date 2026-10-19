// ARG-PR6-1 / reset PR11: one normalisation for addresses compared across
// closure, deactivation, the scheduler backstop and dispatch admission.
// lower(btrim(x)) only trims U+0020, so "\taddr", "addr\n" or "addr\u00a0"
// slipped past the closed/deactivated-recipient rules. Trim every Unicode
// whitespace code point (the set JS's \s matches), identically in JS and
// SQL, then lower-case. For plain-space padding the result equals
// lower(btrim(x)).
export const WS_CLASS = '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
const WS_RE = new RegExp(`^[${WS_CLASS}]+|[${WS_CLASS}]+$`, 'gu')

export function normEmail(addr) {
  if (addr == null) return null
  return String(addr).replace(WS_RE, '').toLowerCase()
}

// SQL expression with the same meaning. `expr` must be trusted SQL (a
// column or a $n placeholder), never user input.
export function sqlNormEmail(expr) {
  return `lower(regexp_replace(${expr}, '^[${WS_CLASS}]+|[${WS_CLASS}]+$', '', 'g'))`
}

// ARG-V2-1 (PR6): unsalted SHA-256 (hex) of the normalised address, as SQL.
// A match key, not anonymisation: a guessed address can be confirmed, and an
// offline dictionary attack can recover it (see migration 119).
// Used to write and to match ochr_closed_address_suppressions so both sides
// apply exactly the normalisation above.
export function sqlEmailSha256(expr) {
  return `encode(sha256(convert_to(${sqlNormEmail(expr)}, 'UTF8')), 'hex')`
}
