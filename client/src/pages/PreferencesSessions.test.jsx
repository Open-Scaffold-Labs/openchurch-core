// Preferences → Sign out everywhere.
//
// The control must call logoutAll (POST /api/auth/logout-all), then
// land on /login. Cancelling the confirm, or a failed bump, must leave
// the secretary on Preferences and still signed in.

import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { SessionsCard } from './Preferences'

const { logoutAll } = vi.hoisted(() => ({ logoutAll: vi.fn() }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', email: 's@sttest.org', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, logoutAll, replaceToken: vi.fn(), updateUser: vi.fn(),
  }),
}))

const mount = () => render(
  <MemoryRouter initialEntries={['/preferences']}>
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Routes>
            <Route path="/preferences" element={<SessionsCard />} />
            <Route path="/login" element={<div>Login page</div>} />
          </Routes>
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  </MemoryRouter>
)

beforeEach(() => {
  logoutAll.mockReset()
  logoutAll.mockResolvedValue(undefined)
  localStorage.removeItem('ochr_locale')
})

describe('SessionsCard — copy', () => {
  it('renders the English control', () => {
    mount()
    expect(screen.getByRole('heading', { name: /sign out everywhere/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign out everywhere/i })).toBeInTheDocument()
    expect(screen.getByText(/shared computer or kiosk/i)).toBeInTheDocument()
  })

  it('renders the Spanish control', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(screen.getByRole('heading', { name: /cerrar sesión en todas partes/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cerrar sesión en todas partes/i })).toBeInTheDocument()
    expect(screen.getByText(/equipo compartido o un quiosco/i)).toBeInTheDocument()
    localStorage.removeItem('ochr_locale')
  })
})

describe('SessionsCard — confirm then leave', () => {
  it('cancel leaves the page and does not call logoutAll', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /sign out everywhere/i }))
    fireEvent.click(await screen.findByRole('button', { name: /stay signed in/i }))
    expect(logoutAll).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: /sign out everywhere/i })).toBeInTheDocument()
    expect(screen.queryByText('Login page')).not.toBeInTheDocument()
  })

  async function confirmEverywhere() {
    fireEvent.click(screen.getByRole('button', { name: /sign out everywhere/i }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /sign out everywhere/i }))
  }

  it('confirm calls logoutAll and navigates to /login', async () => {
    mount()
    await confirmEverywhere()
    await waitFor(() => expect(logoutAll).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Login page')).toBeInTheDocument()
  })

  it('a failed bump stays on Preferences and says nothing was lost', async () => {
    logoutAll.mockRejectedValueOnce(new Error('Could not sign out everywhere. Please try again.'))
    mount()
    await confirmEverywhere()
    expect(await screen.findByRole('alert')).toHaveTextContent(/still signed in/i)
    expect(screen.queryByText('Login page')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /sign out everywhere/i })).toBeInTheDocument()
  })
})
