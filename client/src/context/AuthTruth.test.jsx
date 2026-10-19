// A server failure is not an authentication rejection. (Pass 7 §2)
//
// GET /api/auth/me answers, per server/src/middleware/auth.js and
// server/src/routes/auth.js:
//
//   200  { user }                    the session is valid
//   401  five distinct paths — no cookie, bad/expired token, unknown user,
//        token_version bumped (revoked). ALL positive rejections.
//   500  'Authentication check failed' / 'Failed to load account' — the
//        database threw. The server is saying it COULD NOT CHECK.
//
// It cannot answer 403: the route carries requireAuth and no role gate.
// Elsewhere 403 means authenticated-but-not-permitted, which is never a
// reason to end a session.
//
// The session lives in an httpOnly cookie. A 5xx must not bounce the
// secretary to /login — the cookie is still there, we just could not
// confirm it.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AuthProvider, useAuth } from './AuthContext'

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
      <span data-testid="legacy">{localStorage.getItem('ochr_token') ?? '(cleared)'}</span>
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
  localStorage.removeItem('ochr_token')
})
afterEach(() => localStorage.clear())

describe('CONTROL — a valid session', () => {
  it('resolves to authenticated from the cookie session and stores no JWT', async () => {
    const f = stub('ok'); mount(); await settled()
    expect(screen.getByTestId('authed')).toHaveTextContent('true')
    expect(screen.getByTestId('user')).toHaveTextContent('Secretary')
    expect(screen.getByTestId('legacy')).toHaveTextContent('(cleared)')
    expect(f).toHaveBeenCalled()
  })

  it('wipes a leftover pre-cookie ochr_token so XSS cannot steal it', async () => {
    localStorage.setItem('ochr_token', 'stolen.jwt.value')
    stub('ok'); mount(); await settled()
    expect(localStorage.getItem('ochr_token')).toBeNull()
    expect(screen.getByTestId('legacy')).toHaveTextContent('(cleared)')
  })
})

describe('POSITIVE REJECTION — the session must end', () => {
  for (const kind of ['rejected', 'revoked']) {
    it(`a 401 (${kind}) is unauthenticated and stores no JWT`, async () => {
      stub(kind); mount(); await settled()
      expect(screen.getByTestId('authed')).toHaveTextContent('false')
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated')
      expect(screen.getByTestId('legacy')).toHaveTextContent('(cleared)')
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
    it(`${label} must not claim the user is signed out`, async () => {
      stub(kind); mount(); await settled()
      expect(screen.getByTestId('status')).toHaveTextContent('unknown')
      expect(screen.getByTestId('authed')).toHaveTextContent('false')
    })
  }

  it('a 403 is not an auth rejection and must not claim signed-out', async () => {
    // /api/auth/me cannot return 403 today — it carries requireAuth and no
    // role gate. Pinned anyway: 403 means authenticated-but-not-permitted,
    // and if a future gate lands on this route it must not read as "your
    // session is invalid".
    stub('forbidden'); mount(); await settled()
    expect(screen.getByTestId('status')).toHaveTextContent('unknown')
    expect(screen.getByTestId('authed')).toHaveTextContent('false')
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

describe('no cookie session at all', () => {
  it('asks /me and becomes unauthenticated on 401', async () => {
    const f = stub('rejected'); mount(); await settled()
    expect(screen.getByTestId('authed')).toHaveTextContent('false')
    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated')
    expect(f).toHaveBeenCalled()
  })
})
