// Web Push subscriptions (Sprint PWA / PWA.4a). One row per device a
// signed-in user has subscribed for push notifications. The browser
// hands us a PushSubscription object on subscribe(); the three pieces
// the VAPID-signed dispatcher needs are { endpoint, keys.p256dh,
// keys.auth }. We persist exactly those three plus tenant + actor
// context.
//
// Why this is decoupled from ochr_notification_prefs:
//   - Push is per-DEVICE (a user on phone + desktop has two rows);
//     prefs are per-USER × per-template.
//   - Push subscriptions are opaque provider URLs (FCM, Mozilla,
//     Apple) that can rotate / expire / 410-gone independently of
//     anything the user does. Keeping them in their own table lets
//     the dispatch helper prune dead rows on send-fail without
//     touching pref state.
//
// Vendor-neutral on purpose. Web Push is a W3C standard the browser
// implements directly — no third-party email / push provider needed.
// The send helper (server/src/notifications/push.js) gracefully
// no-ops when VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars are
// absent, so PWA.4 is NOT blocked on the team-lead "email provider
// pick" or any other procurement decision.
//
// UNIQUE on endpoint — a given browser push endpoint belongs to one
// device; if the same browser re-subscribes (e.g. after permission
// reset) we upsert by endpoint so we don't accumulate dead rows.

import pool from '../db.js'

export async function up() {
  console.log('Migration 016: push subscriptions — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_push_subscriptions (
      id              SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES ochr_users(id)         ON DELETE CASCADE,
      endpoint        TEXT NOT NULL UNIQUE,
      p256dh          TEXT NOT NULL,
      auth            TEXT NOT NULL,
      user_agent      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      removed_at      TIMESTAMPTZ
    )
  `)

  // Hot path: "send to all this user's active devices." Covered by
  // (user_id) with the removed_at IS NULL partial filter so dead
  // subscriptions don't get scanned.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_push_subs_user_active
      ON ochr_push_subscriptions (user_id)
      WHERE removed_at IS NULL
  `)

  // Org-scoped admin view: "how many devices in this tenant are
  // subscribed?" — small index, cheap to maintain.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_push_subs_org
      ON ochr_push_subscriptions (organization_id)
      WHERE removed_at IS NULL
  `)

  console.log('Migration 016: push subscriptions — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
