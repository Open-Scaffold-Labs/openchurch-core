// callLLM — platform OpenAI-compat + org BYOK routing.
//
// These tests need no database. They mock the two first-party SDKs so
// we can assert constructor args (baseURL, apiKey) and that org keys
// never fall through onto a platform key.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const { anthropicCreate, openaiCreate, anthropicCtor, openaiCtor } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
  anthropicCtor: vi.fn(),
  openaiCtor: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor(opts = {}) {
      anthropicCtor(opts)
      this.messages = { create: anthropicCreate }
    }
  },
}))

vi.mock('openai', () => ({
  default: class OpenAI {
    constructor(opts = {}) {
      openaiCtor(opts)
      this.chat = { completions: { create: openaiCreate } }
    }
  },
}))

import {
  callLLM,
  isOrgLLMConfigured,
  isPlatformLLMConfigured,
  listPlatformTargets,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_BASE,
} from '../src/ai/callLLM.js'

const AI_ENV = [
  'OPENROUTER_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'OPENROUTER_MODEL',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SUPPORT_AI_MODEL',
  'CLIENT_URL', 'BASE_URL',
]

function clearAiEnv() {
  for (const k of AI_ENV) delete process.env[k]
}

function setEnv(pairs) {
  clearAiEnv()
  for (const [k, v] of Object.entries(pairs)) {
    if (v == null) delete process.env[k]
    else process.env[k] = v
  }
}

const saved = {}

beforeEach(() => {
  for (const k of AI_ENV) saved[k] = process.env[k]
  clearAiEnv()
  anthropicCreate.mockReset()
  openaiCreate.mockReset()
  anthropicCtor.mockReset()
  openaiCtor.mockReset()
})

afterEach(() => {
  for (const k of AI_ENV) {
    if (saved[k] == null) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function mockAnthropic(text = 'from anthropic', usage = { input_tokens: 3, output_tokens: 5 }) {
  anthropicCreate.mockResolvedValue({
    content: [{ type: 'text', text }],
    usage,
  })
}

function mockOpenAI(text = 'from openai', usage = { prompt_tokens: 4, completion_tokens: 6 }) {
  openaiCreate.mockResolvedValue({
    choices: [{ message: { content: text } }],
    usage,
  })
}

describe('isPlatformLLMConfigured / isOrgLLMConfigured', () => {
  it('is false with no platform keys', () => {
    expect(isPlatformLLMConfigured()).toBe(false)
  })

  it('is true for OpenRouter-only, Anthropic-only, or OpenAI-only', () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test' })
    expect(isPlatformLLMConfigured()).toBe(true)
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(isPlatformLLMConfigured()).toBe(true)
    setEnv({ OPENAI_API_KEY: 'sk-test' })
    expect(isPlatformLLMConfigured()).toBe(true)
  })

  it('recognizes first-party org BYOK only', () => {
    expect(isOrgLLMConfigured(null)).toBe(false)
    expect(isOrgLLMConfigured({ provider: 'openrouter' })).toBe(false)
    expect(isOrgLLMConfigured({ provider: 'anthropic' })).toBe(true)
    expect(isOrgLLMConfigured({ provider: 'openai' })).toBe(true)
  })
})

describe('listPlatformTargets — order and exclusivity', () => {
  it('prefers OpenRouter, then Anthropic, then first-party OpenAI', () => {
    setEnv({
      OPENROUTER_API_KEY: 'sk-or-test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-oa-test',
    })
    const targets = listPlatformTargets()
    expect(targets.map(t => t.label)).toEqual(['openrouter', 'anthropic', 'openai'])
    expect(targets[0].baseURL).toBe(DEFAULT_OPENROUTER_BASE)
    expect(targets[0].apiKey).toBe('sk-or-test')
    expect(targets[0].model).toBe(DEFAULT_OPENROUTER_MODEL)
    expect(targets[1].model).toBe(DEFAULT_ANTHROPIC_MODEL)
    expect(targets[2].model).toBe(DEFAULT_OPENAI_MODEL)
  })

  it('uses AI_BASE_URL + OPENAI_API_KEY as openai-compat and does not also call first-party OpenAI', () => {
    setEnv({
      AI_BASE_URL: 'https://proxy.example/v1/',
      OPENAI_API_KEY: 'sk-oa-test',
    })
    const targets = listPlatformTargets()
    expect(targets).toHaveLength(1)
    expect(targets[0].label).toBe('openai-compat')
    expect(targets[0].baseURL).toBe('https://proxy.example/v1')
    expect(targets[0].apiKey).toBe('sk-oa-test')
  })

  it('honors AI_MODEL / OPENROUTER_MODEL on the compat target only', () => {
    setEnv({
      OPENROUTER_API_KEY: 'sk-or-test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AI_MODEL: 'google/gemini-2.5-flash',
    })
    const targets = listPlatformTargets()
    expect(targets[0].model).toBe('google/gemini-2.5-flash')
    expect(targets[1].model).toBe(DEFAULT_ANTHROPIC_MODEL)
  })

  it('an explicit model pin applies to every platform target', () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-test', ANTHROPIC_API_KEY: 'sk-ant-test' })
    const targets = listPlatformTargets({ model: 'vendor/custom-pin' })
    expect(targets.every(t => t.model === 'vendor/custom-pin')).toBe(true)
  })
})

describe('callLLM', () => {
  it('throws NO_PROVIDER when nothing is configured', async () => {
    await expect(callLLM({ userPrompt: 'hi' })).rejects.toMatchObject({
      code: 'NO_PROVIDER',
    })
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(openaiCreate).not.toHaveBeenCalled()
  })

  it('org Anthropic BYOK is exclusive — platform keys are not consulted', async () => {
    setEnv({
      OPENROUTER_API_KEY: 'sk-or-PLATFORM',
      ANTHROPIC_API_KEY: 'sk-ant-PLATFORM',
      OPENAI_API_KEY: 'sk-oa-PLATFORM',
    })
    mockAnthropic('org draft')
    const result = await callLLM({
      systemPrompt: 'sys',
      userPrompt: 'hello',
      org: { provider: 'anthropic', apiKey: 'sk-ant-ORG', model: 'claude-org-pin' },
    })
    expect(result).toMatchObject({
      text: 'org draft',
      provider: 'anthropic (org key)',
      model: 'claude-org-pin',
      usage: { input: 3, output: 5 },
    })
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: 'sk-ant-ORG' })
    expect(openaiCtor).not.toHaveBeenCalled()
    expect(JSON.stringify(anthropicCtor.mock.calls)).not.toContain('PLATFORM')
  })

  it('org OpenAI BYOK uses api.openai.com and never a custom baseURL', async () => {
    setEnv({
      OPENROUTER_API_KEY: 'sk-or-PLATFORM',
      AI_BASE_URL: 'https://openrouter.ai/api/v1',
    })
    mockOpenAI('org openai draft')
    const result = await callLLM({
      systemPrompt: 'sys',
      userPrompt: 'hello',
      org: { provider: 'openai', apiKey: 'sk-ORG-OA' },
    })
    expect(result.provider).toBe('openai (org key)')
    expect(result.model).toBe(DEFAULT_OPENAI_MODEL)
    expect(openaiCtor).toHaveBeenCalledWith({ apiKey: 'sk-ORG-OA' })
    expect(openaiCtor.mock.calls[0][0].baseURL).toBeUndefined()
    expect(anthropicCtor).not.toHaveBeenCalled()
  })

  it('platform OpenRouter posts chat completions with the OpenRouter base and key', async () => {
    setEnv({
      OPENROUTER_API_KEY: 'sk-or-live',
      CLIENT_URL: 'https://openchurch.example',
    })
    mockOpenAI('router draft')
    const result = await callLLM({
      systemPrompt: 'sys',
      userPrompt: 'hello',
      maxTokens: 128,
    })
    expect(result).toMatchObject({
      text: 'router draft',
      provider: 'openrouter',
      model: DEFAULT_OPENROUTER_MODEL,
      usage: { input: 4, output: 6 },
    })
    expect(openaiCtor).toHaveBeenCalledWith({
      apiKey: 'sk-or-live',
      baseURL: DEFAULT_OPENROUTER_BASE,
      defaultHeaders: {
        'HTTP-Referer': 'https://openchurch.example',
        'X-Title': 'OpenChurch',
      },
    })
    expect(openaiCreate).toHaveBeenCalledWith({
      model: DEFAULT_OPENROUTER_MODEL,
      max_tokens: 128,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
    })
    expect(anthropicCtor).not.toHaveBeenCalled()
  })

  it('falls through to Anthropic when OpenRouter fails', async () => {
    setEnv({
      OPENROUTER_API_KEY: 'sk-or-dead',
      ANTHROPIC_API_KEY: 'sk-ant-live',
    })
    openaiCreate.mockRejectedValue(new Error('insufficient credits'))
    mockAnthropic('haiku draft')
    const result = await callLLM({ userPrompt: 'hello' })
    expect(result.provider).toBe('anthropic')
    expect(result.text).toBe('haiku draft')
    expect(openaiCreate).toHaveBeenCalledOnce()
    expect(anthropicCreate).toHaveBeenCalledOnce()
  })

  it('assistant-shaped messages work on the OpenAI-compat path', async () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-live' })
    mockOpenAI('you click Schedule')
    const result = await callLLM({
      systemPrompt: 'helper',
      messages: [
        { role: 'user', content: 'where is the calendar?' },
        { role: 'assistant', content: 'Schedule in the nav.' },
        { role: 'user', content: 'and rooms?' },
      ],
      maxTokens: 700,
    })
    expect(result.text).toBe('you click Schedule')
    expect(openaiCreate.mock.calls[0][0].messages).toEqual([
      { role: 'system', content: 'helper' },
      { role: 'user', content: 'where is the calendar?' },
      { role: 'assistant', content: 'Schedule in the nav.' },
      { role: 'user', content: 'and rooms?' },
    ])
  })

  it('throws ALL_FAILED when every configured target errors', async () => {
    setEnv({ OPENROUTER_API_KEY: 'sk-or-dead', ANTHROPIC_API_KEY: 'sk-ant-dead' })
    openaiCreate.mockRejectedValue(new Error('down'))
    anthropicCreate.mockRejectedValue(new Error('down'))
    await expect(callLLM({ userPrompt: 'hello' })).rejects.toMatchObject({
      code: 'ALL_FAILED',
    })
  })
})

describe('call sites use the shared helper', () => {
  it('Studio, Assistant, and support diagnostic import callLLM and do not construct SDKs', () => {
    const files = [
      new URL('../src/routes/ai.js', import.meta.url),
      new URL('../src/routes/assistant.js', import.meta.url),
      new URL('../src/routes/supportTickets.js', import.meta.url),
    ]
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      expect(src, file.pathname).toMatch(/from '\.\.\/ai\/callLLM\.js'/)
      expect(src, file.pathname).not.toMatch(/from '@anthropic-ai\/sdk'/)
      expect(src, file.pathname).not.toMatch(/from 'openai'/)
      expect(src, file.pathname).not.toMatch(/new Anthropic/)
      expect(src, file.pathname).not.toMatch(/new OpenAI/)
    }
  })
})
