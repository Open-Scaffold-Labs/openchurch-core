// The interceptor's one rule, locked. (C3)
//
// "A 401 from our backend means the session is dead" is the right universal
// rule, and the interceptor applies it to everything outside login/signup.
// The defect was on the other side of the wire: PATCH /api/auth/password
// answered a wrong CURRENT password with 401, so a typo in Preferences signed
// the user out and the inline error never rendered. The server now answers
// 403. This test pins the client half of that contract: 403 is an answer the
// page handles; 401 is still a sign-out; 500 is neither.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { installFetchInterceptor, UNAUTHORIZED_EVENT, TOKEN_STORAGE_KEY } from './fetchInterceptor'

// The interceptor installs once per module and binds whatever window.fetch
// is at that moment, so the transport it wraps is a single mutable handler.
let handler = async () => new Response(null, { status: 200 })
const transport = vi.fn((...args) => handler(...args))
let unauthorizedFired = 0
const onUnauthorized = () => { unauthorizedFired++ }

beforeAll(() => {
  window.fetch = transport
  installFetchInterceptor()
})
beforeEach(() => {
  unauthorizedFired = 0
  localStorage.setItem(TOKEN_STORAGE_KEY, 'a-live-token')
  window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
})
afterEach(() => {
  window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  localStorage.removeItem(TOKEN_STORAGE_KEY)
})

const respond = (status, body = {}) => {
  handler = async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

describe('a wrong current password is not a dead session', () => {
  it('PATCH /api/auth/password → 403 reaches the page; nobody is signed out', async () => {
    respond(403, { error: 'Current password is incorrect' })
    const res = await fetch('/api/auth/password', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'typo', password: 'a-new-password' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/current password is incorrect/i)
    expect(unauthorizedFired).toBe(0)
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('a-live-token')
  })

  it('still sends the bearer token on that request — the caller IS authenticated', async () => {
    respond(403)
    const res = await fetch('/api/auth/password', { method: 'PATCH' })
    expect(res.status).toBe(403)
    const [, init] = transport.mock.calls.at(-1)
    expect(init.headers.Authorization).toBe('Bearer a-live-token')
  })
})

describe('CONTROLS — the universal rule is unchanged', () => {
  it('a 401 from an ordinary endpoint still signs the user out', async () => {
    respond(401, { error: 'Invalid or expired token' })
    const res = await fetch('/api/clients')
    expect(res.status).toBe(401)
    expect(unauthorizedFired).toBe(1)
  })

  it('a 500 does not', async () => {
    respond(500, { error: 'boom' })
    const res = await fetch('/api/clients')
    expect(res.status).toBe(500)
    expect(unauthorizedFired).toBe(0)
  })

  it('a 401 from /api/auth/login is the login page\'s to handle, not a sign-out', async () => {
    respond(401, { error: 'Invalid email or password' })
    const res = await fetch('/api/auth/login', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(unauthorizedFired).toBe(0)
  })
})
