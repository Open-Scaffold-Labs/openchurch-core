// The shell treats a 401 from our backend as a dead session.
// POST /api/auth/deactivate is the exception: that 401 does not prove
// whether this login is on or off, so it must not sign the person out.
// Login and every other route keep the previous rule.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { installSessionFetch, UNAUTHORIZED_EVENT } from './sessionFetch'

let handler = async () => new Response(null, { status: 200 })
const transport = vi.fn((...args) => handler(...args))
const previousFetch = window.fetch
let unauthorizedFired = 0
const onUnauthorized = () => { unauthorizedFired++ }

beforeAll(() => {
  window.fetch = transport
  installSessionFetch()
})
afterAll(() => {
  window.fetch = previousFetch
})
beforeEach(() => {
  unauthorizedFired = 0
  localStorage.setItem('ochr_token', 'a-leftover-jwt')
  window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
})
afterEach(() => {
  window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  localStorage.removeItem('ochr_token')
})

const respond = (status, body = {}) => {
  handler = async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

describe('self-deactivate does not sign the shell out', () => {
  it('a 401 from POST /api/auth/deactivate does not fire unauthorized', async () => {
    respond(401, { error: 'Invalid or expired token' })
    const res = await fetch('/api/auth/deactivate', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(unauthorizedFired).toBe(0)
    const [, init] = transport.mock.calls.at(-1)
    expect(init.credentials).toBe('include')
  })

  it('POST with a query string is still the deactivate route', async () => {
    respond(401)
    const res = await fetch('/api/auth/deactivate?next=%2Faccount', { method: 'post' })
    expect(res.status).toBe(401)
    expect(unauthorizedFired).toBe(0)
  })

  it('a 401 from an ordinary chancery read still signs the person out', async () => {
    respond(401, { error: 'Invalid or expired token' })
    const res = await fetch('/api/diocese/parishes')
    expect(res.status).toBe(401)
    expect(unauthorizedFired).toBe(1)
  })

  it('a 401 from POST /api/auth/close stays on the account page', async () => {
    respond(401, { error: 'Invalid or expired token' })
    const res = await fetch('/api/auth/close', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(unauthorizedFired).toBe(0)
  })

  it('a 401 from POST /api/auth/login still signs the shell out', async () => {
    respond(401, { error: 'Invalid email or password' })
    const res = await fetch('/api/auth/login', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(unauthorizedFired).toBe(1)
  })

  it.each([
    ['GET', '/api/auth/deactivate'],
    ['DELETE', '/api/auth/deactivate'],
    ['POST', '/api/users/2/deactivate'],
    ['DELETE', '/api/users/2'],
    ['POST', '/api/auth/deactivate-now'],
    ['POST', '/api/auth/close-now'],
    ['GET', '/api/auth/close'],
    ['POST', '/api/users/2/close'],
  ])('%s %s still signs the person out', async (method, path) => {
    respond(401, { error: 'Invalid or expired token' })
    const res = await fetch(path, { method })
    expect(res.status).toBe(401)
    expect(unauthorizedFired).toBe(1)
  })

  it('a 500 does not sign the person out', async () => {
    respond(500, { error: 'Failed to deactivate this login' })
    const res = await fetch('/api/auth/deactivate', { method: 'POST' })
    expect(res.status).toBe(500)
    expect(unauthorizedFired).toBe(0)
  })

  it('does not leave ochr_token for XSS to read', async () => {
    respond(200)
    const res = await fetch('/api/diocese/parishes')
    expect(res.status).toBe(200)
    expect(localStorage.getItem('ochr_token')).toBeNull()
  })
})
