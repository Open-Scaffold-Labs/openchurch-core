// Express app factory — constructs and exports the app without listening.
//
// Two consumers:
//   - `server/src/index.js` imports this, calls `app.listen()` for local
//     dev (`npm run dev` / `npm start`).
//   - `api/[...path].js` at the repo root imports this and exports it as
//     a Vercel serverless function handler.
//
// Migrations are NOT run at import time — serverless cold-starts would
// hammer the DB. They're run from `server/src/migrate-cli.js` (invoked
// manually, via a GitHub Action, or in local dev by index.js).

import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import pool from './db.js'
import { dbIdentity, UNKNOWN_IDENTITY } from './monitoring/dbIdentity.js'
import { paymentsProvider, paymentsConfigured, paymentsCanMoveMoney, paymentsWebhookReady, stubWouldFakeMoney } from './payments/index.js'
import { EXPECTED_MIGRATION } from './migrations/names.js'
import { appliedMigration } from './migrations/applied.js'
import { requireSuperAdmin } from './middleware/superAdmin.js'
import { requireAuth, gateMutations, requireRole, requireOrgType } from './middleware/auth.js'
import { isAllowedOrigin, rejectCrossSiteMutation } from './auth/sessionCookie.js'
import {
  CONTENT_SECURITY_POLICY_REPORT_ONLY,
  PERMISSIONS_POLICY,
  REFERRER_POLICY,
} from './security/browserPolicies.js'
import { auditLog } from './middleware/auditLog.js'
import authRouter from './routes/auth.js'
import clientsRouter from './routes/clients.js'
import eventsRouter from './routes/events.js'
import scheduleRouter from './routes/schedule.js'
import aiRouter from './routes/ai.js'
import tasksRouter from './routes/tasks.js'
import calendarRouter from './routes/calendar.js'
import availabilityRouter from './routes/availability.js'
import checkinsRouter from './routes/checkins.js'
import roomsRouter from './routes/rooms.js'
import payrollRouter from './routes/payroll.js'
import donationsRouter from './routes/donations.js'
import notificationsRouter from './routes/notifications.js'
import liturgicalRouter from './routes/liturgical.js'
import packetRouter from './routes/packet.js'
import parishFeastsRouter from './routes/parishFeasts.js'
import bulletinsRouter from './routes/bulletins.js'
import servicePlansRouter from './routes/servicePlans.js'
import {
  publicRouter as calendarSyncPublicRouter,
  authRouter as calendarSyncAuthRouter,
} from './routes/calendarSync.js'
import searchRouter from './routes/search.js'
import onboardingRouter from './routes/onboarding.js'
import { recordRelease, releaseInfo } from './release/log.js'
import setupRouter from './routes/setup.js'
import usersRouter from './routes/users.js'
import {
  publicRouter as billingPublicRouter,
  authRouter   as billingAuthRouter,
} from './routes/billing.js'
import auditLogRouter from './routes/auditLog.js'
import vaultRouter from './routes/vault.js'
import givingStatementsRouter from './routes/givingStatements.js'
import organizationRouter from './routes/organization.js'
import insightsRouter from './routes/insights.js'
import publicEventsRouter from './routes/publicEvents.js'
import attendanceRouter from './routes/attendance.js'
import pledgesRouter from './routes/pledges.js'
import sacramentsRouter from './routes/sacraments.js'
import massIntentionsRouter from './routes/massIntentions.js'
import financeRouter from './routes/finance.js'
import dioceseRouter from './routes/diocese.js'
import reportsRouter from './routes/reports.js'
import dioceseCareRouter from './routes/dioceseCare.js'
import dioceseRegionsRouter from './routes/dioceseRegions.js'
import affiliationRouter from './routes/affiliation.js'
import assessmentsRouter from './routes/assessments.js'
import checklistsRouter from './routes/checklists.js'
import feedbackRouter, { adminRouter as feedbackAdminRouter } from './routes/feedback.js'
import supportTicketsRouter from './routes/supportTickets.js'
import assistantRouter from './routes/assistant.js'
import aiSwitchRouter from './routes/aiSwitch.js'
import notificationPrefsRouter from './routes/notificationPrefs.js'
import unsubscribeRouter from './routes/unsubscribe.js'
import emailWebhookRouter from './routes/emailWebhook.js'
import pushRouter from './routes/push.js'
import notificationsAdminRouter from './routes/notificationsAdmin.js'
import dailyVerseRouter from './routes/dailyVerse.js'
import maintenanceRouter from './routes/maintenance.js'
import cronRouter from './routes/cron.js'
import formsRouter from './routes/forms.js'
import publicFormsRouter from './routes/publicForms.js'
import { swapPublicRouter, swapAdminRouter } from './routes/swap.js'
import groupsRouter from './routes/groups.js'
import connectRouter from './routes/connect.js'
import fundsRouter from './routes/funds.js'
import { kioskAdminRouter, kioskPublicRouter } from './routes/kiosk.js'
import feeSchedulesRouter from './routes/feeSchedules.js'
import invoicesRouter from './routes/invoices.js'
import importsRouter from './routes/imports.js'
import { maskPath } from './utils/redact.js'

const app = express()

// Trust the first proxy hop so req.ip / X-Forwarded-For resolve to the
// real client IP. Vercel terminates TLS at its edge and forwards; without
// this, every rate-limit key would collapse to the same internal IP.
app.set('trust proxy', 1)
// ARG-LEAK-3: don't advertise the framework.
app.disable('x-powered-by')

// CORS allowlist (audit H10). Origins come from CLIENT_URL,
// DIOCESE_CLIENT_URL, and CORS_ORIGINS. Requests with no Origin header
// (curl, server-to-server, same-origin PWA fetches) pass — CORS only
// governs browsers doing cross-origin reads. Outside production,
// localhost dev servers are allowed so dev "just works" with no env
// setup. credentials: true is required so the browser will accept and
// send the httpOnly session cookie on credentialed fetches.
app.use(cors({
  credentials: true,
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true)
    return cb(null, false) // not an error — just no CORS headers for this origin
  },
}))

// Security headers (audit H10) — hand-set, no new dependency. HSTS is
// meaningful only behind TLS, which Vercel guarantees in production.
//
// OC-READY-01-014 adds Content-Security-Policy-Report-Only and a
// conservative Permissions-Policy. HARD: do not set Content-Security-Policy
// (Enforce) here. Report-Only is the only CSP mode this PR ships; flipping
// to Enforce is a separate decision after reports are reviewed.
// Session/cookie auth is unchanged — this middleware only calls res.set.
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('X-Frame-Options', 'DENY')
  res.set('Referrer-Policy', REFERRER_POLICY)
  res.set('Content-Security-Policy-Report-Only', CONTENT_SECURITY_POLICY_REPORT_ONLY)
  res.set('Permissions-Policy', PERMISSIONS_POLICY)
  // ARG-LEAK-3: API responses carry session tokens, giving data and
  // whole-parish exports; no browser or shared cache may keep them. A
  // route that wants caching (e.g. a public feed) can still override.
  if (_req.path.startsWith('/api')) {
    res.set('Cache-Control', 'no-store')
    res.set('Pragma', 'no-cache')
  }
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
})

// Billing webhook MUST mount before express.json() — most providers
// sign the raw bytes of the body, so consuming-then-reparsing as JSON
// breaks signature verification. The webhook router uses its own
// express.raw() to capture the body as a Buffer.
app.use('/api/billing', billingPublicRouter)

// Email delivery events (bounces, complaints). Mounts here for the same
// reason the billing webhook does: the provider signs the raw bytes, so
// this router must see them before express.json() consumes the stream.
app.use('/api/email', emailWebhookRouter)

// 10 MB is generous for JSON bodies but necessary for CSV-member-import
// payloads, which can run several MB for big churches. Tenant routes
// are authed so there's no unauth'd DoS vector through this limit.
app.use(express.json({ limit: '10mb' }))

// Cookie CSRF belt: SameSite=Lax is the strategy (see sessionCookie.js).
// This refuses a cookie-bearing mutation whose Origin is present and
// not on the allowlist — CORS hides the response from a foreign page;
// this refuses the write.
app.use(rejectCrossSiteMutation)

// Health check (H.1) — a real probe: ping the DB and report which
// payments provider is live (stub vs a real one). 503 if the DB is
// unreachable OR its schema is behind the migration this build expects,
// so a load balancer / uptime monitor can react to either.
//
// It also answers the release-truth question (RELIABILITY 1.1): which
// commit is running, in which environment, with which migrations
// applied. Before this, "what version is in production?" could only be
// answered from somebody's memory of a deploy, and a claim nobody can
// check is a claim that quietly goes stale.
//
// `commit` is whatever the platform put in the environment — Vercel sets
// VERCEL_GIT_COMMIT_SHA on every build. When nothing set it, this
// reports the string 'unknown' rather than omitting the field or
// inventing a value: a build that cannot say what it is must say so.
//
// Nothing here is a secret. The commit is public (the snapshot repo is
// public), the environment name is not sensitive, and the migration name
// is already visible in the repository.
// Defined in release/log.js and imported here, not copied. index.js needs
// the same three values to write the release row, and two copies of "how
// this build names itself" is two places to drift — one of which would
// then be silently logging a different commit than /health reports.


// One stderr line when the health probe cannot ask the database.
// `stage` is `ping` (SELECT 1) or `ledger` (appliedMigration()).
// `code` is a five-character SQLSTATE, one of the network codes below,
// or the literal `unknown`. Message, stack, detail, hint, where, and
// the connection string are not fields on this line.
const HEALTH_DB_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
])

function healthDbFailureCode(err) {
  const code = typeof err?.code === 'string' ? err.code : ''
  if (/^[0-9A-Z]{5}$/.test(code)) return code
  if (HEALTH_DB_NETWORK_CODES.has(code)) return code
  return 'unknown'
}

function logHealthDbFailure(stage, err) {
  console.error(JSON.stringify({
    event: 'health_db',
    stage,
    code: healthDbFailureCode(err),
  }))
}

// The ping doubles as the identity probe: the database and schema the
// fingerprint names come from this exact successful round trip.
export const HEALTH_PING_SQL = 'SELECT current_database() AS database, current_schema() AS schema'

async function healthHandler(_req, res) {
  let db = 'ok'
  let migration = 'unknown'
  let probe = null
  try {
    const r = await pool.query(HEALTH_PING_SQL)
    const row = r?.rows?.[0]
    probe = row ? { database: row.database, schema: row.schema } : null
  } catch (err) {
    logHealthDbFailure('ping', err)
    db = 'error'
  }
  // Serverless never calls runAllMigrations(), so this is where a
  // Vercel cold start gets itself into the release log. Once per
  // process, fire-and-forget, and every failure swallowed inside —
  // bookkeeping about deploys must never be why a health check answers
  // 503. A ping that failed never starts it.
  if (db === 'ok') {
    recordRelease(releaseInfo()).catch(() => {})
    // The applied migration is the other half of "what is running": the
    // code and the schema can disagree, and that disagreement is exactly
    // what a bad deploy looks like.
    //
    // Bounded to the migrations THIS BUILD ships — see
    // migrations/applied.js for why, and for the `999-race-sim` row in
    // production that made it necessary. The same function answers for
    // release/log.js, so the two can no longer drift apart.
    //
    // A throw here is still a database failure on the public payload —
    // the same 503, db 'error', schema 'unknown' the single catch used
    // to return. The log is the only place the stage is named.
    try {
      migration = (await appliedMigration()) ?? migration
    } catch (err) {
      logHealthDbFailure('ledger', err)
      db = 'error'
    }
  }
  // The verdict has to READ the disagreement it reports. Both migration
  // fields were already in the payload, but `status` and the HTTP code came
  // from the ping alone — so a database at 098 under code at 099 answered
  // 200 {status:'ok'} while every route touching the 099 table answered
  // 500 (reproduced 8 Sep). prod-health.yml reads `status` and `db` and
  // nothing else; a monitor that is told "ok" by the one field it reads is
  // a monitor that has been switched off. Schema behind code is degraded,
  // and degraded is 503, same as an unreachable database: the deploy runs
  // migrations before the code goes live, so on a good deploy these agree,
  // and a 503 here means the deploy did not do what it said.
  //
  // Only judged when the ping succeeded — with db 'error' the migration is
  // 'unknown', which is the database's fault, not the schema's, and the
  // payload should not blame both.
  const schema = db !== 'ok' ? 'unknown' : migration === EXPECTED_MIGRATION ? 'ok' : 'behind'
  const healthy = db === 'ok' && schema === 'ok'
  // A failed probe (ping OR ledger) never claims an identity.
  const db_identity = db === 'ok' ? dbIdentity(process.env.DATABASE_URL, probe) : UNKNOWN_IDENTITY
  res.status(healthy ? 200 : 503).json({
    status:            healthy ? 'ok' : 'degraded',
    db,
    // Which half is wrong. `db` already says whether the database answered;
    // this says whether what it holds is what this build expects, so a
    // reader of a 503 does not have to compare the two migration fields
    // below by eye to find out.
    schema,
    payments_provider: paymentsProvider(),
    // 'stub' above means two different things: somebody chose the stub, or
    // nobody chose anything — and production is the latter (the public
    // give page reports giving_enabled:false). This is the one that says
    // which. Same predicate the public route refuses on.
    payments_configured: paymentsConfigured(),
    // SELECTED → CONFIGURED → CAPABLE → SAFE. Four different questions, and
    // the first two were the only ones answerable from this payload.
    //
    //   payments_provider   — what was selected. 'stripe' here means
    //                         somebody typed stripe, nothing more.
    //   payments_configured — whether anybody chose at all.
    //   payments_capable    — whether THIS deployment could actually move
    //                         money right now AND record that it did: a
    //                         real provider, the credentials it needs, and
    //                         a webhook receiver that can verify what the
    //                         provider sends back. Stripe without
    //                         PAYMENTS_PROVIDER_SECRET is selected and
    //                         configured and cannot charge anything; Stripe
    //                         without BILLING_WEBHOOK_SECRET charges and
    //                         then cannot write the row (see
    //                         payments_webhook_ready).
    //   payments_safe       — whether a synthetic charge could be recorded
    //                         as a received gift here. False is the alarm:
    //                         it means the stub is running on a deployment
    //                         that is real, and the public give route is
    //                         refusing for that reason.
    //
    // Giving is ENABLED per parish, not per deployment (ochr_funds.active +
    // the org's own configuration), so it is deliberately absent here — the
    // per-parish answer lives on /api/public/:slug/funds as giving_enabled.
    // A deployment-wide "giving enabled" would be a fifth thing that is not
    // true of any particular church.
    payments_capable: paymentsCanMoveMoney(),
    // The webhook half of "capable", on its own, so an operator reading
    // capable:false can see WHICH half is missing. A live gift is recorded
    // by the provider's webhook and nothing else (payments/index.js,
    // recordDonationCheckoutCompleted); a receiver with no signing secret
    // refuses every delivery, and the provider keeps retrying into it for
    // three days before giving up.
    payments_webhook_ready: paymentsWebhookReady(),
    payments_safe: !stubWouldFakeMoney(),
    ...releaseInfo(),
    migration,
    // What the code expects to be applied. Reporting only the applied name
    // makes a reader hold the repo in their head to judge it; reporting both
    // makes a schema-behind-code deploy visible in the payload itself.
    migration_expected: EXPECTED_MIGRATION,
    // Which database answered — non-secret, versioned, diagnostic only.
    // docs/HEALTH-DB-IDENTITY.md
    db_identity,
  })
}
app.get('/health', healthHandler)
// Vercel strips the /api prefix when routing into a serverless function,
// so /api/health arrives here as /health. Expose both paths so local dev
// (no prefix stripping) and production (stripped) both work.
app.get('/api/health', healthHandler)

// Auth endpoints — signup/login are public; /me enforces its own auth.
app.use('/api/auth', authRouter)

// The ICS subscription feed is a capability URL (token in the path) and
// must stay public — calendar apps can't send Authorization headers. It
// is mounted BEFORE requireAuth is applied to the rest of calendar-sync.
app.use('/api/calendar-sync', calendarSyncPublicRouter)
// Public events feed (Sprint P). Unauthenticated — parishioners can
// hit this without an account. Privacy boundary is enforced at the
// query layer: every endpoint filters ochr_events.is_public = TRUE
// and joins ochr_organizations on the URL slug.
app.use('/api/public',        publicEventsRouter)
// Public forms surface (Sprint Forms / F.1). Unauthenticated. The
// router gates on is_public AND status='open' at the query layer
// and rate-limits the submit endpoint per-IP. Mounted at a more
// specific prefix than publicEventsRouter so the route trees
// don't collide.
app.use('/api/public/forms',  publicFormsRouter)
app.use('/api/swap',          swapPublicRouter)
// Self-serve kiosk (CHK.7). Unauthenticated — a tablet at the church
// entrance hits this with only the per-org kiosk token in the path.
// The router resolves the org from the token, 404s on a bad one, and
// rate-limits the check-in endpoint per-IP.
app.use('/api/kiosk',         kioskPublicRouter)
// One-click unsubscribe (RFC 8058). Public — the List-Unsubscribe header
// in every notification points here, and a mail client acting on it has
// no session to present. Authorisation is the HMAC in the path, which
// authorises exactly one thing: turning off one notification type for
// one user. Mounted before requireAuth for the same reason the calendar
// feed is.
app.use('/api/unsubscribe',   unsubscribeRouter)

// Every tenant-scoped route requires a valid JWT. The middleware attaches
// req.user and req.organizationId so handlers can filter queries by org.
//
// gateMutations(...) lets viewers READ but blocks them from writing —
// applied to the routers where viewers should see the content but not
// change it. The onboarding router (clear-samples is destructive) is
// admin-only.
const writeGate = gateMutations('admin', 'staff')
const adminGate = gateMutations('admin')

app.use('/api/clients',       requireAuth, writeGate, auditLog('client'), clientsRouter)
app.use('/api/groups',        requireAuth, writeGate, auditLog('group'),  groupsRouter)
app.use('/api/connect',       requireAuth, writeGate, auditLog('group_interest'), connectRouter)
app.use('/api/funds',         requireAuth, writeGate, auditLog('fund'), fundsRouter)
// Offerings & fees (BILL.0/BILL.1) — the fee catalog + invoice workbench.
// writeGate: staff draft, issue, and record payments (the office's daily
// work); waive and refund are admin-only INSIDE the router (requireRole on
// those routes — pastor's discretion, per the locked staff/admin split).
// Vocabulary rule stands everywhere downstream: sacraments are never sold.
app.use('/api/fee-schedules', requireAuth, writeGate, auditLog('fee_schedule'), feeSchedulesRouter)
app.use('/api/invoices',      requireAuth, writeGate, auditLog('invoice'), invoicesRouter)
app.use('/api/events',        requireAuth, writeGate, auditLog('event'),  eventsRouter)
// Attendance (Sprint T) nested under events. Reads + writes go
// through the same writeGate (staff+admin can mark; viewers read-
// only). Tenant scoping enforced inside the router via
// eventForOrg().
app.use('/api/events/:id/attendance', requireAuth, writeGate, auditLog('attendance'), attendanceRouter)
app.use('/api/schedule',      requireAuth, writeGate, scheduleRouter)
// Parish capabilities only: a diocese session is refused until an approved
// diocese capability is wired (TARS #280 disposition 8).
app.use('/api/ai',            requireAuth, requireOrgType('parish'), writeGate, aiRouter)
app.use('/api/tasks',         requireAuth, writeGate, auditLog('task'),   tasksRouter)
app.use('/api/calendar',      requireAuth, writeGate, auditLog('calendar_event'), calendarRouter)
app.use('/api/availability',  requireAuth, writeGate, auditLog('availability'), availabilityRouter)
app.use('/api/checkins',      requireAuth, writeGate, auditLog('checkin'), checkinsRouter)
app.use('/api/rooms',         requireAuth, writeGate, auditLog('room'), roomsRouter)
// Kiosk token management (CHK.7). Admin-only — minting/revoking a
// capability URL that exposes the member list for self check-in is a
// privileged act. Audited so a rotate/revoke leaves an actor trail.
app.use('/api/kiosk-admin',   requireAuth, requireRole('admin'), auditLog('kiosk'), kioskAdminRouter)
app.use('/api/swap-admin',    requireAuth, writeGate, auditLog('swap_request'), swapAdminRouter)
app.use('/api/payroll',       requireAuth, writeGate, auditLog('payroll'),  payrollRouter)
app.use('/api/donations',     requireAuth, writeGate, auditLog('donation'), donationsRouter)
app.use('/api/sacraments',    requireAuth, writeGate, auditLog('sacrament'), sacramentsRouter)
app.use('/api/mass-intentions', requireAuth, writeGate, auditLog('mass_intention'), massIntentionsRouter)
app.use('/api/finance',       requireAuth, writeGate, auditLog('finance'), financeRouter)
app.use('/api/checklists',    requireAuth, writeGate, auditLog('checklist'), checklistsRouter)
// DIO.1 — the diocese umbrella. requireOrgType hard-gates the diocese
// surface (reads included); the parish-side affiliation panel is
// admin-write because affiliation is an org-level covenant.
// RPT.1 — tradition-specific reporting. Read-only, so no writeGate; any
// signed-in role may run it, because the person who reconciles the numbers
// is often not the person who can edit them.
app.use('/api/reports',       requireAuth, reportsRouter)

// CARE.1 — Parish Care. Mounted ABOVE the general diocese router so
// /api/diocese/care/* resolves here, and behind the same requireOrgType
// gate: a parish token gets 403 on every path, reads included.
app.use('/api/diocese/care', requireAuth, requireOrgType('diocese'), writeGate, auditLog('parish_care'), dioceseCareRouter)
app.use('/api/diocese/regions', requireAuth, requireOrgType('diocese'), writeGate, auditLog('diocese_region'), dioceseRegionsRouter)

app.use('/api/diocese/assessments', requireAuth, requireOrgType('diocese'), writeGate, auditLog('assessment'), assessmentsRouter)
app.use('/api/diocese',       requireAuth, requireOrgType('diocese'), writeGate, auditLog('diocese'), dioceseRouter)
app.use('/api/affiliation',   requireAuth, adminGate, auditLog('affiliation'), affiliationRouter)
// Feedback — any authenticated role may submit (no writeGate); org/email/role
// come from the verified JWT, so there's nothing to gate on beyond auth.
app.use('/api/feedback',      requireAuth, feedbackRouter)
// Founder-only workbench: env-matched email or 404. Deliberately NOT
// behind writeGate/roles — tenant roles don't exist at this layer.
app.use('/api/admin/feedback', requireAuth, requireSuperAdmin, feedbackAdminRouter)
// Support tickets (SUP.2) — like feedback, NO writeGate: a viewer must be
// able to report a problem. Triage mutations are role-checked in-handler
// (parish admin / vendor); every 2xx mutation is audited.
app.use('/api/support-tickets', requireAuth, auditLog('support_ticket'), supportTicketsRouter)
// Migration Studio (MIG.1) — staged, human-reviewed imports. writeGate:
// staff prepare and review; the COMMIT is admin-only inside the router.
// Every upload, mapping, decision, and commit is audited.
app.use('/api/imports',       requireAuth, writeGate, auditLog('import_batch'), importsRouter)
// In-app assistant (SUP.3) — every signed-in role may ask (viewers get
// stuck too). Per-org daily cap inside the route; no writeGate because
// the only "mutation" is the assistant's own usage log.
app.use('/api/assistant',     requireAuth, requireOrgType('parish'), assistantRouter)
// Platform AI stop (Stage 7): operator seats only, 404 otherwise.
app.use('/api/admin/ai-switch', requireAuth, aiSwitchRouter)
app.use('/api/notifications', requireAuth, writeGate, notificationsRouter)
app.use('/api/liturgical',    requireAuth, liturgicalRouter)
// The Sunday Packet (SPK.1) — read-only aggregation; any signed-in role
// can print it (that's the point: the secretary, not just admins).
app.use('/api/packet',        requireAuth, packetRouter)
// Parish feasts (LIT.5) — a church's own liturgical days, layered over
// the universal calendar. Admin-only writes (adminGate = gateMutations
// 'admin'); reads stay open to any authenticated org member so the
// kiosk, dashboard, and schedule can render the feast name. Audited
// so a feast add/remove leaves an actor trail.
app.use('/api/parish-feasts', requireAuth, adminGate, auditLog('parish_feast'), parishFeastsRouter)
// Weekly bulletin (BUL.1) — admin-only publishing surface. Audited so
// edits to what the parish reads leave an actor trail.
app.use('/api/bulletins',     requireAuth, requireRole('admin'), auditLog('bulletin'), bulletinsRouter)
// Service Planner (SVC.1) — order of worship. writeGate so worship staff
// (not just admins) can build the run-sheet; viewers read it. Audited.
app.use('/api/service-plans', requireAuth, writeGate, auditLog('service_plan'), servicePlansRouter)
app.use('/api/calendar-sync', requireAuth, writeGate, calendarSyncAuthRouter)
app.use('/api/search',        requireAuth, searchRouter)
app.use('/api/onboarding',    requireAuth, adminGate, onboardingRouter)

// Getting settled. NOT adminGate, and deliberately NOT writeGate either.
//
// The orientation is for whoever just arrived, and the treasurer invited
// in March is exactly the reader it was written for. writeGate allows
// only admin and staff to make a non-GET request — which meant a VIEWER
// could see the card and be refused 403 when she tried to put it away.
// "Come back to this later" is a personal preference about one person's
// own dashboard, not a change to parish data, and the least-privileged
// user is precisely the one most likely to want it.
//
// Authority is enforced inside the router instead, where it can be
// specific: /later and /record are admin-only and say so, and GET /
// filters its own payload by role so a viewer is never sent an
// invitation action to hide. auditLog stays, because noting an item
// "left for later" is a decision taken on the parish's behalf and should
// have a name on it.
app.use('/api/setup',         requireAuth, auditLog('parish_setup'), setupRouter)
// Users router is admin-only across the board (read + write) — no
// gateMutations split, since even listing the team is privileged.
app.use('/api/users',         requireAuth, requireRole('admin'), auditLog('user'), usersRouter)
// Billing /status is read-by-anyone-in-org; /checkout and /portal are
// admin-only and the router itself layers requireRole on those routes
// implicitly via this mount-level gate.
app.use('/api/billing',       requireAuth, gateMutations('admin'), billingAuthRouter)
// Audit log is read-only and admin-only — non-admins should not be
// able to enumerate the high-trust history of who-did-what.
app.use('/api/audit-log',     requireAuth, requireRole('admin'), auditLogRouter)
// Reading the archive needs no special role; restoring is gated inside
// the router, so a volunteer can see that their mistake is recoverable.
app.use('/api/vault',         requireAuth, writeGate, auditLog('vault'), vaultRouter)
// Year-end giving statements — bookkeeping surface, admin-only. The
// /preview list and per-donor breakdown both filter by organization_id
// at the SQL layer; the role gate is the second line of defense against
// a regular staff user enumerating donor totals.
app.use('/api/giving-statements', requireAuth, requireRole('admin'), givingStatementsRouter)
// Org-level settings (letterhead, EIN, signatory). Admin-only because
// these power the legal/tax document headers; a staff user changing
// the EIN by accident would brick every printed statement until the
// admin notices.
app.use('/api/organization',  requireAuth, requireRole('admin'), auditLog('organization'), organizationRouter)
// Tenant analytics — admin-only growth + activity dashboard. No
// audit middleware here; it's a pure read with no mutations.
app.use('/api/insights',      requireAuth, requireRole('admin'), insightsRouter)
// Pledges (Sprint D). Admin-only — pledge data + donor matching are
// bookkeeping-sensitive. Audited so changes to pledge amount /
// status leave an actor trail (admins doing year-end reconciliation
// occasionally edit historical pledges and we want that recorded).
app.use('/api/pledges',       requireAuth, requireRole('admin'), auditLog('pledge'), pledgesRouter)
// Notification prefs are self-serve — every signed-in user manages
// their own toggles. No role gate; viewers can still need to opt out
// of task/event reminders.
app.use('/api/notification-prefs', requireAuth, notificationPrefsRouter)
// Push subscription management (Sprint PWA / PWA.4a). Self-serve —
// every signed-in user can subscribe their own device. No role gate;
// viewers may opt in to push for the same notifications they receive
// in-app. VAPID config is server-side env; the publicKey endpoint
// returns null when push isn't configured so the UI can disable the
// toggle gracefully.
app.use('/api/push',          requireAuth, pushRouter)
// Operational endpoints for the notification queue (drain, etc.).
// Admin-only — non-admins must not be able to trigger unbounded
// drainer work. Once a real cron is wired, the cron config flips
// this from operator-poked to scheduled.
app.use('/api/admin/notifications', requireAuth, requireRole('admin'), notificationsAdminRouter)
// Daily verse — same content for every user on a given day, but we
// gate behind requireAuth so unauthenticated traffic can't burn
// bible-api.com quota for free.
app.use('/api/daily-verse',   requireAuth, dailyVerseRouter)
// Operational maintenance (retention prune, etc.). VENDOR-ONLY.
//
// This was requireRole('admin') — a *parish* admin — until 2026-08-14.
// pruneOldRecords() takes no org argument: it walks every row of
// ochr_organizations and deletes audit logs, notification logs, AI usage
// and scheduled rows, and anonymises check-in PII, for all of them. So
// any admin at any tenant could force a destructive maintenance pass
// across every other tenant's data. Nothing was readable cross-org and
// only already-expired rows are removed, but the trigger belongs to the
// operator, not the customer. Same env-identified, fail-closed identity
// as /api/admin/feedback.
app.use('/api/admin/maintenance', requireAuth, requireSuperAdmin, maintenanceRouter)
// Forms (Sprint Forms / F.1). Admin-only across the board — every
// caller must be an admin (not just authenticated), so a staff
// account can't build a form, list responses, or delete one.
// Audited because both schema edits and response inbox reads are
// records the admin team will want a "who changed what" trail for.
app.use('/api/forms',         requireAuth, requireRole('admin'), auditLog('form'), formsRouter)
// Cron-callable endpoints. Authenticated via CRON_SECRET env header,
// NOT JWT — there's no user behind a cron invocation. Same underlying
// service functions as the admin paths above; the cron router just
// uses a different gate. See server/src/middleware/cronAuth.js.
app.use('/api/cron', cronRouter)

// Global error handler — last resort for anything a route handler threw
// without catching. Logs structured context to stdout (Vercel's runtime
// logs pick this up automatically) and returns an opaque 500 with a
// short reference id the user can quote in support.
app.use((err, req, res, _next) => {
  const ref = Math.random().toString(36).slice(2, 10)
  // ARG-LEAK-1: body-parser errors (malformed JSON, oversize, bad charset)
  // carry the raw request body in err.body, and V8's SyntaxError message
  // quotes it — a malformed login would write the password to the log.
  // Answer 4xx and log only type/status, never message, stack or body.
  if (err && typeof err.type === 'string' && (err.type.startsWith('entity.') || err.type.endsWith('.unsupported') || err.type === 'request.aborted' || err.type === 'request.size.invalid' || err.type === 'stream.encoding.set' || err.type === 'stream.not.readable' || err.type === 'parameters.too.many')) {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 400
    console.warn('[bad-request]', { ref, method: req.method, path: maskPath(req.path), type: err.type, status })
    return res.status(status).json({ error: status === 413 ? 'Request body too large' : 'Malformed request body', ref })
  }
  console.error('[unhandled]', {
    ref,
    method: req.method,
    path:   req.path,
    user:   req.user?.id ?? null,
    org:    req.organizationId ?? null,
    name:   err?.name,
    message: err?.message,
    stack:   err?.stack,
  })
  res.status(500).json({ error: 'Internal server error', ref })
})

export default app

