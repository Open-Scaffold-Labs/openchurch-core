// Assistant — in-app support chat (SUP.3).
//
//   POST /api/assistant           → { question, page_route, help_key?, history[] } → { answer }
//
// help_key (optional) names a Help-panel guide entry. It is validated
// against the static help content's own keys; the guide TEXT is built on
// the server (ai/assistantGuide.js), never taken from the request.
//   POST /api/assistant/:id/feedback → thumbs up/down on an answer
//
// Mount (app.js):
//   app.use('/api/assistant', requireAuth, writeGate, assistantRouter)
//
// The widget's job is "how do I…" answers about OpenChurch itself plus light
// parish-operations context (liturgical calendar mechanics, giving statements,
// bilingual features). D-01 (2026-10-19): it runs only on the parish's own
// key (AIP.1), Anthropic or OpenAI, on the parish's own bill; with no key
// it answers ai_key_required. It does NOT consume AI Studio
// generation quota — support shouldn't compete with bulletin-writing — but
// is capped at ASSISTANT_DAILY_CAP messages/org/day (default 300), counted
// from ochr_assistant_messages.
//
// Boundaries baked into the system prompt: the assistant is not a canonist,
// not a lawyer, and not the chancery — questions of canon law, sacramental
// validity, or diocesan policy get a warm referral to the pastor or the
// chancery, never an answer. It also never invents features: if it doesn't
// know, it says so and points at Report a Problem.

import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { dispatch, availability, refusalBody } from '../ai/gate.js'
import { isNativeShellRequest, nativeAiCeilingFromRequest } from '../ai/nativeAiMode.js'
import { routeTemplate } from '../ai/routeTemplate.js'
import { CAPABILITIES } from '../ai/policy.js'
import { resolveHelpKey, guideBlock, messageBytes } from '../ai/assistantGuide.js'
import pool from '../db.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

const DAILY_CAP = Number(process.env.ASSISTANT_DAILY_CAP) || 300
const MAX_HISTORY = 12 // turns kept from the client-supplied history

const SYSTEM_PROMPT = `You are the OpenChurch Assistant — a warm, concise helper built into
OpenChurch, church management software for liturgical congregations (Catholic parishes
first). You answer questions about using the software and about everyday parish-office
operations it touches.

## The modules (parish app)
- Dashboard: liturgical day + color, daily verse, urgent tasks, and a card that
  links to Getting settled (/getting-settled), a first-week guide with no progress bar.
- Members (/clients): the person registry — status, roles, tags, birthdays/feast overlaps,
  per-member calendar feed, giving history (staff and admin only), sacramental timeline on each
  profile. Viewers don't see a member's private notes, birth year or giving.
- Groups: ministries and small groups, interest/waitlist flow (admin).
- Schedule: services and events on a liturgical-color calendar; recurring service templates;
  volunteer assignments with self-serve shift swaps and a warning when an assigned member is
  already on an overlapping event. There is no room booking; rooms are check-in spaces only.
- Check-in: attendance with child-safety security codes for pickup matching.
- Register: the permanent sacramental register — baptisms through funerals, minister, place,
  certificate numbers as typed from the book (OpenChurch does not propose the next number or
  check for duplicates), printable certificates. Paper registers are digitized via
  Drafts (/register/drafts): nothing enters the permanent record without explicit confirmation.
- Intentions (/mass-intentions): the Mass intention book — requester, stipend, the Mass it is
  scheduled at, open → scheduled → fulfilled, and the printable weekly sacristy manifest.
  A recorded offering is held in Finance as money owed (account 2330, Mass Stipends Payable),
  not income, and it does not count toward the diocesan assessment. An intention with an offering
  recorded, or one fulfilled or voided, cannot be deleted. Voiding is admin-only with a reason, and
  a still-held offering also needs a refund, transfer, or pastor-directed apply. Administrators
  use Void on the Intentions screen. After a Mass is said, a fulfilled stipend stays held in
  account 2330 — Release stipend is not available yet, and voiding a fulfilled intention that
  still holds the stipend is refused for the same reason (remittance accounting still open).
  A recorded offering is booked on the day the money was received (not the Mass date).
- Worship (/service-planner): order-of-service plans per Mass — hymns, readings, rites.
- Events, Daily Tasks (with checklists; Recurring is only a label and a completed task does not
  come back; daily checklists on the Dashboard reset each day), Forms (public forms), Bulletin (weekly builder, admin).
- Donations: giving ledger, funds (designated/restricted), refunds, and IRS year-end statements
  (/donations/statements) built from the org letterhead settings. Online giving works only once
  the parish's own Stripe account is connected; until then the public Give page takes no card gift,
  and there is no screen in OpenChurch yet for the parish to connect the account itself.
  Recurring online gifts are not taken yet; the Give page accepts one-time gifts only.
- Pledges (parish only; the diocese layer does not read them), Payroll (staff + shifts), Finance (chart of accounts, ledger, period submissions
  to the diocese) — admin. Ledger import is a trial-balance CSV for one period-end date; it must
  balance and is saved all or nothing. From the cutover date a gift with no account mapping has no
  account, and a period with such gifts cannot be sent to the diocese until they are mapped. A mapping
  change starts today or later and earlier gifts keep their account; a change that would move gifts in
  a period already sent is refused. A mapping that lowers the assessable base is the diocese's to set,
  and there is no screen yet for the diocese to set it. A period cannot be sent while a voided
  intention's offering is still held with no disposition, or while it has deposit adjustments
  that are not in the diocesan roll-up yet.
- AI Studio + Library: AI-drafted announcements and content, archived in the Library.
  AI runs only on the parish's own Anthropic or OpenAI key, added by an admin in Org details;
  OpenChurch supplies no key, so without one AI features are off. Because the parish pays
  its own provider, OpenChurch sets no monthly AI limit; the provider's own rate limits apply.
  You (the Assistant) answer a set number of questions per parish each day; the count starts
  over at midnight in the parish's timezone (Org details).
- Admin: Insights (12-month trends), Team (roles: admin/staff/viewer), Org details (letterhead,
  EIN, public church page and its display name, https logo link and accent color, which apply to
  the church page only, not public forms, giving or bulletin pages; the parish page draft is
  published separately from Org details → Publish the parish page, where an admin can Publish,
  Take the page down or Restore the previous page, each confirmed, and visitors see it only while
  the public address switch is on), Billing (current plan; never quote a price, tier, or pricing plans), Audit log, Notifications.
- Preferences: per-user language (English/Spanish) and notification choices.

## Diocese layer (separate chancery app)
A diocese invites a parish; the parish explicitly accepts and chooses summary or detail
sharing — read-only, revocable. Parishes close periods; approved totals freeze; the diocese
computes assessments from approved submissions. Parish-side questions about this live under
Finance → Diocese.

## Hard boundaries
- You draft; a person decides. You never send, post, text or email anything, and you cannot
  message a member, volunteer or donor. Anything you write is a draft the user reviews and
  sends themselves.
- Canon law, sacramental validity, marriage cases, dispensations, diocesan policy: do NOT
  answer substantively. Warmly refer to the pastor or the diocesan chancery.
- Legal/tax advice beyond "the year-end statement includes the IRS-required language": refer
  to a professional.
- Never invent features or buttons. If unsure whether something exists, say so and suggest
  the Report a Problem tab in Help.
- Keep answers short (2-6 sentences), step-numbered when procedural, and in the user's
  language (English or Spanish).`

export async function todayCount(orgId) {
  const { rows: [r] } = await pool.query(
    // The day is the parish's own day (Org details timezone), so "resets at
    // midnight" is true where the parish is, not on the database clock.
    `SELECT COUNT(*)::int AS n FROM ochr_assistant_messages m
       JOIN ochr_organizations o ON o.id = m.organization_id
      WHERE m.organization_id = $1
        AND m.created_at >= (date_trunc('day', NOW() AT TIME ZONE COALESCE(o.timezone, 'UTC'))
                             AT TIME ZONE COALESCE(o.timezone, 'UTC'))`, [orgId])
  return r.n
}

// The assistant's one outbound seam is ai/gate.js dispatch (platform stop,
// explicit routing, input bound). A parish's own Anthropic or OpenAI key is
// THE provider; a parish with no key is told to add one (ai_key_required).
//
// accounting: each POST is one request with its own server-generated id
// (the ledger's idempotency key). On the platform-managed route the gate
// reserves it in ochr_ai_ledger before sending and audits it in
// ochr_ai_audit (OSL AI plan P1). A parish's own key is not accounted.
async function runChat({ orgId, userId, messages, nativeShell, nativeCeiling }) {
  return dispatch({ orgId, capabilityId: 'parish_assistant_v1', system: SYSTEM_PROMPT, messages, maxTokens: 700,
    accounting: { requestId: randomUUID(), actorId: userId },
    nativeShell: nativeShell === true, actorUserId: userId,
    nativeCeiling: nativeShell === true ? nativeCeiling : 'excluded' })
}

// GET /api/assistant/status — can this org get an answer at all?
// The widget probes this once and simply doesn't render the quill when
// the answer is no: a support button that always apologizes is worse
// than no button ("Anxiety is a Defect"). Availability = the org's own
// Anthropic or OpenAI key (AIP.1). With no key, `code: 'ai_key_required'`
// lets the widget show "add your parish's key" instead of hiding or
// implying an outage.
router.get('/status', async (req, res) => {
  const { available, code } = await availability(req.organizationId, 'parish_assistant_v1')
  res.set('Cache-Control', 'private, max-age=60')
  res.json(available ? { available } : { available, code })
})

// POST /api/assistant
router.post('/', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : ''
  if (!question) return res.status(400).json({ error: 'Question is required' })
  if (question.length > 2000) return res.status(400).json({ error: 'Question is too long' })
  // A route is a path. A query or fragment can carry ids, codes or a
  // search the user typed; none of it goes to the model or the log table.
  const pageRoute = routeTemplate(req.body?.page_route)

  try {
    const used = await todayCount(req.organizationId)
    if (used >= DAILY_CAP) {
      return res.status(429).json({
        error: 'The assistant has reached today\u2019s limit for your parish. It resets at midnight in your parish\u2019s timezone \u2014 the Help panel and user guide are always available.',
      })
    }

    // Client-supplied history: [{ role: 'user'|'assistant', content }] — sanitized.
    const history = Array.isArray(req.body?.history)
      ? req.body.history
          .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
          .slice(-MAX_HISTORY)
          .map(t => ({ role: t.role, content: t.content.slice(0, 1000) }))
      : []

    const contextLine = pageRoute ? `(User is currently on page: ${pageRoute})\n\n` : ''
    // Page-guide grounding (S2): static OpenChurch help text for this page,
    // chosen server-side and sized to the capability's remaining input bound.
    const guide = guideBlock(resolveHelpKey(req.body?.help_key, pageRoute), {
      otherBytes: messageBytes([...history, { content: contextLine + question }]),
      maxInputBytes: CAPABILITIES.parish_assistant_v1.maxInputBytes,
    })
    const messages = [...history, { role: 'user', content: guide + contextLine + question }]

    const started = Date.now()
    const { text, provider, model } = await runChat({ orgId: req.organizationId, userId: req.user.id, messages, nativeShell: isNativeShellRequest(req), nativeCeiling: nativeAiCeilingFromRequest(req) })

    const { rows: [logged] } = await pool.query(
      `INSERT INTO ochr_assistant_messages
         (organization_id, user_id, page_route, question, answer, provider, model, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      // Operational telemetry is metadata only (TARS #280 disposition 3): the
      // question and answer text are not stored; the answer is returned once.
      [req.organizationId, req.user.id, pageRoute, null, null, provider, model, Date.now() - started])

    res.json({ id: logged.id, answer: text })
  } catch (err) {
    monitor.error('assistant.chat', err, { orgId: req.organizationId })
    const r = refusalBody(err)
    if (r) return res.status(r.status).json(r.body)
    res.status(500).json({ code: 'ai_failed', error: 'The assistant is unavailable right now \u2014 the Help panel below has the full guide.' })
  }
})

// POST /api/assistant/:id/feedback — thumbs on an answer (own org only).
router.post('/:id/feedback', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' })
  const feedback = req.body?.feedback
  if (!['up', 'down'].includes(feedback)) return res.status(400).json({ error: 'Feedback must be up or down' })
  try {
    const { rowCount } = await pool.query(
      // Own answers only; a free-text note is not stored (metadata only).
      `UPDATE ochr_assistant_messages SET feedback = $2
        WHERE id = $1 AND organization_id = $3 AND user_id = $4`,
      [id, feedback, req.organizationId, req.user.id])
    if (!rowCount) return res.status(404).json({ error: 'Message not found' })
    res.json({ ok: true })
  } catch (err) {
    monitor.error('assistant.feedback', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to record feedback' })
  }
})

export default router
