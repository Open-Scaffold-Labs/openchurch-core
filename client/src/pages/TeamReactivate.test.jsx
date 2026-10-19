// An admin finds a turned-off login on Team and can turn it back on.
// The row stays visible. The button is named, not only an icon.

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Team from './Team'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token',
    loading: false,
  }),
}))

const ME = { id: 1, name: 'Secretary', email: 'sec@parish.test', role: 'admin', created_at: '2026-01-15T00:00:00Z', deactivated: false }
const OFF = { id: 2, name: 'Ada Staff', email: 'ada@parish.test', role: 'staff', created_at: '2026-02-01T00:00:00Z', deactivated: true }
const OTHER = { id: 3, name: 'Bea Staff', email: 'bea@parish.test', role: 'staff', created_at: '2026-03-01T00:00:00Z', deactivated: true }

function ok(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function stubFetch(users = [ME, OFF], reactivate = { status: 200, error: '' }) {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    calls.push({ u, method })
    if (u.includes('/api/calendar-sync')) return ok({ code: 'no_member_match' }, 404)
    if (u.includes('/reactivate') && method === 'POST') {
      if (reactivate.status >= 400) return ok({ error: reactivate.error }, reactivate.status)
      return ok({ reactivated: true, already: false })
    }
    if (u.includes('/api/users') && method === 'GET') return ok(users)
    return ok({})
  }))
  return calls
}

function mount() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Team />
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  )
}

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.unstubAllGlobals()
})

describe('an admin can find a turned-off login', () => {
  it('shows the status and a named control, and an active login has neither', async () => {
    stubFetch()
    mount()
    expect(await screen.findByText(STRINGS.en['team.loginOff'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['team.turnOnName'].replace('{name}', OFF.name) })).toBeInTheDocument()
    expect(screen.getAllByText(STRINGS.en['team.loginOff'])).toHaveLength(1)
  })

  it('confirm posts reactivate and does not hide the person', async () => {
    const calls = stubFetch()
    mount()
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['team.turnOnName'].replace('{name}', OFF.name) }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(STRINGS.en['team.turnOnTitle'].replace('{name}', OFF.name))
    expect(dialog).toHaveTextContent(STRINGS.en['team.turnOnBody'])
    expect(dialog.textContent.toLowerCase()).toMatch(/sign in again/)
    expect(dialog.textContent.toLowerCase()).not.toMatch(/delet/)
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['team.turnOnConfirm'] }))
    await waitFor(() => {
      expect(calls.some(c => c.method === 'POST' && c.u.includes(`/api/users/${OFF.id}/reactivate`))).toBe(true)
    })
    expect(screen.getByText(OFF.name)).toBeInTheDocument()
  })

  it('a failed restore does not claim the login is still off', async () => {
    const server = 'Internal error while reactivating'
    stubFetch([ME, OFF], { status: 500, error: server })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['team.turnOnName'].replace('{name}', OFF.name) }))
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['team.turnOnConfirm'] }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(STRINGS.en['team.turnOnFailed'])
    expect(alert.textContent).not.toContain(server)
    expect(alert.textContent).not.toMatch(/still off|nothing was changed|unchanged/i)
    expect(screen.queryByText(STRINGS.en['team.loginOff'])).toBeNull()
    expect(screen.getByText(STRINGS.en['team.turnOnUnknownStatus'])).toBeInTheDocument()
    expect(screen.getByText(OFF.name)).toBeInTheDocument()
  })

  it.each(['en', 'es'])('an applied restore whose response is lost does not claim the login state (%s)', async (locale) => {
    if (locale === 'es') localStorage.setItem('ochr_locale', 'es')
    const copy = STRINGS[locale]
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      calls.push({ u, method })
      if (u.includes('/api/calendar-sync')) return ok({ code: 'no_member_match' }, 404)
      if (u.includes('/reactivate') && method === 'POST') throw new TypeError('Failed to fetch')
      if (u.includes('/api/users') && method === 'GET') return ok([ME, OFF])
      return ok({})
    }))
    mount()
    const buttonName = copy['team.turnOnName'].replace('{name}', OFF.name)
    fireEvent.click(await screen.findByRole('button', { name: buttonName }))
    fireEvent.click(await screen.findByRole('button', { name: copy['team.turnOnConfirm'] }))
    const alert = await screen.findByRole('alert')
    expect(calls.some(call => call.method === 'POST' && call.u.includes(`/api/users/${OFF.id}/reactivate`))).toBe(true)
    expect(alert).toHaveTextContent(copy['team.turnOnFailed'])
    expect(alert.textContent).not.toMatch(/still off|nothing was changed|unchanged|sigue apagado|no se cambió nada/i)
    expect(screen.queryByText(copy['team.loginOff'])).toBeNull()
    expect(screen.getByText(copy['team.turnOnUnknownStatus'])).toBeInTheDocument()
    expect(screen.getByText(OFF.name)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: buttonName })).toBeInTheDocument()
  })

  async function confirmRestore(name) {
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['team.turnOnName'].replace('{name}', name) }))
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['team.turnOnConfirm'] }))
  }

  it('a second lost restore leaves the first unknown result in place', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      calls.push({ u, method })
      if (u.includes('/api/calendar-sync')) return ok({ code: 'no_member_match' }, 404)
      if (u.includes('/reactivate') && method === 'POST') throw new TypeError('Failed to fetch')
      if (u.includes('/api/users') && method === 'GET') return ok([ME, OFF, OTHER])
      return ok({})
    }))
    mount()
    await confirmRestore(OFF.name)
    await screen.findByText(STRINGS.en['team.turnOnUnknownStatus'])
    await confirmRestore(OTHER.name)
    await waitFor(() => {
      expect(screen.getAllByText(STRINGS.en['team.turnOnUnknownStatus'])).toHaveLength(2)
    })
    expect(calls.filter(call => call.method === 'POST' && call.u.includes('/reactivate'))).toHaveLength(2)
    expect(screen.queryByText(STRINGS.en['team.loginOff'])).toBeNull()
    expect(screen.getByText(OFF.name)).toBeInTheDocument()
    expect(screen.getByText(OTHER.name)).toBeInTheDocument()
  })

  it('a retry that is still pending keeps the unknown result', async () => {
    let release
    let posts = 0
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      if (u.includes('/api/calendar-sync')) return ok({ code: 'no_member_match' }, 404)
      if (u.includes('/reactivate') && method === 'POST') {
        posts += 1
        if (posts === 1) throw new TypeError('Failed to fetch')
        return new Promise(resolve => { release = resolve })
      }
      if (u.includes('/api/users') && method === 'GET') return ok([ME, OFF])
      return ok({})
    }))
    mount()
    await confirmRestore(OFF.name)
    expect(await screen.findByText(STRINGS.en['team.turnOnUnknownStatus'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['team.loginOff'])).toBeNull()
    await confirmRestore(OFF.name)
    await waitFor(() => expect(posts).toBe(2))
    expect(screen.getByText(STRINGS.en['team.turnOnUnknownStatus'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['team.loginOff'])).toBeNull()
    expect(screen.getByText(OFF.name)).toBeInTheDocument()
    release({ ok: true, status: 200, json: async () => ({ reactivated: true, already: false }) })
    await waitFor(() => expect(screen.queryByText(STRINGS.en['team.turnOnUnknownStatus'])).toBeNull())
  })

  it('one proven restore leaves the other person unknown', async () => {
    const attempts = {}
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      if (u.includes('/api/calendar-sync')) return ok({ code: 'no_member_match' }, 404)
      const match = u.match(/\/api\/users\/(\d+)\/reactivate/)
      if (match && method === 'POST') {
        const id = Number(match[1])
        attempts[id] = (attempts[id] || 0) + 1
        if (attempts[id] === 1) throw new TypeError('Failed to fetch')
        if (id === OFF.id) return ok({ reactivated: true, already: false })
        throw new TypeError('Failed to fetch')
      }
      if (u.includes('/api/users') && method === 'GET') {
        return ok([ME, OFF, OTHER].map(person => (
          person.id === OFF.id && attempts[OFF.id] > 1
            ? { ...person, deactivated: false }
            : person
        )))
      }
      return ok({})
    }))
    mount()
    await confirmRestore(OFF.name)
    await confirmRestore(OTHER.name)
    await waitFor(() => {
      expect(screen.getAllByText(STRINGS.en['team.turnOnUnknownStatus'])).toHaveLength(2)
    })
    await confirmRestore(OFF.name)
    await waitFor(() => {
      expect(screen.getAllByText(STRINGS.en['team.turnOnUnknownStatus'])).toHaveLength(1)
    })
    expect(screen.queryByText(STRINGS.en['team.loginOff'])).toBeNull()
    expect(screen.getByText(OFF.name)).toBeInTheDocument()
    expect(screen.getByText(OTHER.name)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['team.turnOnName'].replace('{name}', OTHER.name) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['team.turnOnName'].replace('{name}', OFF.name) })).toBeNull()
  })

  it('Spanish names the same control', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    mount()
    const name = STRINGS.es['team.turnOnName'].replace('{name}', OFF.name)
    expect(await screen.findByRole('button', { name })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['team.loginOff'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['team.loginOff'])).toBeNull()
  })
})
