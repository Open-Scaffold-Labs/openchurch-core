// A daily checklist must not lie about the day or about who may tick it.
//
// A viewer saw an enabled checkbox (`disabled={!canWrite && false}` is
// always false) and an optimistic tick that the server will refuse.
// A failed routines read became an empty template list, so Manage looked
// like a parish with no checklists.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from './ToastProvider'
import { ConfirmProvider } from './ConfirmProvider'
import DailyChecklists from './DailyChecklists'

const viewer = { id: 2, name: 'Reader', role: 'viewer', organization: { id: 1, name: 'St Test', locale: 'en' } }
const staff = { id: 1, name: 'Secretary', role: 'staff', organization: { id: 1, name: 'St Test', locale: 'en' } }

let role = 'viewer'
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: role === 'staff' ? staff : viewer,
    token: 'test-token',
    loading: false,
  }),
}))

const RUN = {
  id: 9,
  title: 'Sunday opening',
  items: [{ text: 'Unlock the doors', done: false }],
}

const ok = (b, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => b })

const stubFetch = (routes = []) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [match, handler] of routes) if (match(u)) return handler()
  if (u.includes('/api/checklists/today')) return ok({ runs: [RUN] })
  if (u.includes('/api/checklists/templates')) return ok({ templates: [{ id: 3, title: 'Opening', items: ['Doors'] }] })
  return ok({})
}))

const mount = () => render(
  <LocaleProvider><ToastProvider><ConfirmProvider>
    <DailyChecklists />
  </ConfirmProvider></ToastProvider></LocaleProvider>
)

beforeEach(() => { role = 'viewer'; vi.unstubAllGlobals() })

describe('daily checklists', () => {
  it('a viewer cannot tick a box the server will refuse', async () => {
    stubFetch(); mount()
    const box = await screen.findByRole('checkbox', { name: /unlock the doors/i })
    expect(box).toBeDisabled()
    fireEvent.click(box)
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/checklists/runs/'), expect.anything())
  })

  it('a failed routines read is not a parish with no checklists', async () => {
    role = 'staff'
    stubFetch([[u => u.includes('/api/checklists/templates'), () => ok({ error: 'no' }, 500)]])
    mount()
    await screen.findByText(/sunday opening/i)
    fireEvent.click(screen.getByRole('button', { name: /manage checklists/i }))
    expect(await screen.findByText(/did not load/i)).toBeInTheDocument()
    expect(screen.queryByText(/^Opening$/)).not.toBeInTheDocument()
  })

  it('a 200 whose templates are not a list is not an empty parish', async () => {
    role = 'staff'
    stubFetch([[u => u.includes('/api/checklists/templates'), () => ok({ templates: { title: 'Opening' } })]])
    mount()
    await screen.findByText(/sunday opening/i)
    fireEvent.click(screen.getByRole('button', { name: /manage checklists/i }))
    expect(await screen.findByText(/did not load/i)).toBeInTheDocument()
  })

  it('CONTROL — a real empty template list stays quiet', async () => {
    role = 'staff'
    stubFetch([[u => u.includes('/api/checklists/templates'), () => ok({ templates: [] })]])
    mount()
    await screen.findByText(/sunday opening/i)
    fireEvent.click(screen.getByRole('button', { name: /manage checklists/i }))
    await waitFor(() => expect(screen.getByPlaceholderText(/checklist name/i)).toBeInTheDocument())
    expect(screen.queryByText(/did not load/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument()
  })

  it.each([
    ['{}', {}],
    ['{date}', { date: '2026-09-30' }],
    ['{runs:null}', { runs: null }],
    ['{data:[run]}', { data: [RUN] }],
  ])('a today body %s is a failed load, not an empty day', async (_label, body) => {
    stubFetch([[u => u.includes('/api/checklists/today'), () => ok(body)]])
    mount()
    expect(await screen.findByText(/checklists didn.t load/i)).toBeInTheDocument()
    expect(screen.getByText(/daily checklists/i)).toBeInTheDocument()
    expect(screen.queryByText(/no checklists for today/i)).not.toBeInTheDocument()
  })

  it('CONTROL — a real empty day stays hidden for a viewer', async () => {
    stubFetch([[u => u.includes('/api/checklists/today'), () => ok({ runs: [] })]])
    mount()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument())
    expect(screen.queryByText(/daily checklists/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/didn.t load/i)).not.toBeInTheDocument()
  })

  it('a viewer sees loading while today is in flight, not a blank day', async () => {
    let release
    const pending = new Promise(resolve => { release = resolve })
    stubFetch([[u => u.includes('/api/checklists/today'), () => pending.then(() => ok({ runs: [] }))]])
    mount()
    expect(await screen.findByRole('status', { name: /loading/i })).toBeInTheDocument()
    expect(screen.getByText(/daily checklists/i)).toBeInTheDocument()
    expect(screen.queryByText(/no checklists for today/i)).not.toBeInTheDocument()
    await act(async () => { release() })
    await waitFor(() => expect(screen.queryByText(/daily checklists/i)).not.toBeInTheDocument())
  })

  it('manage does not look empty while routines are still loading', async () => {
    role = 'staff'
    let release
    const pending = new Promise(resolve => { release = resolve })
    stubFetch([[u => u.includes('/api/checklists/templates'), () => pending.then(() => ok({ templates: [] }))]])
    mount()
    await screen.findByText(/sunday opening/i)
    fireEvent.click(screen.getByRole('button', { name: /manage checklists/i }))
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument()
    expect(screen.queryByText(/didn.t load/i)).not.toBeInTheDocument()
    await act(async () => { release() })
    await waitFor(() => expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument())
    expect(screen.queryByText(/didn.t load/i)).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText(/checklist name/i)).toBeInTheDocument()
  })

  it('an older empty template list does not wipe a newer list', async () => {
    role = 'staff'
    let releaseOld
    const oldTemplates = new Promise(resolve => { releaseOld = resolve })
    let templateGets = 0
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = String(url)
      const method = (opts && opts.method) || 'GET'
      if (u.includes('/api/checklists/today')) return ok({ runs: [RUN] })
      if (u.includes('/api/checklists/runs/')) return ok({ error: 'no' }, 500)
      if (u.includes('/api/checklists/templates') && method === 'GET') {
        templateGets += 1
        if (templateGets === 1) return oldTemplates.then(() => ok({ templates: [] }))
        return ok({ templates: [{ id: 3, title: 'Opening', items: ['Doors'] }] })
      }
      return ok({})
    }))
    mount()
    const box = await screen.findByRole('checkbox', { name: /unlock the doors/i })
    fireEvent.click(box)
    fireEvent.click(await screen.findByRole('button', { name: /manage checklists/i }))
    expect(await screen.findByText('Opening')).toBeInTheDocument()
    await act(async () => { releaseOld() })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Opening')).toBeInTheDocument()
    expect(screen.queryByText(/didn.t load/i)).not.toBeInTheDocument()
  })
})
