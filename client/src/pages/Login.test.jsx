// OC-READY-01-005 Auth-01 — demo credentials must not ship on the
// production Login path. Mutate DEMO_PASSWORD back into Login.jsx (or
// unset the DEV+flag gate) and the matching test goes red.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import Login from './Login'

const { login } = vi.hoisted(() => ({ login: vi.fn() }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    token: null,
    loading: false,
    login,
  }),
}))

const DEMO_PASSWORD = 'demo1234'
const DEMO_EMAIL = 'demo@openchurch.app'
const REVIEW_MARKERS = [
  'SEED_APP_REVIEW_TENANT',
  'APP_REVIEW_EMAIL',
  'APP_REVIEW_PASSWORD',
  'APP_REVIEW_ORG_NAME',
  'APP_REVIEW_ORG_SLUG',
  'review@openchurch',
  'Use review account',
]
const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_ROOT = join(HERE, '..', '..')

const LOGIN_SRC = readFileSync(join(HERE, 'Login.jsx'), 'utf8')
const MAIN_SRC = readFileSync(join(HERE, '..', 'main.jsx'), 'utf8')
const STRINGS_SRC = readFileSync(join(HERE, '..', 'i18n', 'strings.js'), 'utf8')
const ENV_PRODUCTION = readFileSync(join(CLIENT_ROOT, '.env.production'), 'utf8')
const ENV_EXAMPLE = readFileSync(join(CLIENT_ROOT, '.env.example'), 'utf8')

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const HARD_EN_ARIA = ['About OpenChurch', 'Dismiss']
const LOGIN_ARIA_KEYS = ['login.about', 'login.dismiss']
const LOGIN_EMAIL_PH_KEY = 'login.emailPh'
const HARD_EN_EMAIL_PH = 'you@yourchurch.com'

const mount = (initialEntries) => render(
  <MemoryRouter {...(initialEntries ? { initialEntries } : {})}>
    <LocaleProvider>
      <Login />
    </LocaleProvider>
  </MemoryRouter>
)

const mountWithResetFlash = () => mount([{ pathname: '/', state: { passwordReset: true } }])

beforeEach(() => {
  login.mockReset()
  login.mockResolvedValue({ id: 1 })
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Login production path — no shipped demo password', () => {
  it('Login.jsx does not contain the demo password or email literals', () => {
    expect(LOGIN_SRC).not.toContain(DEMO_PASSWORD)
    expect(LOGIN_SRC).not.toContain(DEMO_EMAIL)
  })

  it('Login.jsx, main.jsx, and production env do not contain App Review credentials', () => {
    for (const marker of REVIEW_MARKERS) {
      expect(LOGIN_SRC, marker).not.toContain(marker)
      expect(MAIN_SRC, marker).not.toContain(marker)
      expect(ENV_PRODUCTION, marker).not.toContain(marker)
    }
  })

  it('shared i18n does not ship login.demo / login.demoNote in EN or ES', () => {
    expect(STRINGS_SRC).not.toMatch(/['"]login\.demo['"]/)
    expect(STRINGS_SRC).not.toMatch(/['"]login\.demoNote['"]/)
    expect(STRINGS_SRC).not.toContain('Use demo account')
    expect(STRINGS_SRC).not.toContain('Usar cuenta de demostración')
    expect(STRINGS_SRC).not.toContain(DEMO_PASSWORD)
  })

  it('a residual helper is only referenced behind DEV + VITE_ENABLE_DEMO_LOGIN', () => {
    expect(LOGIN_SRC).toMatch(/import\.meta\.env\.DEV/)
    expect(LOGIN_SRC).toMatch(/VITE_ENABLE_DEMO_LOGIN/)
    const helperLine = LOGIN_SRC.split('\n').find(l => l.includes("from './loginDemo'"))
    expect(helperLine, 'Login must import the gated helper from ./loginDemo').toBeTruthy()
    const gate = LOGIN_SRC.split('\n').filter(l =>
      l.includes('import.meta.env.DEV') && l.includes('VITE_ENABLE_DEMO_LOGIN')
    )
    expect(gate.length).toBeGreaterThan(0)
  })

  it('production Vite env does not set VITE_ENABLE_DEMO_LOGIN', () => {
    const assigned = ENV_PRODUCTION
      .split('\n')
      .filter(l => !l.trimStart().startsWith('#') && l.includes('VITE_ENABLE_DEMO_LOGIN'))
    expect(assigned).toEqual([])
    expect(ENV_EXAMPLE).toMatch(/VITE_ENABLE_DEMO_LOGIN/)
  })
})

describe('default Login surface (flag unset)', () => {
  it('does not show a Use-demo affordance in English or Spanish', () => {
    mount()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /use demo account/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/demo only/i)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(DEMO_PASSWORD)
    expect(document.body.textContent).not.toContain(DEMO_EMAIL)

    fireEvent.click(screen.getByRole('button', { name: /^español$/i }))
    expect(screen.queryByRole('button', { name: /usar cuenta de demostración/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/solo demostración/i)).not.toBeInTheDocument()
  })
})

describe('gated Login helper (DEV + VITE_ENABLE_DEMO_LOGIN)', () => {
  it('shows the helper and fills the seeded credentials only when the flag is set', async () => {
    vi.stubEnv('VITE_ENABLE_DEMO_LOGIN', 'true')
    mount()

    const demo = screen.getByRole('button', { name: /use demo account/i })
    expect(demo).toBeInTheDocument()
    expect(screen.getByText(/demo only/i)).toBeInTheDocument()

    fireEvent.click(demo)
    await waitFor(() => {
      expect(login).toHaveBeenCalledWith(DEMO_EMAIL, DEMO_PASSWORD)
    })
  })

  it('keeps EN/ES helper copy behind the same gate', () => {
    vi.stubEnv('VITE_ENABLE_DEMO_LOGIN', 'true')
    mount()
    fireEvent.click(screen.getByRole('button', { name: /^español$/i }))
    expect(screen.getByRole('button', { name: /usar cuenta de demostración/i })).toBeInTheDocument()
    expect(screen.getByText(/solo demostración/i)).toBeInTheDocument()
  })
})

describe('production Login bundle', () => {
  it('Vite production lib build of Login drops the demo password', () => {
    // Isolated child process — Vitest sets import.meta.env.DEV true, which
    // would keep the helper in an in-process Vite build and false-green
    // (or false-red) the probe. Production `vite build` is DEV=false.
    const out = execFileSync(
      process.execPath,
      [join(CLIENT_ROOT, 'scripts/login-prod-bundle-probe.mjs')],
      {
        cwd: CLIENT_ROOT,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
      },
    )
    expect(out).toMatch(/PASSWORD_ABSENT/)
    expect(out).not.toMatch(/PASSWORD_PRESENT/)
  }, 20_000)

  // Real `vite build` with the project config into a temp dir (never
  // ./dist), so the result depends only on this tree, not on whatever
  // build happened to be left behind locally. The probe prints only
  // PRESENT/ABSENT and asset names.
  function realBuild(env, args = []) {
    const childEnv = { ...process.env, ...env }
    for (const k of Object.keys(env)) if (env[k] === undefined) delete childEnv[k]
    const out = execFileSync(
      process.execPath,
      [join(CLIENT_ROOT, 'scripts/login-real-build-check.mjs'), ...args],
      { cwd: CLIENT_ROOT, encoding: 'utf8', env: childEnv, timeout: 120_000 },
    )
    expect(out, 'probe found the Login chunk').toMatch(/LOGIN_CHUNK Login-/)
    return out
  }

  it.each([
    ['production', { NODE_ENV: 'production', VITE_ENABLE_DEMO_LOGIN: undefined }],
    // A production build run with a non-production NODE_ENV compiles DEV
    // as true; MODE !== 'production' must still drop the helper.
    ['test', { NODE_ENV: 'test', VITE_ENABLE_DEMO_LOGIN: undefined }],
    ['test + flag set', { NODE_ENV: 'test', VITE_ENABLE_DEMO_LOGIN: 'true' }],
  ])('a fresh production build (NODE_ENV=%s) ships no demo credential or helper', (_n, env) => {
    const out = realBuild(env)
    expect(out).toMatch(/CREDENTIAL_ABSENT/)
    expect(out).toMatch(/HELPER_COPY_ABSENT/)
  }, 150_000)

  it('control: a development-mode build with the flag set keeps the local demo helper', () => {
    const out = realBuild({ NODE_ENV: 'development', VITE_ENABLE_DEMO_LOGIN: 'true' }, ['--mode', 'development'])
    expect(out).toMatch(/CREDENTIAL_PRESENT Login-/)
    expect(out).toMatch(/HELPER_COPY_PRESENT Login-/)
  }, 150_000)

  it('the gate is compile-time: DEV, MODE !== production, dot-accessed flag', () => {
    const gate = LOGIN_SRC.split('\n').find(l => l.includes('VITE_ENABLE_DEMO_LOGIN') && l.includes('?'))
    expect(gate).toMatch(/import\.meta\.env\.DEV &&/)
    expect(gate).toMatch(/import\.meta\.env\.MODE !== 'production'/)
    expect(gate).toMatch(/import\.meta\.env\.VITE_ENABLE_DEMO_LOGIN === 'true'/)
    expect(LOGIN_SRC).not.toMatch(/import\.meta\.env\[/)
  })
})

describe('Login About + Dismiss aria is translated', () => {
  it('ENGLISH ABOUT AND DISMISS USE t() COPY', () => {
    mountWithResetFlash()
    expect(screen.getByRole('region', { name: STRINGS.en['login.about'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['login.dismiss'] })).toBeInTheDocument()
  })

  it('SPANISH ABOUT AND DISMISS ARE SPANISH — NOT THE ENGLISH ARIA', () => {
    localStorage.setItem('ochr_locale', 'es')
    mountWithResetFlash()
    expect(screen.getByRole('region', { name: STRINGS.es['login.about'] })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: STRINGS.en['login.about'] })).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.es['login.dismiss'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['login.dismiss'] })).toBeNull()
  })

  it('dismiss still clears the reset flash — no auth behavior change', () => {
    mountWithResetFlash()
    expect(screen.getByText(STRINGS.en['login.resetFlash'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['login.dismiss'] }))
    expect(screen.queryByText(STRINGS.en['login.resetFlash'])).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.en['login.dismiss'] })).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN aria', () => {
    const jsx = stripComments(LOGIN_SRC)
    for (const key of LOGIN_ARIA_KEYS) {
      expect(LOGIN_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(LOGIN_SRC).toMatch(/useLocale\(/)
    expect(jsx).not.toMatch(/aria-label=["']About OpenChurch["']/)
    expect(jsx).not.toMatch(/aria-label=["']Dismiss["']/)
    for (const phrase of HARD_EN_ARIA) {
      expect(jsx, `JSX must not hard-code aria ${JSON.stringify(phrase)}`).not.toMatch(
        new RegExp(`aria-label=["']${phrase}["']`),
      )
    }
    expect(STRINGS.en['login.about']).toBe('About OpenChurch')
    expect(STRINGS.en['login.dismiss']).toBe('Dismiss')
    expect(STRINGS.es['login.about']).toMatch(/acerca de openchurch/i)
    expect(STRINGS.es['login.dismiss']).toMatch(/cerrar/i)
  })
})

describe('Login page has exactly one h1', () => {
  it('keeps Welcome back as the only h1 and still shows the narthex line in English and Spanish', () => {
    const { unmount } = mount()
    const enH1 = document.querySelectorAll('h1')
    expect(enH1).toHaveLength(1)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(enH1[0]).toHaveTextContent(STRINGS.en['login.welcome'])
    const enTagline = screen.getByText(STRINGS.en['login.h1'])
    expect(enTagline.tagName).toBe('P')
    expect(enTagline.className).toContain('font-display')
    expect(enTagline.className).toContain('text-4xl')
    unmount()

    localStorage.setItem('ochr_locale', 'es')
    mount()
    const esH1 = document.querySelectorAll('h1')
    expect(esH1).toHaveLength(1)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(esH1[0]).toHaveTextContent(STRINGS.es['login.welcome'])
    const esTagline = screen.getByText(STRINGS.es['login.h1'])
    expect(esTagline.tagName).toBe('P')
    expect(esTagline).toHaveTextContent(STRINGS.es['login.h1'])
  })
})

const SERVER_DEACTIVATED_LOGIN = 'This login is deactivated. An admin can turn it back on.'

describe('a turned-off login is explained in the person’s language', () => {
  it('a Spanish login page does not render the English server sentence', async () => {
    localStorage.setItem('ochr_locale', 'es')
    login.mockRejectedValueOnce(new Error(SERVER_DEACTIVATED_LOGIN))
    mount()
    fireEvent.change(screen.getByLabelText(STRINGS.es['login.email']), {
      target: { value: 'person@example.com' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.es['login.password']), {
      target: { value: 'a-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['login.signIn'] }))
    expect(await screen.findByText(STRINGS.es['login.deactivated'])).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(SERVER_DEACTIVATED_LOGIN)
    expect(STRINGS.es['login.deactivated']).not.toMatch(/elimin|borrad|deleted/i)
    expect(STRINGS.en['login.deactivated']).not.toMatch(/deleted/i)
  })
})

describe('closed and held refusals are explained in the person’s language', () => {
  it.each([
    ['This login is closed. It cannot be turned back on.', 'login.closed'],
    ['This organization is on hold. Access is stopped; parish history remains.', 'login.held'],
  ])('es: %s', async (serverSentence, key) => {
    localStorage.setItem('ochr_locale', 'es')
    login.mockRejectedValueOnce(new Error(serverSentence))
    mount()
    fireEvent.change(screen.getByLabelText(STRINGS.es['login.email']), { target: { value: 'person@example.com' } })
    fireEvent.change(screen.getByLabelText(STRINGS.es['login.password']), { target: { value: 'a-password' } })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['login.signIn'] }))
    expect(await screen.findByText(STRINGS.es[key])).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(serverSentence)
  })
})

describe('Login email placeholder is translated', () => {
  it('ENGLISH EMAIL PLACEHOLDER USES t() COPY', () => {
    mount()
    expect(screen.getByLabelText(STRINGS.en['login.email'])).toHaveAttribute(
      'placeholder',
      STRINGS.en[LOGIN_EMAIL_PH_KEY],
    )
  })

  it('SPANISH EMAIL PLACEHOLDER IS SPANISH — NOT THE ENGLISH EXAMPLE', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(screen.getByLabelText(STRINGS.es['login.email'])).toHaveAttribute(
      'placeholder',
      STRINGS.es[LOGIN_EMAIL_PH_KEY],
    )
    expect(screen.getByLabelText(STRINGS.es['login.email'])).not.toHaveAttribute(
      'placeholder',
      STRINGS.en[LOGIN_EMAIL_PH_KEY],
    )
  })

  it('i18n strings and the component wiring cannot reintroduce a hard-EN placeholder', () => {
    const jsx = stripComments(LOGIN_SRC)
    expect(LOGIN_SRC).toMatch(/t\('login\.emailPh'\)/)
    expect(STRINGS.en[LOGIN_EMAIL_PH_KEY]).toBe(HARD_EN_EMAIL_PH)
    expect(STRINGS.es[LOGIN_EMAIL_PH_KEY]).toBeTruthy()
    expect(STRINGS.es[LOGIN_EMAIL_PH_KEY]).not.toBe(STRINGS.en[LOGIN_EMAIL_PH_KEY])
    expect(STRINGS.es[LOGIN_EMAIL_PH_KEY]).toMatch(/usted@suiglesia\.com/i)
    expect(jsx, 'JSX must not hard-code the English email placeholder').not.toContain(
      HARD_EN_EMAIL_PH,
    )
  })
})

describe('Login form error is announced', () => {
  it('a rejected sign-in exposes the message with role=alert', async () => {
    const message = 'Sign-in was not accepted.'
    login.mockRejectedValueOnce(new Error(message))
    mount()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.email']), {
      target: { value: 'secretary@example.com' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['login.password']), {
      target: { value: 'password1' },
    })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['login.signIn'] }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(message)
    expect(alert).toHaveAttribute('role', 'alert')
  })
})
