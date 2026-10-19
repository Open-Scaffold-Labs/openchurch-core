// ForgotPassword user-visible chrome goes through strings.js + t() en+es.
// Hard-coded English labels, placeholders, buttons, and sent-state copy
// are the remaining Forgot defect after Login/Signup localization.
// Restoring those literals in the component goes red. Token/API body
// stays { email } POSTed to /api/auth/forgot-password.
// (OC-READY-01-032)

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import ForgotPassword from './ForgotPassword'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    token: null,
    loading: false,
  }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const FORGOT_SRC = readFileSync(join(HERE, 'ForgotPassword.jsx'), 'utf8')

const HARD_EN = [
  'Reset your password',
  'Enter the email associated with your church',
  "We'll send a link",
  'you@yourchurch.com',
  'Send reset link',
  'Sending…',
  'Remembered it',
  'Back to sign in',
  'Check your email',
  "we've sent a link",
  'label="Email"',
  "label='Email'",
]

const FORGOT_KEYS = [
  'forgot.title',
  'forgot.sub',
  'forgot.submit',
  'forgot.submitting',
  'forgot.remembered',
  'forgot.back',
  'forgot.sentTitle',
  'forgot.sentBody',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const mount = () => render(
  <MemoryRouter>
    <LocaleProvider>
      <ForgotPassword />
    </LocaleProvider>
  </MemoryRouter>,
)

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true }),
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ForgotPassword chrome is translated (OC-READY-01-032)', () => {
  it('ENGLISH LABELS, PLACEHOLDER, BUTTONS, AND FOOTER USE t() COPY', () => {
    mount()
    expect(screen.getByRole('heading', { name: STRINGS.en['forgot.title'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['forgot.sub'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['login.email'])).toHaveAttribute(
      'placeholder',
      STRINGS.en['signup.emailPh'],
    )
    expect(screen.getByRole('button', { name: STRINGS.en['forgot.submit'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['forgot.remembered'])).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.en['forgot.back'] })).toHaveAttribute('href', '/login')
  })

  it('SPANISH FORGOT CHROME IS SPANISH — NOT THE ENGLISH LABELS', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(screen.getByRole('heading', { name: STRINGS.es['forgot.title'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['forgot.title'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['forgot.sub'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['forgot.sub'])).toBeNull()
    expect(screen.getByLabelText(STRINGS.es['login.email'])).toHaveAttribute(
      'placeholder',
      STRINGS.es['signup.emailPh'],
    )
    expect(screen.queryByLabelText(STRINGS.en['login.email'])).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.es['forgot.submit'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['forgot.submit'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['forgot.remembered'])).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.es['forgot.back'] })).toBeInTheDocument()
  })

  it('submit still posts the same forgot-password body — email trimmed, no extra fields', async () => {
    mount()
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.email']), {
      target: { value: '  secretary@example.com  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['forgot.submit'] }))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    const [url, opts] = fetch.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/auth\/forgot-password$/)
    expect(opts.method).toBe('POST')
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(opts.body)).toEqual({ email: 'secretary@example.com' })
  })

  it('sent state uses locale copy and still names the typed email', async () => {
    mount()
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.email']), {
      target: { value: 'secretary@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['forgot.submit'] }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: STRINGS.en['forgot.sentTitle'] })).toBeInTheDocument()
    })
    expect(screen.getByText((_, node) => (
      node.tagName === 'P'
      && (node.textContent || '').includes('secretary@example.com')
      && (node.textContent || '').includes('one hour')
    ))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.en['forgot.back'] })).toHaveAttribute('href', '/login')
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(FORGOT_SRC)
    for (const key of FORGOT_KEYS) {
      expect(FORGOT_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(FORGOT_SRC).toMatch(/t\('login\.email'\)/)
    expect(FORGOT_SRC).toMatch(/t\('signup\.emailPh'\)/)
    expect(FORGOT_SRC).toMatch(/t\('err\.save'\)/)
    expect(FORGOT_SRC).toMatch(/useLocale\(/)
    expect(FORGOT_SRC).toMatch(/apiUrl\('\/api\/auth\/forgot-password'\)/)
    expect(FORGOT_SRC).toMatch(/JSON\.stringify\(\{ email: email\.trim\(\) \}\)/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['forgot.title']).toBe('Reset your password')
    expect(STRINGS.en['forgot.submit']).toBe('Send reset link')
    expect(STRINGS.es['forgot.title']).toMatch(/contraseña/i)
    expect(STRINGS.es['forgot.submit']).toMatch(/enviar/i)
  })

  it('a failed request exposes the message with role=alert', async () => {
    const message = 'Could not send the reset link.'
    fetch.mockImplementation(async () => ({
      ok: false,
      json: async () => ({ error: message }),
    }))
    mount()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.email']), {
      target: { value: 'secretary@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['forgot.submit'] }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(message)
    expect(alert).toHaveAttribute('role', 'alert')
  })
})
