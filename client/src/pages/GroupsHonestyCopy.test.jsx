// A Spanish session must hear the groups and connection-request failures
// in Spanish. Those notes used to be hard-coded English, so a failed
// load and an empty parish were distinguished — and then said in the
// wrong language. Failed is still not empty.

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Groups from './Groups'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token',
    loading: false,
  }),
}))

const es = STRINGS.es
const en = STRINGS.en

const ok = (b, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => b })

const GROUP = { id: 4, name: 'Ushers', category: 'ministry', member_count: 2, members: [] }

const stubFetch = (routes = []) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [match, handler] of routes) if (match(u)) return handler()
  if (u.includes('/api/groups')) return ok({ groups: [GROUP] })
  if (u.includes('/api/clients')) return ok([])
  if (u.includes('/api/connect')) return ok({ interests: [] })
  return ok({})
}))

const mount = () => render(
  <MemoryRouter>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Groups />
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  localStorage.setItem('ochr_locale', 'es')
})

describe('groups honesty copy in Spanish', () => {
  it('a refused groups read is the Spanish failure, not an empty parish', async () => {
    stubFetch([[u => u.includes('/api/groups') && !u.includes('/api/groups/'), () => ok({ error: 'no' }, 500)]])
    mount()
    const panel = await screen.findByRole('status')
    expect(panel).toHaveTextContent(es['load.failedTitle'])
    expect(panel).toHaveTextContent(es['load.failedBody'])
    expect(screen.getByRole('button', { name: es['error.tryAgain'] })).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en['error.tryAgain'] })).not.toBeInTheDocument()
    expect(screen.queryByText(/no groups yet/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/couldn't load your groups/i)).not.toBeInTheDocument()
  })

  it('a refused connection-request read is Spanish, and the groups that loaded stay', async () => {
    stubFetch([[u => u.includes('/api/connect'), () => ok({ error: 'no' }, 500)]])
    mount()
    const note = await screen.findByRole('status')
    expect(note).toHaveTextContent(es['load.failedBody'])
    expect(note).not.toHaveTextContent(en['load.failedBody'])
    expect(screen.getByText('Ushers')).toBeInTheDocument()
    expect(screen.queryByText(es['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.queryByText(/connection requests didn't load/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/no groups yet/i)).not.toBeInTheDocument()
  })

  it('a thrown groups read toasts in Spanish and still is not an empty parish', async () => {
    stubFetch([[u => u.includes('/api/groups') && !u.includes('/api/groups/'), () => Promise.reject(new Error('offline'))]])
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent(es['err.load'])
    expect(screen.getByRole('status')).toHaveTextContent(es['load.failedTitle'])
    expect(screen.queryByText(en['err.load'])).not.toBeInTheDocument()
    expect(screen.queryByText(/couldn't load groups/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/no groups yet/i)).not.toBeInTheDocument()
  })

  it('CONTROL — a real empty list is still empty, not the Spanish failure', async () => {
    stubFetch([[u => u.includes('/api/groups') && !u.includes('/api/groups/'), () => ok({ groups: [] })]])
    mount()
    expect(await screen.findByText(/no groups yet/i)).toBeInTheDocument()
    expect(screen.queryByText(es['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
