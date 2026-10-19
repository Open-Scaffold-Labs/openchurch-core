// Durable AI usage ledger over ochr_ai_ledger (migration 100). P1 of the
// OSL AI migration plan: a claim taken BEFORE a model call, settled or
// voided after it, and never released just because we stopped waiting.
//
// THE RULES THIS FILE EXISTS TO KEEP
//   - Reserve before the call. The budget check and the claim happen in ONE
//     transaction under a transaction-scoped advisory lock, so concurrent
//     requests cannot each see "room for one more" and both take it.
//   - Void is not delete. A reservation that was never sent is settled with a
//     known zero and outcome 'void'; the row stays.
//   - Failed is not zero. A call that was sent and then failed is settled
//     with settled_micros NULL, which keeps the full reservation counted.
//   - Unknown is not empty. NULL cost, NULL usage and an unsettled row all
//     count as the reserved amount. Only a caller-supplied known number
//     replaces it.
//   - Every read and write names the tenant. There is no by-id-only path:
//     a reservation id from another parish matches nothing.
//   - Settling is accounting, not admission. It never consults the platform
//     stop, so a call that was in flight when AI was stopped still lands its
//     receipt.
//
// UNITS. The table and every host value here are integer MICROdollars. OSL
// AI's ledger interface speaks DOLLARS (osl-ai docs/BUILD-CONTRACT.md,
// "Ledger interface"). The only dollar entry point is createDurableLedger()
// below, which converts once and refuses an amount that can only be a raw
// microdollar figure passed by mistake (MAX_RESERVATION_USD).
//
// BUDGET WINDOW. A calendar month in UTC. The memory ledger in osl-ai has no
// window at all; a durable one without a window would refuse forever after
// the first month. The limits are configuration, not policy: per-parish and
// overall amounts are an open decision (OSL AI plan, decision 5) and the
// defaults are deliberately small.
import { createHash } from 'node:crypto'
import pool from '../db.js'

export const LEDGER_APPLICATION = 'openchurch'

// The largest single reservation the dollar interface accepts. Every real
// capability reserves cents. 0.02 passed as raw microdollars is 20000,
// which is refused here rather than claimed as $20,000.
export const MAX_RESERVATION_USD = 1

// Conservative until José decides (see the PR body). Dollars per UTC month.
export const DEFAULT_TENANT_MONTHLY_USD = 5
export const DEFAULT_AGGREGATE_MONTHLY_USD = 25

const MAX_MICROS = BigInt(Number.MAX_SAFE_INTEGER)

// One lock for every reservation in the database. The aggregate limit spans
// all parishes, so a per-parish lock would not serialise the check that
// matters. Transaction-scoped (released at COMMIT/ROLLBACK), which also holds
// under a transaction-mode pooler. Two int4 keys: a class and a slot.
const LOCK_CLASS = 0x4f43_4149 // 'OCAI'
const LOCK_SLOT = 1

export class LedgerError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}
const invalid = (detail) => { throw new LedgerError('INVALID_REQUEST', detail) }

export function ledgerEnvironment(env = process.env) {
  return env.VERCEL_ENV || env.NODE_ENV || 'development'
}

// Dollars to whole microdollars from the number's decimal text, never by
// multiplying floats: 0.000001 is exactly one microdollar, and a fraction
// of a microdollar rounds UP for a charge and DOWN for a limit.
export function usdToMicros(value, { roundUp = true } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid('amount must be a finite, non-negative number of dollars')
  const [coefficient, exponent = '0'] = value.toString().toLowerCase().split('e')
  const [whole, fraction = ''] = coefficient.split('.')
  const digits = BigInt(whole + fraction)
  const places = Number(exponent) - fraction.length + 6
  let micros
  if (places >= 0) micros = digits * (10n ** BigInt(places))
  else {
    const divisor = 10n ** BigInt(-places)
    micros = roundUp ? (digits + divisor - 1n) / divisor : digits / divisor
  }
  if (micros > MAX_MICROS) invalid('amount out of range')
  return Number(micros)
}

export function microsToUsd(micros) {
  return Number(micros) / 1_000_000
}

function wholeMicros(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${what} must be a whole, non-negative number of microdollars`)
  return value
}

// Limits come from the environment as dollars, as TEXT. They are parsed
// from that text straight into whole microdollars and never pass through a
// JS Number: Number('0.100000999999999999999') is 0.100001, which would
// round a limit UP (TARS R325-1). Digits past the sixth decimal place are
// truncated, so a limit only ever rounds down. A malformed value is not a
// reason to fall back to a default or to "unlimited": it refuses.
const LIMIT_TEXT = /^(\d+)(?:\.(\d+))?$/

export function limitTextToMicros(raw, name = 'limit') {
  const m = typeof raw === 'string' ? LIMIT_TEXT.exec(raw.trim()) : null
  if (!m) throw new LedgerError('ACCOUNTING_UNAVAILABLE', `${name} is not a dollar amount`)
  const micros = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').slice(0, 6).padEnd(6, '0'))
  if (micros > MAX_MICROS) throw new LedgerError('ACCOUNTING_UNAVAILABLE', `${name} is out of range`)
  return Number(micros)
}

function readLimit(raw, fallbackUsd, name) {
  if (raw === undefined || raw === '') return usdToMicros(fallbackUsd, { roundUp: false })
  return limitTextToMicros(String(raw), name)
}

export function budgetLimits(env = process.env) {
  return {
    tenantMicros: readLimit(env.AI_BUDGET_PARISH_MONTHLY_USD, DEFAULT_TENANT_MONTHLY_USD, 'AI_BUDGET_PARISH_MONTHLY_USD'),
    aggregateMicros: readLimit(env.AI_BUDGET_TOTAL_MONTHLY_USD, DEFAULT_AGGREGATE_MONTHLY_USD, 'AI_BUDGET_TOTAL_MONTHLY_USD'),
  }
}

function identifier(value, what, maxLength = 128) {
  if (typeof value !== 'string' || !value.length || value.length > maxLength
      || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid(`${what} is not a bounded identifier`)
  return value
}

// OpenChurch has no anonymous capability (policy.js: none sets
// allowAnonymous), so a scope is always a parish. publicSessionId is refused
// rather than half-supported.
export function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) invalid('scope is required')
  for (const key of Object.keys(scope)) {
    if (!['application', 'environment', 'tenantId'].includes(key)) invalid(`scope.${key} is not accepted`)
  }
  const application = identifier(scope.application, 'scope.application')
  const environment = identifier(scope.environment, 'scope.environment')
  const tenantId = identifier(scope.tenantId, 'scope.tenantId', 16)
  if (!/^[1-9]\d{0,9}$/.test(tenantId) || Number(tenantId) > 2_147_483_647) invalid('scope.tenantId is not an organization id')
  return { application, environment, tenantId, organizationId: Number(tenantId) }
}

// The same derivation osl-ai's client uses (src/client.js), so a request
// gets one id whichever side computes it, and the id itself is bound to the
// tenant and request.
export function reservationIdFor(scope, requestId) {
  const s = normalizeScope(scope)
  return createHash('sha256')
    .update(JSON.stringify([s.application, s.environment, 'tenant', s.tenantId, identifier(requestId, 'requestId')]))
    .digest('hex')
}

function checkSignal(signal) {
  if (signal?.aborted) throw new LedgerError('CANCELLED')
}

// Test seam: runs inside the reserve transaction after the budget read and
// before the insert, i.e. exactly where a missing lock would let two
// requests interleave. Production never sets it.
let reserveHook = null
export function _setReserveHookForTests(fn) {
  const prev = reserveHook
  reserveHook = fn
  return () => { reserveHook = prev }
}

// What a scope (and the whole application+environment) has committed in the
// current window. A held row, or one settled with an unknown cost, counts
// its full reservation.
const COMMITTED_SQL = `
  SELECT
    COALESCE(SUM(CASE WHEN organization_id = $3
                      THEN COALESCE(settled_micros, reserved_micros) END), 0)::text AS tenant_micros,
    COALESCE(SUM(COALESCE(settled_micros, reserved_micros)), 0)::text AS aggregate_micros
  FROM ochr_ai_ledger
  WHERE application = $1 AND environment = $2
    AND created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`

export async function committed(scope, { db = pool } = {}) {
  const s = normalizeScope(scope)
  const { rows: [r] } = await db.query(COMMITTED_SQL, [s.application, s.environment, s.organizationId])
  return { tenantMicros: Number(r.tenant_micros), aggregateMicros: Number(r.aggregate_micros) }
}

// reserve: claim `amountMicros` for one request, or refuse.
//   DUPLICATE_REQUEST   the id or the (scope, requestId) was ever used, settled or not
//   BUDGET_EXCEEDED     the claim would take the parish or the total past its limit
//   ACCOUNTING_UNAVAILABLE  the database could not be asked; nothing was claimed
export async function reserve({ scope, requestId, capability, amountMicros, limits, signal }) {
  const s = normalizeScope(scope)
  identifier(requestId, 'requestId')
  identifier(capability, 'capability')
  const amount = wholeMicros(amountMicros, 'amountMicros')
  if (amount === 0) invalid('a reservation cannot be zero; an unclaimed call is a call no budget can stop')
  const lim = limits ?? budgetLimits()
  wholeMicros(lim.tenantMicros, 'tenant limit')
  wholeMicros(lim.aggregateMicros, 'aggregate limit')
  const id = reservationIdFor(scope, requestId)
  checkSignal(signal)

  let client
  try {
    client = await pool.connect()
  } catch (err) {
    throw new LedgerError('ACCOUNTING_UNAVAILABLE', 'no database connection')
  }
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_CLASS, LOCK_SLOT])
    const { rows: dup } = await client.query(
      `SELECT 1 FROM ochr_ai_ledger
        WHERE application = $1 AND environment = $2 AND organization_id = $3
          AND (reservation_id = $4 OR request_id = $5)
        LIMIT 1`,
      [s.application, s.environment, s.organizationId, id, requestId])
    if (dup.length) throw new LedgerError('DUPLICATE_REQUEST')
    const used = await committed(scope, { db: client })
    if (used.tenantMicros + amount > lim.tenantMicros || used.aggregateMicros + amount > lim.aggregateMicros) {
      throw new LedgerError('BUDGET_EXCEEDED')
    }
    if (reserveHook) await reserveHook({ id, scope: s, requestId })
    await client.query(
      `INSERT INTO ochr_ai_ledger
         (reservation_id, application, environment, organization_id, request_id, capability, reserved_micros)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, s.application, s.environment, s.organizationId, requestId, capability, amount])
    await client.query('COMMIT')
    return { id }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err instanceof LedgerError) throw err
    // Belt to the check above: the primary key is never recycled.
    if (err?.code === '23505') throw new LedgerError('DUPLICATE_REQUEST')
    if (err?.code === '23503') invalid('scope.tenantId names no organization')
    throw new LedgerError('ACCOUNTING_UNAVAILABLE', 'reserve failed')
  } finally {
    client.release()
  }
}

const OUTCOME = /^[a-z][a-z_]{0,63}$/

function tokens(value, what) {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${what} must be a whole, non-negative count`)
  return value
}

// settle: write the outcome ONCE. Idempotent: a second settle of the same
// reservation changes nothing and reports alreadySettled. actualMicros null
// means "cost unknown" and keeps the reservation counted.
export async function settle({ scope, id, outcome, actualMicros = null, usage = null, signal }) {
  const s = normalizeScope(scope)
  identifier(id, 'id', 2048)
  if (typeof outcome !== 'string' || !OUTCOME.test(outcome)) invalid('outcome is not a bounded identifier')
  const actual = actualMicros === null ? null : wholeMicros(actualMicros, 'actualMicros')
  if (usage !== null && (typeof usage !== 'object' || Array.isArray(usage))) invalid('usage must be an object or null')
  const input = tokens(usage?.inputTokens, 'usage.inputTokens')
  const output = tokens(usage?.outputTokens, 'usage.outputTokens')
  checkSignal(signal)
  try {
    const { rowCount } = await pool.query(
      `UPDATE ochr_ai_ledger
          SET settled_micros = $5, outcome = $6, input_tokens = $7, output_tokens = $8, settled_at = now()
        WHERE reservation_id = $1 AND application = $2 AND environment = $3 AND organization_id = $4
          AND settled_at IS NULL`,
      [id, s.application, s.environment, s.organizationId, actual, outcome, input, output])
    if (rowCount === 1) return { id, alreadySettled: false }
    const { rows } = await pool.query(
      `SELECT 1 FROM ochr_ai_ledger
        WHERE reservation_id = $1 AND application = $2 AND environment = $3 AND organization_id = $4`,
      [id, s.application, s.environment, s.organizationId])
    if (rows.length) return { id, alreadySettled: true }
  } catch (err) {
    throw new LedgerError('ACCOUNTING_UNAVAILABLE', 'settle failed')
  }
  // Not in this tenant's ledger: unknown here, whatever another parish holds.
  throw new LedgerError('ACCOUNTING_UNAVAILABLE', 'no such reservation in this scope')
}

// Never sent: a known zero, and the row stays.
export function voidReservation({ scope, id }) {
  return settle({ scope, id, outcome: 'void', actualMicros: 0 })
}

// A host-side adapter SHAPED like the OSL AI ledger interface
// (BUILD-CONTRACT.md "Ledger interface"), in dollars, bound to ONE tenant
// scope so that settle, which the contract keys by id alone, is still
// tenant-scoped. Not wired to the package yet (it is not installable; plan
// P2/P3).
//
// DOCUMENTED CONTRACT DEVIATION (conservative P1 host policy; TARS ruling 3
// on #325). The contract says host ledgers must ACCEPT `fallbackUsed` /
// `originalError` on settle. This adapter REFUSES `fallbackUsed: true`
// (INVALID_REQUEST) and the reservation stays held, because OpenChurch
// configures no fallback route and a settle claiming one is a policy
// breach. `originalError` is validated and not stored (migration 100 has
// no column for it). This adapter is therefore NOT BUILD-CONTRACT-compatible
// and NOT ready for package integration. The mismatch, including how a
// policy-breach fact is accounted without retaining originalError text,
// must be resolved before P2 wiring.
export function createDurableLedger({ scope, limits } = {}) {
  const bound = normalizeScope(scope)
  const sameScope = (other) => {
    const o = normalizeScope(other)
    if (o.application !== bound.application || o.environment !== bound.environment || o.tenantId !== bound.tenantId) {
      invalid('scope does not match this ledger')
    }
  }
  const boundScope = { application: bound.application, environment: bound.environment, tenantId: bound.tenantId }
  return Object.freeze({
    durability: 'durable',
    async reserve({ id, scope: s, requestId, amountUsd, signal, ...rest }) {
      if (Object.keys(rest).length) invalid('unexpected reserve field')
      sameScope(s)
      if (typeof amountUsd !== 'number' || !(amountUsd > 0) || amountUsd > MAX_RESERVATION_USD) {
        invalid(`amountUsd must be dollars in (0, ${MAX_RESERVATION_USD}]; microdollars are never passed here`)
      }
      if (id !== reservationIdFor(s, requestId)) invalid('id is not bound to this scope and request')
      return reserve({ scope: boundScope, requestId, capability: 'osl', amountMicros: usdToMicros(amountUsd), limits, signal })
    },
    async settle({ id, actualCostUsd, outcome = 'settled', usage = null, signal, fallbackUsed, originalError, ...rest }) {
      if (Object.keys(rest).length) invalid('unexpected settle field')
      if (fallbackUsed !== undefined && typeof fallbackUsed !== 'boolean') invalid('fallbackUsed must be boolean')
      // Contract deviation (see above): OpenChurch configures no fallback
      // route, so a settle that claims one is refused and stays held.
      if (fallbackUsed === true) invalid('fallback is not configured in OpenChurch')
      if (originalError !== undefined && originalError !== null && typeof originalError !== 'object') invalid('originalError must be an object')
      const actualMicros = actualCostUsd === null ? null : usdToMicros(actualCostUsd)
      const u = usage ? { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null } : null
      const r = await settle({ scope: boundScope, id, outcome, actualMicros, usage: u, signal })
      return { id: r.id }
    },
  })
}
