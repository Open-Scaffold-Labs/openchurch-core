// App.jsx sign-in / sign-up chrome goes through the thin local strings
// map + t(). Hard-coded English is the remaining Login/Signup door after
// ConfirmProvider (#123) and FirstUse (#124). Restoring those literals
// in the JSX goes red. NAV labels and the demonstration band stay as-is.
//
// Diocese has no LocaleProvider. Device override (ochr_locale) is the
// only locale term — do not mount parish LocaleProvider here.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { STRINGS } from './i18n/strings'
import App, { Login, Signup, NotADiocese } from './App'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'App.jsx'), 'utf8')

const AUTH_KEYS = [
  'auth.tagline',
  'auth.email',
  'auth.password',
  'auth.signIn',
  'auth.signingIn',
  'auth.loginBlurb',
  'auth.noAccount',
  'auth.setUp',
  'auth.signInFailed',
  'auth.signupTagline',
  'auth.diocese',
  'auth.yourName',
  'auth.diocesePlaceholder',
  'auth.passwordHint',
  'auth.confirmPassword',
  'auth.mismatch',
  'auth.settingUp',
  'auth.createAccount',
  'auth.signupBlurb',
  'auth.alreadySetUp',
  'auth.signupFailed',
  'auth.wrongDoorTitle',
  'auth.wrongDoorBody',
  'auth.signOut',
]

const HARD_EN = [
  'Email',
  'Password',
  'Sign in',
  'Signing in…',
  'Sign in with a diocese account. Parish accounts use the parish app.',
  'The chancery, kept well.',
  'No chancery account yet?',
  'Set one up',
  'Sign-in failed',
  'Set up the chancery.',
  'Your name',
  'Diocese of Oakland',
  'At least 8 characters.',
  'Confirm password',
  'These do not match.',
  'Setting up…',
  'Create the chancery account',
  'This creates a diocese account. Parishes sign up in the parish app, then accept your invitation — you never create accounts on their behalf.',
  'Already set up?',
  'Could not create the account',
  'This is the chancery door',
  'Your account belongs to a parish, so OpenDiocese has nothing to show it. The parish app is where your work lives — including the Diocese panel in Settings.',
  'Sign out',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('Login chrome is translated (thin local en+es)', () => {
  it('ENGLISH LOGIN USES t() COPY', () => {
    render(<Login onLogin={() => {}} onWantSignup={() => {}} />)
    expect(screen.getByText(STRINGS.en['auth.tagline'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['auth.email'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['auth.password'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['auth.signIn'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['auth.loginBlurb'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['auth.noAccount'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['auth.setUp'] })).toBeInTheDocument()
  })

  it('SPANISH LOGIN IS SPANISH — NOT THE ENGLISH CHROME', () => {
    localStorage.setItem('ochr_locale', 'es')
    render(<Login onLogin={() => {}} onWantSignup={() => {}} />)
    expect(screen.getByText(STRINGS.es['auth.tagline'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.es['auth.email'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.es['auth.password'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['auth.signIn'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['auth.loginBlurb'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['auth.noAccount'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['auth.setUp'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['auth.tagline'])).toBeNull()
    expect(screen.queryByLabelText(STRINGS.en['auth.email'])).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['auth.signIn'] })).toBeNull()
    expect(screen.queryByText(STRINGS.en['auth.loginBlurb'])).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['auth.setUp'] })).toBeNull()
  })
})

describe('Signup chrome is translated (thin local en+es)', () => {
  it('ENGLISH SIGNUP USES t() COPY', () => {
    render(<Signup onLogin={() => {}} onCancel={() => {}} />)
    expect(screen.getByText(STRINGS.en['auth.signupTagline'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['auth.diocese'])).toHaveAttribute(
      'placeholder',
      STRINGS.en['auth.diocesePlaceholder'],
    )
    expect(screen.getByLabelText(STRINGS.en['auth.yourName'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['auth.email'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['auth.password'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['auth.passwordHint'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['auth.confirmPassword'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['auth.createAccount'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['auth.signupBlurb'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['auth.alreadySetUp'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['auth.signIn'] })).toBeInTheDocument()
  })

  it('SPANISH SIGNUP IS SPANISH — NOT THE ENGLISH CHROME', () => {
    localStorage.setItem('ochr_locale', 'es')
    render(<Signup onLogin={() => {}} onCancel={() => {}} />)
    expect(screen.getByText(STRINGS.es['auth.signupTagline'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.es['auth.diocese'])).toHaveAttribute(
      'placeholder',
      STRINGS.es['auth.diocesePlaceholder'],
    )
    expect(screen.getByLabelText(STRINGS.es['auth.yourName'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.es['auth.email'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['auth.createAccount'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['auth.signupBlurb'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['auth.signIn'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['auth.signupTagline'])).toBeNull()
    expect(screen.queryByLabelText(STRINGS.en['auth.diocese'])).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['auth.createAccount'] })).toBeNull()
    expect(screen.queryByText(STRINGS.en['auth.signupBlurb'])).toBeNull()
  })

  it('mismatch hint still uses t() copy — no behavior change', () => {
    render(<Signup onLogin={() => {}} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText(STRINGS.en['auth.password']), {
      target: { value: 'abcdefgh' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['auth.confirmPassword']), {
      target: { value: 'abcdxxxx' },
    })
    expect(screen.getByText(STRINGS.en['auth.mismatch'])).toBeInTheDocument()
  })
})

describe('Wrong-door chrome is translated (thin local en+es)', () => {
  it('ENGLISH WRONG-DOOR USES t() COPY', () => {
    render(<NotADiocese onLogout={() => {}} />)
    expect(screen.getByRole('heading', { name: STRINGS.en['auth.wrongDoorTitle'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['auth.wrongDoorBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['auth.signOut'] })).toBeInTheDocument()
  })

  it('SPANISH WRONG-DOOR IS SPANISH — NOT THE ENGLISH CHROME', () => {
    localStorage.setItem('ochr_locale', 'es')
    render(<NotADiocese onLogout={() => {}} />)
    expect(screen.getByRole('heading', { name: STRINGS.es['auth.wrongDoorTitle'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['auth.wrongDoorBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['auth.signOut'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['auth.wrongDoorTitle'] })).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['auth.signOut'] })).toBeNull()
  })
})

describe('App login door mounts without a LocaleProvider', () => {
  it('failed boot still shows Login chrome through t()', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })))
    render(<App />)
    expect(await screen.findByRole('button', { name: STRINGS.en['auth.signIn'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['auth.loginBlurb'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['auth.setUp'] }))
    expect(screen.getByText(STRINGS.en['auth.signupTagline'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['auth.signupBlurb'])).toBeInTheDocument()
  })
})

describe('i18n strings and App.jsx wiring cannot reintroduce hard-EN auth chrome', () => {
  it('every auth key is wired through t() and exists in both locales', () => {
    const jsx = stripComments(SRC)
    expect(SRC).toMatch(/function t\(/)
    expect(jsx).not.toMatch(/useLocale\s*\(/)
    expect(jsx).not.toMatch(/LocaleProvider/)
    expect(jsx).not.toMatch(/from\s+['"][^'"]*\/i18n['"]/)
    for (const key of AUTH_KEYS) {
      expect(SRC, `App.jsx must call t('${key}')`).toMatch(
        new RegExp(`t\\('${key.replace(/\./g, '\\.')}'\\)`),
      )
      expect(STRINGS.en[key], `en missing ${key}`).toBeTruthy()
      expect(STRINGS.es[key], `es missing ${key}`).toBeTruthy()
      expect(STRINGS.es[key], `${key} es must differ from en`).not.toBe(STRINGS.en[key])
    }
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toMatch(
        new RegExp(`['"\`]${escapeRe(phrase)}['"\`]`),
      )
    }
    expect(STRINGS.en['auth.email']).toBe('Email')
    expect(STRINGS.en['auth.password']).toBe('Password')
    expect(STRINGS.en['auth.signIn']).toBe('Sign in')
    expect(STRINGS.en['auth.signingIn']).toBe('Signing in…')
    expect(STRINGS.en['auth.loginBlurb']).toMatch(/diocese account/)
    expect(STRINGS.es['auth.email']).toMatch(/correo electrónico/i)
    expect(STRINGS.es['auth.password']).toMatch(/contraseña/i)
    expect(STRINGS.es['auth.signIn']).toMatch(/iniciar sesión/i)
    expect(STRINGS.es['auth.signingIn']).toMatch(/iniciando sesión/i)
    expect(STRINGS.es['auth.loginBlurb']).toMatch(/diócesis/i)
    expect(STRINGS.es['auth.loginBlurb']).not.toMatch(/Sign in with a diocese account/)
  })
})
