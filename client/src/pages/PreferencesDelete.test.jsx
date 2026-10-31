// C3 deletion confirm on Preferences. The words name what is deleted,
// what the parish keeps, and where an exception question goes.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'

const HERE = dirname(fileURLToPath(import.meta.url))
const logout = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 7, name: 'Parish person', role: 'staff', organization: { id: 1, name: 'St Test', locale: 'en' } },
    logout: (...args) => logout(...args),
  }),
}))

function mount(DeleteLoginCard) {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/preferences']}>
            <Routes>
              <Route path="/preferences" element={<DeleteLoginCard />} />
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
  cleanup()
})

describe('deleting a login from Preferences', () => {
  it('sits on Preferences and confirms through the deletion endpoint', () => {
    const src = readFileSync(join(HERE, 'Preferences.jsx'), 'utf8')
    expect(src).toContain('<DeleteLoginCard />')
    expect(src).toContain("apiUrl('/api/auth/deletion-request/confirm')")
    expect(src).toContain('export function DeleteLoginCard')
  })

  it('English and Spanish name what is deleted, what is kept, and the exception address', () => {
    const enHelp = STRINGS.en['prefs.delete.help']
    const enBody = STRINGS.en['prefs.delete.confirmBody']
    const esHelp = STRINGS.es['prefs.delete.help']
    const esBody = STRINGS.es['prefs.delete.confirmBody']
    expect(enHelp).toBeTruthy()
    expect(enBody).toBeTruthy()
    expect(esHelp).toBeTruthy()
    expect(esBody).toBeTruthy()
    expect(enHelp).toMatch(/sessions/i)
    expect(enHelp).toMatch(/push/i)
    expect(enHelp).toMatch(/sacramental register/i)
    expect(enHelp).toMatch(/seven years/i)
    expect(enHelp).toMatch(/not deletion/i)
    expect(enBody).toContain('support@openscaffoldlabs.com')
    expect(esHelp).toMatch(/sesiones/i)
    expect(esHelp).toMatch(/registro sacramental/i)
    expect(esHelp).toMatch(/siete años/i)
    expect(esHelp).toMatch(/no es elimin/i)
    expect(esBody).toContain('support@openscaffoldlabs.com')
    expect(esBody).not.toBe(enBody)
    expect(enHelp).not.toMatch(/register was deleted|ledger was deleted/i)
    expect(esHelp).not.toMatch(/se eliminó el registro|se eliminó el libro/i)
  })

  it('a confirmed deletion signs out, and a last-admin refusal stays', async () => {
    const { DeleteLoginCard } = await import('./Preferences')
    expect(typeof DeleteLoginCard).toBe('function')
    const fetchMock = vi.fn(async (url, opts) => {
      if (String(url).endsWith('/api/auth/deletion-request') && opts?.method === 'POST') {
        return { status: 201, json: async () => ({ personal_login_deleted: false }) }
      }
      const body = JSON.parse(opts.body)
      expect(body.password).toBe('secret-pw')
      return { status: 200, json: async () => ({ personal_login_deleted: true, purge_performed: false }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    mount(DeleteLoginCard)
    fireEvent.change(screen.getByLabelText(STRINGS.en['prefs.delete.password']), { target: { value: 'secret-pw' } })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['prefs.delete.submit'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(STRINGS.en['prefs.delete.confirmBody'])
    fireEvent.click(within(dialog).getByRole('button', { name: STRINGS.en['prefs.delete.confirm'] }))
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Signed out')).toBeInTheDocument()
    cleanup()

    logout.mockClear()
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).endsWith('/api/auth/deletion-request/confirm')) {
        return { status: 409, json: async () => ({ error: 'Cannot delete the only active admin. Transfer administration first.' }) }
      }
      return { status: 201, json: async () => ({ last_active_admin: true }) }
    }))
    mount(DeleteLoginCard)
    fireEvent.change(screen.getByLabelText(STRINGS.es['prefs.delete.password']), { target: { value: 'clave' } })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['prefs.delete.submit'] }))
    const esDialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(esDialog).getByRole('button', { name: STRINGS.es['prefs.delete.confirm'] }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.es['prefs.delete.lastAdmin'])
    expect(alert.textContent).not.toMatch(/Cannot delete the only/)
    expect(logout).not.toHaveBeenCalled()
  })
})
