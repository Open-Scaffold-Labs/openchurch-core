// D-2, D-5, D-6 on the intention book.
// Red on main: there is no This Sunday control, the picker does not ask
// to hide inactive members, and phone Delete issues DELETE immediately.
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { render, screen, within, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions, { readThisSundayWindow } from './MassIntentions'

const authState = vi.hoisted(() => ({ canWrite: true, role: 'admin' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: authState.role, organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic', timezone: 'America/Los_Angeles' } },
    token: 't', loading: false, canWrite: authState.canWrite, isAdmin: authState.role === 'admin',
  }),
}))

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const SUN = { id: 41, intention: 'For this Sunday', requested_by: 'Synthetic Family', mass_date: '2026-10-04', status: 'scheduled', stipend: null }
const OTHER = { id: 42, intention: 'For a weekday', requested_by: 'Synthetic Family', mass_date: '2026-10-06', status: 'scheduled', stipend: null }
const OPEN = { id: 43, intention: 'For a safe journey', requested_by: 'Synthetic Family', mass_date: '2026-10-08', status: 'open', stipend: null }
const { en, es } = STRINGS

let calls
function stubMatchMedia(matches) {
  vi.stubGlobal('matchMedia', vi.fn(q => ({
    matches: q === '(max-width: 767px)' ? matches : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })))
}
function stubBook() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url)
    calls.push({ u, init })
    if (/\/api\/mass-intentions\/\d+$/.test(u) && init.method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) }
    if (u.includes('/api/clients/picker?')) {
      const show = u.includes('include_inactive=1')
      const rows = [{ id: 7, name: 'Synthetic Active', status: 'active' }]
      if (show) rows.push({ id: 8, name: 'Synthetic Inactive', status: 'inactive' })
      return ok(rows)
    }
    if (u.includes('/api/mass-intentions?')) {
      const params = new URL(u, 'http://x').searchParams
      if (params.get('weekend') === 'this_sunday') {
        return ok({ intentions: [SUN], weekend: { saturday: '2026-10-03', sunday: '2026-10-04' } })
      }
      return ok({ intentions: [SUN, OTHER] })
    }
    return ok([])
  }))
}
const book = () => render(
  <MemoryRouter initialEntries={['/mass-intentions']}>
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Routes><Route path="/mass-intentions" element={<MassIntentions />} /></Routes>
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  </MemoryRouter>,
)
const deletes = () => calls.filter(c => c.init.method === 'DELETE')

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  authState.canWrite = true
  authState.role = 'admin'
})
afterEach(() => vi.unstubAllGlobals())

describe('D-2 This Sunday filter', () => {
  it('asks the server for the vigil weekend and links to the weekly sheet', async () => {
    stubBook()
    book()
    expect(await screen.findByText('For a weekday')).toBeInTheDocument()
    expect(screen.queryByTestId('mi-this-sunday-sheet')).not.toBeInTheDocument()
    expect(calls.some(c => c.u.includes('weekend=this_sunday'))).toBe(false)
    fireEvent.click(screen.getByTestId('mi-this-sunday'))
    expect(await screen.findByText('For this Sunday')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('For a weekday')).not.toBeInTheDocument())
    expect(calls.some(c => c.u.includes('weekend=this_sunday'))).toBe(true)
    expect(screen.getByTestId('mi-this-sunday-sheet').getAttribute('href')).toBe('/mass-intentions/print?start=2026-10-03')
    expect(screen.getByTestId('mi-this-sunday-dates').textContent).toMatch(/Oct/)
    expect(screen.getByTestId('mi-this-sunday-dates').textContent).toMatch(/3/)
    expect(screen.getByTestId('mi-this-sunday-dates').textContent).toMatch(/4/)
  })

  it('a valid empty weekend names that weekend and opens its sheet', async () => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      calls.push({ u, init: {} })
      if (!u.includes('/api/mass-intentions?')) return ok([])
      const params = new URL(u, 'http://x').searchParams
      if (params.get('weekend') === 'this_sunday') {
        return ok({ intentions: [], weekend: { saturday: '2026-10-03', sunday: '2026-10-04' } })
      }
      return ok({ intentions: [OTHER] })
    }))
    book()
    expect(await screen.findByText('For a weekday')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mi-this-sunday'))
    expect(await screen.findByRole('heading', { name: en['mi.thisSundayEmptyTitle'] })).toBeInTheDocument()
    expect(screen.getByText(en['mi.thisSundayEmptyBody'])).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: en['mi.emptyTitle'] })).not.toBeInTheDocument()
    expect(screen.queryByText(en['mi.loadFailed'])).not.toBeInTheDocument()
    expect(screen.getByTestId('mi-this-sunday-dates').textContent).toMatch(/Oct/)
    expect(screen.getByTestId('mi-this-sunday-sheet').getAttribute('href')).toBe('/mass-intentions/print?start=2026-10-03')
  })

  it('a missing or unusable weekend is unread, not an empty or invented window', async () => {
    const bad = [
      undefined,
      null,
      { saturday: 'soon', sunday: '2026-10-04' },
      { saturday: '2026-02-30', sunday: '2026-03-01' },
      { saturday: '2026-10-04', sunday: '2026-10-03' },
      { saturday: '2026-10-03', sunday: '2026-10-05' },
      { saturday: '2026-10-02', sunday: '2026-10-03' },
    ]
    for (const weekend of bad) {
      cleanup()
      calls = []
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        const u = String(url)
        calls.push({ u, init: {} })
        if (!u.includes('/api/mass-intentions?')) return ok([])
        const params = new URL(u, 'http://x').searchParams
        if (params.get('weekend') === 'this_sunday') return ok({ intentions: [SUN], weekend })
        return ok({ intentions: [OTHER] })
      }))
      book()
      expect(await screen.findByText('For a weekday')).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('mi-this-sunday'))
      expect(await screen.findByText(en['mi.loadFailed'])).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: en['mi.thisSundayEmptyTitle'] })).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: en['mi.emptyTitle'] })).not.toBeInTheDocument()
      expect(screen.queryByTestId('mi-this-sunday-dates')).not.toBeInTheDocument()
      expect(screen.queryByTestId('mi-this-sunday-sheet')).not.toBeInTheDocument()
      expect(screen.queryByText('For this Sunday')).not.toBeInTheDocument()
      expect(screen.queryByText('For a weekday')).not.toBeInTheDocument()
    }
  })

  it('ignores weekend metadata when This Sunday is off', async () => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      calls.push({ u, init: {} })
      if (!u.includes('/api/mass-intentions?')) return ok([])
      return ok({ intentions: [OTHER], weekend: { saturday: 'soon', sunday: '2026-02-30' } })
    }))
    book()
    expect(await screen.findByText('For a weekday')).toBeInTheDocument()
    expect(screen.queryByText(en['mi.loadFailed'])).not.toBeInTheDocument()
    expect(screen.queryByTestId('mi-this-sunday-dates')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mi-this-sunday-sheet')).not.toBeInTheDocument()
  })

  it('does not append a later page from another weekend, and the sheet stays on the accepted one', async () => {
    const oldWeekend = { saturday: '2026-10-17', sunday: '2026-10-18' }
    const nextWeekend = { saturday: '2026-10-24', sunday: '2026-10-25' }
    const oldRows = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, intention: `Old vigil ${i}`, requested_by: 'Synthetic Family', mass_date: '2026-10-18', status: 'scheduled', stipend: null,
    }))
    let sundayReads = 0
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      calls.push({ u, init: {} })
      if (!u.includes('/api/mass-intentions?')) return ok([])
      const params = new URL(u, 'http://x').searchParams
      if (params.get('weekend') !== 'this_sunday') return ok({ intentions: [OTHER] })
      sundayReads += 1
      if (sundayReads === 1) return ok({ intentions: oldRows, weekend: oldWeekend })
      return ok({ intentions: [{ id: 900, intention: 'Next weekend row', requested_by: 'Synthetic Family', mass_date: '2026-10-25', status: 'scheduled', stipend: null }], weekend: nextWeekend })
    }))
    book()
    fireEvent.click(screen.getByTestId('mi-this-sunday'))
    expect(await screen.findByText('Old vigil 0')).toBeInTheDocument()
    expect(screen.getByTestId('mi-this-sunday-sheet').getAttribute('href')).toBe('/mass-intentions/print?start=2026-10-17')
    fireEvent.click(screen.getByRole('button', { name: en['mi.loadMore'] }))
    await waitFor(() => {
      expect(calls.some(c => c.u.includes('saturday=2026-10-17') && c.u.includes('sunday=2026-10-18') && c.u.includes('offset=50'))).toBe(true)
    })
    expect(await screen.findByText(en['mi.loadFailed'])).toBeInTheDocument()
    expect(screen.getByText('Old vigil 0')).toBeInTheDocument()
    expect(screen.getByText('Old vigil 49')).toBeInTheDocument()
    expect(screen.queryByText('Next weekend row')).not.toBeInTheDocument()
    expect(screen.getByTestId('mi-this-sunday-dates').textContent).toMatch(/17/)
    expect(screen.getByTestId('mi-this-sunday-dates').textContent).not.toMatch(/25/)
    expect(screen.getByTestId('mi-this-sunday-sheet').getAttribute('href')).toBe('/mass-intentions/print?start=2026-10-17')
  })

  it('appends a later page that names the same weekend', async () => {
    const oldWeekend = { saturday: '2026-10-17', sunday: '2026-10-18' }
    const oldRows = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, intention: `Old vigil ${i}`, requested_by: 'Synthetic Family', mass_date: '2026-10-18', status: 'scheduled', stipend: null,
    }))
    let sundayReads = 0
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      calls.push({ u, init: {} })
      if (!u.includes('/api/mass-intentions?')) return ok([])
      const params = new URL(u, 'http://x').searchParams
      if (params.get('weekend') !== 'this_sunday') return ok({ intentions: [OTHER] })
      sundayReads += 1
      if (sundayReads === 1) return ok({ intentions: oldRows, weekend: oldWeekend })
      return ok({ intentions: [{ id: 901, intention: 'Same weekend extra', requested_by: 'Synthetic Family', mass_date: '2026-10-18', status: 'scheduled', stipend: null }], weekend: oldWeekend })
    }))
    book()
    fireEvent.click(screen.getByTestId('mi-this-sunday'))
    expect(await screen.findByText('Old vigil 0')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en['mi.loadMore'] }))
    expect(await screen.findByText('Same weekend extra')).toBeInTheDocument()
    expect(screen.getByText('Old vigil 0')).toBeInTheDocument()
    expect(screen.queryByText(en['mi.loadFailed'])).not.toBeInTheDocument()
    expect(calls.some(c => c.u.includes('saturday=2026-10-17') && c.u.includes('sunday=2026-10-18') && c.u.includes('offset=50'))).toBe(true)
    expect(screen.getByTestId('mi-this-sunday-sheet').getAttribute('href')).toBe('/mass-intentions/print?start=2026-10-17')
  })

  it('English and Spanish copy exist and differ', () => {
    for (const k of ['mi.thisSunday', 'mi.thisSundaySheet', 'mi.thisSundayEmptyTitle', 'mi.thisSundayEmptyBody', 'mi.thisSundayNoMatchTitle', 'mi.thisSundayNoMatchBody', 'mi.showInactive', 'mi.inactiveMember', 'mi.deleteConfirmTitle', 'mi.deleteConfirmBody', 'mi.deleteConfirm']) {
      expect(en[k], k).toBeTruthy()
      expect(es[k], k).toBeTruthy()
      expect(es[k], k).not.toBe(en[k])
    }
  })

  it('readThisSundayWindow accepts only a real Saturday and the next day', () => {
    expect(readThisSundayWindow({ saturday: '2026-10-03', sunday: '2026-10-04' })).toEqual({ saturday: '2026-10-03', sunday: '2026-10-04' })
    expect(readThisSundayWindow({ saturday: '2026-10-03' })).toBeNull()
    expect(readThisSundayWindow({ saturday: 'soon', sunday: '2026-10-04' })).toBeNull()
    expect(readThisSundayWindow(null)).toBeNull()
    expect(readThisSundayWindow({ saturday: '2026-02-30', sunday: '2026-03-01' })).toBeNull()
    expect(readThisSundayWindow({ saturday: '2026-10-04', sunday: '2026-10-03' })).toBeNull()
    expect(readThisSundayWindow({ saturday: '2026-10-03', sunday: '2026-10-05' })).toBeNull()
    expect(readThisSundayWindow({ saturday: '2026-10-02', sunday: '2026-10-03' })).toBeNull()
  })
})

describe('D-5 Show inactive', () => {
  it('hides inactive members until the toggle, then names them', async () => {
    stubBook()
    book()
    fireEvent.click(await screen.findByRole('button', { name: en['mi.add'] }))
    fireEvent.change(screen.getByLabelText(en['mi.linkMember']), { target: { value: 'Syn' } })
    expect(await screen.findByRole('button', { name: 'Synthetic Active' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Synthetic Inactive/ })).not.toBeInTheDocument()
    expect(calls.some(c => c.u.includes('/api/clients/picker?') && c.u.includes('include_inactive=1'))).toBe(false)
    fireEvent.click(screen.getByTestId('mi-show-inactive'))
    expect(await screen.findByRole('button', { name: /Synthetic Inactive/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Synthetic Inactive/ }).textContent).toContain(en['mi.inactiveMember'])
    expect(calls.some(c => c.u.includes('include_inactive=1') && c.u.includes('search=Syn'))).toBe(true)
    fireEvent.click(screen.getByTestId('mi-show-inactive'))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Synthetic Inactive/ })).not.toBeInTheDocument())
  })
})

describe('D-6 delete confirmation', () => {
  it('phone Delete does nothing until confirmed, then deletes that card', async () => {
    stubMatchMedia(true)
    stubBook()
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const u = String(url)
      calls.push({ u, init })
      if (/\/api\/mass-intentions\/\d+$/.test(u) && init.method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) }
      if (u.includes('/api/mass-intentions?')) return ok({ intentions: [OPEN, { ...SUN, status: 'fulfilled', id: 44, intention: 'For the departed' }] })
      return ok([])
    }))
    calls = []
    book()
    const card = (await screen.findAllByTestId('mi-card')).find(c => within(c).queryByText('For a safe journey'))
    fireEvent.click(within(card).getByRole('button', { name: en['mi.delete'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(en['mi.deleteConfirmTitle'])
    expect(within(dialog).getByText(en['mi.deleteConfirmBody'])).toBeInTheDocument()
    expect(deletes()).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(deletes()).toHaveLength(0)
    expect(screen.getByText('For a safe journey')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: en['mi.delete'] }))
    const again = await screen.findByRole('alertdialog')
    await act(async () => { fireEvent.click(within(again).getByRole('button', { name: en['mi.deleteConfirm'] })) })
    await waitFor(() => expect(deletes()).toHaveLength(1))
    expect(deletes()[0].u).toMatch(/\/api\/mass-intentions\/43$/)
    await waitFor(() => expect(screen.queryByText('For a safe journey')).not.toBeInTheDocument())
  })

  it('Spanish confirmation is Spanish', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubMatchMedia(true)
    stubBook()
    book()
    const card = (await screen.findAllByTestId('mi-card')).find(c => within(c).queryByText('For this Sunday'))
    fireEvent.click(within(card).getByRole('button', { name: es['mi.delete'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleName(es['mi.deleteConfirmTitle'])
    expect(within(dialog).getByText(es['mi.deleteConfirmBody'])).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: en['mi.deleteConfirmTitle'] })).not.toBeInTheDocument()
    expect(deletes()).toHaveLength(0)
  })

  it('a refused delete after confirmation keeps the row and says so', async () => {
    stubBook()
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const u = String(url)
      calls.push({ u, init })
      if (init.method === 'DELETE') return { ok: false, status: 500, json: async () => ({ error: 'Failed to delete Mass intention' }) }
      if (u.includes('/api/mass-intentions?')) return ok({ intentions: [OPEN] })
      return ok([])
    }))
    calls = []
    book()
    fireEvent.click(await screen.findByRole('button', { name: en['mi.delete'] }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: en['mi.deleteConfirm'] }))
    expect(await screen.findByRole('alert')).toHaveTextContent(en['mi.deleteFailed'])
    expect(screen.getByText('For a safe journey')).toBeInTheDocument()
    expect(screen.queryByText('Failed to delete Mass intention')).not.toBeInTheDocument()
  })
})
