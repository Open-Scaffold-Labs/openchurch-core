// Signup user-visible chrome goes through strings.js + t() en+es.
// Hard-coded English labels, placeholders, tradition *display* strings,
// buttons, and password show/hide aria are the remaining Signup defect
// after Login localization. Restoring those literals in the component
// goes red. Tradition option *values* stay the API tokens.
// (OC-READY-01-031)

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import Signup from './Signup'

const { signup } = vi.hoisted(() => ({ signup: vi.fn() }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    token: null,
    loading: false,
    signup,
  }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const SIGNUP_SRC = readFileSync(join(HERE, 'Signup.jsx'), 'utf8')
const LOGIN_SRC = readFileSync(join(HERE, 'Login.jsx'), 'utf8')

const TRADITION_VALUES = ['', 'catholic', 'episcopal', 'lutheran', 'anglican', 'general']

const HARD_EN = [
  'Start your church',
  'A private workspace for your staff',
  'Church name',
  'First Baptist of Austin',
  'I’ll decide later',
  "I'll decide later",
  'Something else',
  'Your name',
  'Pastor Jane Doe',
  'you@yourchurch.com',
  'At least ${MIN_PW} characters',
  'Create church & sign in',
  'Creating your church',
  'Already have an account',
  'Hide password',
  'Show password',
  'Password must be at least',
]

const SIGNUP_KEYS = [
  'signup.title',
  'signup.sub',
  'signup.churchName',
  'signup.churchNamePh',
  'signup.tradition',
  'signup.traditionOptional',
  'signup.traditionLater',
  'signup.traditionCatholic',
  'signup.traditionEpiscopal',
  'signup.traditionLutheran',
  'signup.traditionAnglican',
  'signup.traditionOther',
  'signup.traditionHelp',
  'signup.yourName',
  'signup.yourNamePh',
  'signup.emailPh',
  'signup.passwordPh',
  'signup.passwordMin',
  'signup.showPassword',
  'signup.hidePassword',
  'signup.submit',
  'signup.submitting',
  'signup.haveAccount',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function optionValues() {
  const select = document.getElementById('signup-tradition')
  return [...select.options].map(o => o.value)
}

const mount = () => render(
  <MemoryRouter>
    <LocaleProvider>
      <Signup />
    </LocaleProvider>
  </MemoryRouter>,
)

beforeEach(() => {
  signup.mockReset()
  signup.mockResolvedValue({ id: 1 })
  localStorage.removeItem('ochr_locale')
})

describe('Signup chrome is translated (OC-READY-01-031)', () => {
  it('ENGLISH LABELS, PLACEHOLDERS, OPTIONS, BUTTONS, AND ARIA USE t() COPY', () => {
    mount()
    expect(screen.getByRole('heading', { name: STRINGS.en['signup.title'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['signup.sub'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['signup.churchName'])).toHaveAttribute(
      'placeholder',
      STRINGS.en['signup.churchNamePh'],
    )
    expect(screen.getByLabelText(STRINGS.en['signup.yourName'])).toHaveAttribute(
      'placeholder',
      STRINGS.en['signup.yourNamePh'],
    )
    expect(screen.getByLabelText(STRINGS.en['login.email'])).toHaveAttribute(
      'placeholder',
      STRINGS.en['signup.emailPh'],
    )
    expect(screen.getByLabelText(STRINGS.en['login.password'])).toHaveAttribute(
      'placeholder',
      STRINGS.en['signup.passwordPh'].replace('{min}', '8'),
    )
    expect(screen.getByRole('button', { name: STRINGS.en['signup.showPassword'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['signup.submit'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['signup.haveAccount'])).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.en['login.signIn'] })).toHaveAttribute('href', '/login')

    const select = screen.getByLabelText(new RegExp(STRINGS.en['signup.tradition']))
    const labels = [...select.options].map(o => o.textContent)
    expect(labels).toEqual([
      STRINGS.en['signup.traditionLater'],
      STRINGS.en['signup.traditionCatholic'],
      STRINGS.en['signup.traditionEpiscopal'],
      STRINGS.en['signup.traditionLutheran'],
      STRINGS.en['signup.traditionAnglican'],
      STRINGS.en['signup.traditionOther'],
    ])
    expect(screen.getByText(STRINGS.en['signup.traditionHelp'])).toBeInTheDocument()
  })

  it('SPANISH SIGNUP CHROME IS SPANISH — NOT THE ENGLISH LABELS', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(screen.getByRole('heading', { name: STRINGS.es['signup.title'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['signup.title'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['signup.sub'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['signup.sub'])).toBeNull()
    expect(screen.getByLabelText(STRINGS.es['signup.churchName'])).toHaveAttribute(
      'placeholder',
      STRINGS.es['signup.churchNamePh'],
    )
    expect(screen.queryByLabelText(STRINGS.en['signup.churchName'])).toBeNull()
    expect(screen.getByLabelText(STRINGS.es['signup.yourName'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.es['login.email'])).toHaveAttribute(
      'placeholder',
      STRINGS.es['signup.emailPh'],
    )
    expect(screen.getByLabelText(STRINGS.es['login.password'])).toHaveAttribute(
      'placeholder',
      STRINGS.es['signup.passwordPh'].replace('{min}', '8'),
    )
    expect(screen.getByRole('button', { name: STRINGS.es['signup.showPassword'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['signup.showPassword'] })).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.es['signup.submit'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['signup.submit'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['signup.haveAccount'])).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.es['login.signIn'] })).toBeInTheDocument()

    const select = screen.getByLabelText(new RegExp(STRINGS.es['signup.tradition']))
    const labels = [...select.options].map(o => o.textContent)
    expect(labels).toEqual([
      STRINGS.es['signup.traditionLater'],
      STRINGS.es['signup.traditionCatholic'],
      STRINGS.es['signup.traditionEpiscopal'],
      STRINGS.es['signup.traditionLutheran'],
      STRINGS.es['signup.traditionAnglican'],
      STRINGS.es['signup.traditionOther'],
    ])
    expect(labels).not.toContain(STRINGS.en['signup.traditionLater'])
    expect(labels).not.toContain(STRINGS.en['signup.traditionOther'])
    expect(screen.getByText(STRINGS.es['signup.traditionHelp'])).toBeInTheDocument()
    expect(screen.queryByText(/Mass or service/)).toBeNull()
  })

  it('tradition option values stay the API tokens in both locales', () => {
    mount()
    expect(optionValues()).toEqual(TRADITION_VALUES)

    fireEvent.click(screen.getByRole('button', { name: /^español$/i }))
    expect(optionValues()).toEqual(TRADITION_VALUES)
    expect([...document.getElementById('signup-tradition').options].map(o => o.textContent)).toEqual([
      STRINGS.es['signup.traditionLater'],
      STRINGS.es['signup.traditionCatholic'],
      STRINGS.es['signup.traditionEpiscopal'],
      STRINGS.es['signup.traditionLutheran'],
      STRINGS.es['signup.traditionAnglican'],
      STRINGS.es['signup.traditionOther'],
    ])
  })

  it('submit still posts the same payload shape and tradition tokens', async () => {
    mount()
    fireEvent.change(screen.getByLabelText(STRINGS.en['signup.churchName']), {
      target: { value: '  St Test  ' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['signup.yourName']), {
      target: { value: '  Secretary  ' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.email']), {
      target: { value: '  secretary@example.com  ' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.password']), {
      target: { value: 'password1' },
    })
    fireEvent.change(screen.getByLabelText(new RegExp(STRINGS.en['signup.tradition'])), {
      target: { value: 'lutheran' },
    })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['signup.submit'] }))
    await waitFor(() => {
      expect(signup).toHaveBeenCalledWith({
        organizationName: 'St Test',
        name: 'Secretary',
        email: 'secretary@example.com',
        password: 'password1',
        tradition: 'lutheran',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    })
  })

  it('empty tradition still omits the field — unset means general server-side', async () => {
    mount()
    fireEvent.change(screen.getByLabelText(STRINGS.en['signup.churchName']), {
      target: { value: 'St Test' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['signup.yourName']), {
      target: { value: 'Secretary' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.email']), {
      target: { value: 'secretary@example.com' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.password']), {
      target: { value: 'password1' },
    })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['signup.submit'] }))
    await waitFor(() => {
      expect(signup).toHaveBeenCalledWith({
        organizationName: 'St Test',
        name: 'Secretary',
        email: 'secretary@example.com',
        password: 'password1',
        tradition: undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    })
  })

  // CI runs this file again with TZ=Pacific/Auckland. A client that
  // always sends 'UTC' stays green in the default UTC job and fails here.
  it('sends the runtime zone rather than a fixed UTC', async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    mount()
    fireEvent.change(screen.getByLabelText(STRINGS.en['signup.churchName']), {
      target: { value: 'St Test' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['signup.yourName']), {
      target: { value: 'Secretary' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.email']), {
      target: { value: 'secretary@example.com' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.password']), {
      target: { value: 'password1' },
    })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['signup.submit'] }))
    await waitFor(() => expect(signup).toHaveBeenCalled())
    expect(signup.mock.calls.at(-1)[0].timezone).toBe(zone)
    if ((process.env.TZ || 'UTC') !== 'UTC') {
      expect(signup.mock.calls.at(-1)[0].timezone).not.toBe('UTC')
    }
  })

  it('a timezone lookup that throws omits the field', async () => {
    mount()
    fireEvent.change(screen.getByLabelText(STRINGS.en['signup.churchName']), {
      target: { value: 'St Test' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['signup.yourName']), {
      target: { value: 'Secretary' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.email']), {
      target: { value: 'secretary@example.com' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.password']), {
      target: { value: 'password1' },
    })
    const Original = Intl.DateTimeFormat
    Intl.DateTimeFormat = function DateTimeFormat() {
      throw new Error('no zone')
    }
    try {
      fireEvent.click(screen.getByRole('button', { name: STRINGS.en['signup.submit'] }))
      await waitFor(() => expect(signup).toHaveBeenCalled())
      expect(signup.mock.calls.at(-1)[0].timezone).toBeUndefined()
    } finally {
      Intl.DateTimeFormat = Original
    }
  })

  it('short-password error uses the locale string, not a hard-EN template', () => {
    mount()
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.password']), {
      target: { value: 'short' },
    })
    // Native required/minLength would stop a click; submit the form so the
    // JS length check (the localized chrome) is the path under test.
    fireEvent.submit(document.querySelector('form'))
    expect(screen.getByText(STRINGS.en['signup.passwordMin'].replace('{min}', '8'))).toBeInTheDocument()
    expect(signup).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^español$/i }))
    fireEvent.change(screen.getByLabelText(STRINGS.es['login.password']), {
      target: { value: 'short' },
    })
    fireEvent.submit(document.querySelector('form'))
    expect(screen.getByText(STRINGS.es['signup.passwordMin'].replace('{min}', '8'))).toBeInTheDocument()
    expect(screen.queryByText(/Password must be at least/)).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(SIGNUP_SRC)
    for (const key of SIGNUP_KEYS) {
      expect(SIGNUP_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      // "Episcopal" is the same loanword in both locales; every other
      // Signup string must actually differ so an en-copied es table fails.
      if (key !== 'signup.traditionEpiscopal') {
        expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
      }
    }
    expect(SIGNUP_SRC).toMatch(/t\('login\.email'\)/)
    expect(SIGNUP_SRC).toMatch(/t\('login\.password'\)/)
    expect(SIGNUP_SRC).toMatch(/t\('login\.signIn'\)/)
    expect(SIGNUP_SRC).toMatch(/useLocale\(/)
    expect(SIGNUP_SRC).toMatch(/<option value="">\{t\('signup\.traditionLater'\)\}<\/option>/)
    expect(SIGNUP_SRC).toMatch(/<option value="catholic">\{t\('signup\.traditionCatholic'\)\}<\/option>/)
    expect(SIGNUP_SRC).toMatch(/<option value="episcopal">\{t\('signup\.traditionEpiscopal'\)\}<\/option>/)
    expect(SIGNUP_SRC).toMatch(/<option value="lutheran">\{t\('signup\.traditionLutheran'\)\}<\/option>/)
    expect(SIGNUP_SRC).toMatch(/<option value="anglican">\{t\('signup\.traditionAnglican'\)\}<\/option>/)
    expect(SIGNUP_SRC).toMatch(/<option value="general">\{t\('signup\.traditionOther'\)\}<\/option>/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['signup.churchName']).toBe('Church name')
    expect(STRINGS.en['signup.yourName']).toBe('Your name')
    expect(STRINGS.es['signup.churchName']).toMatch(/iglesia/i)
    expect(STRINGS.es['signup.yourName']).toMatch(/nombre/i)
    expect(STRINGS.es['signup.submit']).toMatch(/iniciar sesión/i)
  })

  it('a visible password error exposes the message with role=alert', () => {
    mount()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.password']), {
      target: { value: 'short' },
    })
    fireEvent.submit(document.querySelector('form'))
    const message = STRINGS.en['signup.passwordMin'].replace('{min}', '8')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(message)
    expect(alert).toHaveAttribute('role', 'alert')
    expect(signup).not.toHaveBeenCalled()
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
