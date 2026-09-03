// Who, in the member roster, is this person?
//
// OpenChurch keeps two tables for the same human. `ochr_users` is a login
// account. `ochr_clients` is a member of the parish. There is no foreign key
// between them and there never has been — the only thing joining a signed-in
// staff member to her own roster entry is a case-insensitive comparison of
// email addresses, performed independently at four call sites.
//
// That is not an accident to be refactored away. Most members are not users
// (a parish has hundreds of members and a handful of logins), and some users
// are not members (a visiting bookkeeper). Neither table can be a foreign key
// on the other without lying about one of those cases. The join is genuinely
// by address.
//
// What was wrong is that the join was written out four times, in four
// dialects — `lower(email)` here, `LOWER(email)` there, org scope first in one
// and second in another — so "are these the same person?" had four answers
// that only happened to agree. This module is the one answer.
//
// It deliberately does NOT try to be clever. No fuzzy matching, no name
// fallback, no normalisation beyond case. A parish that wants
// maria.g@ and mariag@ treated as one person is asking a product question,
// not a database question, and guessing at it here would silently merge two
// people who share a surname.

import pool from '../db.js'

// The predicate, in one place. Case-insensitive on address, always scoped to
// the organization — a member of St Anne's is not a member of St Jude's, and
// an email match across tenants would be the worst kind of correct-looking.
const MATCH = `organization_id = $1 AND lower(email) = lower($2)`

// Returns the member row (selected columns) or null.
//
// `columns` is an allowlist, not interpolation of caller input — every call
// site in this repo passes a literal, and keeping it explicit means a future
// caller cannot turn this into an injection point by passing a request value.
const ALLOWED = new Set([
  'id', 'name', 'email', 'phone', 'status', 'role',
  'calendar_token', 'preferred_language',
])

// `executor` defaults to the pool but accepts a transaction client.
//
// The honest reason, corrected 27 Aug after an audit found the original
// comment claimed more than the code delivers: at connect.js's read the
// transaction has not yet inserted anything into ochr_clients, so there are
// no uncommitted rows to miss. Passing `client` is still right — it avoids
// checking out a SECOND pooled connection while already holding one, which
// is a real exhaustion and ordering hazard — but it does NOT prevent the
// duplicate-insert race. Two concurrent approvals of different interest rows
// carrying the same address each lock their own ochr_group_interests row,
// neither sees the other's uncommitted insert under READ COMMITTED, and both
// insert. See memberLanguage() below for why that matters.
//
// UNKNOWN, deliberately left so: whether duplicate members exist in any real
// tenant. Closing the race needs a unique index on
// (organization_id, lower(btrim(email))) plus ON CONFLICT, which is a
// migration against live parish data and Jose's call, not this module's.
export async function memberByEmail(organizationId, email, columns = ['id'], executor = pool) {
  if (!organizationId || !email) return null
  for (const c of columns) {
    if (!ALLOWED.has(c)) throw new Error(`memberByEmail: column "${c}" is not allowlisted`)
  }
  const { rows } = await executor.query(
    `SELECT ${columns.join(', ')} FROM ochr_clients WHERE ${MATCH} LIMIT 1`,
    [organizationId, email]
  )
  return rows[0] ?? null
}

// Does a member with this address already exist? Separated from the above so
// the intent reads at the call site: connect.js asks this before deciding
// whether to create, and "did we find a row" is the whole question there.
// Language lookup is NOT memberByEmail with a column argument, and the
// difference is load-bearing.
//
// Migration 095 created idx_clients_org_lower_email_lang as a PARTIAL index:
//   ... WHERE preferred_language IS NOT NULL
// Postgres uses a partial index only when the query's predicate implies the
// index's. Dropping `AND preferred_language IS NOT NULL` from the query — as
// this module briefly did — makes the index unusable and the lookup a
// sequential scan. Measured on 20k members, local Postgres 16:
//
//   with the predicate     Index Scan   0.062 ms
//   without it             Seq Scan     9.126 ms   (19,998 rows removed)
//
// languageFor() runs once per recipient on fan-out sends, which is precisely
// what 095 was written for.
//
// A CORRECTION, because the first version of this comment claimed more than
// the code delivers. It said the predicate also made the answer
// deterministic. It does not. `ochr_clients.preferred_language` is
// `TEXT DEFAULT 'en'` (migration 001), and NO production insert path names
// the column — not connect.js, not clients.js, not imports.js, not the
// seeds. So every real row is 'en', never NULL, and `IS NOT NULL` filters
// nothing in production. With no unique constraint on
// (organization_id, email), two duplicate rows both pass the predicate and
// `LIMIT 1` picks by physical order.
//
// The ORDER BY below is what actually makes it deterministic: a row that
// states a non-default preference wins over one that never expressed a view,
// and `id` breaks the remaining tie. Without it, a secretary setting Maria
// to Spanish on the newer of two duplicate rows could still be sent English.
export async function memberLanguage(organizationId, email, executor = pool) {
  if (!organizationId || !email) return null
  const { rows } = await executor.query(
    `SELECT preferred_language FROM ochr_clients
      WHERE ${MATCH} AND preferred_language IS NOT NULL
      ORDER BY (preferred_language <> 'en') DESC, id ASC
      LIMIT 1`,
    [organizationId, email]
  )
  return rows[0]?.preferred_language ?? null
}

export async function memberExistsByEmail(organizationId, email, executor = pool) {
  return (await memberByEmail(organizationId, email, ['id'], executor)) !== null
}
