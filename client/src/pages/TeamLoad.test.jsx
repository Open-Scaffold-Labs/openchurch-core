// A failed team read must not also say the parish has no team.
//
// GET /api/users returns a list. On a 500 the catch set an error and left
// `users` at []. The page then rendered both the error and "No team yet —
// Add your first teammate." A 200 that is not a list crashed on `.map`.

import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
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

const ok = (b, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => b })

const USER = { id: 1, name: 'Secretary', email: 'sec@parish.test', role: 'admin', created_at: '2026-01-15T00:00:00Z' }

const stubFetch = (routes = []) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [match, handler] of routes) if (match(u)) return handler()
  if (u.includes('/api/users')) return ok([USER])
  if (u.includes('/api/calendar-sync')) return ok({ code: 'no_member_match' }, 404)
  return ok({})
}))

const mount = () => render(
  <LocaleProvider><ToastProvider><ConfirmProvider>
    <Team />
  </ConfirmProvider></ToastProvider></LocaleProvider>
)

const NO_TEAM = /no team yet/i
const UNREAD = /couldn't load the team/i

beforeEach(() => vi.unstubAllGlobals())

describe('the team read', () => {
  it('a 500 is not "No team yet"', async () => {
    stubFetch([[u => u.includes('/api/users'), () => ok({ error: 'no' }, 500)]])
    mount()
    expect(await screen.findByText(UNREAD)).toBeInTheDocument()
    expect(screen.queryByText(NO_TEAM)).not.toBeInTheDocument()
  })

  it('a 200 that is not a list is not "No team yet"', async () => {
    stubFetch([[u => u.includes('/api/users'), () => ok({ users: [USER] })]])
    mount()
    expect(await screen.findByText(UNREAD)).toBeInTheDocument()
    expect(screen.queryByText(NO_TEAM)).not.toBeInTheDocument()
    expect(screen.queryByText('Secretary')).not.toBeInTheDocument()
  })

  it('a list of only a null row is not "No team yet" and does not throw', async () => {
    stubFetch([[u => u.includes('/api/users'), () => ok([null])]])
    mount()
    expect(await screen.findByText(UNREAD)).toBeInTheDocument()
    expect(screen.queryByText(NO_TEAM)).not.toBeInTheDocument()
  })

  it('a null row beside a real person is skipped and the person stays', async () => {
    stubFetch([[u => u.includes('/api/users'), () => ok([null, USER])]])
    mount()
    expect(await screen.findByText('Secretary')).toBeInTheDocument()
    expect(screen.queryByText(NO_TEAM)).not.toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('CONTROL — an empty list is "No team yet"', async () => {
    stubFetch([[u => u.includes('/api/users'), () => ok([])]])
    mount()
    expect(await screen.findByText(NO_TEAM)).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('an older [] arriving after a newer list does not replace it', async () => {
    let releaseOld
    const oldList = new Promise(resolve => { releaseOld = resolve })
    let gets = 0
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      const method = (opts && opts.method) || 'GET'
      if (u.includes('/api/calendar-sync')) return ok({ code: 'no_member_match' }, 404)
      if (u.includes('/api/users/') && method === 'PATCH') return ok({ ok: true })
      if (u.includes('/api/users') && method === 'GET') {
        gets += 1
        if (gets === 1) return ok([USER])
        if (gets === 2) return oldList.then(() => ok([]))
        return ok([USER, { id: 2, name: 'Sacristan', email: 's@parish.test', role: 'staff', created_at: '2026-02-01T00:00:00Z' }])
      }
      return ok({})
    }))
    mount()
    expect(await screen.findByText('Secretary')).toBeInTheDocument()
    const role = screen.getByLabelText(/role for secretary/i)
    fireEvent.change(role, { target: { value: 'staff' } })
    fireEvent.change(role, { target: { value: 'admin' } })
    expect(await screen.findByText('Sacristan')).toBeInTheDocument()
    await act(async () => { releaseOld() })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Sacristan')).toBeInTheDocument()
    expect(screen.getByText('Secretary')).toBeInTheDocument()
    expect(screen.queryByText(NO_TEAM)).not.toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('a failed refetch keeps the people already on screen', async () => {
    let gets = 0
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      const method = (opts && opts.method) || 'GET'
      if (u.includes('/api/calendar-sync')) return ok({ code: 'no_member_match' }, 404)
      if (u.includes('/api/users/') && method === 'PATCH') return ok({ ok: true })
      if (u.includes('/api/users') && method === 'GET') {
        gets += 1
        if (gets === 1) return ok([USER])
        return ok({ error: 'no' }, 500)
      }
      return ok({})
    }))
    mount()
    expect(await screen.findByText('Secretary')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/role for secretary/i), { target: { value: 'staff' } })
    expect(await screen.findByText(UNREAD)).toBeInTheDocument()
    expect(screen.getByText('Secretary')).toBeInTheDocument()
    expect(screen.queryByText(NO_TEAM)).not.toBeInTheDocument()
  })
})
