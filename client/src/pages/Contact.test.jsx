// OC-READY-01-007 — public Support/contact page.
// Mutate any of these back and the matching test goes red:
//   1. /contact registered only inside ProtectedLayout (logged-out bounce)
//   2. Login or Signup lose the /contact link
//   3. The page hides the mailto / visible address
//   4. The page grows the admin /support ticket queue

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import Contact, { DEFAULT_PUBLIC_SUPPORT_EMAIL, publicSupportEmail } from './Contact'
import Login from './Login'
import Signup from './Signup'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    token: null,
    loading: false,
    login: vi.fn(),
    signup: vi.fn(),
  }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_SRC = readFileSync(join(HERE, '..', 'App.jsx'), 'utf8')
const ENV_EXAMPLE = readFileSync(join(HERE, '..', '..', '.env.example'), 'utf8')

function publicRoutesSrc() {
  const start = APP_SRC.indexOf('export default function App()')
  const catchAll = APP_SRC.indexOf('path="/*"', start)
  return APP_SRC.slice(start, catchAll)
}

function protectedLayoutSrc() {
  const start = APP_SRC.indexOf('function ProtectedLayout()')
  const end = APP_SRC.indexOf('function RedirectIfAuthed', start)
  return APP_SRC.slice(start, end)
}

const wrap = (node, path = '/contact') => render(
  <MemoryRouter initialEntries={[path]}>
    <LocaleProvider>
      {node}
    </LocaleProvider>
  </MemoryRouter>,
)

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('public /contact route registration', () => {
  it('is a logged-out public route and does not collide with admin /support', () => {
    const publicBlock = publicRoutesSrc()
    const protectedBlock = protectedLayoutSrc()

    expect(publicBlock).toMatch(/path="\/contact"/)
    expect(publicBlock).not.toMatch(/path="\/support"/)
    expect(protectedBlock).toMatch(/path="\/support"/)
    expect(protectedBlock).not.toMatch(/path="\/contact"/)
    expect(ENV_EXAMPLE).toMatch(/VITE_PUBLIC_SUPPORT_EMAIL/)
  })
})

describe('publicSupportEmail', () => {
  it('defaults to support@openscaffoldlabs.com and honours a build-time override', () => {
    expect(DEFAULT_PUBLIC_SUPPORT_EMAIL).toBe('support@openscaffoldlabs.com')
    expect(publicSupportEmail({})).toBe('support@openscaffoldlabs.com')
    expect(publicSupportEmail({ VITE_PUBLIC_SUPPORT_EMAIL: '   ' })).toBe('support@openscaffoldlabs.com')
    expect(publicSupportEmail({ VITE_PUBLIC_SUPPORT_EMAIL: 'parish-ready@example.test' }))
      .toBe('parish-ready@example.test')
  })
})

describe('logged-out /contact page', () => {
  it('is reachable without auth and shows a human mailto, not the ticket queue', () => {
    wrap(
      <Routes>
        <Route path="/login" element={<div>LOGIN_BOUNCE</div>} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/*" element={<Navigate to="/login" replace />} />
      </Routes>,
      '/contact',
    )

    expect(screen.queryByText('LOGIN_BOUNCE')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /write us/i })).toBeInTheDocument()
    expect(screen.getByText(/you do not need an account/i)).toBeInTheDocument()

    const mailtos = screen.getAllByRole('link').filter(a => a.getAttribute('href') === `mailto:${DEFAULT_PUBLIC_SUPPORT_EMAIL}`)
    expect(mailtos.length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(DEFAULT_PUBLIC_SUPPORT_EMAIL).length).toBeGreaterThanOrEqual(1)

    expect(document.body.textContent).not.toMatch(/diagnos/i)
    expect(document.body.textContent).not.toMatch(/severity/i)
    expect(document.body.textContent).not.toMatch(/waiting_on_parish/i)
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument()
  })

  it('keeps EN/ES user-facing copy', () => {
    wrap(<Contact />)
    fireEvent.click(screen.getByRole('button', { name: /^español$/i }))
    expect(screen.getByRole('heading', { name: /escríbanos/i })).toBeInTheDocument()
    expect(screen.getByText(/no necesita una cuenta/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /escribir a support@openscaffoldlabs\.com/i })).toBeInTheDocument()
  })
})

describe('Login and Signup link to /contact', () => {
  it('Login offers the public contact page', () => {
    wrap(<Login />, '/login')
    const link = screen.getByRole('link', { name: /need help\? write us/i })
    expect(link).toHaveAttribute('href', '/contact')
  })

  it('Signup offers the public contact page', () => {
    wrap(<Signup />, '/signup')
    const link = screen.getByRole('link', { name: /need help\? write us/i })
    expect(link).toHaveAttribute('href', '/contact')
  })
})
