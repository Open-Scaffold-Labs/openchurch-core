// Shared LLM helper — Studio, Assistant, and support diagnostic.
//
// Platform traffic prefers an OpenAI-compatible client (OpenRouter or any
// custom baseURL) so we are not stuck on three Anthropic-first SDK copies.
// Org BYOK (AIP.1) stays first-party and exclusive: if a parish plugged in
// Anthropic or OpenAI, that is the only provider we call — no silent hop
// onto the platform bill.
//
// Platform order (first configured target is tried; on failure the next
// configured target is tried, same exclusive-per-org / fallback-across-
// platform-keys shape Studio already had for Anthropic → OpenAI):
//
//   1. OpenAI-compat — OPENROUTER_API_KEY, or AI_BASE_URL + a key
//      (OPENROUTER_API_KEY || OPENAI_API_KEY). Base defaults to
//      https://openrouter.ai/api/v1 when the OpenRouter key is set.
//   2. Anthropic     — ANTHROPIC_API_KEY (first-party Messages API)
//   3. OpenAI        — OPENAI_API_KEY against api.openai.com, skipped
//      when that same key already served step 1 (custom AI_BASE_URL).
//
// Model pins: org.model (BYOK) wins, then an explicit `model` argument
// (SUPPORT_AI_MODEL from Assistant / diagnostic when set), then the
// default for the target that actually fires. Do not assume Haiku when
// the live target is OpenRouter.

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash'
export const DEFAULT_OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

function trim(v) {
  return v == null ? '' : String(v).trim()
}

function stripSlash(url) {
  return String(url || '').replace(/\/+$/, '')
}

function llmError(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

function usageFromAnthropic(message) {
  return {
    input: message?.usage?.input_tokens ?? null,
    output: message?.usage?.output_tokens ?? null,
  }
}

function usageFromOpenAI(completion) {
  return {
    input: completion?.usage?.prompt_tokens ?? null,
    output: completion?.usage?.completion_tokens ?? null,
  }
}

function turnsFrom({ userPrompt, messages }) {
  if (Array.isArray(messages) && messages.length) return messages
  if (typeof userPrompt === 'string') return [{ role: 'user', content: userPrompt }]
  throw llmError('callLLM requires userPrompt or messages', 'BAD_REQUEST')
}

function modelFor(kind, { orgModel, model }) {
  if (orgModel) return orgModel
  if (model) return model
  if (kind === 'anthropic') return DEFAULT_ANTHROPIC_MODEL
  if (kind === 'openai') return DEFAULT_OPENAI_MODEL
  return trim(process.env.AI_MODEL) || trim(process.env.OPENROUTER_MODEL) || DEFAULT_OPENROUTER_MODEL
}

function isOpenRouterBase(baseURL) {
  return /openrouter\.ai/i.test(baseURL || '')
}

function platformCompatTarget() {
  const openrouterKey = trim(process.env.OPENROUTER_API_KEY)
  const openaiKey = trim(process.env.OPENAI_API_KEY)
  const configuredBase = stripSlash(trim(process.env.AI_BASE_URL))
  const baseURL = configuredBase || (openrouterKey ? DEFAULT_OPENROUTER_BASE : '')
  const apiKey = openrouterKey || (baseURL ? openaiKey : '')
  if (!baseURL || !apiKey) return null
  const usedOpenAIKey = !openrouterKey && apiKey === openaiKey
  const label = isOpenRouterBase(baseURL) || openrouterKey ? 'openrouter' : 'openai-compat'
  return { kind: 'openai-compat', apiKey, baseURL, usedOpenAIKey, label }
}

// Exported for /status, diagnostic gating, and tests. True when any
// platform key can serve a call — including OpenRouter-only deploys.
export function isPlatformLLMConfigured() {
  return Boolean(
    trim(process.env.OPENROUTER_API_KEY)
    || trim(process.env.ANTHROPIC_API_KEY)
    || trim(process.env.OPENAI_API_KEY)
  )
}

export function isOrgLLMConfigured(org) {
  return org?.provider === 'anthropic' || org?.provider === 'openai'
}

// Ordered platform targets. Org BYOK is not in this list.
export function listPlatformTargets({ model } = {}) {
  const targets = []
  const compat = platformCompatTarget()
  if (compat) {
    targets.push({
      ...compat,
      model: modelFor('openai-compat', { model }),
    })
  }
  const anthropicKey = trim(process.env.ANTHROPIC_API_KEY)
  if (anthropicKey) {
    targets.push({
      kind: 'anthropic',
      apiKey: anthropicKey,
      label: 'anthropic',
      model: modelFor('anthropic', { model }),
    })
  }
  const openaiKey = trim(process.env.OPENAI_API_KEY)
  if (openaiKey && !compat?.usedOpenAIKey) {
    targets.push({
      kind: 'openai',
      apiKey: openaiKey,
      label: 'openai',
      model: modelFor('openai', { model }),
    })
  }
  return targets
}

function orgTarget(org, model) {
  if (!isOrgLLMConfigured(org)) return null
  return {
    kind: org.provider,
    apiKey: org.apiKey,
    label: `${org.provider} (org key)`,
    model: modelFor(org.provider, { orgModel: org.model, model }),
  }
}

function openaiCompatHeaders(baseURL) {
  if (!isOpenRouterBase(baseURL) && !trim(process.env.OPENROUTER_API_KEY)) return undefined
  const referer = trim(process.env.CLIENT_URL) || trim(process.env.BASE_URL) || 'https://openchurch.vercel.app'
  return {
    'HTTP-Referer': referer,
    'X-Title': 'OpenChurch',
  }
}

async function callAnthropic({ apiKey, model, maxTokens, systemPrompt, turns }) {
  const client = new Anthropic({ apiKey })
  const message = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: turns,
  })
  const text = message.content?.find?.(b => b.type === 'text')?.text
    ?? message.content?.[0]?.text
  return { text, usage: usageFromAnthropic(message) }
}

async function callOpenAI({ apiKey, model, maxTokens, systemPrompt, turns, baseURL }) {
  const headers = baseURL ? openaiCompatHeaders(baseURL) : undefined
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(headers ? { defaultHeaders: headers } : {}),
  })
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...turns,
  ]
  const completion = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages,
  })
  const text = completion.choices?.[0]?.message?.content
  return { text, usage: usageFromOpenAI(completion) }
}

async function invokeTarget(target, { maxTokens, systemPrompt, turns }) {
  const args = {
    apiKey: target.apiKey,
    model: target.model,
    maxTokens,
    systemPrompt,
    turns,
    baseURL: target.baseURL,
  }
  const result = target.kind === 'anthropic'
    ? await callAnthropic(args)
    : await callOpenAI(args)
  if (!result.text) throw new Error(`${target.label}: empty response`)
  return {
    text: result.text,
    provider: target.label,
    model: target.model,
    usage: result.usage,
  }
}

// Returns { text, provider, model, usage: { input, output } }.
// Throws with code NO_PROVIDER or ALL_FAILED.
export async function callLLM({
  systemPrompt,
  userPrompt,
  messages,
  maxTokens = 1024,
  org = null,
  model,
} = {}) {
  const turns = turnsFrom({ userPrompt, messages })
  const errors = []

  const byok = orgTarget(org, model)
  if (byok) return invokeTarget(byok, { maxTokens, systemPrompt, turns })

  const targets = listPlatformTargets({ model })
  if (!targets.length) throw llmError('No AI provider configured', 'NO_PROVIDER')

  for (const target of targets) {
    try {
      return await invokeTarget(target, { maxTokens, systemPrompt, turns })
    } catch (err) {
      errors.push(`${target.label}: ${err.message}`)
    }
  }

  throw llmError(`All providers failed: ${errors.join(' | ')}`, 'ALL_FAILED')
}
