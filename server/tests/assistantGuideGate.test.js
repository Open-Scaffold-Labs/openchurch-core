// Sage-style S2 through the REAL ai/gate.js, provider keys unset.
// Grounding must not change the stop switch, the refusal codes or the
// no-fallback rule: with no key, the answer is a visible refusal and no
// SDK is ever constructed. db.js is a fake (no database).
import { describe, it, expect, beforeEach, vi } from 'vitest'

const cap = vi.hoisted(() => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  return { stopped: false, sdk: 0, inserts: 0 }
})

vi.mock('@anthropic-ai/sdk', () => ({ default: class { constructor() { cap.sdk++ } } }))
vi.mock('openai', () => ({ default: class { constructor() { cap.sdk++ } } }))
vi.mock('../src/db.js', () => ({
  default: {
    query: async (sql) => {
      if (/FROM ochr_platform_ai_switch/.test(sql)) return { rows: [{ stopped: cap.stopped }] }
      if (/FROM ochr_organizations/.test(sql)) return { rows: [{ ai_provider: null }] }
      if (/COUNT\(\*\)::int AS n FROM ochr_assistant_messages/.test(sql)) return { rows: [{ n: 0 }] }
      if (/INSERT INTO ochr_assistant_messages/.test(sql)) { cap.inserts++; return { rows: [{ id: 1 }] } }
      throw new Error(`unexpected query in test: ${sql}`)
    },
  },
}))

import express from 'express'
import request from 'supertest'
import assistantRouter from '../src/routes/assistant.js'

const app = express()
app.use(express.json())
app.use((req, _res, next) => { req.organizationId = 9002; req.user = { id: 78 }; next() })
app.use('/api/assistant', assistantRouter)

beforeEach(() => { cap.stopped = false; cap.sdk = 0; cap.inserts = 0 })

describe('grounded requests through the real gate, keys unset', () => {
  it('no platform key: 503 ai_unavailable, zero SDK constructions, nothing logged', async () => {
    const r = await request(app).post('/api/assistant').send({ question: 'Synthetic?', page_route: '/register', help_key: 'register' })
    expect(r.status).toBe(503)
    expect(r.body).toEqual({ code: 'ai_unavailable', error: 'AI is not available right now.' })
    expect(cap.sdk).toBe(0)
    expect(cap.inserts).toBe(0)
  })

  it('stop switch on: 403 ai_disabled, zero SDK constructions', async () => {
    cap.stopped = true
    const r = await request(app).post('/api/assistant').send({ question: 'Synthetic?', page_route: '/register', help_key: 'register' })
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ code: 'ai_disabled', error: 'AI features are paused for everyone right now.' })
    expect(cap.sdk).toBe(0)
  })

  it('status is an explicit available:false with no key', async () => {
    const r = await request(app).get('/api/assistant/status')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ available: false })
  })
})
