// Bounce and complaint suppression — the table that stops the log lying.
//
// Before this, dispatch() wrote status='sent' the moment the provider's
// API returned 200. A provider returns 200 for a mailbox that was deleted
// two years ago; it finds out seconds later, asynchronously, and told
// nobody because there was nowhere to tell. So a parish secretary reading
// the notification log saw a clean column of 'sent' against an address
// that has never once received anything — the same failure shape as the
// backup digest that reported success while writing to a stub, which is
// the reason emailTransportIsLive() exists.
//
// Two changes:
//
//   ochr_email_suppressions   one row per dead or complaining address.
//   ochr_notification_log
//     .provider_message_id    the provider's id for the send, which is the
//                             only handle a later webhook has to find the
//                             row it is about.
//
// WHY NO organization_id. Every other tenant table has one and the tenancy
// audit exists to enforce that, so its absence here is a decision and not
// an oversight. A hard bounce is a fact about a mailbox, not about a
// parish: if juan@example.org no longer exists, it does not exist for St
// Anne's and for St Jude's separately. Scoping suppression per tenant
// would mean every parish independently re-discovers the same dead address
// by mailing it, and each of those attempts is charged against the ONE
// sending domain they all share. The blast radius of getting this wrong is
// the reverse of the usual one — a per-tenant table leaks damage between
// tenants, and the global table contains it.
//
// What that costs: parish A's send can suppress an address parish B also
// holds. That is intended. The row stores an address, a reason and a
// timestamp — no parish, no member, no message content — so it carries no
// tenant data across the boundary, only the fact that a mailbox is dead.
//
// Complaints ("this is spam") are stored the same way and are stricter in
// one respect: they are never auto-cleared. A bounce can be a full mailbox;
// a complaint is a person telling you to stop.

import pool from '../db.js'

export async function up() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_email_suppressions (
      id                  SERIAL PRIMARY KEY,
      email               TEXT NOT NULL,
      reason              TEXT NOT NULL,
      provider            TEXT,
      provider_event_id   TEXT,
      detail              TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    ALTER TABLE ochr_email_suppressions
      DROP CONSTRAINT IF EXISTS ochr_email_suppressions_reason_check
  `)
  await pool.query(`
    ALTER TABLE ochr_email_suppressions
      ADD CONSTRAINT ochr_email_suppressions_reason_check
      CHECK (reason IN ('bounce', 'complaint', 'manual'))
  `)

  // The lookup is lower(email) and it runs before EVERY send, so it has to
  // be an index seek and it has to be unique — two rows for one address
  // would make "is this suppressed" ambiguous and let a retrying webhook
  // grow the table without bound.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_email_suppressions_lower_email
      ON ochr_email_suppressions (lower(email))
  `)

  // Webhooks retry. Without this, one bounce delivered three times is
  // three attempts to insert, and only the unique index above saves it —
  // which turns a duplicate into an error path rather than a no-op.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_suppressions_event
      ON ochr_email_suppressions (provider, provider_event_id)
      WHERE provider_event_id IS NOT NULL
  `)

  // RLS, enable-only. Every ochr_* table has carried row level security
  // since the 080 sweep, and the push gate refuses a CREATE TABLE that
  // does not. No policy is attached here, matching the rest of the schema:
  // the server connects as the owning role, and the switch exists so that
  // a future anon/authenticated key cannot read the table by default.
  //
  // This table's lack of an organization_id (argued above) makes the
  // switch MORE important rather than less: there is no tenant column to
  // scope a leak by, so every row is visible to anything that gets a
  // connection without it.
  await pool.query(`
    ALTER TABLE ochr_email_suppressions ENABLE ROW LEVEL SECURITY
  `)

  await pool.query(`
    ALTER TABLE ochr_notification_log
      ADD COLUMN IF NOT EXISTS provider_message_id TEXT
  `)

  // Finding the log row a delivery event refers to. Partial because the
  // overwhelming majority of rows are stubbed sends with no provider id.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_log_provider_message
      ON ochr_notification_log (provider_message_id)
      WHERE provider_message_id IS NOT NULL
  `)

  // ── Self-assertion, same posture as 090/093/094/095 ──────────────
  // A suppression table that exists but whose unique index silently did
  // not install is worse than no table: the check still passes, the
  // inserts still succeed, and duplicates accumulate until somebody reads
  // a count. Nothing about the send path would report it.
  const { rows: idx } = await pool.query(`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_email_suppressions_lower_email'
  `)
  if (!idx.length) throw new Error('096: uq_email_suppressions_lower_email was not created')
  if (!/UNIQUE/i.test(idx[0].indexdef)) {
    throw new Error('096: the suppression index is not unique — one address could hold many rows')
  }
  if (!/lower\(/i.test(idx[0].indexdef)) {
    throw new Error('096: the suppression index is not functional — lower(email) lookups cannot use it')
  }

  const { rows: rls } = await pool.query(`
    SELECT relrowsecurity FROM pg_class WHERE relname = 'ochr_email_suppressions'
  `)
  if (!rls.length || rls[0].relrowsecurity !== true) {
    throw new Error('096: row level security is not enabled on ochr_email_suppressions')
  }

  const { rows: col } = await pool.query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'ochr_notification_log' AND column_name = 'provider_message_id'
  `)
  if (!col.length) {
    throw new Error('096: ochr_notification_log.provider_message_id is missing — delivery events would have no row to correct')
  }

  // The CHECK is what keeps 'reason' a closed set. Without it a typo in a
  // future adapter writes 'bounced' and every query filtering on 'bounce'
  // quietly stops seeing those rows.
  const { rows: chk } = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'ochr_email_suppressions_reason_check'
  `)
  if (!chk.length) throw new Error('096: the reason CHECK constraint is missing')
  for (const r of ['bounce', 'complaint', 'manual']) {
    if (!chk[0].def.includes(`'${r}'`)) {
      throw new Error(`096: the reason CHECK does not admit '${r}'`)
    }
  }

  console.log('Migration 096: email-suppressions — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
