// Every outbound model call passes through here (Stage 7, TARS review of
// #280 at ba12d348). In order, before any provider is contacted:
//   1. the platform AI stop (Dale/CoS controlled, ochr_platform_ai_switch),
//      checked early and again, authoritatively, right before the SDK call;
//   2. explicit routing: a configured org provider is THE provider for a
//      capability that supports it; a lookup/decrypt failure or an
//      unsupported selection refuses — it never becomes managed routing;
//      managed routing only when no override exists and the capability
//      permits it;
//   3. the capability's data classes against the chosen route;
//   4. the capability's input byte bound, output tokens, timeout and the
//      route's pinned model.
// This is not a classifier: a capability tag does not make free text safe.
// It bounds what is sent and where it can go.
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import pool from '../db.js'
import { ROUTES, CAPABILITIES, POLICY_VERSION } from './policy.js'
import { providerFailure } from './providerError.js'
import { getOrgProvider } from './orgProvider.js'
import { LEDGER_APPLICATION, ledgerEnvironment, reserve, settle, voidReservation } from './ledger.js'
import { recordAiEvent } from './audit.js'
import { monitor } from '../monitoring/index.js'

const STATUS = {
  ai_disabled: 403,
  ai_forbidden: 403,
  ai_unsupported_provider: 403,
  ai_input_too_large: 413,
  ai_unavailable: 503,
}

export function aiRefusal(code) {
  const err = new Error(code)
  err.code = code
  err.httpStatus = STATUS[code] ?? 503
  err.refusal = true
  return err
}

// Stable, machine-readable refusal bodies (the client localizes by code).
const ENGLISH = {
  ai_disabled: 'AI features are paused for everyone right now.',
  ai_forbidden: 'This AI request is not allowed.',
  ai_unsupported_provider: "This feature isn't available with your parish's AI provider.",
  ai_input_too_large: 'That is too much text for one AI request.',
  ai_unavailable: 'AI is not available right now.',
}
export function refusalBody(err) {
  if (err?.refusal) return { status: err.httpStatus, body: { code: err.code, error: ENGLISH[err.code] ?? ENGLISH.ai_unavailable } }
  return null
}

// The stop. No row means never stopped. A failed read is treated as
// stopped (fail closed). There is no automatic resume: only an explicit
// authorized PUT clears it.
export async function aiStopped() {
  try {
    const { rows } = await pool.query('SELECT stopped FROM ochr_platform_ai_switch WHERE id = 1')
    return rows[0]?.stopped === true
  } catch {
    return true
  }
}

export async function assertAiRunning() {
  if (await aiStopped()) throw aiRefusal('ai_disabled')
}

// Explicit routing. Returns { routeId, provider, apiKey, model }.
export async function resolveRoute(orgId, capabilityId) {
  const cap = CAPABILITIES[capabilityId]
  if (!cap) throw aiRefusal('ai_forbidden')
  let org
  try {
    org = await getOrgProvider(orgId)
  } catch {
    // Lookup or key decryption failed: we do not know what the parish
    // chose, so nothing is sent anywhere.
    throw aiRefusal('ai_unavailable')
  }
  if (org) {
    const routeId = `${org.provider}-byok`
    if (!ROUTES[routeId] || !(cap.byokProviders ?? []).includes(org.provider)) {
      throw aiRefusal('ai_unsupported_provider')
    }
    return { routeId, provider: org.provider, apiKey: org.apiKey, model: org.model || ROUTES[routeId].model, label: `${org.provider} (org key)` }
  }
  if (cap.managed === false) throw aiRefusal('ai_unsupported_provider')
  if (!process.env.ANTHROPIC_API_KEY) throw aiRefusal('ai_unavailable')
  return { routeId: cap.routeId, provider: ROUTES[cap.routeId].provider, apiKey: undefined, model: ROUTES[cap.routeId].model, label: 'anthropic' }
}

function assertClasses(routeId, cap) {
  const route = ROUTES[routeId]
  const ok = route && cap.allowedDataClasses.every(c => route.allowedDataClasses.includes(c))
  if (!ok) throw aiRefusal('ai_forbidden')
}

// One provider call. Returns { text, provider, model, usage } or throws a
// providerFailure. `sent` is set the moment the SDK is asked to send, so
// the caller can tell "never left" from "left and failed".
async function callProvider(route, { system, messages, max_tokens, opts }, sent) {
  if (route.provider === 'openai') {
    let completion
    try {
      const client = new OpenAI({ apiKey: route.apiKey })
      sent.value = true
      completion = await client.chat.completions.create({
        model: route.model, max_tokens,
        messages: [{ role: 'system', content: system }, ...messages],
      }, opts)
    } catch (upstream) { throw providerFailure(route.label, upstream) }
    const text = completion?.choices?.[0]?.message?.content
    if (text) return { text, provider: route.label, model: route.model }
    throw providerFailure(route.label, null)
  }

  let message
  try {
    const client = route.apiKey ? new Anthropic({ apiKey: route.apiKey }) : new Anthropic()
    sent.value = true
    message = await client.messages.create({ model: route.model, max_tokens, system, messages }, opts)
  } catch (upstream) { throw providerFailure(route.label, upstream) }
  const text = message?.content?.find?.(b => b.type === 'text')?.text ?? message?.content?.[0]?.text
  const usage = { input: Number.isInteger(message?.usage?.input_tokens) ? message.usage.input_tokens : null,
    output: Number.isInteger(message?.usage?.output_tokens) ? message.usage.output_tokens : null }
  if (text) return { text, provider: route.label, model: route.model, usage }
  const empty = providerFailure(route.label, null)
  empty.usage = usage
  throw empty
}

// messages: [{ role, content }] — the complete outbound user payload.
//
// accounting (optional): { requestId, actorId }. When given AND the chosen
// route is platform-managed, the call is reserved in ochr_ai_ledger before
// it is sent and audited in ochr_ai_audit (ai/ledger.js, ai/audit.js). Only
// the in-app assistant passes it today (OSL AI plan P1). A parish's own key
// (BYOK) is their bill and stays unaccounted, as before.
export async function dispatch({ orgId, capabilityId, system, messages, maxTokens, accounting }) {
  await assertAiRunning()
  const cap = CAPABILITIES[capabilityId]
  if (!cap) throw aiRefusal('ai_forbidden')
  const bytes = messages.reduce((n, m) => n + Buffer.byteLength(String(m.content ?? ''), 'utf8'), 0)
  if (bytes > cap.maxInputBytes) throw aiRefusal('ai_input_too_large')
  const route = await resolveRoute(orgId, capabilityId)
  assertClasses(route.routeId, cap)
  const max_tokens = Math.min(maxTokens ?? cap.maxOutputTokens, cap.maxOutputTokens)
  const opts = { timeout: cap.timeoutMs, maxRetries: 0 }
  const accounted = accounting && ROUTES[route.routeId]?.credentialMode === 'managed'
  if (accounted) {
    return accountedCall({ orgId, capabilityId, cap, route, accounting, call: { system, messages, max_tokens, opts } })
  }
  // S7-F6 admission boundary. The early check above is a cheap fail-closed
  // short-circuit; THIS recheck is authoritative. It runs after every
  // awaited routing/config lookup and with nothing awaited between it and
  // the SDK call below, so a stop committed before this read refuses the
  // call. A stop committed after it cannot recall a request already sent:
  // the switch governs admission, not in-flight calls (bounded by the
  // capability timeout, maxRetries 0). No connection or lock is held
  // across the network call.
  await assertAiRunning()
  return callProvider(route, { system, messages, max_tokens, opts }, { value: false })
}

// Reserve -> authoritative stop recheck -> send -> settle, with an audit
// event at the start and the end. The order matters:
//   - the stop recheck is AFTER the reservation (which awaits the database)
//     and immediately before the send, so it still wraps the network call;
//   - a reservation refused by the stop is VOIDED (known zero, row kept);
//   - a call that was sent and then failed keeps its reservation (cost
//     unknown is not zero);
//   - settling never consults the stop: an in-flight call lands its receipt
//     even if AI was stopped while it ran.
// Any accounting or audit failure refuses (ai_unavailable) and is logged by
// code only; a reservation that could not be finalised stays held, which is
// the conservative direction.
async function accountedCall({ orgId, capabilityId, cap, route, accounting, call }) {
  const scope = { application: LEDGER_APPLICATION, environment: ledgerEnvironment(), tenantId: String(orgId) }
  const meta = {
    application: scope.application, environment: scope.environment, tenantId: scope.tenantId,
    actorId: accounting.actorId ?? null, requestId: accounting.requestId, capability: capabilityId,
    routeId: route.routeId, provider: ROUTES[route.routeId].provider, requestedModel: route.model,
    dataClass: 'internal', policyVersion: POLICY_VERSION, promptVersion: cap.promptVersion, contractVersion: '1',
  }
  const started = Date.now()
  const unavailable = (stage, err) => {
    monitor.error('ai.accounting', err, { orgId, stage, code: err?.code ?? null })
    return aiRefusal('ai_unavailable')
  }
  const finish = async (event, code, extra = {}) => {
    await recordAiEvent({ ...meta, event, code, durationMs: Date.now() - started, ...extra })
  }

  try { await finish('started', null) } catch (err) { throw unavailable('audit_started', err) }

  let id
  try {
    ({ id } = await reserve({ scope, requestId: accounting.requestId, capability: capabilityId, amountMicros: cap.reservationUsd }))
  } catch (err) {
    try { await finish('denied', err?.code ?? 'ACCOUNTING_UNAVAILABLE') } catch (auditErr) { throw unavailable('audit_denied', auditErr) }
    throw unavailable('reserve', err)
  }

  // Authoritative admission check. Nothing awaited between it and the send.
  if (await aiStopped()) {
    try {
      await voidReservation({ scope, id })
      await finish('denied', 'ai_disabled')
    } catch (err) { throw unavailable('void', err) }
    throw aiRefusal('ai_disabled')
  }

  const sent = { value: false }
  let result
  try {
    result = await callProvider(route, call, sent)
  } catch (failure) {
    const u = failure?.usage
    try {
      if (!sent.value) await voidReservation({ scope, id })
      else await settle({ scope, id, outcome: 'failed', actualMicros: null,
        usage: u ? { inputTokens: u.input, outputTokens: u.output } : null })
      await finish('failed', sent.value ? 'provider_failed' : 'not_sent',
        u ? { usage: { inputTokens: u.input, outputTokens: u.output } } : {})
    } catch (err) { throw unavailable('settle_failed', err) }
    throw failure
  }

  const usage = result.usage ? { inputTokens: result.usage.input, outputTokens: result.usage.output } : null
  try {
    // No pricing table yet: the cost is unknown, so the reservation stands
    // as the charge. Token counts are recorded as reported (null if not).
    await settle({ scope, id, outcome: 'success', actualMicros: null, usage })
    await finish('succeeded', null, { usage })
  } catch (err) { throw unavailable('settle_success', err) }
  return result
}

// For availability probes: same decision as dispatch, no provider call.
export async function available(orgId, capabilityId) {
  try {
    await assertAiRunning()
    await resolveRoute(orgId, capabilityId)
    return true
  } catch {
    return false
  }
}
