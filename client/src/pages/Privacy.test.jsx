// P1 lane B — public /privacy route shell.
// Mutate any of these back and the matching test goes red:
//   1. /privacy missing from the logged-out routes, or moved into ProtectedLayout
//   2. Login, Signup or Contact lose the /privacy link
//   3. the page stops saying it is a DRAFT / not published
//   4. the page imports a counsel draft as if it were the policy
//   5. EN/ES copy goes missing

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import Privacy, { PRIVACY_DRAFT_MARKER } from './Privacy'
import Contact, { DEFAULT_PUBLIC_SUPPORT_EMAIL } from './Contact'
import Login from './Login'
import Signup from './Signup'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false, login: vi.fn(), signup: vi.fn() }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_SRC = readFileSync(join(HERE, '..', 'App.jsx'), 'utf8')
const PRIVACY_SRC = readFileSync(join(HERE, 'Privacy.jsx'), 'utf8')

function publicRoutesSrc() {
  const start = APP_SRC.indexOf('export default function App()')
  return APP_SRC.slice(start, APP_SRC.indexOf('path="/*"', start))
}
function protectedLayoutSrc() {
  const start = APP_SRC.indexOf('function ProtectedLayout()')
  return APP_SRC.slice(start, APP_SRC.indexOf('function RedirectIfAuthed', start))
}

const wrap = (node, path = '/privacy') => render(
  <MemoryRouter initialEntries={[path]}><LocaleProvider>{node}</LocaleProvider></MemoryRouter>,
)

beforeEach(() => { localStorage.removeItem('ochr_locale') })

describe('public /privacy route registration', () => {
  it('is a logged-out public route, not inside ProtectedLayout', () => {
    expect(publicRoutesSrc()).toMatch(/<Route path="\/privacy" element={<Privacy \/>} \/>/)
    expect(protectedLayoutSrc()).not.toMatch(/path="\/privacy"/)
  })

  it('does not import any counsel or policy draft as content', () => {
    // Built from parts so the withheld draft filenames never appear literally (public snapshot drift check).
    const policyDraft = ['PRIVACY', 'POLICY', 'DRAFT'].join('-')
    const noticeDraft = ['P1', 'PRIVACY', 'NOTICE', 'DRAFT'].join('-')
    expect(PRIVACY_SRC).not.toMatch(new RegExp(`${policyDraft}|${noticeDraft}\\.md['"]|\\.md\\?raw`))
    expect(PRIVACY_SRC).not.toMatch(new RegExp(['text', 'white'].join('-')))
  })
})

describe('logged-out /privacy content', () => {
  it('renders without auth, marked DRAFT and not published', () => {
    const { container } = wrap(
      <Routes>
        <Route path="/login" element={<div>LOGIN_BOUNCE</div>} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/*" element={<Navigate to="/login" replace />} />
      </Routes>,
    )
    expect(screen.queryByText('LOGIN_BOUNCE')).not.toBeInTheDocument()
    expect(container.querySelector(`[data-privacy-shell="${PRIVACY_DRAFT_MARKER}"]`)).not.toBeNull()
    expect(screen.getByRole('heading', { name: /privacy at openchurch/i })).toBeInTheDocument()
    expect(screen.getByText(/DRAFT — not the final privacy policy/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/not published yet/i)
    expect(screen.getByRole('link', { name: new RegExp(DEFAULT_PUBLIC_SUPPORT_EMAIL.replace('.', '\\.')) }))
      .toHaveAttribute('href', `mailto:${DEFAULT_PUBLIC_SUPPORT_EMAIL}`)
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute('href', '/login')
    expect(screen.getByRole('link', { name: /^contact$/i })).toHaveAttribute('href', '/contact')
    // No finished-policy claims in the shell.
    expect(document.body.textContent).not.toMatch(/we (never|do not) sell|retain(ed)? for \d+|days/i)
  })

  it('keeps EN/ES copy, with every key present in both locales', () => {
    const keys = Object.keys(STRINGS.en).filter(k => k.startsWith('privacyPage.'))
    expect(keys.length).toBeGreaterThanOrEqual(8)
    for (const k of keys) expect(STRINGS.es[k], k).toBeTruthy()
    wrap(<Privacy />)
    fireEvent.click(screen.getByRole('button', { name: /^español$/i }))
    expect(screen.getByRole('heading', { name: /privacidad en openchurch/i })).toBeInTheDocument()
    expect(screen.getByText(/BORRADOR — no es la política de privacidad final/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/aún no está publicada/i)
  })
})

describe('link shell to /privacy', () => {
  it.each([
    ['Login', <Login key="l" />, '/login'],
    ['Signup', <Signup key="s" />, '/signup'],
    ['Contact', <Contact key="c" />, '/contact'],
  ])('%s links to /privacy', (_name, node, path) => {
    wrap(node, path)
    expect(screen.getByRole('link', { name: /^privacy \(draft\)$/i })).toHaveAttribute('href', '/privacy')
  })
})
