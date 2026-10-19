// Groups must not turn a bad read into "you have no groups" or a crash.
//
// A 200 whose `groups` is not a list skipped the failure banner
// (`groups.length` is undefined, so it is not 0) and then threw on `.map`.
// A failed connection-request read became `{ interests: [] }`, which the
// page hides — the same shape as a parish with no one waiting.

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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

const NO_GROUPS = /no groups yet/i
const UNREAD = STRINGS.en['load.failedTitle']
const INTERESTS_UNREAD = STRINGS.en['load.failedBody']

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('the groups read', () => {
  it('a 200 that is not a list is not "No groups yet"', async () => {
    stubFetch([[u => u.includes('/api/groups') && !u.includes('/api/groups/'), () => ok({ groups: { name: 'Ushers' } })]])
    mount()
    expect(await screen.findByText(UNREAD)).toBeInTheDocument()
    expect(screen.queryByText(NO_GROUPS)).not.toBeInTheDocument()
  })

  it('a failed connection-request read is not silence', async () => {
    stubFetch([[u => u.includes('/api/connect'), () => ok({ error: 'no' }, 500)]])
    mount()
    expect(await screen.findByText(INTERESTS_UNREAD)).toBeInTheDocument()
    expect(screen.queryByText(/approve/i)).not.toBeInTheDocument()
  })

  it('CONTROL — a real empty list is "No groups yet"', async () => {
    stubFetch([[u => u.includes('/api/groups') && !u.includes('/api/groups/'), () => ok({ groups: [] })]])
    mount()
    expect(await screen.findByText(NO_GROUPS)).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('a rejected fetch is the failure banner, not "No groups yet"', async () => {
    stubFetch([[u => u.includes('/api/groups') && !u.includes('/api/groups/'), () => Promise.reject(new Error('offline'))]])
    mount()
    expect(await screen.findByText(UNREAD)).toBeInTheDocument()
    expect(screen.queryByText(NO_GROUPS)).not.toBeInTheDocument()
  })

  it('a 200 null groups body is not "No groups yet"', async () => {
    stubFetch([[u => u.includes('/api/groups') && !u.includes('/api/groups/'), () => ok(null)]])
    mount()
    expect(await screen.findByText(UNREAD)).toBeInTheDocument()
    expect(screen.queryByText(NO_GROUPS)).not.toBeInTheDocument()
  })

  it('a groups 500 is not "No groups yet"', async () => {
    stubFetch([[u => u.includes('/api/groups') && !u.includes('/api/groups/'), () => ok({ error: 'no' }, 500)]])
    mount()
    expect(await screen.findByText(UNREAD)).toBeInTheDocument()
    expect(screen.queryByText(NO_GROUPS)).not.toBeInTheDocument()
  })

  it.each([
    ['null', null],
    ['{interests:null}', { interests: null }],
    ['{interests:{}}', { interests: { name: 'Pat' } }],
  ])('a 200 interests body %s is not a parish with no one waiting', async (_label, body) => {
    stubFetch([[u => u.includes('/api/connect'), () => ok(body)]])
    mount()
    expect(await screen.findByText(INTERESTS_UNREAD)).toBeInTheDocument()
    expect(screen.getByText('Ushers')).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
    expect(screen.queryByText(NO_GROUPS)).not.toBeInTheDocument()
  })

  it('an older [] arriving after a newer list does not replace it', async () => {
    let releaseOld
    const oldGroups = new Promise(resolve => { releaseOld = resolve })
    let gets = 0
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      const method = (opts && opts.method) || 'GET'
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/connect')) return ok({ interests: [] })
      if (u.includes('/api/groups') && method === 'POST') return ok({ id: 9, name: 'Ushers' })
      if (u.includes('/api/groups') && method === 'GET') {
        gets += 1
        if (gets === 1) return oldGroups.then(() => ok({ groups: [] }))
        return ok({ groups: [GROUP] })
      }
      return ok({})
    }))
    mount()
    await waitFor(() => expect(gets).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: /new group/i }))
    fireEvent.change(screen.getByPlaceholderText(/worship team/i), { target: { value: 'Ushers' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(await screen.findByText('Ushers')).toBeInTheDocument()
    await act(async () => { releaseOld() })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Ushers')).toBeInTheDocument()
    expect(screen.queryByText(NO_GROUPS)).not.toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })
})
