// FAILURE-L2-15 — Golden Journeys 1–2 under a bad read.
//
// A failed, rejected, or incomplete response must not become the empty
// book, an empty week, "no sacraments recorded", or a roster percentage.
// A genuinely empty success still may say empty. That control is in here
// so a fix cannot trade one lie for the other.

import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MassIntentions from './MassIntentions'
import SacristySheet from './SacristySheet'
import Clients from './Clients'
import MemberDetail from './MemberDetail'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const BOOK_EMPTY = /no mass intentions yet|aún no hay intenciones de misa/i
const BOOK_UNREAD = /couldn't load the intention book/i
const WEEK_EMPTY = /no intentions are scheduled|no hay intenciones programadas/i
const SAC_EMPTY = /no sacraments recorded yet/i
const SAC_UNREAD = /could not be read|no se pudo leer el registro sacramental/i
const STATS_LIE = /undefined%/
const MEMBER = { id: 20013, name: 'Sample Member', email: 'sample@example.com', status: 'active', role: 'Member' }
const INTENTION = {
  id: 15,
  intention: 'IN-WINDOW SAMPLE',
  formatted_intention: 'IN-WINDOW SAMPLE',
  requested_by: 'Sample requester',
  requester_name: 'Sample requester',
  mass_date: '2026-09-16',
  status: 'scheduled',
  stipend: 10,
}

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const httpError = (status) => ({ ok: false, status, json: async () => ({ error: 'nope' }) })
const malformed = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token') } })
const rejected = () => Promise.reject(new TypeError('Failed to fetch'))

function bookRoutes(path = '/mass-intentions') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions" element={<ToastProvider><MassIntentions /></ToastProvider>} />
          <Route path="/mass-intentions/print" element={<SacristySheet />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function sheetOnly(path = '/mass-intentions/print?start=2026-09-13') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions/print" element={<SacristySheet />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function withShell(ui) {
  return (
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  )
}

function renderMembers() {
  return render(
    <MemoryRouter initialEntries={['/clients']}>
      {withShell(
        <Routes>
          <Route path="/clients" element={<Clients />} />
        </Routes>,
      )}
    </MemoryRouter>,
  )
}

function renderProfile() {
  return render(
    <MemoryRouter initialEntries={[`/clients/${MEMBER.id}`]}>
      {withShell(
        <Routes>
          <Route path="/clients/:id" element={<MemberDetail />} />
        </Routes>,
      )}
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.unstubAllGlobals()
})

describe('Golden Journey 1 — the intention book', () => {
  function stubBook(book) {
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      if (u.includes('/api/calendar/') && !u.includes('/api/calendar?')) return ok({ id: 1, title: 'Sunday', date: '2026-09-13' })
      if (u.includes('/api/calendar')) return ok([])
      if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
      if (u.includes('/api/mass-intentions/nearest-outside')) return ok({ date: null, undated_waiting: false, undated_waiting_count: 0 })
      if (u.includes('/api/mass-intentions/weekly')) return ok({ intentions: [] })
      if (u.includes('/api/mass-intentions') && method === 'GET') return book(u)
      if (u.includes('/api/mass-intentions') && method === 'POST') return ok({ id: 99 })
      return ok({})
    }))
  }

  async function expectUnreadBook() {
    expect(await screen.findByText(BOOK_UNREAD)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: BOOK_EMPTY })).not.toBeInTheDocument()
  }

  it('CONTROL: a real empty book may say there are no intentions', async () => {
    stubBook(() => ok({ intentions: [] }))
    bookRoutes()
    expect(await screen.findByRole('heading', { name: BOOK_EMPTY })).toBeInTheDocument()
    expect(screen.queryByText(BOOK_UNREAD)).not.toBeInTheDocument()
  })

  it('CONTROL: a listed intention is the book, not the empty card', async () => {
    stubBook(() => ok({ intentions: [INTENTION] }))
    bookRoutes()
    expect(await screen.findByText('IN-WINDOW SAMPLE')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: BOOK_EMPTY })).not.toBeInTheDocument()
  })

  for (const [label, response] of [
    ['a rejected request', rejected],
    ['a 500', () => httpError(500)],
    ['a 403', () => httpError(403)],
    ['a malformed body', malformed],
    ['a 200 with no intentions list', () => ok({})],
    ['a 200 with intentions: null', () => ok({ intentions: null })],
    ['a 200 with intentions as an object', () => ok({ intentions: { id: 1 } })],
  ]) {
    it(`${label} is unread, not an empty book`, async () => {
      stubBook(() => response())
      bookRoutes()
      await expectUnreadBook()
    })
  }

  it('opening Add after a failed read does not clear the book into empty', async () => {
    stubBook(() => httpError(500))
    bookRoutes()
    await expectUnreadBook()
    fireEvent.click(screen.getByRole('button', { name: /add intention/i }))
    expect(await screen.findByLabelText(/^intention$/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]).includes('/api/calendar'))).toBe(true)
    })
    expect(screen.queryByRole('heading', { name: BOOK_EMPTY })).not.toBeInTheDocument()
    expect(screen.getByText(BOOK_UNREAD)).toBeInTheDocument()
  })

  it('a save whose reload is not a list does not claim the book is empty', async () => {
    let phase = 'list'
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      if (method === 'POST' && u.includes('/api/mass-intentions')) {
        phase = 'saved'
        return ok({ id: 99 })
      }
      if (u.includes('/api/calendar')) return ok([])
      if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
      if (u.includes('/api/mass-intentions/nearest-outside')) return ok({ date: null, undated_waiting: false, undated_waiting_count: 0 })
      if (u.includes('/api/mass-intentions/weekly')) return ok({ intentions: [] })
      if (u.includes('/api/mass-intentions') && method === 'GET') {
        return phase === 'saved' ? ok({}) : ok({ intentions: [] })
      }
      return ok({})
    }))
    bookRoutes()
    expect(await screen.findByRole('heading', { name: BOOK_EMPTY })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /add intention/i }))
    fireEvent.change(screen.getByLabelText(/^intention$/i), { target: { value: 'For a safe journey' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(BOOK_UNREAD)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: BOOK_EMPTY })).not.toBeInTheDocument()
    expect(screen.queryByText('For a safe journey')).not.toBeInTheDocument()
  })

  it('a successful save survives refresh, and back from the sheet still shows it', async () => {
    const row = { ...INTENTION, intention: 'For a safe journey' }
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      if (u.includes('/api/calendar')) return ok([])
      if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
      if (u.includes('/api/mass-intentions/nearest-outside')) return ok({ date: null, undated_waiting: false, undated_waiting_count: 0 })
      if (u.includes('/api/mass-intentions/weekly')) return ok({ intentions: [{ ...row, formatted_intention: row.intention }] })
      if (u.includes('/api/mass-intentions') && method === 'POST') return ok({ id: 99 })
      if (u.includes('/api/mass-intentions') && method === 'GET') return ok({ intentions: [row] })
      return ok({})
    }))
    const first = bookRoutes()
    expect(await screen.findByText('For a safe journey')).toBeInTheDocument()
    first.unmount()
    bookRoutes()
    expect(await screen.findByText('For a safe journey')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: BOOK_EMPTY })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: /weekly sheet/i }))
    expect(await screen.findByText('Mass Intentions for the Week')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: /^intentions$/i }))
    expect(await screen.findByText('For a safe journey')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: BOOK_EMPTY })).not.toBeInTheDocument()
  })

  it('the save control stays disabled while the write is in flight', async () => {
    let posts = 0
    let release
    const pending = new Promise((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      if (u.includes('/api/calendar')) return ok([])
      if (method === 'POST' && u.includes('/api/mass-intentions')) {
        posts += 1
        await pending
        return ok({ id: 99 })
      }
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
      return ok({})
    }))
    bookRoutes()
    expect(await screen.findByRole('heading', { name: BOOK_EMPTY })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /add intention/i }))
    fireEvent.change(screen.getByLabelText(/^intention$/i), { target: { value: 'For a safe journey' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    const save = screen.getByRole('button', { name: /^save$/i })
    await waitFor(() => expect(save).toBeDisabled())
    expect(posts).toBe(1)
    release()
    await waitFor(() => expect(screen.queryByLabelText(/^intention$/i)).not.toBeInTheDocument())
  })
})

describe('Golden Journey 1 — the sacristy sheet', () => {
  function stubWeekly(weekly) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
      if (u.includes('/api/mass-intentions/nearest-outside')) return ok({ date: null, undated_waiting: false, undated_waiting_count: 0 })
      if (u.includes('/api/mass-intentions/weekly')) return weekly()
      return ok({})
    }))
  }

  it('CONTROL: a real empty week may say nothing is scheduled', async () => {
    stubWeekly(() => ok({ intentions: [] }))
    sheetOnly()
    expect(await screen.findByText(WEEK_EMPTY)).toBeInTheDocument()
    expect(screen.queryByTestId('sheet-load-failed')).not.toBeInTheDocument()
  })

  for (const [label, response] of [
    ['a rejected request', rejected],
    ['a 500', () => httpError(500)],
    ['a malformed body', malformed],
    ['a 200 with no intentions list', () => ok({})],
    ['a 200 with intentions: null', () => ok({ intentions: null })],
    ['a 200 with intentions as an object', () => ok({ intentions: { id: 1 } })],
  ]) {
    it(`${label} is a failed week, not an empty one`, async () => {
      stubWeekly(() => response())
      sheetOnly()
      expect(await screen.findByTestId('sheet-load-failed')).toBeInTheDocument()
      expect(screen.queryByText(WEEK_EMPTY)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^print$/i })).not.toBeInTheDocument()
    })
  }

  it('a Spanish parish hears the Spanish failure, not the English one and not an empty week', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubWeekly(() => ok({}))
    sheetOnly()
    const banner = await screen.findByTestId('sheet-load-failed')
    expect(banner.textContent).toBe(STRINGS.es['sheet.loadFailed'])
    expect(screen.queryByText(WEEK_EMPTY)).not.toBeInTheDocument()
  })
})

describe('Golden Journey 2 — member list counts', () => {
  const SAMPLE = { id: 7, name: 'Sample Member', role: 'Member', status: 'active' }

  function stubClients({ stats, list = () => ok([SAMPLE]) }) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/clients/stats')) return stats()
      if (u.includes('/api/clients')) return list()
      return ok({})
    }))
  }

  it('CONTROL: finite counts render, including zero growth', async () => {
    stubClients({ stats: () => ok({ total: 2, newWeek: 0, active: 2, growth: 0 }) })
    renderMembers()
    expect(await screen.findByText('Sample Member')).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.queryByText(STATS_LIE)).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['mem.statsFailed'])).not.toBeInTheDocument()
  })

  it('CONTROL: a rejected count read says the counts failed and does not invent a percentage', async () => {
    stubClients({ stats: rejected })
    renderMembers()
    expect(await screen.findByText(STRINGS.en['mem.statsFailed'])).toBeInTheDocument()
    expect(screen.queryByText(STATS_LIE)).not.toBeInTheDocument()
    expect(screen.getByText('Sample Member')).toBeInTheDocument()
  })

  for (const [label, response] of [
    ['a 500', () => httpError(500)],
    ['a malformed body', malformed],
    ['a 200 object with no counts', () => ok({})],
    ['a 200 missing growth', () => ok({ total: 4, newWeek: 1, active: 4 })],
    ['a 200 whose growth is not a number', () => ok({ total: 4, newWeek: 1, active: 4, growth: 'up' })],
  ]) {
    it(`${label} is unavailable counts, not undefined%`, async () => {
      stubClients({ stats: () => response() })
      renderMembers()
      expect(await screen.findByText(STRINGS.en['mem.statsFailed'])).toBeInTheDocument()
      expect(screen.queryByText(STATS_LIE)).not.toBeInTheDocument()
      expect(screen.getByText('Sample Member')).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: /no members yet/i })).not.toBeInTheDocument()
    })
  }

  it('a rejected member list is not an empty parish', async () => {
    stubClients({
      stats: () => ok({ total: 2, newWeek: 0, active: 2, growth: 0 }),
      list: rejected,
    })
    renderMembers()
    expect(await screen.findByText(STRINGS.en['mem.listFailed'])).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /no members yet/i })).not.toBeInTheDocument()
  })

  it('CONTROL: a successful empty list may say there are no members', async () => {
    stubClients({
      stats: () => ok({ total: 0, newWeek: 0, active: 0, growth: 0 }),
      list: () => ok([]),
    })
    renderMembers()
    expect(await screen.findByRole('heading', { name: /no members yet/i })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['mem.listFailed'])).not.toBeInTheDocument()
  })

  for (const [label, body] of [
    ['a 200 object', {}],
    ['a 200 null', null],
    ['a 200 scalar', 4],
    ['a 200 wrapped list', { clients: [SAMPLE] }],
  ]) {
    it(`${label} is a failed member list, not an empty parish`, async () => {
      stubClients({
        stats: () => ok({ total: 2, newWeek: 0, active: 2, growth: 0 }),
        list: () => ok(body),
      })
      renderMembers()
      expect(await screen.findByText(STRINGS.en['mem.listFailed'])).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: /no members yet/i })).not.toBeInTheDocument()
      expect(screen.queryByText('Sample Member')).not.toBeInTheDocument()
    })
  }

  it('a Spanish parish hears the Spanish failure, not an empty roll', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubClients({
      stats: () => ok({ total: 2, newWeek: 0, active: 2, growth: 0 }),
      list: () => ok({}),
    })
    renderMembers()
    expect(await screen.findByText(STRINGS.es['mem.listFailed'])).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /aún no hay miembros|no members yet/i })).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['mem.listFailed'])).not.toBeInTheDocument()
  })
})

describe("Golden Journey 2 — a member's sacraments", () => {
  function stubProfile(records) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/donations')) return ok({ lines: [], total: 0, gift_count: 0 })
      if (u.includes('/api/sacraments?client_id')) return records()
      if (u.match(/\/api\/clients\/\d+$/)) return ok(MEMBER)
      if (u.includes('/api/pledges')) return ok({ pledges: [] })
      if (u.includes('/api/availability')) return ok({ unavailability: [] })
      if (u.includes('/checkins')) return ok({ checkins: [] })
      return ok({})
    }))
  }

  it('CONTROL: a member with no entries may say so', async () => {
    stubProfile(() => ok({ records: [] }))
    renderProfile()
    expect(await screen.findByText(SAC_EMPTY)).toBeInTheDocument()
    expect(screen.queryByText(SAC_UNREAD)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sample Member' })).toBeInTheDocument()
  })

  it('CONTROL: a recorded baptism is shown', async () => {
    stubProfile(() => ok({ records: [{ id: 2, type: 'baptism', date: '2018-06-10', certificate_no: 'GJ-2', minister: 'Fr. Sample', place: 'St Test' }] }))
    renderProfile()
    expect(await screen.findByText(/GJ-2/)).toBeInTheDocument()
    expect(screen.queryByText(SAC_EMPTY)).not.toBeInTheDocument()
  })

  for (const [label, response] of [
    ['a rejected request', rejected],
    ['a 500', () => httpError(500)],
    ['a malformed body', malformed],
    ['a 200 with no records list', () => ok({})],
    ['a 200 with records: null', () => ok({ records: null })],
    ['a 200 with records as an object', () => ok({ records: { id: 2 } })],
  ]) {
    it(`${label} is unread, not a member with no sacraments`, async () => {
      stubProfile(() => response())
      renderProfile()
      expect(await screen.findByText(SAC_UNREAD)).toBeInTheDocument()
      expect(screen.queryByText(SAC_EMPTY)).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Sample Member' })).toBeInTheDocument()
    })
  }
})
