# Alerting Setup — "know before the priest calls"

_All configuration, no code — with one correction made on 27 Aug, because
the sentence below used to overstate the starting point._

_The health endpoint already returns 503 when the DB is unreachable, and the
Saturday backup email doubles as a cron heartbeat. **Sentry is wired, not
live.** `@sentry/node` is a declared dependency and
`server/src/monitoring/index.js` forwards `monitor.error` to it — but ONLY
when `SENTRY_DSN` is set AND `NODE_ENV === 'production'`. `SENTRY_DSN` is
empty in `.env.example` and whether it is set on the deployment is **not
verified**. Until somebody queries the deployment, assume runtime errors go
to stderr — which on Vercel means the platform's runtime logs, where they
are readable but nobody is told. Choosing a destination is an open decision
(see PICKUP), not a setup step._

## 1. Sentry → phone (runtime errors)

1. Install the **Sentry mobile app**, sign in, enable notifications.
2. sentry.io → project → **Alerts → Create Alert → Issues**:
   - "A new issue is created" → notify immediately (new bug categories are
     rare at this scale; every one deserves a look).
   - "An issue is seen more than 10 times in one hour" → notify (regression
     storm — likely a Sunday-morning path).
3. **Deploy-aware grouping:** Vercel → Integrations → Sentry (associates
   errors with deploys, so "started after Tuesday's push" answers itself).
4. Quiet what you can't act on: mute noisy non-actionable issues from the
   mobile app rather than letting alert fatigue set in — an alert channel
   you've learned to ignore is worse than none.

## 2. Uptime → phone (is it up at all?)

Sentry can't tell you the whole app is down. Use a free external monitor
(UptimeRobot / Better Stack, either is fine):

- Monitor: `GET https://<production-domain>/api/health`, every 5 min.
- Alert on: status ≠ 200 (the endpoint returns **503 when the DB is
  unreachable** — so this one check covers app AND database).
- Notify: mobile push + email. Add SMS if the free tier includes it.
- **Sunday window:** add a second monitor at 1-minute interval, active
  Sundays 6:00–13:00 local, if the provider supports schedules — check-in
  time is the one window where minutes matter.

## 3. Webhook & email failure visibility

- **Stripe:** Dashboard → Webhooks → endpoint → enable **failure email
  notifications** (a silently failing webhook = donations charged but not
  recorded — the worst kind of quiet).
- **Resend:** Dashboard → check bounce/failure counts weekly (they're also
  in `ochr_notification_log` as `failed` rows, which the Monday dashboard
  query already surfaces).

## 4. The heartbeat you already have

No Saturday backup email = the cron layer is broken (and so, probably, are
reminders and digests). Treat a missing Saturday email as an incident. Add
a recurring phone reminder — "Did the backup email arrive?" — Saturday 9am,
until checking it is reflex.

## 5. When an alert fires (the whole triage tree)

1. Uptime alert → Vercel status page / deploy log first (bad deploy? roll
   back from the Vercel dashboard — one click), then Supabase status.
2. Sentry alert → is it parish-facing and Sunday-adjacent? Fix or roll back
   now. Otherwise it waits for the Sunday code hour — write it down, close
   the phone.
3. Anything touching pickup security or the register → highest severity,
   regardless of day.
