// A11Y-L0-03 — login/signup thumb targets.
// jsdom does no layout and evaluates no media query, so this pins the
// contract the 390×844 measurement depends on, not a fake 44px box:
//   1. show-password / locale / forgot carry `tap-auth`
//   2. `.tap-auth` is granted 44×44 inside `pointer: coarse`
//   3. show-password is keyboard-activable (no tabIndex=-1)

import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { LocaleProvider } from '../i18n'
import Login from './Login'
import Signup from './Signup'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), signup: vi.fn(), user: null, token: null, loading: false }),
}))

function mountLogin() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <Login />
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function mountSignup() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <Signup />
      </LocaleProvider>
    </MemoryRouter>,
  )
}

describe('A11Y-L0-03 auth tap targets', () => {
  it('login show-password, forgot, and locale carry tap-auth', () => {
    mountLogin()
    const show = screen.getByRole('button', { name: /show password/i })
    expect(show.className).toMatch(/\btap-auth\b/)
    expect(show).not.toHaveAttribute('tabIndex', '-1')
    expect(screen.getByRole('link', { name: /forgot/i }).className).toMatch(/\btap-auth\b/)
    expect(screen.getByRole('button', { name: 'English' }).className).toMatch(/\btap-auth\b/)
    expect(screen.getByRole('button', { name: 'Español' }).className).toMatch(/\btap-auth\b/)
  })

  it('signup show-password and locale carry tap-auth', () => {
    mountSignup()
    expect(screen.getByRole('button', { name: /show password/i }).className).toMatch(/\btap-auth\b/)
    expect(screen.getByRole('button', { name: 'English' }).className).toMatch(/\btap-auth\b/)
    expect(screen.getByRole('button', { name: 'Español' }).className).toMatch(/\btap-auth\b/)
  })

  it('show-password toggles from the keyboard', () => {
    mountLogin()
    const show = screen.getByRole('button', { name: /show password/i })
    fireEvent.click(show)
    expect(screen.getByRole('button', { name: /hide password/i })).toBeInTheDocument()
  })

  it('stylesheet grants tap-auth 44px inside pointer:coarse', async () => {
    const src = await readFile('src/index.css', 'utf8')
    expect(src).toMatch(/@media\s*\(pointer:\s*coarse\)[\s\S]*\.tap-auth\s*\{[\s\S]*min-width:\s*44px[\s\S]*min-height:\s*44px/)
  })
})
