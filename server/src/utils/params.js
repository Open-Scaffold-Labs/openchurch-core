// Small helpers for validating Express route params.

// Parse a :id param that maps to a Postgres SERIAL (integer) column.
// Returns a positive integer or `null` for anything else (empty string,
// "abc", "1.5", "-3", etc.). Routes should short-circuit with a 400 on
// null to avoid surfacing raw Postgres cast errors to clients.
export function parseIntId(raw) {
  if (raw === undefined || raw === null) return null

  // DIGITS ONLY, and this is the load-bearing line.
  //
  // `Number()` accepts a good deal that is not an id: '1e3' becomes 1000,
  // '0x10' becomes 16, and — the one that matters —
  // '999999999999999999999' becomes 1e+21, which IS an integer by
  // Number.isInteger and sails straight through to Postgres as the literal
  // "1e+21". Measured: SQLSTATE 22P02, invalid input syntax for type
  // integer, caught by the route's catch-all and returned as a 500.
  //
  // So the guard whose entire job is to stop a bad id becoming a server
  // fault had the fault in it, at all twenty-four call sites. Found on a
  // second pass over a change that adopted this helper for exactly that
  // reason.
  //
  // An id is a string of digits. Anything else is not an id, whatever
  // Number() is willing to make of it.
  const str = String(raw).trim()
  if (!/^\d+$/.test(str)) return null

  const n = Number(str)
  // Safe-integer bound rather than INT4 max: several tables here are
  // BIGSERIAL (ochr_diocese_affiliations among them), so capping at
  // 2147483647 would reject ids those tables can legitimately issue. Beyond
  // 2^53 the value cannot survive the round trip through a JS number at all,
  // which makes it the honest ceiling.
  if (!Number.isSafeInteger(n) || n <= 0) return null
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
