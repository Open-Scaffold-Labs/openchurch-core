// Gated helper coverage — this module is allowed to hold demo credentials
// because Login.jsx only mounts it behind DEV + VITE_ENABLE_DEMO_LOGIN.

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import LoginDemoShortcut from './loginDemo'
import { DEMO_EMAIL, DEMO_PASSWORD } from './loginDemo'

const { login } = vi.hoisted(() => ({ login: vi.fn() }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    token: null,
    loading: false,
    login,
  }),
}))

const props = () => ({
  loading: false,
  setLoading: vi.fn(),
  setError: vi.fn(),
  setEmail: vi.fn(),
  setPassword: vi.fn(),
})

const mount = (over = {}) => {
  const p = { ...props(), ...over }
  render(
    <MemoryRouter>
      <LocaleProvider>
        <LoginDemoShortcut {...p} />
      </LocaleProvider>
    </MemoryRouter>
  )
  return p
}

beforeEach(() => {
  login.mockReset()
  login.mockResolvedValue({ id: 1 })
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('LoginDemoShortcut', () => {
  it('renders English copy and submits the seeded demo credentials', async () => {
    const p = mount()
    expect(screen.getByRole('button', { name: /use demo account/i })).toBeInTheDocument()
    expect(screen.getByText(/demo only/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /use demo account/i }))
    expect(p.setEmail).toHaveBeenCalledWith(DEMO_EMAIL)
    expect(p.setPassword).toHaveBeenCalledWith(DEMO_PASSWORD)
    await waitFor(() => {
      expect(login).toHaveBeenCalledWith(DEMO_EMAIL, DEMO_PASSWORD)
    })
  })

  it('renders Spanish copy when the device locale is es', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(screen.getByRole('button', { name: /usar cuenta de demostración/i })).toBeInTheDocument()
    expect(screen.getByText(/solo demostración/i)).toBeInTheDocument()
    localStorage.removeItem('ochr_locale')
  })
})
