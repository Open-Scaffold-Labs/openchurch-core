// Self-serve permanent closure sits beside turning the login off.
// The confirm dialog says the closure is permanent and does not say
// every copy is gone. Success signs out. A last-admin refusal stays.

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { CloseLoginCard } from './Preferences'

const logout = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 7, name: 'Parish person', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    logout: (...args) => logout(...args),
  }),
}))

function mount() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/preferences']}>
            <Routes>
              <Route path="/preferences" element={<CloseLoginCard />} />
              <Route path="/login" element={<p>Signed out</p>} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  )
}

beforeEach(() => {
  logout.mockClear()
  localStorage.removeItem('ochr_locale')
  vi.unstubAllGlobals()
})

describe('closing a login from Preferences', () => {
  it('English confirm is permanent and does not promise every copy is gone', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['prefs.close.submit'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(STRINGS.en['prefs.close.confirmTitle'])
    expect(dialog).toHaveTextContent(STRINGS.en['prefs.close.confirmBody'])
    expect(STRINGS.en['prefs.close.confirmBody']).toMatch(/cannot be turned back on/i)
    expect(STRINGS.en['prefs.close.confirmBody']).toMatch(/every copy is gone/i)
    expect(STRINGS.en['prefs.close.help']).not.toMatch(/turn the login back on/i)
  })

  it('Spanish confirm is Spanish', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['prefs.close.submit'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(STRINGS.es['prefs.close.confirmTitle'])
    expect(dialog).toHaveTextContent(STRINGS.es['prefs.close.confirmBody'])
    expect(screen.queryByRole('heading', { name: STRINGS.en['prefs.close.confirmTitle'] })).toBeNull()
  })

  it('a closed login signs out, and a last-admin refusal stays with our words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      json: async () => ({ closed: true, all_copies_erased: false }),
    })))
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['prefs.close.submit'] }))
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['prefs.close.confirm'] }))
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Signed out')).toBeInTheDocument()
    cleanup()

    logout.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 409,
      json: async () => ({ error: 'Cannot close the only active admin. Transfer administration first.' }),
    })))
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['prefs.close.submit'] }))
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['prefs.close.confirm'] }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.en['prefs.close.lastAdmin'])
    expect(alert.textContent).not.toMatch(/Cannot close the only/)
    expect(logout).not.toHaveBeenCalled()
  })
})
