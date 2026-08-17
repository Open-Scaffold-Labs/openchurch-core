import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import pool from '../db.js'
import { requireIntParam } from '../utils/params.js'
import { quotaFor, reserveSlot, releaseSlot, updateSlotProvider } from '../billing/aiQuota.js'
import { requireRole } from '../middleware/auth.js'
import { getOrgProvider, encryptApiKey } from '../ai/orgProvider.js'
import { resolveLiturgicalContext } from './liturgical.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

// Default models — kept small and cheap. Callers can still override via
// body.model if we ever expose that.
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_OPENAI_MODEL    = 'gpt-4o-mini'

// System prompts per generation type. Keeping them here (rather than the
// client) keeps prompt engineering server-side where it belongs.
const SYSTEM_PROMPTS = {
  sermon:       'You are a sermon-preparation assistant for a liturgical parish. You DRAFT; the preacher decides. When liturgical context is provided (season, feast, date), root the sermon in it and suggest fitting lectionary readings. Return: a title, the liturgical day, suggested readings, a one-paragraph theme, a 3-5 point outline (each point with scripture and a one-sentence application), one pastoral illustration idea, and a short closing prayer. Mark anything doctrinally weighty as "for the preacher to discern".',
  message:      'You write warm, friendly, and clear church communication messages. Keep tone pastoral and inclusive. Output only the message body — no subject line unless asked. You draft; a person decides — never present doctrine, canon law, or the discipline of any tradition as settled, and leave anything doctrinally weighty for the parish to discern.',
  devotional:   'You write short, encouraging Christian devotionals (150–250 words). Include a scripture reference, a reflection, and a one-line prayer. Output only the devotional. You draft; a person decides — cite scripture only where you are confident of the reference, and never present doctrine or the discipline of any tradition as settled.',
  announcement: 'You write short, upbeat church announcements suitable for bulletins or social posts. Keep it under 80 words, warm in tone, and end with a clear call to action. You draft; a person decides — never present doctrine, canon law, or the discipline of any tradition as settled.',
}

const ALLOWED_TYPES = new Set(Object.keys(SYSTEM_PROMPTS))

// Run a prompt through the provider chain. With no org override:
// platform keys, Anthropic → OpenAI fallback. When the org has plugged
// in its OWN provider (AIP.1), we use exactly that — their provider,
// their key, their optional model pin, no silent fallback onto the
// platform's bill. Returns { text, provider, model } or throws.
async function runLLM({ systemPrompt, userPrompt, maxTokens = 1024, org = null }) {
  const errors = []

  if (org?.provider === 'anthropic') {
    const model = org.model || DEFAULT_ANTHROPIC_MODEL
    const client = new Anthropic({ apiKey: org.apiKey })
    const message = await client.messages.create({
      model, max_tokens: maxTokens, system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const text = message.content?.[0]?.text
    if (text) return { text, provider: 'anthropic (org key)', model }
    throw new Error('anthropic (org key): empty response')
  }
  if (org?.provider === 'openai') {
    const model = org.model || DEFAULT_OPENAI_MODEL
    const client = new OpenAI({ apiKey: org.apiKey })
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
    })
    const text = completion.choices?.[0]?.message?.content
    if (text) return { text, provider: 'openai (org key)', model }
    throw new Error('openai (org key): empty response')
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic()
      const message = await client.messages.create({
        model: DEFAULT_ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      })
      const text = message.content?.[0]?.text
      if (text) return { text, provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL }
    } catch (err) {
      errors.push(`anthropic: ${err.message}`)
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI()
      const completion = await client.chat.completions.create({
        model: DEFAULT_OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
      })
      const text = completion.choices?.[0]?.message?.content
      if (text) return { text, provider: 'openai', model: DEFAULT_OPENAI_MODEL }
    } catch (err) {
      errors.push(`openai: ${err.message}`)
    }
  }

  const err = new Error(errors.length ? `All providers failed: ${errors.join(' | ')}` : 'No AI provider configured')
  err.code = errors.length ? 'ALL_FAILED' : 'NO_PROVIDER'
  throw err
}

// POST /api/ai/enhance — kept for existing callers.
router.post('/enhance', async (req, res) => {
  const { text, context } = req.body ?? {}
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided' })

  // Same quota gate as /generate. Until this fix /enhance was
  // burning provider credits without consuming the meter or being
  // gated when an org went over — a real cost-leak the AI quota
  // work shipped earlier didn't cover.
  //
  // Atomic check-and-reserve (closes the TOCTOU race) BEFORE runLLM so we
  // never burn credits on a refused call. A reservation failure now FAILS
  // CLOSED — a DB error 503s rather than silently letting the call through
  // and bypassing the cap.
  let slotId
  try {
    const reservation = await reserveSlot(req.organizationId, {
      endpoint: 'enhance',
      type:     null,
      userId:   req.user?.id,
      provider: null,
      model:    null,
    })
    if (!reservation.reserved) {
      const quota = reservation.quota
      return res.status(429).json({
        code:  'quota_exceeded',
        error: `Monthly AI limit reached (${quota.used}/${quota.limit}). Resets ${new Date(quota.period_end).toLocaleDateString()}.`,
        used:  quota.used,
        limit: quota.limit,
        plan:  quota.plan,
        period_end: quota.period_end,
      })
    }
    slotId = reservation.id
  } catch (qErr) {
    monitor.error('ai-quota.reserve', qErr, { orgId: req.organizationId, endpoint: 'enhance' })
    return res.status(503).json({ error: 'AI quota check failed, please try again' })
  }

  const systemPrompt = 'You are a helpful assistant for a church management system. Improve the text provided by the user to be clearer and more professional while preserving all original meaning. Return only the improved text, no explanations.'
  const userPrompt   = `Context: ${context || 'General church notes'}\n\nText: ${text}`

  try {
    const org = await getOrgProvider(req.organizationId).catch(() => null)
    const { text: result, provider, model } = await runLLM({ systemPrompt, userPrompt, org })
    // Backfill the provider/model onto the reserved usage row now that we
    // know which provider served the call. Best-effort — never fails the request.
    updateSlotProvider(slotId, { provider, model }).catch(uErr => monitor.error('ai-quota.update', uErr, { orgId: req.organizationId, endpoint: 'enhance' }))
    res.json({ result })
  } catch (err) {
    // The LLM call failed after we reserved a slot — refund it so a failed
    // call doesn't count against the org's quota. Best-effort.
    releaseSlot(slotId).catch(rErr => monitor.error('ai-quota.release', rErr, { orgId: req.organizationId, endpoint: 'enhance' }))
    monitor.error('ai.enhance', err, { orgId: req.organizationId })
    // Provider errors stay in the logs — clients get a stable message,
    // never raw upstream detail (key fragments, model names, quotas).
    const status = err.code === 'NO_PROVIDER' ? 503 : 500
    res.status(status).json({ error: status === 503 ? 'AI is not configured' : 'AI request failed' })
  }
})

// POST /api/ai/generate — typed content generation (sermon/message/devotional/announcement).
// On success, persists the prompt + output to ai_generations for history,
// AND records a usage row toward this org's monthly AI quota.
router.post('/generate', async (req, res) => {
  const { prompt, type } = req.body ?? {}
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt is required' })
  if (!ALLOWED_TYPES.has(type)) {
    return res.status(400).json({ error: `Invalid type. Expected one of: ${[...ALLOWED_TYPES].join(', ')}` })
  }

  // Quota gate — must run BEFORE runLLM so we never burn credits on a
  // call we're going to refuse. Failed/refused calls do not count.
  //
  // Atomic check-and-reserve closes the TOCTOU race the plain COUNT(*) gate
  // had — concurrent requests contending for the last slot can't both pass.
  // A reservation failure now FAILS CLOSED (503) instead of silently
  // proceeding and bypassing the cap.
  let slotId
  try {
    const reservation = await reserveSlot(req.organizationId, {
      endpoint: 'generate',
      type,
      userId:   req.user?.id,
      provider: null,
      model:    null,
    })
    if (!reservation.reserved) {
      const quota = reservation.quota
      return res.status(429).json({
        code:  'quota_exceeded',
        error: `Monthly AI limit reached (${quota.used}/${quota.limit}). Resets ${new Date(quota.period_end).toLocaleDateString()}.`,
        used:  quota.used,
        limit: quota.limit,
        plan:  quota.plan,
        period_end: quota.period_end,
      })
    }
    slotId = reservation.id
  } catch (qErr) {
    monitor.error('ai-quota.reserve', qErr, { orgId: req.organizationId })
    return res.status(503).json({ error: 'AI quota check failed, please try again' })
  }

  try {
    // Sermon assistant (AIP.2): when the preacher names the date they're
    // preaching, the system already knows the liturgical day — inject it
    // so the draft is rooted in the actual Sunday, not a generic one.
    let userPrompt = prompt
    if (type === 'sermon') {
      const preachDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.preach_date ?? '') ? req.body.preach_date : null
      if (preachDate) {
        try {
          const lit = await resolveLiturgicalContext(preachDate, req.organizationId)
          if (lit?.season) {
            userPrompt = `Liturgical context — preaching date ${preachDate}: ${lit.season}` +
              (lit.feast_name ? `, ${lit.feast_name}` : '') +
              (lit.color ? ` (liturgical color: ${lit.color})` : '') +
              `.\n\n${prompt}`
          }
        } catch { /* context is an enrichment, never a blocker */ }
      }
    }

    const org = await getOrgProvider(req.organizationId).catch(() => null)
    const { text, provider, model } = await runLLM({
      systemPrompt: SYSTEM_PROMPTS[type],
      userPrompt,
      org,
      maxTokens: 1500,
    })

    // Backfill the provider/model onto the reserved usage row now that we
    // know which provider served the call. Best-effort — never fails the request.
    updateSlotProvider(slotId, { provider, model }).catch(uErr => monitor.error('ai-quota.update', uErr, { orgId: req.organizationId, type }))

    let saved = null
    try {
      const { rows } = await pool.query(
        `INSERT INTO ochr_ai_generations (organization_id, type, prompt, output, provider, model)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.organizationId, type, prompt, text, provider, model]
      )
      saved = rows[0]
    } catch (dbErr) {
      // Don't fail the user's request if logging fails — just return the text.
      monitor.error('ai.generations.insert', dbErr, { orgId: req.organizationId, type })
    }

    res.json({
      id: saved?.id ?? null,
      output: text,
      provider,
      model,
      created_at: saved?.created_at ?? new Date().toISOString(),
    })
  } catch (err) {
    // The LLM call failed after we reserved a slot — refund it so a failed
    // call doesn't count against the org's quota. Best-effort.
    releaseSlot(slotId).catch(rErr => monitor.error('ai-quota.release', rErr, { orgId: req.organizationId }))
    console.error(err)
    const status = err.code === 'NO_PROVIDER' ? 503 : 500
    res.status(status).json({ error: status === 503 ? 'AI is not configured' : 'AI request failed' })
  }
})

// GET /api/ai/quota — current usage snapshot for the auth'd org. Used
// by the AI Studio meter and by callers who want to render a "you have
// N left" indicator without having to attempt a generation first.
router.get('/quota', async (req, res) => {
  try {
    const quota = await quotaFor(req.organizationId)
    res.json(quota)
  } catch (err) {
    monitor.error('ai-quota.read', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load AI quota' })
  }
})

// GET /api/ai/generations
//   ?type=sermon|message|devotional|announcement
//   ?q=keyword               — ILIKE on prompt + output
//   ?since=ISO  ?until=ISO   — created_at range
//   ?limit=N (default 25, max 200)
//   ?offset=N
//
// Returns { rows, total, hasMore, limit, offset } so the Library
// page can paginate. The AI Studio's right-rail strip reads
// data.rows; the previous bare-array shape is gone.
router.get('/generations', async (req, res) => {
  try {
    const { type } = req.query
    const limit  = Math.min(parseInt(req.query.limit, 10) || 25, 200)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)

    const where  = ['organization_id = $1']
    const params = [req.organizationId]

    if (type && ALLOWED_TYPES.has(type)) {
      params.push(type)
      where.push(`type = $${params.length}`)
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`)
      where.push(`(prompt ILIKE $${params.length} OR output ILIKE $${params.length})`)
    }
    if (req.query.since) {
      const since = new Date(req.query.since)
      if (!Number.isNaN(since.getTime())) {
        params.push(since.toISOString())
        where.push(`created_at >= $${params.length}`)
      }
    }
    if (req.query.until) {
      const until = new Date(req.query.until)
      if (!Number.isNaN(until.getTime())) {
        params.push(until.toISOString())
        where.push(`created_at <= $${params.length}`)
      }
    }

    const whereClause = where.join(' AND ')
    const countQ = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ochr_ai_generations WHERE ${whereClause}`,
      params
    )
    const total = countQ.rows[0].total

    const pageParams = [...params, limit, offset]
    const rowsQ = await pool.query(
      `SELECT id, type, prompt, output, provider, model, created_at
         FROM ochr_ai_generations
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams
    )
    res.json({
      rows: rowsQ.rows,
      total,
      limit,
      offset,
      hasMore: offset + rowsQ.rows.length < total,
    })
  } catch (err) {
    monitor.error('ai.generations.list', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load generation history' })
  }
})

// DELETE /api/ai/generations/:id — remove one history entry.
router.delete('/generations/:id', async (req, res) => {
  const id = requireIntParam(req, res); if (id === null) return
  try {
    const result = await pool.query(
      'DELETE FROM ochr_ai_generations WHERE id = $1 AND organization_id = $2',
      [id, req.organizationId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete generation' })
  }
})

// ── Org AI provider management (AIP.1) — admin only ─────────
// The key is write-only: PUT stores it encrypted; GET returns provider,
// model, and the key's last four characters, never the key itself.

// GET /api/ai/provider
router.get('/provider', requireRole('admin'), async (req, res) => {
  try {
    const org = await getOrgProvider(req.organizationId)
    if (!org) {
      return res.json({ source: 'platform', provider: null, model: null, key_last4: null })
    }
    res.json({ source: 'org', provider: org.provider, model: org.model, key_last4: org.last4 })
  } catch (err) {
    monitor.error('ai.provider.get', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to load AI provider settings' })
  }
})

// PUT /api/ai/provider — { provider: 'anthropic'|'openai', api_key, model? }
router.put('/provider', requireRole('admin'), async (req, res) => {
  const provider = req.body?.provider
  const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : ''
  const model = req.body?.model != null ? String(req.body.model).trim() || null : null
  if (!['anthropic', 'openai'].includes(provider)) {
    return res.status(400).json({ error: "provider must be 'anthropic' or 'openai'" })
  }
  if (apiKey.length < 20 || apiKey.length > 300) {
    return res.status(400).json({ error: 'That does not look like a valid API key' })
  }
  if (model && model.length > 100) return res.status(400).json({ error: 'Model name too long' })
  try {
    await pool.query(
      `UPDATE ochr_organizations
          SET ai_provider = $1, ai_api_key_enc = $2, ai_model = $3
        WHERE id = $4`,
      [provider, encryptApiKey(apiKey), model, req.organizationId]
    )
    res.json({ source: 'org', provider, model, key_last4: apiKey.slice(-4) })
  } catch (err) {
    monitor.error('ai.provider.put', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to save AI provider settings' })
  }
})

// DELETE /api/ai/provider — revert to the platform's built-in AI.
router.delete('/provider', requireRole('admin'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE ochr_organizations
          SET ai_provider = NULL, ai_api_key_enc = NULL, ai_model = NULL
        WHERE id = $1`,
      [req.organizationId]
    )
    res.json({ source: 'platform', provider: null, model: null, key_last4: null })
  } catch (err) {
    monitor.error('ai.provider.delete', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'Failed to reset AI provider settings' })
  }
})

export default router
