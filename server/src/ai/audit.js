// Bounded AI audit sink over ochr_ai_audit (migration 100).
//
// METADATA ONLY. The table has no column that could hold a prompt, an
// answer, source text, a credential or raw provider error text, and this
// writer keeps it that way from the other side: it copies a fixed list of
// fields, every string must be a short identifier, and anything else in the
// event — including fields osl-ai's client adds that have no column here —
// is dropped, never stringified into a column.
//
// A FAILED WRITE IS AN ERROR. osl-ai's contract: "recordEvent failure is
// surfaced, not ignored." recordAiEvent throws AuditError; the caller
// decides what refusal that becomes. It never returns quietly.
import pool from '../db.js'

export const AUDIT_EVENTS = Object.freeze(['started', 'succeeded', 'failed', 'denied'])

export class AuditError extends Error {
  constructor(detail) {
    super(`AUDIT_UNAVAILABLE: ${detail}`)
    this.code = 'AUDIT_UNAVAILABLE'
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

function text(value, what) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !ID.test(value)) throw new AuditError(`${what} is not a bounded identifier`)
  return value
}

function count(value, what) {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new AuditError(`${what} is not a whole, non-negative count`)
  return value
}

function orgId(value, what) {
  if (value === undefined || value === null) return null
  const s = String(value)
  if (!/^[1-9]\d{0,9}$/.test(s) || Number(s) > 2_147_483_647) throw new AuditError(`${what} is not an id`)
  return Number(s)
}

// event: { application, environment, tenantId, actorId?, requestId, event,
//          capability?, routeId?, provider?, requestedModel?, reportedModel?,
//          finishReason?, code?, dataClass?, policyVersion?, promptVersion?,
//          contractVersion?, usage?: { inputTokens, outputTokens },
//          costMicros?, costEstimated?, durationMs? }
export async function recordAiEvent(e) {
  if (!e || typeof e !== 'object') throw new AuditError('event is required')
  if (!AUDIT_EVENTS.includes(e.event)) throw new AuditError('unknown event')
  const organizationId = orgId(e.tenantId, 'tenantId')
  if (organizationId === null) throw new AuditError('a tenant is required')
  const row = [
    text(e.application, 'application'),
    text(e.environment, 'environment'),
    organizationId,
    orgId(e.actorId, 'actorId'),
    text(e.requestId, 'requestId'),
    e.event,
    text(e.capability, 'capability'),
    text(e.routeId, 'routeId'),
    text(e.provider, 'provider'),
    text(e.requestedModel, 'requestedModel'),
    text(e.reportedModel, 'reportedModel'),
    text(e.finishReason, 'finishReason'),
    text(e.code, 'code'),
    text(e.dataClass, 'dataClass'),
    text(e.policyVersion, 'policyVersion'),
    text(e.promptVersion, 'promptVersion'),
    text(e.contractVersion, 'contractVersion'),
    count(e.usage?.inputTokens, 'usage.inputTokens'),
    count(e.usage?.outputTokens, 'usage.outputTokens'),
    count(e.costMicros, 'costMicros'),
    e.costEstimated === undefined || e.costEstimated === null ? null : e.costEstimated === true,
    count(e.durationMs, 'durationMs'),
  ]
  if (!row[0] || !row[1] || !row[4]) throw new AuditError('application, environment and requestId are required')
  try {
    await pool.query(
      `INSERT INTO ochr_ai_audit
         (application, environment, organization_id, actor_id, request_id, event,
          capability, route_id, provider, requested_model, reported_model, finish_reason,
          error_code, data_class, policy_version, prompt_version, contract_version,
          input_tokens, output_tokens, cost_micros, cost_estimated, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      row)
  } catch {
    throw new AuditError('write failed')
  }
}
