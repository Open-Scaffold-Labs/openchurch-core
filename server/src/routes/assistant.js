// Assistant — in-app support chat (SUP.3).
//
//   POST /api/assistant           → { question, page_route, history[] } → { answer }
//   POST /api/assistant/:id/feedback → thumbs up/down on an answer
//
// Mount (app.js):
//   app.use('/api/assistant', requireAuth, writeGate, assistantRouter)
//
// The widget's job is "how do I…" answers about OpenChurch itself plus light
// parish-operations context (liturgical calendar mechanics, giving statements,
// bilingual features). It follows the AI Studio provider chain: an org that
// has plugged in its own key (AIP.1) rides its own provider and bill;
// everyone else uses the platform key. It does NOT consume AI Studio
// generation quota — support shouldn't compete with bulletin-writing — but
// is capped at ASSISTANT_DAILY_CAP messages/org/day (default 300), counted
// from ochr_assistant_messages.
//
// Boundaries baked into the system prompt: the assistant is not a canonist,
// not a lawyer, and not the chancery — questions of canon law, sacramental
// validity, or diocesan policy get a warm referral to the pastor or the
// chancery, never an answer. It also never invents features: if it doesn't
// know, it says so and points at Report a Problem.

import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import pool from '../db.js'
import { getOrgProvider } from '../ai/orgProvider.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// Same default as AI Studio (small, cheap, known-good); SUPPORT_AI_MODEL
// upgrades the assistant + diagnostic together.
const DEFAULT_MODEL = process.env.SUPPORT_AI_MODEL || 'claude-haiku-4-5-20251001'
const DAILY_CAP = Number(process.env.ASSISTANT_DAILY_CAP) || 300
const MAX_HISTORY = 12 // turns kept from the client-supplied history

const SYSTEM_PROMPT = `You are the OpenChurch Assistant — a warm, concise helper built into
OpenChurch, church management software for liturgical congregations (Catholic parishes
first). You answer questions about using the software and about everyday parish-office
operations it touches.

## The modules (parish app)
- Dashboard: liturgical day + color, daily verse, urgent tasks, Get Started checklist.
- Members (/clients): the person registry — status, roles, tags, birthdays/feast overlaps,
  per-member calendar feed, giving history, sacramental timeline on each profile.
- Groups: ministries and small groups, interest/waitlist flow (admin).
- Schedule: services and events on a liturgical-color calendar; recurring service templates;
  room booking with conflict detection; volunteer assignments with self-serve shift swaps.
- Check-in: attendance with child-safety security codes for pickup matching.
- Register: the permanent sacramental register — baptisms through funerals, minister, place,
  certificate numbers, printable certificates. Paper registers are digitized via
  Drafts (/register/drafts): nothing enters the permanent record without explicit confirmation.
- Intentions (/mass-intentions): the Mass intention book — requester, stipend, the Mass it is
  scheduled at, open → scheduled → fulfilled, and the printable weekly sacristy manifest.
- Worship (/service-planner): order-of-service plans per Mass — hymns, readings, rites.
- Events, Daily Tasks (with checklists), Forms (public forms), Bulletin (weekly builder, admin).
- Donations: giving ledger, funds (designated/restricted), online giving, refunds, and IRS
  year-end statements (/donations/statements) built from the org letterhead settings.
- Pledges, Payroll (staff + shifts), Finance (chart of accounts, ledger, period submissions
  to the diocese) — admin.
- AI Studio + Library: AI-drafted announcements and content, with a monthly quota by plan.
- Admin: Insights (12-month trends), Team (roles: admin/staff/viewer), Org details (letterhead,
  EIN, public church page), Billing (Free vs Parish $79/mo), Audit log, Notifications.
- Preferences: per-user language (English/Spanish) and notification choices.

## Diocese layer (separate chancery app)
A diocese invites a parish; the parish explicitly accepts and chooses summary or detail
sharing — read-only, revocable. Parishes close periods; approved totals freeze; the diocese
computes assessments from approved submissions. Parish-side questions about this live under
Finance → Diocese.

## Hard boundaries
- Canon law, sacramental validity, marriage cases, dispensations, diocesan policy: do NOT
  answer substantively. Warmly refer to the pastor or the diocesan chancery.
- Legal/tax advice beyond "the year-end statement includes the IRS-required language": refer
  to a professional.
- Never invent features or buttons. If unsure whether something exists, say so and suggest
  the Report a Problem tab in Help.
- Keep answers short (2-6 sentences), step-numbered when procedural, and in the user's
  language (English or Spanish).`

async function todayCount(orgId) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ochr_assistant_messages
      WHERE organization_id = $1 AND created_at >= date_trunc('day', NOW())`, [orgId])
  return r.n
}

async function runChat({ org, messages }) {
  if (org?.provider === 'anthropic') {
    const model = org.model || DEFAULT_MODEL
    const client = new Anthropic({ apiKey: org.apiKey })
    const m = await client.messages.create({ model, max_tokens: 700, system: SYSTEM_PROMPT, messages })
    const text = m.content?.[0]?.text
    if (text) return { text, provider: 'anthropic (org key)', model }
    throw new Error('anthropic (org key): empty response')
  }
  // Org OpenAI keys fall through to platform for the assistant (chat-shape
  // differences aren't worth a second code path here); platform Anthropic:
  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic()
    const m = await client.messages.create({ model: DEFAULT_MODEL, max_tokens: 700, system: SYSTEM_PROMPT, messages })
    const text = m.content?.[0]?.text
    if (text) return { text, provider: 'anthropic', model: DEFAULT_MODEL }
  }
  throw new Error('No AI provider available')
}

// GET /api/assistant/status — can this org get an answer at all?
// The widget probes this once and simply doesn't render the quill when
// the answer is no: a support button that always apologizes is worse
// than no button ("Anxiety is a Defect"). Availability = platform key,
// or the org's own Anthropic key (AIP.1).
router.get('/status', async (req, res) => {
  try {
    let available = Boolean(process.env.ANTHROPIC_API_KEY)
    if (!available) {
      const org = await getOrgProvider(req.organizationId).catch(() => null)
      available = org?.provider === 'anthropic'
    }
    res.set('Cache-Control', 'private, max-age=300')
    res.json({ available })
  } catch {
    res.json({ available: false })
  }
})

// POST /api/assistant
router.post('/', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : ''
  if (!question) return res.status(400).json({ error: 'Question is required' })
  if (question.length > 2000) return res.status(400).json({ error: 'Question is too long' })
  const pageRoute = typeof req.body?.page_route === 'string' ? req.body.page_route.slice(0, 200) : null

  try {
    const used = await todayCount(req.organizationId)
    if (used >= DAILY_CAP) {
      return res.status(429).json({
        error: 'The assistant has reached today\u2019s limit for your parish. It resets at midnight \u2014 the Help panel and user guide are always available.',
      })
    }

    // Client-supplied history: [{ role: 'user'|'assistant', content }] — sanitized.
    const history = Array.isArray(req.body?.history)
      ? req.body.history
          .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
          .slice(-MAX_HISTORY)
          .map(t => ({ role: t.role, content: t.content.slice(0, 4000) }))
      : []

    const contextLine = pageRoute ? `(User is currently on page: ${pageRoute})\n\n` : ''
    const messages = [...history, { role: 'user', content: contextLine + question }]

    const org = await getOrgProvider(req.organizationId).catch(() => null)
    const started = Date.now()
    const { text, provider, model } = await runChat({ org, messages })

    const { rows: [logged] } = await pool.query(
      `INSERT INTO ochr_assistant_messages
         (organization_id, user_id, page_route, question, answer, provider, model, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.organizationId, req.user.id, pageRoute, question, text, provider, model, Date.now() - started])

    res.json({ id: logged.id, answer: text })
  } catch (err) {
    monitor.error('assistant.chat', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'The assistant is unavailable right now \u2014 the Help panel below has the full guide.' })
  }
})

// POST /api/assistant/:id/feedback — thumbs on an answer (own org only).
router.post('/:id/feedback', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' })
  const feedback = req.body?.feedback
  if (!['up', 'down'].includes(feedback)) return res.status(400).json({ error: 'Feedback must be up or down' })
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null
  try {
    const { rowCount } = await pool.query(
      `UPDATE ochr_assistant_messages SET feedback = $2, feedback_note = $3
        WHERE id = $1 AND organization_id = $4`,
      [id, feedback, note, req.organizationId])
    if (!rowCount) return res.status(404).json({ error: 'Message not found' })
    res.json({ ok: true })
  } catch (err) {
    monitor.error('assistant.feedback', err, { orgId: req.organizationId, id })
    res.status(500).json({ error: 'Failed to record feedback' })
  }
})

export default router
