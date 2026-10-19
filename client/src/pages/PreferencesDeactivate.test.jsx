// Self-serve login deactivation lives on Preferences, which every role
// can open. The confirm dialog says the login is turned off and does not
// say the account is deleted. Success clears the session. A last-active
// admin refusal stays on the page and keeps the session.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { DeactivateLoginCard } from './Preferences'

const session = vi.hoisted(() => ({ role: 'viewer' }))
const logout = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 7, name: 'Parish person', role: session.role, organization: { id: 1, name: 'St Test', locale: 'en' } },
    logout: (...args) => logout(...args),
  }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const PREFS = readFileSync(join(HERE, 'Preferences.jsx'), 'utf8')
const APP = readFileSync(join(HERE, '../App.jsx'), 'utf8')

const KEYS = [
  'prefs.deactivate.title',
  'prefs.deactivate.help',
  'prefs.deactivate.submit',
  'prefs.deactivate.confirmTitle',
  'prefs.deactivate.confirmBody',
  'prefs.deactivate.confirm',
  'prefs.deactivate.cancel',
  'prefs.deactivate.saving',
  'prefs.deactivate.failed',
  'prefs.deactivate.lastAdmin',
]

function mount() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/preferences']}>
            <Routes>
              <Route path="/preferences" element={<DeactivateLoginCard />} />
              <Route path="/login" element={<p>Signed out</p>} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  )
}

beforeEach(() => {
  session.role = 'viewer'
  logout.mockClear()
  localStorage.removeItem('ochr_locale')
  vi.unstubAllGlobals()
})

const SERVER_LAST_ADMIN = 'Cannot deactivate the only active admin. Transfer administration first. Closing the organization is a separate step and is not done here.'

async function confirmTurnOff() {
  fireEvent.click(screen.getByRole('button', { name: STRINGS.en['prefs.deactivate.submit'] }))
  fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['prefs.deactivate.confirm'] }))
}

describe('turning a login off from Preferences', () => {
  it('every role can reach Preferences, and the control is on that page', () => {
    const line = APP.split('\n').find(row => row.includes("to: '/preferences'"))
    expect(line).toBeTruthy()
    expect(line).not.toMatch(/adminOnly/)
    expect(PREFS).toMatch(/<DeactivateLoginCard \/>/)
  })

  it('English confirm says the login is turned off and does not say deleted', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['prefs.deactivate.submit'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(STRINGS.en['prefs.deactivate.confirmTitle'])
    expect(dialog).toHaveTextContent(STRINGS.en['prefs.deactivate.confirmBody'])
    expect(dialog.textContent.toLowerCase()).not.toMatch(/delet/)
    expect(fetch).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()
  })

  it('Spanish confirm is Spanish', async () => {
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn())
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['prefs.deactivate.submit'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(STRINGS.es['prefs.deactivate.confirmTitle'])
    expect(dialog).toHaveTextContent(STRINGS.es['prefs.deactivate.confirmBody'])
    expect(screen.queryByRole('heading', { name: STRINGS.en['prefs.deactivate.confirmTitle'] })).toBeNull()
  })

  it('cancel does not call the server or clear the session', async () => {
    vi.stubGlobal('fetch', vi.fn())
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['prefs.deactivate.submit'] }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(dialog.querySelector('button') ? screen.getByRole('button', { name: STRINGS.en['prefs.deactivate.cancel'] }) : null)
    expect(fetch).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()
    expect(screen.queryByText('Signed out')).toBeNull()
  })

  it('success clears the session and leaves the page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ deactivated: true, already: false }),
    })))
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['prefs.deactivate.submit'] }))
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['prefs.deactivate.confirm'] }))
    await waitFor(() => expect(logout).toHaveBeenCalled())
    expect(await screen.findByText('Signed out')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalled()
    const [url, opts] = fetch.mock.calls[0]
    expect(String(url)).toContain('/api/auth/deactivate')
    expect(opts.method).toBe('POST')
  })

  it.each(['staff', 'viewer'])('%s can start turning the login off and is signed out when it succeeds', async (role) => {
    session.role = role
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ deactivated: true, already: false }),
    })))
    mount()
    await confirmTurnOff()
    await waitFor(() => expect(logout).toHaveBeenCalled())
    expect(await screen.findByText('Signed out')).toBeInTheDocument()
    expect(String(fetch.mock.calls[0][0])).toContain('/api/auth/deactivate')
  })

  it('the only active administrator stays signed in, in their language, and the parish is not closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 409, json: async () => ({ error: SERVER_LAST_ADMIN }),
    })))
    mount()
    await confirmTurnOff()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.en['prefs.deactivate.lastAdmin'])
    expect(alert).toHaveTextContent(/transferred/i)
    expect(alert.textContent.toLowerCase()).not.toMatch(/delet/)
    expect(alert.textContent).not.toContain(SERVER_LAST_ADMIN)
    expect(logout).not.toHaveBeenCalled()
    expect(screen.queryByText('Signed out')).toBeNull()
  })

  it('Spanish does not show the English server refusal', async () => {
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 409, json: async () => ({ error: SERVER_LAST_ADMIN }),
    })))
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['prefs.deactivate.submit'] }))
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.es['prefs.deactivate.confirm'] }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.es['prefs.deactivate.lastAdmin'])
    expect(alert.textContent).not.toContain(SERVER_LAST_ADMIN)
    expect(alert.textContent).not.toMatch(/Cannot deactivate/)
    expect(logout).not.toHaveBeenCalled()
  })

  it.each(['en', 'es'])('an applied deactivate whose response is lost does not claim the login state (%s)', async (locale) => {
    if (locale === 'es') localStorage.setItem('ochr_locale', 'es')
    const copy = STRINGS[locale]
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method })
      throw new TypeError('Failed to fetch')
    }))
    mount()
    fireEvent.click(screen.getByRole('button', { name: copy['prefs.deactivate.submit'] }))
    fireEvent.click(await screen.findByRole('button', { name: copy['prefs.deactivate.confirm'] }))
    const alert = await screen.findByRole('alert')
    expect(calls.some(call => call.method === 'POST' && call.url.includes('/api/auth/deactivate'))).toBe(true)
    expect(alert).toHaveTextContent(copy['prefs.deactivate.failed'])
    expect(alert.textContent).not.toMatch(/still on|still off|nothing was changed|unchanged|sigue encendido|sigue apagado|no se cambió nada/i)
    expect(logout).not.toHaveBeenCalled()
    expect(screen.queryByText('Signed out')).toBeNull()
    expect(screen.getByRole('heading', { name: copy['prefs.deactivate.title'] })).toBeInTheDocument()
  })

  it('a rejected session keeps this page and does not claim the login is still on', async () => {
    const server = 'Invalid or expired token'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({ error: server }),
    })))
    mount()
    await confirmTurnOff()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.en['prefs.deactivate.failed'])
    expect(alert.textContent).not.toContain(server)
    expect(alert.textContent).not.toMatch(/still on|nothing was changed|unchanged/i)
    expect(logout).not.toHaveBeenCalled()
    expect(screen.queryByText('Signed out')).toBeNull()
  })

  it('the button says it is working while the request is open', async () => {
    let release
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { release = resolve })))
    mount()
    await confirmTurnOff()
    const working = await screen.findByRole('button', { name: STRINGS.en['prefs.deactivate.saving'] })
    expect(working).toBeDisabled()
    expect(working).toHaveAttribute('aria-busy', 'true')
    release({ ok: true, status: 200, json: async () => ({ deactivated: true }) })
    await waitFor(() => expect(logout).toHaveBeenCalled())
  })

  it('both languages have the copy, and neither says deleted', () => {
    for (const key of KEYS) {
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
      expect(STRINGS.en[key].toLowerCase(), key).not.toMatch(/delet/)
      expect(STRINGS.es[key].toLowerCase(), key).not.toMatch(/elimin/)
    }
    expect(STRINGS.en['prefs.deactivate.failed']).not.toMatch(/still on|still off|nothing was changed|unchanged/i)
    expect(STRINGS.es['prefs.deactivate.failed']).not.toMatch(/sigue encendido|sigue apagado|no se cambió nada/i)
    expect(STRINGS.en['prefs.deactivate.lastAdmin']).toMatch(/stays on/i)
    expect(STRINGS.es['prefs.deactivate.lastAdmin']).toMatch(/sigue encendido/i)
  })
})
