# OpenChurch — Operational Notes

A practical reference for the parts of OpenChurch that aren't user features:
cron schedule, env vars, vendor-neutral plumbing, and the steps needed to flip
the team-lead picks live when they land.

The README has the short table; this is the longer "how do I actually flip
this on?" form.

## Activating Vercel cron

Three cron entries are pre-declared in `vercel.json`. They do nothing until
two conditions hold:

1. The Vercel project has the `CRON_SECRET` env var set (any random hex string
   — `openssl rand -hex 32` is fine).
2. A push to `main` triggers a new deploy. Vercel reads `vercel.json` on
   deploy and registers the schedule. The cron tab on the Vercel dashboard
   will show all three entries.

Vercel sends `Authorization: Bearer ${CRON_SECRET}` on every invocation.
`requireCronAuth` (server/src/middleware/cronAuth.js) rejects anything else
with 401 and returns 503 when `CRON_SECRET` isn't set so misconfigured
deploys surface loudly instead of silently no-op'ing.

The same underlying functions are reachable via `/api/admin/...` paths for
manual operator pokes from the UI:

| Cron path | Admin path | Used by |
|---|---|---|
| `POST /api/cron/drain-notifications` | `POST /api/admin/notifications/drain` | Notifications scheduler |
| `POST /api/cron/enqueue-birthdays` | `POST /api/admin/notifications/enqueue-birthdays` | Birthday + anniversary helper |
| `POST /api/cron/retention-prune` | `POST /api/admin/maintenance/retention-prune` | Daily retention prune |

## Email provider swap

Today every notification goes through `dispatchStub` in
`server/src/notifications/transport.js`, which writes a row to
`ochr_notification_log` with `status='stubbed'` instead of sending. The
template registry, scheduling queue, prefs UI, drainer, and trigger points
(event create, birthday enqueue) all work end-to-end against the stub.

To go live with a real provider:

1. Pick a provider (Resend, Postmark, SES, etc.) and add its SDK to
   `server/package.json`.
2. Set the provider's API key on the Vercel project (e.g. `RESEND_API_KEY`).
3. Replace `dispatchStub` in `transport.js` with a function that calls the
   provider, awaits the response, and writes a row with `status='sent'` /
   `'failed'` / the provider's error message. The signature stays the same.
4. Push. Every notification path now sends real email; nothing else changes.

The notification log already captures subject + body + recipient + status,
so the admin viewer (when one exists) doesn't need to change either.

## Error monitoring swap

Same pattern. Today `monitor.error/warn/info` calls (server/src/monitoring/
index.js) write structured JSON to stderr/stdout. To wire a real monitoring
tool (Sentry, Axiom, Datadog, etc.):

1. Add the SDK.
2. Replace the `dispatch` function in `monitoring/index.js` with the
   provider's `captureException` / `log` call. Keep the existing JSON shape
   as `extra` / context if the provider supports structured fields.
3. The ~25 callsites already migrated to `monitor.error` (audit middleware,
   notification dispatch, AI quota, daily verse, etc.) flip live with no
   further changes.

Route-level `console.error(err); res.status(500).json(...)` paths in some
handlers still log to stderr directly. They produce visible signal via the
500 response so the migration was deferred. Migrate them incrementally as
you touch the surrounding code.

## Billing provider

The billing schema is provider-neutral
(`provider_customer_id`, `provider_subscription_id`). When a provider is
picked:

1. Add the SDK and set the price id env var
   (`BILLING_PRICE_ID_PRO`).
2. Implement the checkout / customer portal flows in
   `server/src/routes/billing.js`. The webhook router is already mounted
   before `express.json()` so the raw body is preserved for signature
   verification.

## Plans + retention

`server/src/billing/plans.js` is the single source of truth for per-plan
limits:

- `members`, `events` — feature limits, currently informational
- `ai_generations_per_month` — enforced gate on `/api/ai/generate` and
  `/api/ai/enhance`
- `retention_days` — used by the retention prune to age out
  `ochr_audit_log` and `ochr_notification_log`

Other tables use fixed retention windows hardcoded in
`server/src/services/retention.js`:

- `ochr_ai_usage` → 90 days (quota math only needs the current month)
- `ochr_scheduled_notifications` → 30 days, ONLY rows in terminal status
  (`sent` / `failed` / `cancelled`). Pending rows are work-not-yet-done and
  survive forever.
- `ochr_ai_generations` → never auto-pruned. User-owned sermon archive that
  the Library page depends on.

## Smoke tests

`server/tests/smoke.test.js` runs against a real Postgres instance via
supertest. Run with `cd server && npm test`. Default per-test timeout is
15 seconds (some tests do 5–6 supertest round-trips on a row that triggers
multiple writes via the audit + notification side-channels).

## Multi-tenant boundary

Every tenant-scoped table has an `organization_id` column. Every query
filters by `req.organizationId` (derived from the JWT). The smoke suite
includes a `tenant isolation` describe block that creates two orgs and
asserts no cross-org reads or writes — both via SQL filtering AND via
response codes (DELETE on a non-tenant row returns 404, never 204).

When adding a new mutating route, you MUST:

1. Filter all reads by `organization_id`
2. Filter all writes by `organization_id` in the WHERE clause
3. Return 404 (not 204) on a DELETE that touched zero rows
4. Add a tenant-isolation smoke test for the new resource

## Support system (SUP)

The support console (`/support`, admin nav) reads `/api/support-tickets`;
parish reports come in through the Help panel's Report tab (the `?` in the
header) and land status `new`, severity `normal`. Taxonomy is the Aug 12
handoff's, verbatim — severity critical/high/normal/low, status
new/diagnosing/waiting_on_parish/in_progress/resolved/closed,
classification bug/confusion/feature_request/product_insight.

Env:

- `SUPER_ADMIN_EMAIL` — already the founder workbench identity; also makes
  that user a support *vendor* (cross-org queue, full triage). Fail-closed.
- `VENDOR_ADMIN_EMAILS` — optional comma-separated additional vendor
  triagers (for when OSL grows past one).
- `SUPPORT_EMAIL` — if set, every new ticket is forwarded there through the
  vendor-neutral `sendEmail()` seam (Resend when `RESEND_API_KEY` is set,
  console stub otherwise). Best-effort; never blocks submission.
- `ANTHROPIC_API_KEY` — enables the async AI triage pass (suggested
  severity/classification, root cause, suspected files). Absent → tickets
  simply arrive untriaged; nothing errors. `SUPPORT_AI_MODEL` overrides the
  default (AI Studio's Haiku default).
- `ASSISTANT_DAILY_CAP` — in-app assistant messages/org/day (default 300).
  The assistant follows the AIP.1 org-key chain and does NOT consume AI
  Studio quota.

Deliberately absent (Founder Decision Ledger, Aug 12): AI self-heal
dispatch. When it's green-lit, the workflow + endpoints land with their own
migration for the PR-tracking columns.

## Registry audit

An upstream audit verifies on every push that four conventions still hold:

- Client port `5202`
- Server port `3034`
- Auth localStorage key `ochr_token`
- DB table prefix `ochr_`

The audit currently passes. If a future change shifts any of these by
accident, the action fails with an explanation comment on the PR.
