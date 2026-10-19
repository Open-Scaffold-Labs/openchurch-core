// Stage 7 AI privacy boundary, final tree after the TARS #280 review.
// Fake providers capture every outbound SDK call; nothing reaches a real
// model. Synthetic text and synthetic tenants only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const cap = vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = 'synthetic-platform-anthropic'
  process.env.OPENAI_API_KEY = 'synthetic-platform-openai'
  process.env.VENDOR_ADMIN_EMAILS = 'synthetic-operator@example.com'
  return { anthropic: [], openai: [], anthropicImpl: null, openaiImpl: null }
})

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    constructor(opts) { this.opts = opts }
    get messages() {
      return {
        create: async (body, reqOpts) => {
          cap.anthropic.push({ opts: this.opts, body, reqOpts })
          if (cap.anthropicImpl) return cap.anthropicImpl(body)
          return { content: [{ type: 'text', text: 'SYNTH-DRAFT-OUTPUT' }] }
        },
      }
    }
  },
}))
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    constructor(opts) { this.opts = opts }
    get chat() {
      return { completions: { create: async (body) => {
        cap.openai.push({ opts: this.opts, body })
        if (cap.openaiImpl) return cap.openaiImpl(body)
        return { choices: [{ message: { content: 'SYNTH-OPENAI-OUTPUT' } }] }
      } } }
    }
  },
}))

import request from 'supertest'
import 'dotenv/config'
import pool from '../src/db.js'
import { CAPABILITIES } from '../src/ai/policy.js'
import { encryptApiKey } from '../src/ai/orgProvider.js'
import { providerFailure } from '../src/ai/providerError.js'
import { routeTemplate } from '../src/ai/routeTemplate.js'
import { runDiagnostic } from '../src/routes/supportTickets.js'
import { _setDispatchForTests } from '../src/monitoring/index.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const PW = 'ai-boundary-pw'
const SECRET_PROMPT = 'SYNTH-PROMPT-Q9 a parishioner wrote this'
let server, orgA, orgB, dio, staffA, viewerA, operator, ipSeq = 1
const nextIp = () => `10.88.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })

async function capture(fn) {
  const chunks = []
  const spies = ['error', 'warn', 'log', 'info'].map(m => vi.spyOn(console, m).mockImplementation((...a) => { chunks.push(a.map(x => x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x)).join(' ')) }))
  const restore = _setDispatchForTests((level, scope, message, context) => {
    chunks.push(JSON.stringify({ level, scope, message, context }))
  })
  try { return { result: await fn(), text: chunks.join('\n') } }
  finally { restore(); spies.forEach(s => s.mockRestore()) }
}

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  for (const k of ['A', 'B']) {
    const email = `ai_boundary_${k}_${RUN_ID}@example.com`
    const r = await createOrg(server, { organizationName: `AI Boundary ${k} ${RUN_ID}`, name: `Synthetic ${k}`, email, password: PW }, nextIp())
    expect(r.status).toBe(201)
    const o = { id: r.body.user.organization.id, token: r.body.token }
    if (k === 'A') orgA = o; else orgB = o
  }
  const d = await createOrg(server, { organizationName: `AI Boundary Dio ${RUN_ID}`, name: 'Synthetic Dio', email: `ai_boundary_dio_${RUN_ID}@example.com`, password: PW }, nextIp())
  expect(d.status).toBe(201)
  dio = { id: d.body.user.organization.id, token: d.body.token }
  await pool.query("UPDATE ochr_organizations SET org_type = 'diocese' WHERE id = $1", [dio.id])
  staffA = await addUser(orgA, 'staff', `ai_staff_${RUN_ID}@example.com`)
  viewerA = await addUser(orgA, 'viewer', `ai_viewer_${RUN_ID}@example.com`)
  const op = await createOrg(server, { organizationName: `AI Operator ${RUN_ID}`, name: 'Synthetic Operator', email: 'synthetic-operator@example.com', password: PW }, nextIp())
  expect(op.status).toBe(201)
  operator = { id: op.body.user.organization.id, userId: op.body.user.id, token: op.body.token }
  // R3-1: the switch is bound to the user id; the operator email is also in
  // VENDOR_ADMIN_EMAILS above, which must NOT be enough on its own.
  process.env.AI_SWITCH_OPERATOR_USER_IDS = String(operator.userId)
}, 60_000)

async function addUser(org, role, email) {
  const c = await request(server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', nextIp())
    .send({ name: `Synthetic ${role}`, email, password: PW, role })
  expect(c.status).toBe(201)
  const l = await request(server).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PW })
  expect(l.status).toBe(200)
  return { token: l.body.token, id: l.body.user.id }
}

const setByok = (org, provider, enc) => pool.query(
  'UPDATE ochr_organizations SET ai_provider = $2, ai_api_key_enc = $3, ai_model = NULL WHERE id = $1',
  [org.id, provider, enc === undefined ? encryptApiKey(`synthetic-${provider}-org-key`) : enc])
const clearByok = org => pool.query('UPDATE ochr_organizations SET ai_provider = NULL, ai_api_key_enc = NULL, ai_model = NULL WHERE id = $1', [org.id])
const setStop = stopped => request(server).put('/api/admin/ai-switch').set(auth(operator.token)).set('X-Forwarded-For', nextIp()).send({ stopped, reason: 'synthetic test' })
const assistant = (o, body) => request(server).post('/api/assistant').set(auth(o.token)).set('X-Forwarded-For', nextIp()).send(body)
const enhance = (o, text) => request(server).post('/api/ai/enhance').set(auth(o.token)).set('X-Forwarded-For', nextIp()).send({ text })
const noCalls = () => { expect(cap.anthropic).toHaveLength(0); expect(cap.openai).toHaveLength(0) }

afterAll(async () => {
  await pool.query('DELETE FROM ochr_platform_ai_switch WHERE id = 1').catch(() => {})
  for (const o of [orgA, orgB, dio, operator]) if (o) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [o.id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

beforeEach(async () => {
  cap.anthropic.length = 0; cap.openai.length = 0; cap.anthropicImpl = null; cap.openaiImpl = null
  process.env.ANTHROPIC_API_KEY = 'synthetic-platform-anthropic'
  await clearByok(orgA)
})

const generate = (o, body) => request(server).post('/api/ai/generate').set(auth(o.token)).set('X-Forwarded-For', nextIp()).send(body)


const MARK = 'SYNTH-PRIVATE-MARKER'
const leaky = (status) => {
  const e = new Error(`message ${MARK}-msg`)
  e.status = status
  e.name = `${MARK}-name`
  e.error = { type: `${MARK}-type`, message: `${MARK}-nested` }
  e.cause = new Error(`${MARK}-cause`)
  return e
}

describe('positive controls', () => {
  it('a platform generate reaches the managed route model with the text and saves the draft', async () => {
    const r = await generate(orgA, { prompt: 'Synthetic announcement for the bake sale', type: 'announcement' })
    expect(r.status).toBe(200)
    expect(r.body.output).toBe('SYNTH-DRAFT-OUTPUT')
    expect(cap.anthropic).toHaveLength(1)
    expect(cap.anthropic[0].body.model).toBe('claude-haiku-4-5-20251001')
    expect(cap.anthropic[0].body.max_tokens).toBeLessThanOrEqual(512)
    expect(cap.anthropic[0].reqOpts.timeout).toBe(30_000)
    expect(cap.anthropic[0].body.messages[0].content).toContain('Synthetic announcement for the bake sale')
    expect(cap.openai).toHaveLength(0)
  })
  it('the assistant answers a parish on the platform key and stores metadata only', async () => {
    const r = await assistant(orgA, { question: 'SYNTH-Q how do I print a tag?', page_route: '/checkin' })
    expect(r.status).toBe(200)
    expect(cap.anthropic).toHaveLength(1)
    const { rows } = await pool.query('SELECT question, answer, page_route, provider FROM ochr_assistant_messages WHERE id = $1 AND organization_id = $2', [r.body.id, orgA.id])
    expect(rows[0]).toEqual({ question: null, answer: null, page_route: '/checkin', provider: 'anthropic' })
  })
})

describe('F1: provider errors carry no upstream text', () => {
  it('helper: markers in message, name, type, nested error and cause never reach the Error', () => {
    for (const st of [400, 401, 429, 500, 529, undefined, 'x', 9999]) {
      const e = providerFailure('anthropic', leaky(st))
      expect(`${e.message}\n${e.stack}\n${JSON.stringify(e)}`).not.toContain(MARK)
    }
    expect(providerFailure('anthropic', leaky(429)).category).toBe('rate_limited')
    expect(providerFailure(`${MARK}-label`, leaky(500)).message).not.toContain(MARK)
  })
  it('generate, enhance and assistant failures: no marker in monitor/log output, no OpenAI fallback', async () => {
    cap.anthropicImpl = () => { throw leaky(529) }
    const g = await capture(() => generate(orgA, { prompt: SECRET_PROMPT, type: 'message' }))
    const e = await capture(() => enhance(orgA, SECRET_PROMPT))
    const a = await capture(() => assistant(orgA, { question: SECRET_PROMPT }))
    for (const { result, text } of [g, e, a]) {
      expect(result.status).toBe(500)
      expect(result.body.code).toBe('ai_failed')
      expect(text).not.toContain(MARK)
      expect(text).not.toContain('SYNTH-PROMPT-Q9')
    }
    expect(g.text).toContain('ai.generate')
    expect(cap.openai).toHaveLength(0)
    const { rows } = await pool.query('SELECT 1 FROM ochr_ai_generations WHERE organization_id = $1 AND prompt = $2', [orgA.id, SECRET_PROMPT])
    expect(rows).toHaveLength(0)
  })
})

describe('F2: explicit routing', () => {
  it('anthropic BYOK uses the org key for generate and assistant, never the platform key', async () => {
    await setByok(orgA, 'anthropic')
    expect((await generate(orgA, { prompt: 'Synthetic', type: 'announcement' })).status).toBe(200)
    expect((await assistant(orgA, { question: 'Synthetic help?' })).status).toBe(200)
    expect(cap.anthropic).toHaveLength(2)
    for (const c of cap.anthropic) expect(c.opts?.apiKey).toBe('synthetic-anthropic-org-key')
  })
  it('openai BYOK: generate uses OpenAI with the org key; the assistant refuses visibly with zero calls', async () => {
    await setByok(orgA, 'openai')
    const g = await generate(orgA, { prompt: 'Synthetic', type: 'announcement' })
    expect(g.status).toBe(200)
    expect(cap.openai).toHaveLength(1)
    expect(cap.openai[0].opts.apiKey).toBe('synthetic-openai-org-key')
    expect(cap.anthropic).toHaveLength(0)
    cap.openai.length = 0
    const a = await assistant(orgA, { question: 'Synthetic help?' })
    expect(a.status).toBe(403)
    expect(a.body.code).toBe('ai_unsupported_provider')
    noCalls()
    const st = await request(server).get('/api/assistant/status').set(auth(orgA.token))
    expect(st.body.available).toBe(false)
  })
  it('a malformed stored key refuses (503) with zero calls; it never becomes managed routing', async () => {
    await setByok(orgA, 'anthropic', 'not.a.valid-ciphertext')
    const g = await generate(orgA, { prompt: 'Synthetic', type: 'announcement' })
    const a = await assistant(orgA, { question: 'Synthetic help?' })
    for (const r of [g, a]) { expect(r.status).toBe(503); expect(r.body.code).toBe('ai_unavailable') }
    noCalls()
    expect((await request(server).get('/api/assistant/status').set(auth(orgA.token))).body.available).toBe(false)
  })
  it('platform-only with no platform key: 503 ai_unavailable, zero calls', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const g = await generate(orgA, { prompt: 'Synthetic', type: 'announcement' })
    expect(g.status).toBe(503)
    expect(g.body.code).toBe('ai_unavailable')
    noCalls()
  })
  it('support triage is managed-only: a BYOK parish gets its ticket, and no provider call', async () => {
    await setByok(orgA, 'anthropic')
    const t = await request(server).post('/api/support-tickets').set(auth(orgA.token)).set('X-Forwarded-For', nextIp())
      .send({ description: 'Synthetic: the roster did not load today', page_route: '/checkin' })
    expect(t.status).toBe(201)
    await runDiagnostic(t.body.id, 'Synthetic: the roster did not load today', '/checkin')
    noCalls()
    const { rows } = await pool.query('SELECT diagnosis FROM ochr_support_tickets WHERE id = $1', [t.body.id])
    expect(rows[0].diagnosis).toBeNull()
  })
})

describe('F3: support diagnostic minimization', () => {
  it('stores and sends a route template, and a failure persists a category, not the upstream text', async () => {
    cap.anthropicImpl = () => { throw leaky(500) }
    cap.anthropic.length = 0
    const t = await request(server).post('/api/support-tickets').set(auth(orgA.token)).set('X-Forwarded-For', nextIp())
      .send({ description: 'Synthetic: kiosk link broke', page_route: '/checkin/123?code=SYNTH-QCODE#SYNTH-FRAG' })
    expect(t.status).toBe(201)
    const { rows: [tk] } = await pool.query('SELECT page_route FROM ochr_support_tickets WHERE id = $1', [t.body.id])
    expect(tk.page_route).toBe('/checkin/:id')
    // the create path fires the diagnostic in the background; run it once more
    // explicitly so the assertion does not race the background call
    await runDiagnostic(t.body.id, 'Synthetic: kiosk link broke', tk.page_route)
    expect(cap.anthropic.length).toBeGreaterThanOrEqual(1)
    for (const c of cap.anthropic) expect(JSON.stringify(c.body)).not.toMatch(/SYNTH-QCODE|SYNTH-FRAG|123/)
    const { rows: [after] } = await pool.query('SELECT diagnosis FROM ochr_support_tickets WHERE id = $1', [t.body.id])
    expect(after.diagnosis).toEqual({ error: 'diagnostic_failed', category: 'upstream_error' })
    expect(JSON.stringify(after)).not.toContain(MARK)
  })
})

describe('F4: route templates, not URLs', () => {
  it('cuts query/fragment, fails closed on any encoding or odd characters, templates id segments', () => {
    expect(routeTemplate('/checkin?code=X#y')).toBe('/checkin')
    expect(routeTemplate('/members/123/edit')).toBe('/members/:id/edit')
    expect(routeTemplate('/kiosk/abcdefghijklmnopqrstuvwxyzab')).toBe('/kiosk/:id')
    for (const bad of ['/checkin%3Fcode%3DX', '/checkin%253Fcode=X', '/checkin%25253Fcode=X', '/checkin%E0%A4%A', '/x%2F..', 'checkin', '/a b', '/caf\u00e9', 'x'.repeat(600)]) {
      expect(routeTemplate(bad), bad).toBeNull()
    }
  })
  it('the assistant sends and stores only the template', async () => {
    const r = await assistant(orgA, { question: 'Where is the roster?', page_route: '/checkin/42%25253Fcode=SYNTH-ENC' })
    expect(r.status).toBe(200)
    expect(JSON.stringify(cap.anthropic[0].body)).not.toContain('SYNTH-')
    const { rows } = await pool.query('SELECT page_route FROM ochr_assistant_messages WHERE id = $1', [r.body.id])
    expect(rows[0].page_route).toBeNull()
    const r2 = await assistant(orgA, { question: 'Where?', page_route: '/members/77?tab=SYNTH-T' })
    const { rows: r2rows } = await pool.query('SELECT page_route FROM ochr_assistant_messages WHERE id = $1', [r2.body.id])
    expect(r2rows[0].page_route).toBe('/members/:id')
  })
})

describe('F5: bounds and classes at the seam', () => {
  it('an over-limit enhance is refused 413 before any provider call', async () => {
    const r = await enhance(orgA, 'x'.repeat(9_000))
    expect(r.status).toBe(413)
    expect(r.body.code).toBe('ai_input_too_large')
    noCalls()
  })
  it('a capability whose data class the route does not accept is refused 403, zero calls', async () => {
    const c = CAPABILITIES.parish_devotional_draft_v1
    const saved = c.allowedDataClasses
    c.allowedDataClasses = ['restricted']
    try {
      const r = await generate(orgA, { prompt: 'Synthetic devotional', type: 'devotional' })
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('ai_forbidden')
      noCalls()
    } finally { c.allowedDataClasses = saved }
  })
})

describe('platform AI stop (Dale/CoS)', () => {
  it('a non-operator cannot read or change it', async () => {
    expect((await request(server).get('/api/admin/ai-switch').set(auth(orgA.token))).status).toBe(404)
    expect((await request(server).put('/api/admin/ai-switch').set(auth(orgA.token)).send({ stopped: true })).status).toBe(404)
  })
  it('stopped => zero provider calls on every path, sync and async, managed and BYOK; status false; explicit resume only', async () => {
    expect((await setStop(true)).status).toBe(200)
    try {
      const g = await generate(orgA, { prompt: 'Synthetic', type: 'announcement' })
      const e = await enhance(orgA, 'Synthetic text')
      const a = await assistant(orgA, { question: 'Synthetic?' })
      for (const r of [g, e, a]) { expect(r.status).toBe(403); expect(r.body.code).toBe('ai_disabled') }
      await setByok(orgA, 'anthropic')
      expect((await generate(orgA, { prompt: 'Synthetic', type: 'announcement' })).status).toBe(403)
      await clearByok(orgA)
      const t = await request(server).post('/api/support-tickets').set(auth(orgA.token)).set('X-Forwarded-For', nextIp())
        .send({ description: 'Synthetic: ticket while AI is stopped', page_route: '/' })
      expect(t.status).toBe(201)
      await runDiagnostic(t.body.id, 'Synthetic: ticket while AI is stopped', '/')
      expect((await request(server).get('/api/assistant/status').set(auth(orgA.token))).body.available).toBe(false)
      noCalls()
      const { rows } = await pool.query('SELECT stopped, changed_by FROM ochr_platform_ai_switch_events ORDER BY id DESC LIMIT 1')
      expect(rows[0].stopped).toBe(true)
      expect(rows[0].changed_by).toBe(operator.userId)
      // R3-5: the same change is in the ordinary audit trail
      const { rows: aud } = await pool.query(
        `SELECT user_id, action, entity_type, summary, metadata FROM ochr_audit_log
          WHERE entity_type = 'ai_switch' AND organization_id = $1 ORDER BY id DESC LIMIT 1`, [operator.id])
      expect(aud[0]).toMatchObject({ user_id: operator.userId, action: 'update', summary: 'Stopped platform AI', metadata: { stopped: true, reason: 'synthetic test' } })
    } finally {
      expect((await setStop(false)).status).toBe(200)
    }
    expect((await generate(orgA, { prompt: 'Synthetic', type: 'announcement' })).status).toBe(200)
  })
})

describe('R3-1: the switch is bound to a user id, not the JWT email', () => {
  it('an email-only operator (VENDOR_ADMIN_EMAILS match, id not listed) gets 404; unset list => nobody', async () => {
    const saved = process.env.AI_SWITCH_OPERATOR_USER_IDS
    try {
      process.env.AI_SWITCH_OPERATOR_USER_IDS = String(orgA.userId ?? 999999999)
      expect((await request(server).get('/api/admin/ai-switch').set(auth(operator.token))).status).toBe(404)
      expect((await request(server).put('/api/admin/ai-switch').set(auth(operator.token)).send({ stopped: true })).status).toBe(404)
      delete process.env.AI_SWITCH_OPERATOR_USER_IDS
      expect((await request(server).get('/api/admin/ai-switch').set(auth(operator.token))).status).toBe(404)
      process.env.AI_SWITCH_OPERATOR_USER_IDS = ' , abc, 0 '
      expect((await request(server).get('/api/admin/ai-switch').set(auth(operator.token))).status).toBe(404)
    } finally { process.env.AI_SWITCH_OPERATOR_USER_IDS = saved }
    expect((await request(server).get('/api/admin/ai-switch').set(auth(operator.token))).status).toBe(200)
    const { rows } = await pool.query('SELECT stopped FROM ochr_platform_ai_switch WHERE id = 1')
    expect(rows[0]?.stopped ?? false).toBe(false)
  })
  it('R3-4: both switch tables have row level security enabled', async () => {
    const { rows } = await pool.query(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('ochr_platform_ai_switch', 'ochr_platform_ai_switch_events') ORDER BY 1`)
    expect(rows).toEqual([
      { relname: 'ochr_platform_ai_switch', relrowsecurity: true },
      { relname: 'ochr_platform_ai_switch_events', relrowsecurity: true },
    ])
  })
})

describe('R3-2: provider set without a key', () => {
  it('refuses ai_unavailable with zero calls; never the platform key', async () => {
    await setByok(orgA, 'anthropic', null)
    try {
      const g = await generate(orgA, { prompt: 'Synthetic', type: 'announcement' })
      const a = await assistant(orgA, { question: 'Synthetic?' })
      for (const r of [g, a]) { expect(r.status).toBe(503); expect(r.body.code).toBe('ai_unavailable') }
      noCalls()
    } finally { await clearByok(orgA) }
  })
})

describe('least privilege and org type', () => {
  it('raw shared AI history is admin-only; tenant-scoped for admins', async () => {
    const mark = `SYNTH-TENANT-A-${RUN_ID}`
    const made = await generate(orgA, { prompt: mark, type: 'announcement' })
    expect(made.status).toBe(200)
    for (const who of [viewerA, staffA]) {
      const r = await request(server).get('/api/ai/generations').set(auth(who.token))
      expect(r.status).toBe(403)
      expect(JSON.stringify(r.body)).not.toContain(mark)
      expect((await request(server).delete(`/api/ai/generations/${made.body.id}`).set(auth(who.token)).set('X-Forwarded-For', nextIp())).status).toBe(403)
    }
    const other = await request(server).get(`/api/ai/generations?q=${encodeURIComponent(mark)}`).set(auth(orgB.token))
    expect(other.status).toBe(200)
    expect(other.body.total).toBe(0)
    expect((await request(server).delete(`/api/ai/generations/${made.body.id}`).set(auth(orgB.token)).set('X-Forwarded-For', nextIp())).status).toBe(404)
    const own = await request(server).get(`/api/ai/generations?q=${encodeURIComponent(mark)}`).set(auth(orgA.token))
    expect(own.body.total).toBe(1)
  })
  it('assistant feedback is own-answer only and stores no note', async () => {
    const r = await assistant(orgA, { question: 'Synthetic?' })
    expect((await request(server).post(`/api/assistant/${r.body.id}/feedback`).set(auth(staffA.token)).send({ feedback: 'up' })).status).toBe(404)
    expect((await request(server).post(`/api/assistant/${r.body.id}/feedback`).set(auth(orgA.token)).send({ feedback: 'down', note: 'SYNTH-NOTE' })).status).toBe(200)
    const { rows } = await pool.query('SELECT feedback, feedback_note FROM ochr_assistant_messages WHERE id = $1', [r.body.id])
    expect(rows[0]).toEqual({ feedback: 'down', feedback_note: null })
  })
  it('a diocese session is refused parish AI (403 code), zero calls, but can still file a support ticket', async () => {
    const g = await generate(dio, { prompt: 'Synthetic', type: 'announcement' })
    const a = await assistant(dio, { question: 'Synthetic?' })
    for (const r of [g, a]) { expect(r.status).toBe(403); expect(r.body.code).toBe('org_type_forbidden') }
    noCalls()
    const t = await request(server).post('/api/support-tickets').set(auth(dio.token)).set('X-Forwarded-For', nextIp())
      .send({ description: 'Synthetic diocese report here', page_route: '/' })
    expect(t.status).toBe(201)
  })
  it('a diocese session gets no AI quota or provider settings either', async () => {
    for (const path of ['/api/ai/quota', '/api/ai/provider']) {
      const r = await request(server).get(path).set(auth(dio.token))
      expect(r.status, path).toBe(403)
      expect(r.body.code).toBe('org_type_forbidden')
    }
  })
  it('the org-type check fails closed on a DB error: 500, zero calls', async () => {
    const real = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) =>
      (typeof sql === 'string' && sql.includes('SELECT org_type FROM ochr_organizations')
        ? Promise.reject(new Error('synthetic org-type failure'))
        : real(sql, ...rest)))
    try {
      const g = await generate(orgA, { prompt: 'Synthetic', type: 'announcement' })
      const a = await assistant(orgA, { question: 'Synthetic?' })
      for (const r of [g, a]) expect(r.status).toBe(500)
      noCalls()
    } finally { spy.mockRestore() }
  })
})

describe('kill switch fails closed', () => {
  it('an unreadable switch row counts as stopped: 403 ai_disabled, zero calls', async () => {
    // let any earlier test's background support diagnostic settle first
    await new Promise(r => setTimeout(r, 300)); cap.anthropic.length = 0; cap.openai.length = 0
    const real = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) =>
      (typeof sql === 'string' && sql.includes('FROM ochr_platform_ai_switch')
        ? Promise.reject(new Error('synthetic read failure'))
        : real(sql, ...rest)))
    try {
      const r = await enhance(orgA, 'Synthetic draft line.')
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('ai_disabled')
      noCalls()
    } finally { spy.mockRestore() }
  })
})

describe('S7-F6: authoritative stop recheck at the admission boundary', () => {
  // Deterministic: the stop is committed WHILE the org-provider lookup is
  // paused (after the early check passed), then the lookup resumes.
  const realQuery = pool.query.bind(pool)
  const forceSwitch = stopped => realQuery(
    `INSERT INTO ochr_platform_ai_switch (id, stopped, reason, changed_at) VALUES (1, $1, 'synthetic race', NOW())
     ON CONFLICT (id) DO UPDATE SET stopped = EXCLUDED.stopped, reason = EXCLUDED.reason, changed_at = NOW()`, [stopped])
  async function stopDuringLookup(fn) {
    await forceSwitch(false)
    let paused = 0
    const spy = vi.spyOn(pool, 'query').mockImplementation(async (sql, ...rest) => {
      if (typeof sql === 'string' && sql.includes('SELECT ai_provider, ai_api_key_enc')) {
        paused++
        await forceSwitch(true) // the stop lands mid-lookup
      }
      return realQuery(sql, ...rest)
    })
    try { return { r: await fn(), paused } } finally { spy.mockRestore(); await forceSwitch(false) }
  }
  beforeEach(async () => { await new Promise(r => setTimeout(r, 300)); cap.anthropic.length = 0; cap.openai.length = 0 })

  it('managed generate and assistant: zero SDK calls, 403 ai_disabled', async () => {
    for (const call of [() => generate(orgA, { prompt: 'Synthetic', type: 'announcement' }), () => assistant(orgA, { question: 'Synthetic?' })]) {
      const { r, paused } = await stopDuringLookup(call)
      expect(paused).toBeGreaterThan(0)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('ai_disabled')
    }
    noCalls()
  })
  it('BYOK (anthropic and openai) generate: zero SDK calls', async () => {
    for (const p of ['anthropic', 'openai']) {
      await setByok(orgA, p)
      const { r, paused } = await stopDuringLookup(() => generate(orgA, { prompt: 'Synthetic', type: 'announcement' }))
      expect(paused).toBeGreaterThan(0)
      expect(r.status).toBe(403)
    }
    await clearByok(orgA)
    noCalls()
  })
  it('async support triage through the shared gate: zero SDK calls, ticket stands', async () => {
    const t = await request(server).post('/api/support-tickets').set(auth(orgA.token)).set('X-Forwarded-For', nextIp())
      .send({ description: 'Synthetic: race ticket here', page_route: '/' })
    expect(t.status).toBe(201)
    await new Promise(r => setTimeout(r, 300)); cap.anthropic.length = 0
    const { paused } = await stopDuringLookup(() => runDiagnostic(t.body.id, 'Synthetic: race ticket here', '/'))
    expect(paused).toBeGreaterThan(0)
    noCalls()
  })
})

describe('R4-2: an emergency stop does not depend on the audit table', () => {
  it('stop commits (logged) when the audit insert fails; resume with a failed audit rolls back', async () => {
    const realConnect = pool.connect.bind(pool)
    const spy = vi.spyOn(pool, 'connect').mockImplementation(async (cb) => {
      if (typeof cb === 'function') return realConnect(cb) // pool.query's internal path
      const c = await realConnect()
      const q = c.query.bind(c)
      c.query = (sql, ...rest) => (typeof sql === 'string' && sql.includes('INSERT INTO ochr_audit_log')
        ? Promise.reject(new Error('synthetic audit failure')) : q(sql, ...rest))
      const release = c.release.bind(c)
      c.release = (...a) => { c.query = q; return release(...a) }
      return c
    })
    try {
      const { result: stop, text } = await capture(() => setStop(true))
      expect(stop.status).toBe(200)
      expect(text).toContain('ai.switch.audit')
      let { rows } = await pool.query('SELECT stopped FROM ochr_platform_ai_switch WHERE id = 1')
      expect(rows[0].stopped).toBe(true)
      const resume = await capture(() => setStop(false))
      expect(resume.result.status).toBe(500)
      ;({ rows } = await pool.query('SELECT stopped FROM ochr_platform_ai_switch WHERE id = 1'))
      expect(rows[0].stopped).toBe(true)
    } finally { spy.mockRestore() }
    expect((await setStop(false)).status).toBe(200)
  })
})

describe('R4-3: a broken org provider is visible to the admin', () => {
  it('keyless provider => 200 { source: org, broken: true, key_last4: null }, no key material', async () => {
    await setByok(orgA, 'anthropic', null)
    try {
      const r = await request(server).get('/api/ai/provider').set(auth(orgA.token))
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ source: 'org', provider: 'anthropic', model: null, key_last4: null, broken: true })
    } finally { await clearByok(orgA) }
  })
})

describe('R5-1: the stop-audit failure report carries no row values', () => {
  it('Sentry/log get the SQLSTATE code and a generic Error only', async () => {
    const realConnect = pool.connect.bind(pool)
    const spy = vi.spyOn(pool, 'connect').mockImplementation(async (cb) => {
      if (typeof cb === 'function') return realConnect(cb)
      const c = await realConnect()
      const q = c.query.bind(c)
      c.query = (sql, ...rest) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO ochr_audit_log')) {
          const e = new Error('SYNTH-ROW-MSG violates check constraint')
          e.code = '23514'
          e.detail = 'Failing row contains (SYNTH-ROW-EMAIL@example.com, SYNTH-ROW-NAME)'
          return Promise.reject(e)
        }
        return q(sql, ...rest)
      }
      const release = c.release.bind(c)
      c.release = (...a) => { c.query = q; return release(...a) }
      return c
    })
    try {
      const { result, text } = await capture(() => setStop(true))
      expect(result.status).toBe(200)
      expect(text).toContain('ai.switch.audit failed')
      expect(text).toContain('23514')
      expect(text).not.toMatch(/SYNTH-ROW/)
    } finally { spy.mockRestore() }
    expect((await setStop(false)).status).toBe(200)
  })
})

describe('R5-2: broken only for a missing key or a failed decrypt', () => {
  it('an undecryptable key => broken:true; a transient DB error => 500, never broken', async () => {
    await setByok(orgA, 'openai', 'AAAA.BBBB.CCCC')
    try {
      const r = await request(server).get('/api/ai/provider').set(auth(orgA.token))
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ source: 'org', provider: 'openai', model: null, key_last4: null, broken: true })
    } finally { await clearByok(orgA) }
    await setByok(orgA, 'anthropic')
    const realQuery = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) =>
      typeof sql === 'string' && sql.includes('FROM ochr_organizations WHERE id') && sql.includes('ai_provider')
        ? Promise.reject(Object.assign(new Error('synthetic transient'), { code: '57P01' }))
        : realQuery(sql, ...rest))
    try {
      const r = await request(server).get('/api/ai/provider').set(auth(orgA.token))
      expect(r.status).toBe(500)
      expect(r.body.broken).toBeUndefined()
      expect(JSON.stringify(r.body)).not.toMatch(/synthetic|anthropic/)
    } finally { spy.mockRestore(); await clearByok(orgA) }
  })
})

describe('R4-5: allowlist edge cases', () => {
  it("'*' is not a wildcard; a closed (deactivated) allowlisted user is refused 401", async () => {
    const saved = process.env.AI_SWITCH_OPERATOR_USER_IDS
    try {
      process.env.AI_SWITCH_OPERATOR_USER_IDS = '*'
      expect((await request(server).get('/api/admin/ai-switch').set(auth(operator.token))).status).toBe(404)
      process.env.AI_SWITCH_OPERATOR_USER_IDS = `1,*,${operator.userId}`
      expect((await request(server).get('/api/admin/ai-switch').set(auth(operator.token))).status).toBe(200)
      const extra = await addUser({ token: operator.token }, 'admin', `ai_closed_op_${RUN_ID}@example.com`)
      process.env.AI_SWITCH_OPERATOR_USER_IDS = `${operator.userId},${extra.id}`
      expect((await request(server).get('/api/admin/ai-switch').set(auth(extra.token))).status).toBe(200)
      await pool.query('UPDATE ochr_users SET deactivated_at = NOW() WHERE id = $1', [extra.id])
      expect((await request(server).get('/api/admin/ai-switch').set(auth(extra.token))).status).toBe(401)
    } finally { process.env.AI_SWITCH_OPERATOR_USER_IDS = saved }
  })
})
