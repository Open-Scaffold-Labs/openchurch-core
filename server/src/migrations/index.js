// Single source of truth for the migration chain. Both the local-dev
// boot in server/src/index.js and the CI/manual entry point in
// server/src/migrate-cli.js call runAllMigrations() so the order of
// operations and the set of applied migrations stay in lockstep.
//
// Each migration is idempotent (CREATE IF NOT EXISTS, ALTER ADD IF NOT
// EXISTS) so re-running is safe. On top of that idempotency we now keep a
// ledger (ochr_schema_migrations): once a migration's name is recorded we
// SKIP its up() entirely on later runs, so a warm DB doesn't re-execute all
// 40-odd CREATE/ALTER statements — and, crucially, the destructive backfill
// UPDATEs inside baseMigrate ('base') run at most once. Concurrent runs are
// serialized by a Postgres session advisory lock so two boots can't race the
// ledger.

import pool from '../db.js'
import { migrate as baseMigrate, DEMO_ORG_SLUG } from '../migrate.js'
import { seedSampleData } from '../onboarding/sampleSeed.js'
import { up as bilingual }      from './001-bilingual.js'
import { up as passwordReset }  from './002-password-reset.js'
import { up as rolesCheck }     from './003-roles-check.js'
import { up as billing }        from './004-billing.js'
import { up as auditLog }       from './005-audit-log.js'
import { up as aiUsage }        from './006-ai-usage.js'
import { up as notifications }  from './007-notifications.js'
import { up as scheduledNotifications } from './008-scheduled-notifications.js'
import { up as searchIndex } from './009-search-index.js'
import { up as recurrence } from './010-recurrence.js'
import { up as birthdays } from './011-birthdays.js'
import { up as givingStatements } from './012-giving-statements.js'
import { up as publicEvents } from './013-public-events.js'
import { up as attendance } from './014-attendance.js'
import { up as pledges } from './015-pledges.js'
import { up as pushSubscriptions } from './016-push-subscriptions.js'
import { up as forms } from './017-forms.js'
import { up as formResponses } from './018-form-responses.js'
import { up as avatars } from './019-user-avatar.js'
import { up as swapRequests } from './020-swap-requests.js'
import { up as groups } from './021-groups.js'
import { up as eventGroups } from './022-event-groups.js'
import { up as churchPage } from './023-church-page.js'
import { up as memberUnavailability } from './024-member-unavailability.js'
import { up as groupInterests } from './025-group-interests.js'
import { up as onlineGiving } from './026-online-giving.js'
import { up as reminderSource } from './027-reminder-source.js'
import { up as reminderOptout } from './028-reminder-optout.js'
import { up as reminderLead } from './029-reminder-lead.js'
import { up as donationRefund } from './030-donation-refund.js'
import { up as recurringGifts } from './031-recurring-gifts.js'
import { up as swapReminded } from './032-swap-reminded.js'
import { up as perfIndexes } from './033-perf-indexes.js'
import { up as checkins } from './034-checkins.js'
import { up as checkinSecurity } from './035-checkin-security.js'
import { up as rooms } from './036-rooms.js'
import { up as kioskToken } from './037-kiosk-token.js'
import { up as calendarLiturgical } from './038-calendar-liturgical.js'
import { up as parishFeasts } from './039-parish-feasts.js'
import { up as orgTimezone } from './040-org-timezone.js'
import { up as bulletins } from './041-bulletins.js'
import { up as servicePlans } from './042-service-plans.js'
import { up as checkinCodeHash } from './043-checkin-code-hash.js'
import { up as tenantFkGuards } from './044-tenant-fk-guards.js'
import { up as sacramentalRecords } from './045-sacramental-records.js'
import { up as massIntentions } from './046-mass-intentions.js'
import { up as sacristyManifest } from './047-sacristy-manifest.js'
import { up as sacramentMeta } from './048-sacrament-meta.js'
import { up as sacramentalDrafts } from './049-sacramental-drafts.js'
import { up as donationPaymentRefUnique } from './050-donation-payment-ref-unique.js'
import { up as feedbackLedger } from './051-feedback-ledger.js'
import { up as telemetryDashboard } from './052-telemetry-dashboard.js'
import { up as feedbackStatus } from './053-feedback-status.js'
import { up as auditHardening } from './054-audit-hardening.js'
import { up as sessionAndRaceGuards } from './055-session-and-race-guards.js'
import { up as manifestEventId } from './056-manifest-event-id.js'
import { up as financeLedger } from './057-finance-ledger.js'
import { up as dioceseAffiliations } from './058-diocese-affiliations.js'
import { up as reportSubmissions } from './059-report-submissions.js'
import { up as sampleSeedMarker } from './060-sample-seed-marker.js'
import { up as pledgeTenantFk } from './061-pledge-tenant-fk.js'
import { up as assessments } from './062-assessments.js'
import { up as orgAiProvider } from './063-org-ai-provider.js'
import { up as dailyChecklists } from './064-daily-checklists.js'
import { up as supportSystem } from './065-support-system.js'
import { up as coaOfferingsRename } from './066-coa-offerings-rename.js'
import { up as parishFeeSchedules } from './067-parish-fee-schedules.js'
import { up as parishInvoices } from './068-parish-invoices.js'
import { up as invoicePayments } from './069-invoice-payments.js'
import { up as burialSacrament } from './070-burial-sacrament.js'

// The ordered chain, each with a stable ledger name. baseMigrate runs
// FIRST because it creates the core tables (organizations, users, and the
// tenant tables) every later migration ALTERs. The names are permanent —
// never rename an already-shipped entry or its up() will re-run.
const MIGRATIONS = [
  ['base',                     baseMigrate],
  ['001-bilingual',            bilingual],
  ['002-password-reset',       passwordReset],
  ['003-roles-check',          rolesCheck],
  ['004-billing',              billing],
  ['005-audit-log',            auditLog],
  ['006-ai-usage',             aiUsage],
  ['007-notifications',        notifications],
  ['008-scheduled-notifications', scheduledNotifications],
  ['009-search-index',         searchIndex],
  ['010-recurrence',           recurrence],
  ['011-birthdays',            birthdays],
  ['012-giving-statements',    givingStatements],
  ['013-public-events',        publicEvents],
  ['014-attendance',           attendance],
  ['015-pledges',              pledges],
  ['016-push-subscriptions',   pushSubscriptions],
  ['017-forms',                forms],
  ['018-form-responses',       formResponses],
  ['019-user-avatar',          avatars],
  ['020-swap-requests',        swapRequests],
  ['021-groups',               groups],
  ['022-event-groups',         eventGroups],
  ['023-church-page',          churchPage],
  ['024-member-unavailability', memberUnavailability],
  ['025-group-interests',      groupInterests],
  ['026-online-giving',        onlineGiving],
  ['027-reminder-source',      reminderSource],
  ['028-reminder-optout',      reminderOptout],
  ['029-reminder-lead',        reminderLead],
  ['030-donation-refund',      donationRefund],
  ['031-recurring-gifts',      recurringGifts],
  ['032-swap-reminded',        swapReminded],
  ['033-perf-indexes',         perfIndexes],
  ['034-checkins',             checkins],
  ['035-checkin-security',     checkinSecurity],
  ['036-rooms',                rooms],
  ['037-kiosk-token',          kioskToken],
  ['038-calendar-liturgical',  calendarLiturgical],
  ['039-parish-feasts',        parishFeasts],
  ['040-org-timezone',         orgTimezone],
  ['041-bulletins',            bulletins],
  ['042-service-plans',        servicePlans],
  ['043-checkin-code-hash',    checkinCodeHash],
  ['044-tenant-fk-guards',     tenantFkGuards],
  ['045-sacramental-records',  sacramentalRecords],
  ['046-mass-intentions',      massIntentions],
  ['047-sacristy-manifest',    sacristyManifest],
  ['048-sacrament-meta',       sacramentMeta],
  ['049-sacramental-drafts',   sacramentalDrafts],
  ['050-donation-payment-ref-unique', donationPaymentRefUnique],
  ['051-feedback-ledger',      feedbackLedger],
  ['052-telemetry-dashboard',  telemetryDashboard],
  ['053-feedback-status',      feedbackStatus],
  ['054-audit-hardening',      auditHardening],
  ['055-session-and-race-guards', sessionAndRaceGuards],
  ['056-manifest-event-id',    manifestEventId],
  ['057-finance-ledger',       financeLedger],
  ['058-diocese-affiliations', dioceseAffiliations],
  ['059-report-submissions',   reportSubmissions],
  ['060-sample-seed-marker',   sampleSeedMarker],
  ['061-pledge-tenant-fk',     pledgeTenantFk],
  ['062-assessments',          assessments],
  ['063-org-ai-provider',      orgAiProvider],
  ['064-daily-checklists',     dailyChecklists],
  ['065-support-system',       supportSystem],
  ['066-coa-offerings-rename', coaOfferingsRename],
  ['067-parish-fee-schedules', parishFeeSchedules],
  ['068-parish-invoices',      parishInvoices],
  ['069-invoice-payments',     invoicePayments],
  ['070-burial-sacrament',     burialSacrament],
]

// Fixed key for the session advisory lock. Any constant works as long as
// it's the same across every process that runs migrations.
const MIGRATION_LOCK_KEY = 727274

// High-water mark for the existing-DB baseline (below). When adopting a
// database that was migrated under the old always-run system (schema present,
// ledger absent), we record migrations as already-applied ONLY through this
// name — the last migration that shipped in the release which introduced the
// ledger. Any migration added in a LATER release sorts after it and is
// deliberately NOT baselined, so it still runs on first adoption instead of
// being silently marked done without ever executing. Update this only when a
// new baseline is intentionally established.
const BASELINE_THROUGH = '042-service-plans'

export async function runAllMigrations() {
  // Run the whole thing on ONE dedicated connection. pg_advisory_lock is
  // SESSION-scoped — bound to the exact backend that acquired it — so the lock
  // and its matching unlock must run on the same client; issuing them via
  // pool.query() (as before) could unlock on a different pooled backend, which
  // silently returns false and leaks the lock. (Through Supabase's
  // transaction-mode pooler even a pinned client is multiplexed per
  // transaction, so the lock is best-effort there; the ledger's
  // ON CONFLICT DO NOTHING idempotency below is the real guard. On a direct
  // session connection — CI and a direct DATABASE_URL — it serializes cleanly.)
  const client = await pool.connect()
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
  try {
    // Probe BEFORE we create anything. `to_regclass` returns NULL (not an
    // error) when a relation is absent, so it's the cheapest way to ask two
    // questions: does the ledger already exist, and does the schema already
    // exist? We key "schema exists" off ochr_clients — a core table present
    // on any database that has ever been migrated.
    const { rows: probe } = await client.query(
      `SELECT to_regclass('public.ochr_schema_migrations') AS ledger,
              to_regclass('public.ochr_clients')           AS clients`
    )
    const ledgerExisted = probe[0].ledger  !== null
    const schemaExisted = probe[0].clients !== null

    // Ledger of applied migrations. Idempotent create. RLS is enabled to
    // satisfy the mandatory ochr_* convention (advisors flag
    // rls_disabled_in_public otherwise). No policy is defined on purpose: this
    // is a server-only bookkeeping table never reached through the tenant API,
    // so RLS-on-with-no-policy (deny-all to non-owner roles) is exactly right.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ochr_schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await client.query('ALTER TABLE ochr_schema_migrations ENABLE ROW LEVEL SECURITY')

    // ADOPTING AN EXISTING DATABASE. If the ledger didn't exist yet but the
    // schema did, this DB has already had every migration applied under the
    // old always-run system. Baseline the ledger by recording ALL current
    // migrations as applied so NONE of them re-run — critically, this stops
    // the destructive one-time backfills (e.g. 001's preferred_language
    // tagging) from firing one final time and reverting admin edits on the
    // first ledgered deploy. A fresh DB (no schema — CI, a new tenant DB)
    // skips this branch and runs the whole chain once, recording as it goes.
    // We baseline only through BASELINE_THROUGH (not the whole current chain),
    // so a migration added in a later release that co-deploys with this
    // adoption still runs instead of being marked applied without executing.
    if (!ledgerExisted && schemaExisted) {
      for (const [name] of MIGRATIONS) {
        await client.query(
          'INSERT INTO ochr_schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          [name]
        )
        if (name === BASELINE_THROUGH) break
      }
    }

    const { rows: applied } = await client.query('SELECT name FROM ochr_schema_migrations')
    const done = new Set(applied.map(r => r.name))

    // Context handed to every migration. Almost all ignore it; 060 needs to
    // know whether this run is standing up a brand-new database (where the
    // demo org was created seconds ago by `base` and still needs its sample
    // data) or adopting one with real history (where every existing org has
    // already had its seeding window and must be stamped so a later deploy
    // can't resurrect cleared data). `schemaExisted` is the probe we already
    // ran above, so this costs nothing extra.
    const ctx = { freshDatabase: !schemaExisted }

    for (const [name, up] of MIGRATIONS) {
      if (done.has(name)) continue
      await up(ctx)
      await client.query(
        'INSERT INTO ochr_schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [name]
      )
    }

    // Demo-org sample seed runs LAST so every column referenced by the
    // seed (e.g. ochr_clients.birth_date from 011) already exists. It stays
    // un-ledgered on purpose — a brand-new demo org created on a later boot
    // still needs seeding, which a one-shot ledger entry would skip forever.
    //
    // Safety now comes from the org itself: seedSampleData() claims
    // ochr_organizations.samples_seeded_at (migration 060) atomically and
    // returns { skipped: true } if it's already stamped. Before 060 the
    // guard keyed off the presence of '[Sample]%' tasks, so clearing sample
    // data made this call re-insert the whole set on the next deploy — see
    // the header of onboarding/sampleSeed.js.
    try {
      const { rows } = await client.query(
        'SELECT id FROM ochr_organizations WHERE slug = $1',
        [DEMO_ORG_SLUG],
      )
      if (rows.length > 0) {
        await seedSampleData(pool, rows[0].id)
      }
    } catch (seedErr) {
      console.error('demo-org sample seed failed (migration continuing):', seedErr)
    }
  } finally {
    // Unlock on the SAME client that holds the session lock, then return it.
    try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]) } catch { /* ignore */ }
    client.release()
  }
}
