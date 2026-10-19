// Sign out everywhere must call POST /api/auth/logout-all and only
// clear the local session after the server answers yes.
//
// /logout clears this device's httpOnly cookie. A stolen JWT or a
// kiosk left signed in stays live unless token_version bumps. If
// logoutAll cleared the local session on a failed bump, the
// secretary would land on /login while every other device stayed up.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AuthProvider, useAuth } from './AuthContext'
import { stashIntentionDraft, peekIntentionDraft } from '../utils/intentionDraft'

const USER = {
  id: 1, email: 'secretary@sttest.org', name: 'Secretary', role: 'admin',
  organization: { id: 1, name: 'St Test', slug: 'st-test' },
}

function Probe() {
  const { logoutAll, isAuthenticated, user } = useAuth()
  return (
    <div>
      <span data-testid="authed">{String(isAuthenticated)}</span>
      <span data-testid="user">{user?.name ?? '(no user)'}</span>
      <span data-testid="legacy">{localStorage.getItem('ochr_token') ?? '(cleared)'}</span>
      <button onClick={() => logoutAll().catch(err => {
        document.getElementById('err').textContent = err.message
      })}>Sign out everywhere</button>
      <span id="err" data-testid="err" />
    </div>
  )
}

const meOk = () => ({ ok: true, status: 200, json: async () => ({ user: USER }) })

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_token')
})
afterEach(() => localStorage.clear())

describe('logoutAll — the server said yes', () => {
  it('POSTs /api/auth/logout-all then clears the local session', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const u = String(url)
      calls.push({ url: u, method: opts.method || 'GET' })
      if (u.includes('/api/auth/me')) return meOk()
      if (u.includes('/api/auth/logout-all')) return { ok: true, status: 204, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({}) }
    }))

    stashIntentionDraft({
      form: { intention: 'For the parish', mass_date: '2026-10-04' },
      nonce: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByTestId('authed').textContent).toBe('true'))

    await act(async () => { fireEvent.click(screen.getByText('Sign out everywhere')) })
    await waitFor(() => expect(screen.getByTestId('authed').textContent).toBe('false'))
    expect(peekIntentionDraft()).toBeNull()
    expect(screen.getByTestId('user').textContent).toBe('(no user)')
    expect(screen.getByTestId('legacy').textContent).toBe('(cleared)')

    const revoke = calls.find(c => c.url.includes('/logout-all'))
    expect(revoke).toEqual({ url: expect.stringContaining('/api/auth/logout-all'), method: 'POST' })
    expect(calls.some(c => c.url.includes('/api/auth/logout') && !c.url.includes('logout-all'))).toBe(false)
  })
})

describe('logoutAll — the server said no', () => {
  it('a 500 leaves the session in place and surfaces the failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/auth/me')) return meOk()
      if (u.includes('/api/auth/logout-all')) {
        return { ok: false, status: 500, json: async () => ({ error: 'Could not sign out everywhere. Please try again.' }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }))

    stashIntentionDraft({
      form: { intention: 'For the parish', mass_date: '2026-10-04' },
      nonce: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByTestId('authed').textContent).toBe('true'))

    await act(async () => { fireEvent.click(screen.getByText('Sign out everywhere')) })
    await waitFor(() => expect(screen.getByTestId('err').textContent).toMatch(/could not sign out everywhere/i))
    expect(screen.getByTestId('authed').textContent).toBe('true')
    expect(screen.getByTestId('user').textContent).toBe('Secretary')
    expect(peekIntentionDraft()?.form.intention).toBe('For the parish')
  })
})
