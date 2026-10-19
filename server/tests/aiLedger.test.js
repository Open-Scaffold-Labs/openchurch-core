// OSL AI plan P1: the durable AI usage ledger (ai/ledger.js) and bounded
// audit (ai/audit.js) over migration 100, and their wiring into the
// in-app assistant's platform-managed path.
//
// Real local Postgres (the CI service or scripts/local-db.mjs). Fake
// providers capture every outbound SDK call; nothing reaches a real model.
// Synthetic text and synthetic parishes only. Ledger unit tests use their
// own environment name per run so their budget sums see only their rows.
//
// Runs in the serial group (package.json): it flips the real platform AI
// switch, as aiPrivacyBoundary.test.js does, and the two must not overlap.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'

const cap = vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = 'synthetic-platform-anthropic'
  delete process.env.OPENAI_API_KEY
  return { anthropic: [], impl: null }
})

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    constructor(opts) { this.opts = opts }
    get messages() {
      return {
        create: async (body) => {
          cap.anthropic.push({ opts: this.opts, body })
          if (cap.impl) return cap.impl(body)
          return { content: [{ type: 'text', text: 'SYNTH-ANSWER' }], usage: { input_tokens: 321, output_tokens: 54 } }
        },
      }
    }
  },
}))

import request from 'supertest'
import pool from '../src/db.js'
import {
  reserve, settle, voidReservation, committed, createDurableLedger, reservationIdFor,
  usdToMicros, budgetLimits, limitTextToMicros, LedgerError, _setReserveHookForTests, MAX_RESERVATION_USD,
} from '../src/ai/ledger.js'
import { recordAiEvent, AuditError } from '../src/ai/audit.js'
import { CAPABILITIES } from '../src/ai/policy.js'
import { encryptApiKey } from '../src/ai/orgProvider.js'
import { RUN_ID, bindServer, closeServer, migrateOnce } from './support/harness.js'
import { createOrg } from './support/provision.js'

const PW = 'ai-ledger-pw'
const QUESTION = 'SYNTH-LEDGER-QUESTION how do I print a tag?'
const ENV = `test-ledger-${RUN_ID}`
let server, orgA, orgB, ipSeq = 1
const nextIp = () => `10.77.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
const auth = t => ({ Authorization: `Bearer ${t}` })
const scopeOf = (o, environment = ENV) => ({ application: 'openchurch', environment, tenantId: String(o.id) })
const LIMITS = { tenantMicros: 1_000_000, aggregateMicros: 10_000_000 }
let seq = 0
const rid = (tag = 'r') => `${tag}-${RUN_ID}-${++seq}`
const row = id => pool.query('SELECT * FROM ochr_ai_ledger WHERE reservation_id = $1', [id]).then(r => r.rows[0])
const codeOf = async (p) => { try { await p; return 'OK' } catch (e) { return e.code } }

const forceSwitch = stopped => pool.query(
  `INSERT INTO ochr_platform_ai_switch (id, stopped, reason, changed_at) VALUES (1, $1, 'synthetic ledger', NOW())
   ON CONFLICT (id) DO UPDATE SET stopped = EXCLUDED.stopped, reason = EXCLUDED.reason, changed_at = NOW()`, [stopped])

beforeAll(async () => {
  await migrateOnce()
  server = await bindServer()
  for (const k of ['A', 'B']) {
    const r = await createOrg(server, { organizationName: `AI Ledger ${k} ${RUN_ID}`, name: `Synthetic ${k}`, email: `ai_ledger_${k}_${RUN_ID}@example.com`, password: PW }, nextIp())
    expect(r.status).toBe(201)
    const o = { id: r.body.user.organization.id, userId: r.body.user.id, token: r.body.token }
    if (k === 'A') orgA = o; else orgB = o
  }
}, 60_000)

afterAll(async () => {
  await forceSwitch(false).catch(() => {})
  await pool.query('DELETE FROM ochr_ai_ledger WHERE environment = $1', [ENV]).catch(() => {})
  for (const o of [orgA, orgB]) if (o) await pool.query('DELETE FROM ochr_organizations WHERE id = $1', [o.id]).catch(() => {})
  await closeServer(server)
  await pool.end()
})

// ------------------------------------------------------------------ units --
describe('units: dollars at the OSL boundary, whole microdollars inside', () => {
  it('converts from decimal text, rounding charges up and limits down', () => {
    expect(usdToMicros(0.000001)).toBe(1)
    expect(usdToMicros(0.0000011)).toBe(2)
    expect(usdToMicros(0.0000011, { roundUp: false })).toBe(1)
    expect(usdToMicros(0.1 + 0.2)).toBe(300_001)
    expect(usdToMicros(0.02)).toBe(20_000)
    expect(usdToMicros(1e-7)).toBe(1)
    expect(usdToMicros(0)).toBe(0)
  })
  it('refuses negative, NaN, infinite and non-number amounts', () => {
    for (const bad of [-0.01, NaN, Infinity, -Infinity, '0.02', null, undefined, 1n]) {
      expect(() => usdToMicros(bad), String(bad)).toThrow(LedgerError)
    }
  })
  it('the OSL ledger refuses a raw microdollar figure instead of reserving $20,000', async () => {
    const ledger = createDurableLedger({ scope: scopeOf(orgA), limits: { tenantMicros: 100_000_000_000, aggregateMicros: 100_000_000_000 } })
    const raw = CAPABILITIES.parish_text_enhance_v1.reservationUsd // 20000 — microdollars
    const requestId = rid('raw')
    const id = reservationIdFor(scopeOf(orgA), requestId)
    expect(await codeOf(ledger.reserve({ id, scope: scopeOf(orgA), requestId, amountUsd: raw }))).toBe('INVALID_REQUEST')
    expect(await row(id)).toBeUndefined()
    // ...and the same capability in dollars reserves exactly its microdollars.
    await ledger.reserve({ id, scope: scopeOf(orgA), requestId, amountUsd: raw / 1_000_000 })
    expect(Number((await row(id)).reserved_micros)).toBe(raw)
    expect(MAX_RESERVATION_USD).toBeLessThan(raw)
  })
  it('budget limits: defaults, dollars rounded down, malformed refuses', () => {
    expect(budgetLimits({})).toEqual({ tenantMicros: 5_000_000, aggregateMicros: 25_000_000 })
    expect(budgetLimits({ AI_BUDGET_PARISH_MONTHLY_USD: '0.0000019', AI_BUDGET_TOTAL_MONTHLY_USD: '3' }))
      .toEqual({ tenantMicros: 1, aggregateMicros: 3_000_000 })
    for (const bad of ['-1', 'ten', '1e3', 'Infinity', ' NaN']) {
      expect(() => budgetLimits({ AI_BUDGET_PARISH_MONTHLY_USD: bad }), bad).toThrow(/ACCOUNTING_UNAVAILABLE/)
    }
  })
})

// R325-1 (TARS): a configured limit is parsed from its decimal text and
// only ever rounds DOWN. Number('0.100000999999999999999') is 0.100001,
// which the old conversion turned into 100001 microdollars.
describe('budget limits never round up (R325-1)', () => {
  const parish = v => budgetLimits({ AI_BUDGET_PARISH_MONTHLY_USD: v }).tenantMicros
  it('the reproduced value floors to 100000, not 100001', () => {
    expect(parish('0.100000999999999999999')).toBe(100_000)
    expect(budgetLimits({ AI_BUDGET_TOTAL_MONTHLY_USD: '0.100000999999999999999' }).aggregateMicros).toBe(100_000)
  })
  it('boundary values: whole micros, just below, just above', () => {
    const cases = {
      '0': 0, '0.0': 0, '0.000000': 0, '0.0000009': 0, '0.000000999999999999': 0,
      '0.000001': 1, '0.0000019': 1, '0.0000019999999999999999': 1,
      '0.1': 100_000, '0.100000': 100_000, '0.1000009': 100_000, '0.100001': 100_001,
      '1': 1_000_000, '1.0000005': 1_000_000, '0.999999999999999999999': 999_999,
      '5': 5_000_000, '25.000000999': 25_000_000, ' 3 ': 3_000_000,
      '9007199254.740991': Number.MAX_SAFE_INTEGER,
    }
    for (const [text, micros] of Object.entries(cases)) expect(parish(text), text).toBe(micros)
  })
  it('many-decimal inputs truncate at the sixth place and never exceed the exact value', () => {
    for (let digits = 7; digits <= 60; digits++) {
      const nines = '0.' + '9'.repeat(digits)
      expect(parish(nines), nines).toBe(999_999)
      const tail = '12.345678' + '9'.repeat(digits - 6)
      expect(parish(tail), tail).toBe(12_345_678)
    }
  })
  it('defaults stay; malformed and out-of-range values still refuse', () => {
    expect(budgetLimits({})).toEqual({ tenantMicros: 5_000_000, aggregateMicros: 25_000_000 })
    for (const bad of ['-0.1', '.5', '5.', '1e3', '0x10', '1,000', '+1', 'Infinity', 'NaN', '1 2', '9007199254.740992', '1' + '0'.repeat(30)]) {
      expect(() => parish(bad), bad).toThrow(/ACCOUNTING_UNAVAILABLE/)
    }
    expect(() => limitTextToMicros(5)).toThrow(/ACCOUNTING_UNAVAILABLE/)
  })
  it('charges still round up while limits round down', () => {
    expect(usdToMicros(0.0000011)).toBe(2)
    expect(parish('0.0000011')).toBe(1)
  })
  it('Postgres admission at a configured over-precision limit: exactly at the limit admitted, one micro over refused', async () => {
    const env = `${ENV}-r325`
    const lim = budgetLimits({ AI_BUDGET_PARISH_MONTHLY_USD: '0.100000999999999999999', AI_BUDGET_TOTAL_MONTHLY_USD: '0.100000999999999999999' })
    const go = amountMicros => codeOf(reserve({ scope: scopeOf(orgA, env), requestId: rid('r325'), capability: 'c', amountMicros, limits: lim }))
    try {
      expect(await go(100_001)).toBe('BUDGET_EXCEEDED') // one micro over, alone
      expect(await go(99_999)).toBe('OK')
      expect(await go(1)).toBe('OK')                     // exactly at the limit: 100,000
      expect(await go(1)).toBe('BUDGET_EXCEEDED')        // one micro over
      expect((await committed(scopeOf(orgA, env))).tenantMicros).toBe(100_000)
    } finally { await pool.query('DELETE FROM ochr_ai_ledger WHERE environment = $1', [env]) }
  })
})

// --------------------------------------------------------------- reserve --
describe('reserve: unique, bounded, tenant-scoped', () => {
  it('a duplicate request is refused before and after settlement', async () => {
    const requestId = rid('dup')
    const { id } = await reserve({ scope: scopeOf(orgA), requestId, capability: 'parish_assistant_v1', amountMicros: 10_000, limits: LIMITS })
    expect(await codeOf(reserve({ scope: scopeOf(orgA), requestId, capability: 'parish_assistant_v1', amountMicros: 10_000, limits: LIMITS }))).toBe('DUPLICATE_REQUEST')
    await settle({ scope: scopeOf(orgA), id, outcome: 'success', actualMicros: 0 })
    expect(await codeOf(reserve({ scope: scopeOf(orgA), requestId, capability: 'parish_assistant_v1', amountMicros: 10_000, limits: LIMITS }))).toBe('DUPLICATE_REQUEST')
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM ochr_ai_ledger WHERE request_id = $1', [requestId])
    expect(rows[0].n).toBe(1)
  })
  it('the same request id in another parish is a different reservation', async () => {
    const requestId = rid('shared')
    const a = await reserve({ scope: scopeOf(orgA), requestId, capability: 'c', amountMicros: 1, limits: LIMITS })
    const b = await reserve({ scope: scopeOf(orgB), requestId, capability: 'c', amountMicros: 1, limits: LIMITS })
    expect(a.id).not.toBe(b.id)
  })
  it('zero, negative, fractional and NaN reservations are refused', async () => {
    for (const amountMicros of [0, -1, 1.5, NaN, Infinity, '10']) {
      expect(await codeOf(reserve({ scope: scopeOf(orgA), requestId: rid('bad'), capability: 'c', amountMicros, limits: LIMITS })), String(amountMicros)).toBe('INVALID_REQUEST')
    }
  })
  it('a scope that names no organization, or no tenant, is refused', async () => {
    expect(await codeOf(reserve({ scope: { application: 'openchurch', environment: ENV, tenantId: '2147483000' }, requestId: rid('fk'), capability: 'c', amountMicros: 1, limits: LIMITS }))).toBe('INVALID_REQUEST')
    expect(await codeOf(reserve({ scope: { application: 'openchurch', environment: ENV, publicSessionId: 'x' }, requestId: rid('anon'), capability: 'c', amountMicros: 1, limits: LIMITS }))).toBe('INVALID_REQUEST')
    expect(await codeOf(reserve({ scope: { application: 'openchurch', environment: ENV, tenantId: '1 OR 1=1' }, requestId: rid('inj'), capability: 'c', amountMicros: 1, limits: LIMITS }))).toBe('INVALID_REQUEST')
  })
  it('the parish limit and the overall limit both refuse', async () => {
    const env = `${ENV}-limit`
    const lim = { tenantMicros: 25_000, aggregateMicros: 35_000 }
    const go = o => codeOf(reserve({ scope: scopeOf(o, env), requestId: rid('lim'), capability: 'c', amountMicros: 10_000, limits: lim }))
    expect(await go(orgA)).toBe('OK')
    expect(await go(orgA)).toBe('OK')
    expect(await go(orgA)).toBe('BUDGET_EXCEEDED') // parish: 30,000 > 25,000
    expect(await go(orgB)).toBe('OK')               // total 30,000
    expect(await go(orgB)).toBe('BUDGET_EXCEEDED') // total: 40,000 > 35,000
    await pool.query('DELETE FROM ochr_ai_ledger WHERE environment = $1', [env])
  })
})

// ----------------------------------------------------------- concurrency --
describe('concurrency: the budget check and the claim are one atomic step', () => {
  it('a second request waits for the first claim and then sees it (controlled interleaving)', async () => {
    const env = `${ENV}-race`
    const lim = { tenantMicros: 10_000, aggregateMicros: 10_000 } // room for exactly one
    let release, arrived = 0
    const gate = new Promise(r => { release = r })
    const restore = _setReserveHookForTests(async () => { arrived++; if (arrived === 1) await gate })
    try {
      const first = reserve({ scope: scopeOf(orgA, env), requestId: rid('race'), capability: 'c', amountMicros: 10_000, limits: lim })
      while (arrived === 0) await new Promise(r => setTimeout(r, 10))
      const second = codeOf(reserve({ scope: scopeOf(orgA, env), requestId: rid('race'), capability: 'c', amountMicros: 10_000, limits: lim }))
      // Give the second request every chance to get past the check.
      await new Promise(r => setTimeout(r, 400))
      const { rows: waiting } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)
      expect(arrived).toBe(1)
      expect(waiting[0].n).toBeGreaterThanOrEqual(1)
      release()
      await first
      expect(await second).toBe('BUDGET_EXCEEDED')
    } finally { release(); restore() }
    const used = await committed(scopeOf(orgA, env))
    expect(used.tenantMicros).toBe(10_000)
    await pool.query('DELETE FROM ochr_ai_ledger WHERE environment = $1', [env])
  })
  it('a burst of 20 concurrent requests admits exactly what the budget holds', async () => {
    const env = `${ENV}-burst`
    const lim = { tenantMicros: 70_000, aggregateMicros: 70_000 }
    const restore = _setReserveHookForTests(() => new Promise(r => setTimeout(r, 5)))
    let results
    try {
      results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        codeOf(reserve({ scope: scopeOf(i % 2 ? orgA : orgB, env), requestId: rid('burst'), capability: 'c', amountMicros: 10_000, limits: lim }))))
    } finally { restore() }
    expect(results.filter(r => r === 'OK')).toHaveLength(7)
    expect(results.filter(r => r === 'BUDGET_EXCEEDED')).toHaveLength(13)
    const { rows } = await pool.query('SELECT COALESCE(SUM(reserved_micros),0)::int AS s FROM ochr_ai_ledger WHERE environment = $1', [env])
    expect(rows[0].s).toBe(70_000)
    await pool.query('DELETE FROM ochr_ai_ledger WHERE environment = $1', [env])
  })
})

// ---------------------------------------------------------------- settle --
describe('settle: void is not delete, failed is not zero, unknown is not empty', () => {
  const env = () => `${ENV}-settle`
  afterEach(() => pool.query('DELETE FROM ochr_ai_ledger WHERE environment = $1', [env()]))
  const take = (o = orgA) => reserve({ scope: scopeOf(o, env()), requestId: rid('s'), capability: 'c', amountMicros: 10_000, limits: LIMITS })

  it('an unknown cost keeps the full reservation counted; a known cost replaces it', async () => {
    const a = await take(); const b = await take(); const c = await take(); const d = await take()
    await settle({ scope: scopeOf(orgA, env()), id: a.id, outcome: 'success', actualMicros: null, usage: { inputTokens: 5, outputTokens: null } })
    await settle({ scope: scopeOf(orgA, env()), id: b.id, outcome: 'failed', actualMicros: null })
    await settle({ scope: scopeOf(orgA, env()), id: c.id, outcome: 'success', actualMicros: 1_234 })
    // d is never settled: still held.
    expect((await committed(scopeOf(orgA, env()))).tenantMicros).toBe(10_000 + 10_000 + 1_234 + 10_000)
    const ra = await row(a.id)
    expect(ra.settled_micros).toBeNull()
    expect(ra.outcome).toBe('success')
    expect(Number(ra.input_tokens)).toBe(5)
    expect(ra.output_tokens).toBeNull() // missing usage is unknown, never zero
    expect((await row(d.id)).settled_at).toBeNull()
  })
  it('a void is a known zero and the row stays', async () => {
    const a = await take()
    await voidReservation({ scope: scopeOf(orgA, env()), id: a.id })
    const r = await row(a.id)
    expect(r).toBeDefined()
    expect(r.outcome).toBe('void')
    expect(Number(r.settled_micros)).toBe(0)
    expect((await committed(scopeOf(orgA, env()))).tenantMicros).toBe(0)
  })
  it('settle is idempotent: the first outcome stands', async () => {
    const a = await take()
    expect((await settle({ scope: scopeOf(orgA, env()), id: a.id, outcome: 'failed', actualMicros: null })).alreadySettled).toBe(false)
    expect((await settle({ scope: scopeOf(orgA, env()), id: a.id, outcome: 'success', actualMicros: 0 })).alreadySettled).toBe(true)
    const r = await row(a.id)
    expect(r.outcome).toBe('failed')
    expect(r.settled_micros).toBeNull()
  })
  it('another parish cannot settle, void or read a reservation', async () => {
    const b = await take(orgB)
    expect(await codeOf(settle({ scope: scopeOf(orgA, env()), id: b.id, outcome: 'success', actualMicros: 0 }))).toBe('ACCOUNTING_UNAVAILABLE')
    expect(await codeOf(voidReservation({ scope: scopeOf(orgA, env()), id: b.id }))).toBe('ACCOUNTING_UNAVAILABLE')
    expect((await row(b.id)).settled_at).toBeNull()
    expect((await committed(scopeOf(orgA, env()))).tenantMicros).toBe(0)
    expect((await committed(scopeOf(orgB, env()))).tenantMicros).toBe(10_000)
  })
  it('negative, fractional and NaN costs or token counts are refused', async () => {
    const a = await take()
    for (const actualMicros of [-1, 0.5, NaN, Infinity]) {
      expect(await codeOf(settle({ scope: scopeOf(orgA, env()), id: a.id, outcome: 'success', actualMicros })), String(actualMicros)).toBe('INVALID_REQUEST')
    }
    expect(await codeOf(settle({ scope: scopeOf(orgA, env()), id: a.id, outcome: 'success', usage: { inputTokens: -3 } }))).toBe('INVALID_REQUEST')
    expect(await codeOf(settle({ scope: scopeOf(orgA, env()), id: a.id, outcome: 'free text outcome' }))).toBe('INVALID_REQUEST')
    expect((await row(a.id)).settled_at).toBeNull()
  })
  it('late settle: a reservation still settles after AI is stopped', async () => {
    const a = await take()
    await forceSwitch(true)
    try {
      expect((await settle({ scope: scopeOf(orgA, env()), id: a.id, outcome: 'success', actualMicros: null })).alreadySettled).toBe(false)
    } finally { await forceSwitch(false) }
    expect((await row(a.id)).outcome).toBe('success')
  })
  it('the OSL ledger settles only within its own tenant and refuses a claimed fallback', async () => {
    const la = createDurableLedger({ scope: scopeOf(orgA, env()), limits: LIMITS })
    const lb = createDurableLedger({ scope: scopeOf(orgB, env()), limits: LIMITS })
    const requestId = rid('osl')
    const id = reservationIdFor(scopeOf(orgB, env()), requestId)
    expect(await codeOf(la.reserve({ id, scope: scopeOf(orgB, env()), requestId, amountUsd: 0.01 }))).toBe('INVALID_REQUEST')
    await lb.reserve({ id, scope: scopeOf(orgB, env()), requestId, amountUsd: 0.01 })
    expect(await codeOf(la.settle({ id, actualCostUsd: 0 }))).toBe('ACCOUNTING_UNAVAILABLE')
    expect(await codeOf(lb.settle({ id, actualCostUsd: 0.001, fallbackUsed: true }))).toBe('INVALID_REQUEST')
    expect(await lb.settle({ id, actualCostUsd: null, outcome: 'success', usage: { inputTokens: 1, outputTokens: 2 } })).toEqual({ id })
    expect((await row(id)).settled_micros).toBeNull()
  })
})

// ----------------------------------------------------------------- audit --
describe('audit: metadata only, and a failed write is an error', () => {
  const base = () => ({ application: 'openchurch', environment: ENV, tenantId: String(orgA.id), actorId: orgA.userId, requestId: rid('aud'), capability: 'parish_assistant_v1' })
  it('stores the fixed metadata and drops anything else', async () => {
    const e = { ...base(), event: 'succeeded', usage: { inputTokens: 3, outputTokens: 4 }, prompt: QUESTION, response: 'SYNTH-ANSWER', originalError: { message: 'SYNTH-RAW' } }
    await recordAiEvent(e)
    const { rows } = await pool.query('SELECT * FROM ochr_ai_audit WHERE request_id = $1', [e.requestId])
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].input_tokens)).toBe(3)
    const all = JSON.stringify(rows[0])
    for (const leak of [QUESTION, 'SYNTH-ANSWER', 'SYNTH-RAW']) expect(all).not.toContain(leak)
  })
  it('refuses free text where an identifier belongs, and an actor from another parish', async () => {
    expect(await codeOf(recordAiEvent({ ...base(), event: 'failed', code: 'Upstream said: SYNTH secret text' }))).toBe('AUDIT_UNAVAILABLE')
    expect(await codeOf(recordAiEvent({ ...base(), event: 'whatever' }))).toBe('AUDIT_UNAVAILABLE')
    expect(await codeOf(recordAiEvent({ ...base(), actorId: orgB.userId, event: 'started' }))).toBe('AUDIT_UNAVAILABLE')
  })
  it('a database failure surfaces as AuditError', async () => {
    const real = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) =>
      (typeof sql === 'string' && sql.includes('INSERT INTO ochr_ai_audit') ? Promise.reject(new Error('synthetic audit failure')) : real(sql, ...rest)))
    try {
      await expect(recordAiEvent({ ...base(), event: 'started' })).rejects.toBeInstanceOf(AuditError)
    } finally { spy.mockRestore() }
  })
})

// ------------------------------------------------- the assistant, wired --
describe('the assistant on the managed route: reserve, recheck, send, settle', () => {
  const ask = (o = orgA, body = { question: QUESTION }) => request(server).post('/api/assistant').set(auth(o.token)).set('X-Forwarded-For', nextIp()).send(body)
  const ledgerRows = o => pool.query(`SELECT * FROM ochr_ai_ledger WHERE organization_id = $1 AND environment = 'test' ORDER BY created_at`, [o.id]).then(r => r.rows)
  const auditRows = o => pool.query(`SELECT * FROM ochr_ai_audit WHERE organization_id = $1 AND environment = 'test' ORDER BY id`, [o.id]).then(r => r.rows)
  const clear = async () => {
    for (const o of [orgA, orgB]) {
      await pool.query('DELETE FROM ochr_ai_ledger WHERE organization_id = $1', [o.id])
      await pool.query('DELETE FROM ochr_ai_audit WHERE organization_id = $1', [o.id])
    }
  }
  beforeEach(async () => {
    cap.anthropic.length = 0; cap.impl = null
    process.env.ANTHROPIC_API_KEY = 'synthetic-platform-anthropic'
    process.env.AI_BUDGET_PARISH_MONTHLY_USD = '1000'
    process.env.AI_BUDGET_TOTAL_MONTHLY_USD = '100000'
    await forceSwitch(false)
    await clear()
  })
  afterEach(() => { delete process.env.AI_BUDGET_PARISH_MONTHLY_USD; delete process.env.AI_BUDGET_TOTAL_MONTHLY_USD })

  it('success: one reservation, settled with tokens and the cost unknown; audit started + succeeded; no text stored', async () => {
    const r = await ask()
    expect(r.status).toBe(200)
    expect(r.body.answer).toBe('SYNTH-ANSWER')
    const [l, ...more] = await ledgerRows(orgA)
    expect(more).toHaveLength(0)
    expect(l.outcome).toBe('success')
    expect(l.capability).toBe('parish_assistant_v1')
    expect(Number(l.reserved_micros)).toBe(CAPABILITIES.parish_assistant_v1.reservationUsd)
    expect(l.settled_micros).toBeNull()
    expect([Number(l.input_tokens), Number(l.output_tokens)]).toEqual([321, 54])
    const a = await auditRows(orgA)
    expect(a.map(x => x.event)).toEqual(['started', 'succeeded'])
    expect(a.every(x => x.request_id === l.request_id && x.actor_id === orgA.userId)).toBe(true)
    const all = JSON.stringify([l, a])
    expect(all).not.toContain('SYNTH-LEDGER-QUESTION')
    expect(all).not.toContain('SYNTH-ANSWER')
  })

  it('every request gets its own idempotency key', async () => {
    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(200)
    const rows = await ledgerRows(orgA)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(x => x.request_id)).size).toBe(2)
  })

  it('a stop committed during the reservation refuses before send and voids the claim', async () => {
    const restore = _setReserveHookForTests(() => forceSwitch(true))
    let r
    try { r = await ask() } finally { restore(); await forceSwitch(false) }
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('ai_disabled')
    expect(cap.anthropic).toHaveLength(0)
    const [l] = await ledgerRows(orgA)
    expect(l.outcome).toBe('void')
    expect(Number(l.settled_micros)).toBe(0)
    expect((await auditRows(orgA)).map(x => [x.event, x.error_code])).toEqual([['started', null], ['denied', 'ai_disabled']])
  })

  it('a stop committed while the call is in flight still settles it (late settle)', async () => {
    cap.impl = async () => { await forceSwitch(true); return { content: [{ type: 'text', text: 'SYNTH-ANSWER' }], usage: { input_tokens: 1, output_tokens: 2 } } }
    let r
    try { r = await ask() } finally { await forceSwitch(false) }
    expect(r.status).toBe(200)
    const [l] = await ledgerRows(orgA)
    expect(l.outcome).toBe('success')
    expect(l.settled_at).not.toBeNull()
  })

  it('a provider failure after send keeps the reservation (failed is not zero)', async () => {
    cap.impl = async () => { const e = new Error('SYNTH-UPSTREAM-BODY'); e.status = 529; throw e }
    const r = await ask()
    expect(r.status).toBeGreaterThanOrEqual(500)
    expect(cap.anthropic).toHaveLength(1)
    const [l] = await ledgerRows(orgA)
    expect(l.outcome).toBe('failed')
    expect(l.settled_micros).toBeNull()
    expect((await committed({ application: 'openchurch', environment: 'test', tenantId: String(orgA.id) })).tenantMicros)
      .toBe(CAPABILITIES.parish_assistant_v1.reservationUsd)
    const a = await auditRows(orgA)
    expect(a.map(x => [x.event, x.error_code])).toEqual([['started', null], ['failed', 'provider_failed']])
    expect(JSON.stringify(a)).not.toContain('SYNTH-UPSTREAM-BODY')
  })

  it('over budget: 503 ai_unavailable, zero SDK calls, a denied audit, nothing claimed', async () => {
    process.env.AI_BUDGET_PARISH_MONTHLY_USD = '0.005'
    const r = await ask()
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('ai_unavailable')
    expect(cap.anthropic).toHaveLength(0)
    expect(await ledgerRows(orgA)).toHaveLength(0)
    expect((await auditRows(orgA)).map(x => [x.event, x.error_code])).toEqual([['started', null], ['denied', 'BUDGET_EXCEEDED']])
  })

  it('a malformed budget refuses rather than spending', async () => {
    process.env.AI_BUDGET_TOTAL_MONTHLY_USD = 'unlimited'
    const r = await ask()
    expect(r.status).toBe(503)
    expect(cap.anthropic).toHaveLength(0)
  })

  it('the ledger unreachable: 503, zero SDK calls', async () => {
    // Only the reserve transaction's checkout fails; pool.query (callback
    // form internally) keeps working, so auth and routing are unaffected.
    const realConnect = pool.connect.bind(pool)
    const spy = vi.spyOn(pool, 'connect').mockImplementation(async (cb) => {
      if (typeof cb === 'function') return realConnect(cb)
      throw new Error('synthetic connect failure')
    })
    let r
    try { r = await ask() } finally { spy.mockRestore() }
    expect(r.status).toBe(503)
    expect(cap.anthropic).toHaveLength(0)
  })

  it('the audit unwritable: 503, zero SDK calls, nothing reserved', async () => {
    const real = pool.query.bind(pool)
    const spy = vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) =>
      (typeof sql === 'string' && sql.includes('INSERT INTO ochr_ai_audit') ? Promise.reject(new Error('synthetic audit failure')) : real(sql, ...rest)))
    let r
    try { r = await ask() } finally { spy.mockRestore() }
    expect(r.status).toBe(503)
    expect(cap.anthropic).toHaveLength(0)
    expect(await ledgerRows(orgA)).toHaveLength(0)
  })

  it('AI stopped (as in production): 403 ai_disabled, no ledger or audit rows', async () => {
    await forceSwitch(true)
    let r
    try { r = await ask() } finally { await forceSwitch(false) }
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('ai_disabled')
    expect(await ledgerRows(orgA)).toHaveLength(0)
    expect(await auditRows(orgA)).toHaveLength(0)
  })

  it('no platform key (managed AI off): refused before any ledger or audit write', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const r = await ask()
    expect(r.status).toBe(503)
    expect(await ledgerRows(orgA)).toHaveLength(0)
    expect(await auditRows(orgA)).toHaveLength(0)
  })

  it("a parish's own Anthropic key is not accounted (unchanged)", async () => {
    await pool.query('UPDATE ochr_organizations SET ai_provider = $2, ai_api_key_enc = $3 WHERE id = $1', [orgB.id, 'anthropic', encryptApiKey('synthetic-org-key')])
    try {
      const r = await ask(orgB)
      expect(r.status).toBe(200)
      expect(cap.anthropic[0].opts.apiKey).toBe('synthetic-org-key')
    } finally {
      await pool.query('UPDATE ochr_organizations SET ai_provider = NULL, ai_api_key_enc = NULL WHERE id = $1', [orgB.id])
    }
    expect(await ledgerRows(orgB)).toHaveLength(0)
    expect(await auditRows(orgB)).toHaveLength(0)
  })
})
