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
import { paymentsProvider } from './payments/index.js'
import { requireSuperAdmin } from './middleware/superAdmin.js'
import { requireAuth, gateMutations, requireRole, requireOrgType } from './middleware/auth.js'
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
import usersRouter from './routes/users.js'
import {
  publicRouter as billingPublicRouter,
  authRouter   as billingAuthRouter,
} from './routes/billing.js'
import auditLogRouter from './routes/auditLog.js'
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
import affiliationRouter from './routes/affiliation.js'
import assessmentsRouter from './routes/assessments.js'
import checklistsRouter from './routes/checklists.js'
import feedbackRouter, { adminRouter as feedbackAdminRouter } from './routes/feedback.js'
import supportTicketsRouter from './routes/supportTickets.js'
import assistantRouter from './routes/assistant.js'
import notificationPrefsRouter from './routes/notificationPrefs.js'
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

const app = express()

// Trust the first proxy hop so req.ip / X-Forwarded-For resolve to the
// real client IP. Vercel terminates TLS at its edge and forwards; without
// this, every rate-limit key would collapse to the same internal IP.
app.set('trust proxy', 1)

// CORS allowlist (audit H10). Origins come from CORS_ORIGINS (comma-
// separated) with CLIENT_URL as the always-trusted default. Requests
// with no Origin header (curl, server-to-server, same-origin PWA
// fetches) pass — CORS only governs browsers doing cross-origin reads.
// Outside production, localhost dev servers are allowed so dev "just
// works" with no env setup.
const ALLOWED_ORIGINS = new Set(
  [
    ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    process.env.CLIENT_URL,
  ].filter(Boolean).map(u => u.replace(/\/$/, ''))
)
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true)
    if (ALLOWED_ORIGINS.has(origin.replace(/\/$/, ''))) return cb(null, true)
    if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+$/.test(origin)) {
      return cb(null, true)
    }
    return cb(null, false) // not an error — just no CORS headers for this origin
  },
}))

// Security headers (audit H10) — hand-set, no new dependency. HSTS is
// meaningful only behind TLS, which Vercel guarantees in production.
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('X-Frame-Options', 'DENY')
  res.set('Referrer-Policy', 'no-referrer')
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

// 10 MB is generous for JSON bodies but necessary for CSV-member-import
// payloads, which can run several MB for big churches. Tenant routes
// are authed so there's no unauth'd DoS vector through this limit.
app.use(express.json({ limit: '10mb' }))

// Health check (H.1) — a real probe: ping the DB and report which
// payments provider is live (stub vs a real one). 503 if the DB is
// unreachable so a load balancer / uptime monitor can react.
async function healthHandler(_req, res) {
  let db = 'ok'
  try {
    await pool.query('SELECT 1')
  } catch {
    db = 'error'
  }
  res.status(db === 'ok' ? 200 : 503).json({
    status:            db === 'ok' ? 'ok' : 'degraded',
    db,
    payments_provider: paymentsProvider(),
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
app.use('/api/ai',            requireAuth, writeGate, aiRouter)
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
// In-app assistant (SUP.3) — every signed-in role may ask (viewers get
// stuck too). Per-org daily cap inside the route; no writeGate because
// the only "mutation" is the assistant's own usage log.
app.use('/api/assistant',     requireAuth, assistantRouter)
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
// Operational maintenance (retention prune, etc.). Admin-only.
// Vercel cron will hit this once a day when wired.
app.use('/api/admin/maintenance', requireAuth, requireRole('admin'), maintenanceRouter)
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
