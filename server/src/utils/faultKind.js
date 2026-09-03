// Which kind of failure was that?
//
// Written for one open question: an import-mapping flake that fails roughly
// one run in seventeen. The mechanism is established — `pending` proves the
// mapping call never landed, and the duplicate detector is provably innocent
// — but the CAUSE is not, and two candidates remain:
//
//   1. a query or logic error caught by the route's catch-all
//   2. a pool.connect() timeout at PG_POOL_MAX=5 (connectionTimeoutMillis
//      is 10s in db.js, so a starved pool fails rather than queues forever)
//
// Both produce byte-identical output: HTTP 500 with the same localized
// message. Sixteen further runs did not reproduce it, so waiting for it to
// happen again is only useful if the next occurrence SAYS which one it was.
// That is all this does.
//
// Deliberately applied at one call site for now rather than swept through
// every catch-all. It is an investigation tool with a specific question to
// answer; if a second site needs it, that is the moment to spread it, not
// before.
//
// The values are coarse on purpose — a SQLSTATE and a category, never a
// message or a stack. This rides in an API response to an authenticated
// admin, and "what broke" should never become "here is the shape of the
// database".
export function faultKind(err) {
  const msg = String(err?.message ?? '')

  // node-postgres raises this exact phrase when every client in the pool is
  // checked out and connectionTimeoutMillis elapses. Candidate 2.
  if (/timeout exceeded when trying to connect/i.test(msg)) return 'pool_timeout'

  // A Postgres error carries a five-character SQLSTATE. Candidate 1, and the
  // code says which flavour without saying anything about the data.
  if (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return `db:${err.code}`

  // A pool that has been ended, or a socket that went away mid-statement —
  // neither is a query fault and both would otherwise read as one.
  if (/Cannot use a pool after calling end/i.test(msg)) return 'pool_ended'
  if (/Connection terminated/i.test(msg)) return 'connection_lost'

  return 'unknown'
}
