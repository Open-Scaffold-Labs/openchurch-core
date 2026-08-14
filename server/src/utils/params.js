// Small helpers for validating Express route params.

// Parse a :id param that maps to a Postgres SERIAL (integer) column.
// Returns a positive integer or `null` for anything else (empty string,
// "abc", "1.5", "-3", etc.). Routes should short-circuit with a 400 on
// null to avoid surfacing raw Postgres cast errors to clients.
export function parseIntId(raw) {
  if (raw === undefined || raw === null) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

// Express helper: validates req.params[name] is a positive integer and
// responds 400 if not. Returns the parsed id, or `null` after responding —
// callers should `return` immediately when they get null back.
export function requireIntParam(req, res, name = 'id') {
  const id = parseIntId(req.params[name])
  if (id === null) {
    res.status(400).json({ error: `Invalid ${name}` })
    return null
  }
  return id
}

// Parse a ?days=N window query param. Garbage ("abc", "-5", "1e99")
// falls back to the default instead of poisoning the SQL interval cast
// with NaN (which 500s). Clamped to 1..3650 — a decade is the widest
// window any report needs.
export function parseDays(raw, dflt) {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isInteger(n) || n < 1) return dflt
  return Math.min(n, 3650)
}

// Optional pagination for list endpoints. Reads ?limit and ?offset off the
// query. A valid limit is clamped to 1..200; anything invalid/absent falls
// back to a safety cap of 1000 rows so an endpoint can never stream an
// unbounded result set. offset is a non-negative integer (else 0). Returns
// { limit, offset } ready to append as `LIMIT $n OFFSET $m`. This is a
// ceiling, not a behavior change — real orgs sit well under 1000.
export function parsePagination(query = {}) {
  const SAFETY_CAP = 1000
  const rawLimit  = Number.parseInt(query.limit, 10)
  const rawOffset = Number.parseInt(query.offset, 10)
  const limit  = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 200)
    : SAFETY_CAP
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0
  return { limit, offset }
}
