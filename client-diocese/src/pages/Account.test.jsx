// Self-serve login deactivation lives on the account page, linked beside
// sign-out. The confirm dialog says the login is turned off and does not
// say the account is deleted. Success calls the shell logout. A last-active
// admin refusal, and every ambiguous answer, stays on the page.
//
// 401 and 500 are exercised through installSessionFetch, the wrapper
// main.jsx installs. A stub of fetch replaces that wrapper, so those two
// statuses are not in the stubbed list below.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'
import { AuthCtx } from '../authContext'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { STRINGS } from '../i18n/strings'
import { installSessionFetch, UNAUTHORIZED_EVENT } from '../sessionFetch'
import Account from './Account'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, '../App.jsx'), 'utf8')
const ACCOUNT = readFileSync(join(HERE, 'Account.jsx'), 'utf8')
const TEAM = readFileSync(join(HERE, 'Team.jsx'), 'utf8')

const USER = {
  id: 4,
  name: 'Canon',
  organization: { name: 'Demonstration Diocese', is_demo: false },
}

const KEYS = [
  'account.link',
  'account.title',
  'account.sub',
  'account.deactivate.title',
  'account.deactivate.help',
  'account.deactivate.submit',
  'account.deactivate.confirmTitle',
  'account.deactivate.confirmBody',
  'account.deactivate.confirm',
  'account.deactivate.cancel',
  'account.deactivate.saving',
  'account.deactivate.failed',
  'account.deactivate.lastAdmin',
]

const SERVER_LAST_ADMIN = 'Cannot deactivate the only active admin. Transfer administration first. Closing the organization is a separate step and is not done here.'
const SERVER_FAILED = 'Failed to deactivate this login'
const SERVER_401 = 'Invalid or expired token'

const logout = vi.hoisted(() => vi.fn())

function Harness() {
  const [user, setUser] = useState(USER)
  const signOut = () => {
    logout()
    try { localStorage.removeItem('ochr_token') } catch { /* App logout */ }
    setUser(null)
  }
  if (!user) return <p>Signed out</p>
  return (
    <AuthCtx.Provider value={{ user, logout: signOut }}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/account']}>
          <Routes>
            <Route path="/account" element={<Account />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </AuthCtx.Provider>
  )
}

beforeEach(() => {
  logout.mockClear()
  localStorage.removeItem('ochr_locale')
  localStorage.setItem('ochr_token', 'session-sentinel')
  vi.unstubAllGlobals()
})

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

async function confirmTurnOff(locale = 'en') {
  const copy = STRINGS[locale]
  fireEvent.click(screen.getByRole('button', { name: copy['account.deactivate.submit'] }))
  const confirm = await screen.findByRole('button', { name: copy['account.deactivate.confirm'] })
  await act(async () => {
    fireEvent.click(confirm)
  })
}

function callsOf(fetchMock) {
  return fetchMock.mock.calls.map(([url, opts]) => ({
    url: String(url),
    method: String(opts?.method || 'GET').toUpperCase(),
  }))
}

describe('turning this login off from the account page', () => {
  it('sits beside sign-out, outside the product navigation, and Team stays invite-only', () => {
    expect(APP).toMatch(/path="\/account"/)
    expect(APP).toMatch(/t\('account\.link'\)/)
    expect(APP).not.toMatch(/to:\s*'\/account'/)
    expect(ACCOUNT).toMatch(/apiUrl\('\/api\/auth\/deactivate'\)/)
    expect(ACCOUNT).not.toMatch(/\/api\/users/)
    expect(ACCOUNT).not.toMatch(/\bDELETE\b/)
    // Team may display a deactivated login and restore it. Turning a
    // login off remains self-service on Account, never a Team request.
    expect(TEAM).not.toMatch(/\/deactivate['"`]/)
    expect(TEAM).not.toMatch(/method:\s*'DELETE'/)
  })

  it('the signed-in shell links here beside sign-out', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/auth/me')) return jsonResponse(200, { user: USER })
      return jsonResponse(200, { parishes: [], submissions: [] })
    }))
    render(<ConfirmProvider><App /></ConfirmProvider>)
    const link = await screen.findByRole('link', { name: STRINGS.en['account.link'] })
    const signOut = screen.getByRole('button', { name: STRINGS.en['auth.signOut'] })
    expect(screen.getByRole('navigation')).not.toContainElement(link)
    expect(signOut.closest('aside')).toContainElement(link)
    expect(link.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(link)
    expect(await screen.findByRole('heading', { name: STRINGS.en['account.deactivate.title'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['account.deactivate.help'])).toBeInTheDocument()
  })

  it('English confirm says the login is turned off and does not say deleted', async () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['account.deactivate.submit'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(STRINGS.en['account.deactivate.confirmTitle'])
    expect(dialog).toHaveTextContent(STRINGS.en['account.deactivate.confirmBody'])
    expect(dialog.textContent.toLowerCase()).not.toMatch(/delet/)
    expect(fetch).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()
    expect(localStorage.getItem('ochr_token')).toBe('session-sentinel')
  })

  it('Spanish confirm is Spanish', async () => {
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn())
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['account.deactivate.submit'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(STRINGS.es['account.deactivate.confirmTitle'])
    expect(dialog).toHaveTextContent(STRINGS.es['account.deactivate.confirmBody'])
    expect(screen.queryByRole('heading', { name: STRINGS.en['account.deactivate.confirmTitle'] })).toBeNull()
  })

  it('cancel does not fetch', async () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['account.deactivate.submit'] }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['account.deactivate.cancel'] }))
    expect(dialog).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()
    expect(screen.queryByText('Signed out')).toBeNull()
    expect(localStorage.getItem('ochr_token')).toBe('session-sentinel')
    expect(screen.getByRole('heading', { name: STRINGS.en['account.deactivate.title'] })).toBeInTheDocument()
  })

  it.each([
    [{ deactivated: true }],
    [{ deactivated: true, already: true }],
  ])('200 %j logs out', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, body)))
    render(<Harness />)
    await confirmTurnOff()
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Signed out')).toBeInTheDocument()
    const calls = callsOf(fetch)
    expect(calls).toEqual([
      { url: expect.stringContaining('/api/auth/deactivate'), method: 'POST' },
    ])
    expect(calls.some(call => call.method === 'DELETE' || call.url.includes('/api/users'))).toBe(false)
  })

  it('the only request issued on confirm is POST /api/auth/deactivate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { deactivated: true })))
    render(<Harness />)
    await confirmTurnOff()
    await waitFor(() => expect(logout).toHaveBeenCalled())
    const calls = callsOf(fetch)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toMatch(/\/api\/auth\/deactivate$/)
    expect(calls[0].url).not.toMatch(/\/api\/users/)
  })

  it('the shell logout leaves the signed-in shell, and no user row is deleted', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const entry = { url: String(url), method: String(opts.method || 'GET').toUpperCase() }
      calls.push(entry)
      if (entry.url.includes('/api/auth/me')) return jsonResponse(200, { user: USER })
      if (entry.method === 'POST' && entry.url.includes('/api/auth/deactivate')) {
        return jsonResponse(200, { deactivated: true, already: false })
      }
      return jsonResponse(200, { parishes: [], submissions: [] })
    }))
    render(<ConfirmProvider><App /></ConfirmProvider>)
    fireEvent.click(await screen.findByRole('link', { name: STRINGS.en['account.link'] }))
    await confirmTurnOff()
    expect(await screen.findByRole('button', { name: STRINGS.en['auth.signIn'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['auth.signOut'] })).toBeNull()
    const posted = calls.filter(call => call.method === 'POST' && /\/api\/auth\/deactivate$/.test(call.url))
    expect(posted).toHaveLength(1)
    expect(calls.some(call => call.method === 'DELETE')).toBe(false)
    expect(calls.some(call => call.url.includes('/api/users'))).toBe(false)
    expect(localStorage.getItem('ochr_token')).toBeNull()
  })

  it('409 stays on the page, does not log out, and shows the last-admin string', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: SERVER_LAST_ADMIN }),
    })))
    render(<Harness />)
    await confirmTurnOff()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.en['account.deactivate.lastAdmin'])
    expect(alert.textContent).not.toContain(SERVER_LAST_ADMIN)
    expect(alert.textContent).not.toMatch(/Cannot deactivate/)
    expect(alert.textContent.toLowerCase()).not.toMatch(/delet/)
    expect(logout).not.toHaveBeenCalled()
    expect(screen.queryByText('Signed out')).toBeNull()
    expect(localStorage.getItem('ochr_token')).toBe('session-sentinel')
    expect(screen.getByRole('heading', { name: STRINGS.en['account.deactivate.title'] })).toBeInTheDocument()
  })

  it('Spanish does not show the English server refusal', async () => {
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: SERVER_LAST_ADMIN }),
    })))
    render(<Harness />)
    await confirmTurnOff('es')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.es['account.deactivate.lastAdmin'])
    expect(alert.textContent).not.toContain(SERVER_LAST_ADMIN)
    expect(alert.textContent).not.toMatch(/Cannot deactivate/)
    expect(logout).not.toHaveBeenCalled()
    expect(localStorage.getItem('ochr_token')).toBe('session-sentinel')
  })

  it.each([
    ['network', () => { throw new TypeError('Failed to fetch') }, SERVER_FAILED],
    ['200 without deactivated', () => jsonResponse(200, { ok: true }), null],
    ['200 non-json', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json') } }), null],
  ])('%s does not log out and does not clear the session', async (_label, respond, hidden) => {
    vi.stubGlobal('fetch', vi.fn(respond))
    render(<Harness />)
    await confirmTurnOff()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.en['account.deactivate.failed'])
    if (hidden) expect(alert.textContent).not.toContain(hidden)
    expect(alert.textContent).not.toMatch(/still on|still off|nothing was changed|unchanged/i)
    expect(logout).not.toHaveBeenCalled()
    expect(screen.queryByText('Signed out')).toBeNull()
    expect(localStorage.getItem('ochr_token')).toBe('session-sentinel')
    expect(screen.getByRole('heading', { name: STRINGS.en['account.deactivate.title'] })).toBeInTheDocument()
    const calls = callsOf(fetch)
    expect(calls).toEqual([
      { url: expect.stringContaining('/api/auth/deactivate'), method: 'POST' },
    ])
  })

  it.each([
    [401, SERVER_401],
    [500, SERVER_FAILED],
  ])('HTTP %s from POST /api/auth/deactivate is handled by the installed session wrapper', async (status, serverSentence) => {
    const previous = window.fetch
    let unauthorizedFired = 0
    const onUnauthorized = () => { unauthorizedFired++ }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    const deactivateCalls = []
    const transport = vi.fn(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url ?? ''
      const method = String(init.method || 'GET').toUpperCase()
      let path = ''
      try { path = new URL(url, window.location.origin).pathname } catch { path = '' }
      // Account.jsx does not set credentials. Only installSessionFetch does,
      // and only when the page calls the fetch that wrapper installed.
      const viaWrapper = (new Error().stack || '').includes('sessionFetch.js')
      if (path === '/api/session-probe') {
        return new Response(JSON.stringify({ error: SERVER_401 }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && path === '/api/auth/deactivate') {
        const res = new Response(JSON.stringify({ error: serverSentence }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
        deactivateCalls.push({ res, credentials: init.credentials, viaWrapper })
        return res
      }
      if (path === '/api/auth/me') {
        return new Response(JSON.stringify({ user: USER }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ parishes: [], submissions: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    window.fetch = transport
    installSessionFetch()
    try {
      expect(window.fetch).not.toBe(transport)
      await window.fetch('/api/session-probe')
      expect(unauthorizedFired).toBe(1)
      unauthorizedFired = 0
      render(<ConfirmProvider><App /></ConfirmProvider>)
      fireEvent.click(await screen.findByRole('link', { name: STRINGS.en['account.link'] }))
      await confirmTurnOff()
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(STRINGS.en['account.deactivate.failed'])
      expect(alert.textContent).not.toContain(serverSentence)
      expect(alert.textContent).not.toMatch(/still on|still off|nothing was changed|unchanged/i)
      expect(unauthorizedFired).toBe(0)
      expect(screen.getByRole('button', { name: STRINGS.en['auth.signOut'] })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: STRINGS.en['auth.signIn'] })).toBeNull()
      expect(screen.getByRole('heading', { name: STRINGS.en['account.deactivate.title'] })).toBeInTheDocument()
      expect(deactivateCalls).toHaveLength(1)
      expect(deactivateCalls[0].credentials).toBe('include')
      expect(deactivateCalls[0].viaWrapper).toBe(true)
      expect(deactivateCalls[0].res.status).toBe(status)
      expect(deactivateCalls[0].res.bodyUsed).toBe(true)
      const logoutPosts = transport.mock.calls.filter(([input, init]) => {
        const url = typeof input === 'string' ? input : input?.url ?? ''
        const method = String(init?.method || 'GET').toUpperCase()
        return method === 'POST' && url.includes('/api/auth/logout')
      })
      expect(logoutPosts).toHaveLength(0)
    } finally {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
      window.fetch = previous
    }
  })

  it('both languages have the copy, and neither says deleted', () => {
    for (const locale of Object.keys(STRINGS)) {
      for (const key of KEYS) {
        expect(STRINGS[locale][key], `${locale} ${key}`).toBeTruthy()
        expect(STRINGS[locale][key].toLowerCase(), `${locale} ${key}`).not.toMatch(/delet|elimin|borrad/)
      }
    }
    expect(STRINGS.es['account.deactivate.title']).not.toBe(STRINGS.en['account.deactivate.title'])
    expect(STRINGS.en['account.deactivate.failed']).not.toMatch(/still on|still off|nothing was changed|unchanged/i)
    expect(STRINGS.es['account.deactivate.failed']).not.toMatch(/sigue encendido|sigue apagado|no se cambió nada/i)
    expect(STRINGS.en['account.deactivate.lastAdmin']).toMatch(/stays on/i)
    expect(STRINGS.es['account.deactivate.lastAdmin']).toMatch(/sigue encendido/i)
    expect(STRINGS.en['account.deactivate.help']).toMatch(/turn the login back on/i)
    expect(STRINGS.es['account.deactivate.help']).toMatch(/volver a encender/i)
  })
})
