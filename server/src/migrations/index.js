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
// serialized by a Postgres advisory lock held in one open transaction for
// the length of the run (see runAllMigrations for why a transaction and not
// a session), so two boots can't race the ledger.

import pool from '../db.js'
import { MIGRATION_NAMES } from './names.js'
import { migrate as baseMigrate, DEMO_ORG_SLUG } from '../migrate.js'
import { seedSampleData } from '../onboarding/sampleSeed.js'
import { seedAppReviewTenant } from '../seed/appReviewTenant.js'
import { monitor } from '../monitoring/index.js'
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
import { up as tenantFkComposites } from './071-tenant-fk-composites.js'
import { up as orgTradition } from './072-org-tradition.js'
import { up as registerAmendments } from './073-register-amendments.js'
import { up as parishCare } from './074-parish-care.js'
import { up as tenantFkRepair } from './075-tenant-fk-repair.js'
import { up as pastoralLead } from './076-pastoral-lead.js'
import { up as staffInvitations } from './077-staff-invitations.js'
import { up as demoWorkspace } from './078-demo-workspace.js'
import { up as continuityVault } from './079-continuity-vault.js'
import { up as rlsSweep }        from './080-rls-sweep.js'
import { up as notificationFairness } from './081-notification-fairness.js'
import { up as migrationStudio } from './082-migration-studio.js'
import { up as importBatchTenantFk } from './083-import-batch-tenant-fk.js'
import { up as importRetention } from './084-import-retention.js'
import { up as importUndo } from './085-import-undo.js'
import { up as fundAccountMapping } from './086-fund-account-mapping.js'
import { up as assessmentBands } from './087-assessment-bands.js'
import { up as parishSetup } from './088-parish-setup.js'
import { up as releaseLog } from './089-release-log.js'
import { up as ledgerExcludesRefunds } from './090-ledger-excludes-refunds.js'
import { up as recurringGiftFailures } from './091-recurring-gift-failures.js'
import { up as recurringRetryAnchor } from './092-recurring-retry-anchor.js'
import { up as orgLocale } from './093-org-locale.js'
import { up as affiliationReinvite } from './094-affiliation-reinvite.js'
import { up as languageLookupIndex } from './095-language-lookup-index.js'
import { up as emailSuppressions } from './096-email-suppressions.js'
import { up as donorEmailLowerIndex } from './097-donor-email-lower-index.js'
import { up as submissionNoOverlap } from './098-submission-no-overlap.js'
import { up as periodAdjustments } from './099-period-adjustments.js'
import { up as aiAccounting } from './100-ai-accounting.js'
import { up as manifestCalendarTenant } from './101-manifest-calendar-tenant.js'
import { up as fulfilledMassStamps } from './102-fulfilled-mass-stamps.js'
import { up as attendedServiceStamps } from './103-attended-service-stamps.js'
import { up as donationRefundFacts } from './104-donation-refund-facts.js'
import { up as periodAdjustmentPerRefund } from './105-period-adjustment-per-refund.js'
import { up as periodAdjustmentCredits } from './106-period-adjustment-credits.js'
import { up as periodAdjustmentAssessableImpact } from './107-period-adjustment-assessable-impact.js'
import { up as periodAdjustmentAssessableUnknown } from './108-period-adjustment-assessable-unknown.js'
import { up as issuedGivingStatements } from './109-issued-giving-statements.js'
import { up as priorFulfilmentLabel } from './110-prior-fulfilment-label.js'
import { up as loginDeactivation } from './111-login-deactivation.js'
import { up as loginClosure } from './112-login-closure.js'
import { up as closureSubjectCopies } from './113-closure-subject-copies.js'
import { up as profileAndOrganizationHold } from './114-profile-and-organization-hold.js'
import { up as billingEventReceipts } from './115-billing-event-receipts.js'
import { up as stage7AiStopAndPlaintextGuard } from './116-stage7-ai-stop-and-plaintext-guard.js'
import { up as neutralizeDemoAdmin } from './117-neutralize-demo-admin.js'
import { up as viewsSecurityInvoker } from './118-views-security-invoker.js'
import { up as closedAddressSuppression } from './119-closed-address-suppression.js'

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
  ['071-tenant-fk-composites', tenantFkComposites],
  ['072-org-tradition',        orgTradition],
  ['073-register-amendments',  registerAmendments],
  ['074-parish-care',          parishCare],
  ['075-tenant-fk-repair',     tenantFkRepair],
  ['076-pastoral-lead',        pastoralLead],
  ['077-staff-invitations',    staffInvitations],
  ['078-demo-workspace',       demoWorkspace],
  ['079-continuity-vault',     continuityVault],
  ['080-rls-sweep',            rlsSweep],
  ['081-notification-fairness', notificationFairness],
  ['082-migration-studio',     migrationStudio],
  ['083-import-batch-tenant-fk', importBatchTenantFk],
  ['084-import-retention',     importRetention],
  ['085-import-undo',          importUndo],
  ['086-fund-account-mapping', fundAccountMapping],
  ['087-assessment-bands',     assessmentBands],
  ['088-parish-setup',         parishSetup],
  ['089-release-log',          releaseLog],
  ['090-ledger-excludes-refunds', ledgerExcludesRefunds],
  ['091-recurring-gift-failures', recurringGiftFailures],
  ['092-recurring-retry-anchor', recurringRetryAnchor],
  ['093-org-locale', orgLocale],
  ['094-affiliation-reinvite', affiliationReinvite],
  ['095-language-lookup-index', languageLookupIndex],
  ['096-email-suppressions', emailSuppressions],
  ['097-donor-email-lower-index', donorEmailLowerIndex],
  ['098-submission-no-overlap', submissionNoOverlap],
  ['099-period-adjustments', periodAdjustments],
  ['100-ai-accounting', aiAccounting],
  ['101-manifest-calendar-tenant', manifestCalendarTenant],
  ['102-fulfilled-mass-stamps',    fulfilledMassStamps],
  ['103-attended-service-stamps',  attendedServiceStamps],
  ['104-donation-refund-facts',    donationRefundFacts],
  ['105-period-adjustment-per-refund', periodAdjustmentPerRefund],
  ['106-period-adjustment-credits', periodAdjustmentCredits],
  ['107-period-adjustment-assessable-impact', periodAdjustmentAssessableImpact],
  ['108-period-adjustment-assessable-unknown', periodAdjustmentAssessableUnknown],
  ['109-issued-giving-statements', issuedGivingStatements],
  ['110-prior-fulfilment-label', priorFulfilmentLabel],
  ['111-login-deactivation', loginDeactivation],
  ['112-login-closure', loginClosure],
  ['113-closure-subject-copies', closureSubjectCopies],
  ['114-profile-and-organization-hold', profileAndOrganizationHold],
  ['115-billing-event-receipts', billingEventReceipts],
  ['116-stage7-ai-stop-and-plaintext-guard', stage7AiStopAndPlaintextGuard],
  ['117-neutralize-demo-admin', neutralizeDemoAdmin],
  ['118-views-security-invoker', viewsSecurityInvoker],
  ['119-closed-address-suppression', closedAddressSuppression],
]

// names.js carries this same chain for /api/health, which needs the names
// without paying to import ninety-odd migration modules on a cold start.
// Two lists is two things to forget, so the drift is caught here rather
// than discovered as a health check quietly reporting the wrong head.
{
  const here = MIGRATIONS.map(([name]) => name)
  const drift = here.length !== MIGRATION_NAMES.length ||
                here.some((name, i) => name !== MIGRATION_NAMES[i])
  if (drift) {
    throw new Error(
      'migrations/names.js is out of step with the MIGRATIONS chain. ' +
      `index.js has ${here.length} entries ending '${here.at(-1)}'; ` +
      `names.js has ${MIGRATION_NAMES.length} ending '${MIGRATION_NAMES.at(-1)}'. ` +
      'Add the migration to BOTH.'
    )
  }
}

// Fixed key for the advisory lock. Any constant works as long as it's the
// same across every process that runs migrations.
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

// Postgres error codes that mean "another runner created this object between
// our IF NOT EXISTS check and our CREATE". They are not schema errors — they
// are the signature of two migration runs overlapping.
//
// Overlap was possible despite the advisory lock: until 8 Sep it was a
// SESSION lock, which a transaction-mode pooler could not keep on one backend
// (see the note in runAllMigrations), and `node --watch` restarts can leave
// the outgoing process still migrating while the incoming one starts. That
// is exactly what happened to 084 on 2026-08-20 — CREATE INDEX IF NOT EXISTS
// is a check and a create, not one atomic step, so both runs passed the
// check and the loser raised 23505 on pg_class_relname_nsp_index. The lock
// now holds through the pooler too, but this stays: it costs nothing when
// the lock works and is the only net under it if it ever does not.
const CONCURRENT_DDL_CODES = new Set([
  '23505', // unique_violation — typically pg_class_relname_nsp_index
  '42P07', // duplicate_table (indexes live in pg_class too)
  '42710', // duplicate_object
  '42701', // duplicate_column
])

// Run one migration, tolerating a loss to a concurrent runner but never
// tolerating a genuine failure.
//
// On a collision we do NOT assume the other runner finished the job. We
// re-read the ledger: if the other run recorded the migration, it completed
// and we can move on. If it did not, we retry the up() once — by then the
// objects it raced us over exist, so the IF NOT EXISTS clauses no-op and the
// remainder applies. A second failure is real and propagates.
async function applyMigration(db, name, up, ctx) {
  try {
    await up(ctx)
    return
  } catch (err) {
    if (!CONCURRENT_DDL_CODES.has(err?.code)) throw err

    const { rows } = await db.query(
      'SELECT 1 FROM ochr_schema_migrations WHERE name = $1', [name])
    if (rows.length > 0) {
      console.log(`  ${name}: applied concurrently by another runner — continuing.`)
      return
    }

    console.warn(`  ${name}: lost a DDL race (${err.code}); retrying once.`)
    await up(ctx)
  }
}

export async function runAllMigrations({ appReviewEnv } = {}) {
  // THE LOCK LIVES IN A TRANSACTION, AND ONLY THE LOCK (8 Sep).
  //
  // It used to be a SESSION lock (pg_advisory_lock) taken on a pinned
  // client and released on the same client. On a direct connection that is
  // sound. Through a transaction-mode pooler — Supabase's 6543, which is
  // what production's DATABASE_URL is — it is not: the pooler hands the
  // pinned client a backend per TRANSACTION, and a client between
  // statements is between transactions, so whenever other traffic exists
  // the backend under it changes mid-run. The unlock then ran on a backend
  // that never held the lock ("you don't own a lock of type
  // ExclusiveLock"), returned false, and the lock stayed granted to an idle
  // pooled backend. Every runner after that hung on pg_advisory_lock until
  // the pooler happened to recycle that backend. Reproduced through
  // PgBouncer 1.22 in transaction mode with churn traffic: 4 of 6 runs left
  // the next runner blocked indefinitely, 1 of 6 let it in without
  // exclusion.
  //
  // So: BEGIN, take a TRANSACTION-scoped lock (pg_advisory_xact_lock), keep
  // that transaction open for the whole run, COMMIT at the end. A
  // transaction pins one backend under transaction pooling, so the lock
  // lives on exactly one backend for exactly as long as the run — and it
  // cannot leak: COMMIT, ROLLBACK, a dead process or a dead backend all
  // release it. On a direct connection nothing observable changes: runs
  // serialise as before.
  //
  // NOTHING ELSE GOES IN THAT TRANSACTION. Every write that must PERSIST
  // regardless of a later failure — the ledger table, each per-migration
  // ledger row, the baseline — and every read that must see the latest
  // committed state goes through `pool` (autocommit), not the pinned client.
  // That is what keeps today's resumability: a failure in migration N rolls
  // back nothing but the lock, and the ledger still says 1..N-1 are done.
  // The pinned client also touches no table, so it holds no relation lock
  // that could block a migration's DDL on another connection.
  //
  // (If a deployment sets idle_in_transaction_session_timeout shorter than a
  // cold migration run, the lock holder is killed and COMMIT fails loudly —
  // a visible failure, not a silent one, and the ledger is intact.)
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY])

    // Probe BEFORE we create anything. `to_regclass` returns NULL (not an
    // error) when a relation is absent, so it's the cheapest way to ask two
    // questions: does the ledger already exist, and does the schema already
    // exist? We key "schema exists" off ochr_clients — a core table present
    // on any database that has ever been migrated. Through the pool, not the
    // lock's transaction: it must see what the runner we just waited for
    // committed.
    const { rows: probe } = await pool.query(
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ochr_schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await pool.query('ALTER TABLE ochr_schema_migrations ENABLE ROW LEVEL SECURITY')

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
        await pool.query(
          'INSERT INTO ochr_schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          [name]
        )
        if (name === BASELINE_THROUGH) break
      }
    }

    const { rows: applied } = await pool.query('SELECT name FROM ochr_schema_migrations')
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
      await applyMigration(pool, name, up, ctx)
      await pool.query(
        'INSERT INTO ochr_schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [name]
      )
    }

    // The ledger is only honest if every migration we were asked to run is in
    // it. A gap here means one was skipped without raising — the failure mode
    // that leaves a database serving traffic on a schema nobody verified.
    const { rows: ledgerNow } = await pool.query('SELECT name FROM ochr_schema_migrations')
    const recorded = new Set(ledgerNow.map(r => r.name))
    const missing = MIGRATIONS.map(([n]) => n).filter(n => !recorded.has(n))
    if (missing.length > 0) {
      throw new Error(`Migrations finished but are absent from the ledger: ${missing.join(', ')}`)
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
      const { rows } = await pool.query(
        'SELECT id, tradition FROM ochr_organizations WHERE slug = $1',
        [DEMO_ORG_SLUG],
      )
      if (rows.length > 0) {
        // TRAD.2 — the demo org is stamped 'episcopal' by migration 072,
        // so its sample data speaks Episcopal too rather than seeding
        // Fellowship Hall into a parish whose fixture says Vestry.
        await seedSampleData(pool, rows[0].id, rows[0].tradition)
      }
    } catch (seedErr) {
      console.error('demo-org sample seed failed (migration continuing):', seedErr)
    }

    // Ending the transaction is what releases the lock; there is no unlock
    // call to land on the wrong backend. The transaction wrote nothing, so
    // COMMIT and ROLLBACK differ only in intent — COMMIT on the way out
    // because that is the honest word for "the run finished".
    await client.query('COMMIT')
  } catch (err) {
    // A failed run releases the lock the same way. If the backend under the
    // transaction is already gone, so is the lock — nothing to do.
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // App Review sandbox (OC-READY-01-010) runs only AFTER the schema run has
  // committed and released its lock. It is optional operator setup, not
  // schema: its outcome is reported on its own line and returned, and it
  // can neither turn a finished migration into "FATAL: migrations failed"
  // nor hold the migration lock while it writes.
  const appReviewSeed = await runAppReviewSeedAfterMigrations(pool, appReviewEnv)
  return { appReviewSeed }
}

// The App Review seed, separated from schema truth.
//
// Flag off → { status: 'skipped' } and nothing is printed (production).
// Created / already present → one informational line.
// Refused (a named gate said no) or failed (anything else threw) → a loud
// block on stderr plus monitor.error, and the outcome is returned so a
// caller that WANTS a hard stop (the explicit seed script) can have one.
// It never throws: the schema run it follows has already committed, and
// reporting a seed problem as a migration failure would be false.
export async function runAppReviewSeedAfterMigrations(db = pool, env) {
  let outcome
  try {
    const result = env === undefined
      ? await seedAppReviewTenant(db)
      : await seedAppReviewTenant(db, env)
    if (result.reason === 'flag_off') return { status: 'skipped', reason: 'flag_off' }
    outcome = {
      status: result.seeded ? 'created' : 'already_exists',
      reason: result.reason,
      organizationSlug: result.organizationSlug,
    }
    console.log(`App Review seed: ${outcome.status} ('${outcome.organizationSlug}').`)
    return outcome
  } catch (err) {
    outcome = {
      status: err?.reason ? 'refused' : 'failed',
      reason: err?.reason || 'error',
      message: err?.message || String(err),
    }
  }
  console.error([
    '',
    `APP REVIEW SEED ${outcome.status.toUpperCase()}: ${outcome.reason}`,
    `  ${outcome.message}`,
    '  The schema migrations above completed and are ledgered; this is only the',
    '  optional App Review sandbox requested by SEED_APP_REVIEW_TENANT.',
    '',
  ].join('\n'))
  monitor.error('migrations.app_review_seed', new Error(`${outcome.status}: ${outcome.reason}`))
  return outcome
}
