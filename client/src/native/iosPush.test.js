import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestNativeNoticePermission } from './iosPush'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'iosPush.js'), 'utf8')

function plugin(receive = 'prompt') {
  const calls = []
  const listeners = {}
  return {
    calls,
    listeners,
    checkPermissions: vi.fn(async () => {
      calls.push('check')
      return { receive }
    }),
    requestPermissions: vi.fn(async () => {
      calls.push('request')
      return { receive: 'granted' }
    }),
    register: vi.fn(async () => {
      calls.push('register')
      listeners.registration?.({ value: 'device-token-should-not-leak' })
    }),
    addListener: vi.fn(async (name, fn) => {
      calls.push(`listen:${name}`)
      listeners[name] = fn
    }),
  }
}

describe('native notice permission', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('fetch must not run')
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks, registers, and drops the token', async () => {
    const native = plugin('prompt')
    const result = await requestNativeNoticePermission(native)
    expect(result).toEqual({ state: 'granted' })
    expect(JSON.stringify(result)).not.toContain('device-token')
    expect(native.calls).toEqual(['check', 'request', 'listen:registration', 'listen:registrationError', 'register'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not ask again when the device already refused', async () => {
    const native = plugin('denied')
    expect(await requestNativeNoticePermission(native)).toEqual({ state: 'denied' })
    expect(native.requestPermissions).not.toHaveBeenCalled()
    expect(native.register).not.toHaveBeenCalled()
  })

  it('says the device was not registered when registration fails', async () => {
    const native = plugin('granted')
    native.register.mockImplementation(async () => {
      native.listeners.registrationError?.({ error: 'no-entitlement' })
    })
    expect(await requestNativeNoticePermission(native)).toEqual({ state: 'not-registered' })
  })

  it('does not pretend a missing plugin asked the device', async () => {
    expect(await requestNativeNoticePermission(null)).toEqual({ state: 'unavailable' })
  })

  it('has no send path', () => {
    expect(SRC).not.toMatch(/fetch\s*\(|localStorage|XMLHttpRequest|apiUrl|vapid|ochr_token|console\./i)
  })
})
