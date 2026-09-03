// A server failure is not an authentication rejection. (Pass 7 §2)
//
// GET /api/auth/me answers, per server/src/middleware/auth.js and
// server/src/routes/auth.js:
//
//   200  { user }                    the session is valid
//   401  five distinct paths — no header, bad/expired token, unknown user,
//        token_version bumped (revoked). ALL positive rejections.
//   500  'Authentication check failed' / 'Failed to load account' — the
//        database threw. The server is saying it COULD NOT CHECK.
//
// It cannot answer 403: the route carries requireAuth and no role gate.
// Elsewhere 403 means authenticated-but-not-permitted, which is never a
// reason to end a session.
//
// The client collapsed all of that into `if (!res.ok) throw` and cleared
// the session in the catch. So a database hiccup signed the secretary out
// and sent her to /login — the app asserting her session was invalid when
// what it actually knew was nothing.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AuthProvider, useAuth } from './AuthContext'

const TOKEN = 'stored.jwt.value'
const USER = {
  id: 1, email: 'secretary@sttest.org', name: 'Secretary', role: 'admin',
  organization: { id: 1, name: 'St Test', slug: 'st-test' },
}

// A probe that reports exactly what the app would act on.
function Probe() {
  const { isAuthenticated, loading, user, authStatus, retryAuth } = useAuth()
  return (
    <div>
      <span data-testid="status">{authStatus ?? '(none)'}</span>
      <span data-testid="authed">{String(isAuthenticated)}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{user?.name ?? '(no user)'}</span>
      <span data-testid="token">{localStorage.getItem('ochr_token') ?? '(cleared)'}</span>
      {retryAuth && <button onClick={retryAuth}>Retry</button>}
    </div>
  )
}

const meResponses = {
  ok:        () => ({ ok: true,  status: 200, json: async () => ({ user: USER }) }),
  rejected:  () => ({ ok: false, status: 401, json: async () => ({ error: 'Invalid or expired token' }) }),
  revoked:   () => ({ ok: false, status: 401, json: async () => ({ error: 'Session expired — please sign in again' }) }),
  forbidden: () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) }),
  down:      () => ({ ok: false, status: 500, json: async () => ({ error: 'Authentication check failed' }) }),
  unavail:   () => ({ ok: false, status: 503, json: async () => ({ error: 'Service Unavailable' }) }),
  network:   () => { throw new TypeError('Failed to fetch') },
  malformed: () => ({ ok: true,  status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }),
  noUserKey: () => ({ ok: true,  status: 200, json: async () => ({}) }),
}

const stub = (kind) => {
  const fn = vi.fn(async (url) => {
    if (String(url).includes('/api/auth/me')) return meResponses[kind]()
    return { ok: true, status: 200, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const mount = () => render(<AuthProvider><Probe /></AuthProvider>)
const settled = async () =>
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.setItem('ochr_token', TOKEN)
})
afterEach(() => localStorage.clear())

describe('CONTROL — a valid session', () => {
  it('resolves to authenticated and keeps the token', async () => {
    stub('ok'); mount(); await settled()
    expect(screen.getByTestId('authed')).toHaveTextContent('true')
    expect(screen.getByTestId('user')).toHaveTextContent('Secretary')
    expect(screen.getByTestId('token')).toHaveTextContent(TOKEN)
  })
})

describe('POSITIVE REJECTION — the session must end', () => {
  for (const kind of ['rejected', 'revoked']) {
    it(`a 401 (${kind}) clears the session and the stored token`, async () => {
      stub(kind); mount(); await settled()
      expect(screen.getByTestId('authed')).toHaveTextContent('false')
      expect(screen.getByTestId('token')).toHaveTextContent('(cleared)')
    })
  }
})

describe('COULD NOT VERIFY — the session must survive', () => {
  for (const [kind, label] of [
    ['down',      'a 500 from the auth check'],
    ['unavail',   'a 503'],
    ['network',   'a dropped connection'],
    ['malformed', 'a body that is not JSON'],
    ['noUserKey', 'a 200 that carries no user'],
  ]) {
    it(`${label} must not sign the user out`, async () => {
      stub(kind); mount(); await settled()
      // The credential is untouched — nothing has rejected it.
      expect(screen.getByTestId('token')).toHaveTextContent(TOKEN)
      expect(screen.getByTestId('status')).toHaveTextContent('unknown')
      // And the app must not believe it has an authenticated user.
      expect(screen.getByTestId('authed')).toHaveTextContent('false')
    })
  }

  it('a 403 is not an auth rejection and must not sign the user out', async () => {
    // /api/auth/me cannot return 403 today — it carries requireAuth and no
    // role gate. Pinned anyway: 403 means authenticated-but-not-permitted,
    // and if a future gate lands on this route it must not read as "your
    // session is invalid".
    stub('forbidden'); mount(); await settled()
    expect(screen.getByTestId('token')).toHaveTextContent(TOKEN)
  })

  it('recovers on retry once the server answers, with no page reload', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (!String(url).includes('/api/auth/me')) return { ok: true, status: 200, json: async () => ({}) }
      return ++call === 1 ? meResponses.down() : meResponses.ok()
    }))
    mount(); await settled()
    expect(screen.getByTestId('status')).toHaveTextContent('unknown')

    await act(async () => { fireEvent.click(screen.getByText('Retry')) })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(screen.getByTestId('user')).toHaveTextContent('Secretary')
  })
})

describe('no stored token at all', () => {
  it('is unauthenticated without asking the server', async () => {
    localStorage.removeItem('ochr_token')
    const f = stub('ok'); mount(); await settled()
    expect(screen.getByTestId('authed')).toHaveTextContent('false')
    expect(f).not.toHaveBeenCalled()
  })
})
