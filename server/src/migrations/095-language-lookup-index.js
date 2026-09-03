// The language lookup runs on every outbound message, and scanned the roster.
//
// notifications/transport.js `languageFor()` asks one question per
// notification: does this recipient have a stated language preference?
//
//   SELECT preferred_language FROM ochr_clients
//    WHERE organization_id = $1 AND lower(email) = lower($2)
//      AND preferred_language IS NOT NULL
//    LIMIT 1
//
// There was no index on email at all. The planner used the organization
// index and filtered, which means it read the whole roster — and because
// MOST members have no stated preference, the common case never
// short-circuits. It reads everything and returns nothing.
//
// MEASURED at 20,000 members in one organization, before and after:
//
//   without index : Seq Scan, 20,852 rows removed by filter, 3.257 ms
//   with index    : Index Scan, 0.042 ms   (no preference — the common case)
//                   Index Scan, 0.018 ms   (has a preference)
//   index size    : 80 kB
//
// ~78x on the common case. Not dramatic per message; the reason it is worth
// a migration is that it is per-RECIPIENT on paths that fan out — the weekly
// serving digest, the recurring-gift run — where a 200-member parish paid
// two thirds of a second in lookups to answer "nobody here asked for
// Spanish". And it grows linearly with the roster.
//
// WHY PARTIAL. `WHERE preferred_language IS NOT NULL` is what makes this
// cheap: the index holds only the members who actually stated a preference,
// roughly one in fifty. It still answers the common case correctly and
// directly — a lookup that finds nothing IS the answer "no preference", and
// the planner can prove that from the index alone rather than from the table.
// A full index on (organization_id, lower(email)) would work too and cost
// fifty times the space to answer the same question.
//
// WHY FUNCTIONAL. The query compares lower(email), so a plain index on email
// cannot serve it. The lower() is deliberate — email is case-insensitive in
// practice and a parish secretary typing 'Maria@…' must not miss a
// preference recorded against 'maria@…'.

// NOT CONCURRENTLY, deliberately. A plain CREATE INDEX takes a lock that
// blocks writes to ochr_clients while it builds — measured at 12 ms on a
// 20,000-row table, which is the largest roster this product is built for
// (the stack is sized for 1-50 parishes). CONCURRENTLY trades that for an
// index that can be left INVALID if the build fails, and it is what 104 of
// the 105 index creations in this repository already do. Not worth a one-off
// here; revisit if a single organization ever carries six figures of members.

import pool from '../db.js'

export async function up() {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_clients_org_lower_email_lang
      ON ochr_clients (organization_id, lower(email))
      WHERE preferred_language IS NOT NULL
  `)

  // Self-assertion, same posture as 090/093/094. An index that silently did
  // not install would leave the query quietly scanning again, and nothing
  // would report it — the notification still sends, just slower every year.
  const { rows } = await pool.query(`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_clients_org_lower_email_lang'
  `)
  if (!rows.length) throw new Error('095: idx_clients_org_lower_email_lang was not created')
  const def = rows[0].indexdef
  if (!/lower\(/i.test(def)) {
    throw new Error('095: the index is not functional — lower(email) lookups cannot use it')
  }
  if (!/WHERE .*preferred_language/i.test(def)) {
    throw new Error('095: the index is not partial — it would cost fifty times the space for the same answer')
  }

  console.log('Migration 095: language-lookup-index — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
