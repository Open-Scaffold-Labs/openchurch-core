// ResetPassword user-visible chrome goes through strings.js + t() en+es.
// Hard-coded English labels, placeholders, buttons, missing-token copy,
// and show/hide aria are the remaining Reset defect after Login/Signup
// localization. Restoring those literals in the component goes red.
// Token query, POST { token, password }, MIN_PW = 8, and the login
// flash navigate stay the auth contract.
// (OC-READY-01-032)

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import ResetPassword from './ResetPassword'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    token: null,
    loading: false,
  }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

const HERE = dirname(fileURLToPath(import.meta.url))
const RESET_SRC = readFileSync(join(HERE, 'ResetPassword.jsx'), 'utf8')
const LOGIN_SRC = readFileSync(join(HERE, 'Login.jsx'), 'utf8')

const HARD_EN = [
  'Choose a new password',
  'signed in fresh',
  'New password',
  'Confirm new password',
  'Re-enter the new password',
  'Set new password',
  'Updating…',
  'Reset link missing',
  'password-reset email',
  'Send a reset link',
  'Hide password',
  'Show password',
  'Passwords do not match',
  'Password must be at least',
  'At least ${MIN_PW} characters',
]

const RESET_KEYS = [
  'reset.title',
  'reset.sub',
  'reset.newPassword',
  'reset.confirmPassword',
  'reset.confirmPh',
  'reset.submit',
  'reset.submitting',
  'reset.mismatch',
  'reset.missingTitle',
  'reset.missingBody',
  'reset.sendLink',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const mount = (search = '?token=reset-token-fixture') => render(
  <MemoryRouter initialEntries={[`/reset${search}`]}>
    <LocaleProvider>
      <ResetPassword />
    </LocaleProvider>
  </MemoryRouter>,
)

beforeEach(() => {
  navigate.mockReset()
  localStorage.removeItem('ochr_locale')
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, message: 'Password updated. You can sign in with your new password.' }),
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ResetPassword chrome is translated (OC-READY-01-032)', () => {
  it('ENGLISH LABELS, PLACEHOLDERS, BUTTON, AND ARIA USE t() COPY', () => {
    mount()
    expect(screen.getByRole('heading', { name: STRINGS.en['reset.title'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['reset.sub'].replace('{min}', '8'))).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['reset.newPassword'])).toHaveAttribute(
      'placeholder',
      STRINGS.en['signup.passwordPh'].replace('{min}', '8'),
    )
    expect(screen.getByLabelText(STRINGS.en['reset.confirmPassword'])).toHaveAttribute(
      'placeholder',
      STRINGS.en['reset.confirmPh'],
    )
    expect(screen.getByRole('button', { name: STRINGS.en['login.showPassword'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['reset.submit'] })).toBeInTheDocument()
  })

  it('SPANISH RESET CHROME IS SPANISH — NOT THE ENGLISH LABELS', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(screen.getByRole('heading', { name: STRINGS.es['reset.title'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['reset.title'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['reset.sub'].replace('{min}', '8'))).toBeInTheDocument()
    expect(screen.queryByText(/signed in fresh/)).toBeNull()
    expect(screen.getByLabelText(STRINGS.es['reset.newPassword'])).toHaveAttribute(
      'placeholder',
      STRINGS.es['signup.passwordPh'].replace('{min}', '8'),
    )
    expect(screen.queryByLabelText(STRINGS.en['reset.newPassword'])).toBeNull()
    expect(screen.getByLabelText(STRINGS.es['reset.confirmPassword'])).toHaveAttribute(
      'placeholder',
      STRINGS.es['reset.confirmPh'],
    )
    expect(screen.getByRole('button', { name: STRINGS.es['login.showPassword'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['login.showPassword'] })).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.es['reset.submit'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['reset.submit'] })).toBeNull()
  })

  it('missing-token explainer is localized and still points at /forgot', () => {
    mount('')
    expect(screen.getByRole('heading', { name: STRINGS.en['reset.missingTitle'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['reset.missingBody'])).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.en['reset.sendLink'] })).toHaveAttribute('href', '/forgot')
  })

  it('Spanish missing-token explainer is Spanish', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount('')
    expect(screen.getByRole('heading', { name: STRINGS.es['reset.missingTitle'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['reset.missingTitle'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['reset.missingBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['reset.missingBody'])).toBeNull()
    expect(screen.getByRole('link', { name: STRINGS.es['reset.sendLink'] })).toHaveAttribute('href', '/forgot')
  })

  it('submit still posts { token, password } to reset-password and flashes login', async () => {
    mount('?token=reset-token-fixture')
    fireEvent.change(screen.getByLabelText(STRINGS.en['reset.newPassword']), {
      target: { value: 'password1' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['reset.confirmPassword']), {
      target: { value: 'password1' },
    })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['reset.submit'] }))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    const [url, opts] = fetch.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/auth\/reset-password$/)
    expect(opts.method).toBe('POST')
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(opts.body)).toEqual({ token: 'reset-token-fixture', password: 'password1' })
    expect(navigate).toHaveBeenCalledWith('/login', { replace: true, state: { passwordReset: true } })
  })

  it('password rules stay MIN_PW = 8 and locale chrome, not a hard-EN template', () => {
    expect(RESET_SRC).toMatch(/const MIN_PW = 8/)
    mount()
    fireEvent.change(screen.getByLabelText(STRINGS.en['reset.newPassword']), {
      target: { value: 'short' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['reset.confirmPassword']), {
      target: { value: 'short' },
    })
    fireEvent.submit(document.querySelector('form'))
    expect(screen.getByText(STRINGS.en['signup.passwordMin'].replace('{min}', '8'))).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^español$/i }))
    fireEvent.change(screen.getByLabelText(STRINGS.es['reset.newPassword']), {
      target: { value: 'short' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.es['reset.confirmPassword']), {
      target: { value: 'short' },
    })
    fireEvent.submit(document.querySelector('form'))
    expect(screen.getByText(STRINGS.es['signup.passwordMin'].replace('{min}', '8'))).toBeInTheDocument()
    expect(screen.queryByText(/Password must be at least/)).toBeNull()

    fireEvent.change(screen.getByLabelText(STRINGS.es['reset.newPassword']), {
      target: { value: 'password1' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.es['reset.confirmPassword']), {
      target: { value: 'password2' },
    })
    fireEvent.submit(document.querySelector('form'))
    expect(screen.getByText(STRINGS.es['reset.mismatch'])).toBeInTheDocument()
    expect(screen.queryByText(/Passwords do not match/)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a visible mismatch error exposes the message with role=alert', () => {
    mount()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText(STRINGS.en['reset.newPassword']), {
      target: { value: 'password1' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['reset.confirmPassword']), {
      target: { value: 'password2' },
    })
    fireEvent.submit(document.querySelector('form'))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.en['reset.mismatch'])
    expect(alert).toHaveAttribute('role', 'alert')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(RESET_SRC)
    for (const key of RESET_KEYS) {
      expect(RESET_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(RESET_SRC).toMatch(/t\('login\.showPassword'\)/)
    expect(RESET_SRC).toMatch(/t\('login\.hidePassword'\)/)
    expect(RESET_SRC).toMatch(/t\('signup\.passwordPh'/)
    expect(RESET_SRC).toMatch(/t\('signup\.passwordMin'/)
    expect(RESET_SRC).toMatch(/t\('err\.save'\)/)
    expect(RESET_SRC).toMatch(/useLocale\(/)
    expect(RESET_SRC).toMatch(/apiUrl\('\/api\/auth\/reset-password'\)/)
    expect(RESET_SRC).toMatch(/JSON\.stringify\(\{ token, password \}\)/)
    expect(RESET_SRC).toMatch(/navigate\('\/login', \{ replace: true, state: \{ passwordReset: true \} \}\)/)
    expect(RESET_SRC).toMatch(/params\.get\('token'\)/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['reset.newPassword']).toBe('New password')
    expect(STRINGS.en['reset.confirmPassword']).toBe('Confirm new password')
    expect(STRINGS.es['reset.newPassword']).toMatch(/contraseña/i)
    expect(STRINGS.es['reset.submit']).toMatch(/establecer/i)
  })

  it('Login leftover password aria is the same tiny t() fold — not a Login rewrite', () => {
    expect(LOGIN_SRC).toMatch(/t\('login\.showPassword'\)/)
    expect(LOGIN_SRC).toMatch(/t\('login\.hidePassword'\)/)
    const jsx = stripComments(LOGIN_SRC)
    expect(jsx).not.toMatch(/aria-label=\{showPw \? 'Hide password' : 'Show password'\}/)
    expect(STRINGS.en['login.showPassword']).toBe('Show password')
    expect(STRINGS.en['login.hidePassword']).toBe('Hide password')
    expect(STRINGS.es['login.showPassword']).toMatch(/mostrar/i)
    expect(STRINGS.es['login.hidePassword']).toMatch(/ocultar/i)
  })
})
