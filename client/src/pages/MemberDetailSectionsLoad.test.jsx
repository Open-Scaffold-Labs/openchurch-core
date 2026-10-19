// Two profile sections that folded a refused read into an answer:
//
//   1. Availability: a refused GET /api/availability?client_id= became []
//      and rendered "No blackout dates." A dropped connection left the
//      initial [] and said the same. The rotation auto-fill relies on these
//      dates, so "none" is a claim about who can serve.
//   2. Attendance: a refused GET /api/clients/:id/checkins became [], and
//      an empty list hides the section, so a 500 looked exactly like a
//      parishioner with no attendance history.
//
// Empty is an answer. Failed is the absence of one.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MemberDetail from './MemberDetail'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const MEMBER = { id: 20013, name: 'Default Probe', email: 'probe@x.com', status: 'active' }
const CHECKIN = { id: 5, event_id: 18, event_title: 'Sunday Mass (synthetic)', date: '2026-10-11', checked_in_at: '2026-10-11T17:00:00Z' }

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

const isAvail    = u => u.includes('/api/availability?client_id=')
const isCheckins = u => /\/api\/clients\/\d+\/checkins/.test(u)

function stubFetch({ availability = () => ok({ unavailability: [] }), checkins = () => ok({ checkins: [] }), locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (isAvail(u)) return availability()
    if (isCheckins(u)) return checkins()
    if (u.includes(`/api/clients/${MEMBER.id}/donations`)) return ok({ lines: [], total: 0, gift_count: 0 })
    if (u.match(/\/api\/clients\/\d+$/)) return ok(MEMBER)
    return ok({ records: [], entries: [], pledges: [], dates: [] })
  }))
}

const mount = () => render(
  <MemoryRouter initialEntries={[`/clients/${MEMBER.id}`]}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

const NO_BLACKOUTS = 'No blackout dates.'
const { en, es } = STRINGS

async function settled() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('availability section when the read fails', () => {
  for (const [label, availability] of [
    ['a 500', () => err(500)],
    ['a 403', () => err(403)],
    ['a dropped connection', () => { throw new TypeError('Failed to fetch') }],
    ['a 200 body without the list', () => ok({ error: 'odd' })],
  ]) {
    it(`${label} is not "No blackout dates."`, async () => {
      stubFetch({ availability })
      mount()
      expect(await screen.findByText('Default Probe')).toBeInTheDocument()
      expect(await screen.findByText(en['load.failedTitle'])).toBeInTheDocument()
      expect(screen.queryByText(NO_BLACKOUTS)).not.toBeInTheDocument()
    })
  }

  it('retry reads the dates again', async () => {
    let n = 0
    stubFetch({ availability: () => (++n === 1 ? err(500) : ok({ unavailability: [{ id: 3, client_id: MEMBER.id, start_date: '2026-11-01', end_date: '2026-11-01', reason: 'Retreat' }] })) })
    mount()
    await screen.findByText(en['load.failedTitle'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['load.retry'] })) })
    expect(await screen.findByText('Retreat')).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(NO_BLACKOUTS)).not.toBeInTheDocument()
  })

  it('says it in Spanish too', async () => {
    stubFetch({ availability: () => err(500), locale: 'es' })
    mount()
    expect(await screen.findByText(es['load.failedTitle'])).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(NO_BLACKOUTS)).not.toBeInTheDocument()
  })

  it('CONTROL: a real empty answer still says "No blackout dates."', async () => {
    stubFetch()
    mount()
    expect(await screen.findByText(NO_BLACKOUTS)).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
  })
})

describe('attendance section when the read fails', () => {
  for (const [label, checkins] of [
    ['a 500', () => err(500)],
    ['a dropped connection', () => { throw new TypeError('Failed to fetch') }],
    ['a 200 body without the list', () => ok({ error: 'odd' })],
  ]) {
    it(`${label} does not vanish like a member who never attended`, async () => {
      stubFetch({ checkins })
      mount()
      expect(await screen.findByText('Default Probe')).toBeInTheDocument()
      expect(await screen.findByRole('heading', { name: en['member.attendance'] })).toBeInTheDocument()
      expect(screen.getByText(en['load.failedTitle'])).toBeInTheDocument()
    })
  }

  it('retry shows the attendance that was there', async () => {
    let n = 0
    stubFetch({ checkins: () => (++n === 1 ? err(500) : ok({ checkins: [CHECKIN] })) })
    mount()
    await screen.findByRole('heading', { name: en['member.attendance'] })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['load.retry'] })) })
    expect(await screen.findByText('Sunday Mass (synthetic)')).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
  })

  it('CONTROL: no attendance at all still hides the section', async () => {
    stubFetch()
    mount()
    expect(await screen.findByText('Default Probe')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(NO_BLACKOUTS)).toBeInTheDocument())
    await settled()
    expect(screen.queryByRole('heading', { name: en['member.attendance'] })).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
  })

  it('CONTROL: real attendance still lists the service', async () => {
    stubFetch({ checkins: () => ok({ checkins: [CHECKIN] }) })
    mount()
    expect(await screen.findByText('Sunday Mass (synthetic)')).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
  })
})

// R310-2 (TARS on #310 at c0fbec95): a retry can overlap the post-add
// refresh, because the add form stays usable while the retry is pending.
// Only the latest read may decide rows / failure / loading. Deferred fetches
// make the order deterministic.
describe('R310-2 availability: an older read never overwrites a newer one', () => {
  const ADDED = { id: 9, client_id: MEMBER.id, start_date: '2026-12-24', end_date: '2026-12-24', reason: 'Christmas retreat' }
  const deferred = () => { let resolve; const p = new Promise(r => { resolve = r }); return { p, resolve } }

  // Every availability GET gets its own deferred, in order. POST resolves ok.
  function stubDeferred() {
    const reads = []
    const posts = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const u = String(url)
      if (isAvail(u)) { const d = deferred(); reads.push(d); return d.p }
      if (u.endsWith('/api/availability') && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return ok({ id: ADDED.id }) }
      if (isCheckins(u)) return ok({ checkins: [] })
      if (u.includes(`/api/clients/${MEMBER.id}/donations`)) return ok({ lines: [], total: 0, gift_count: 0 })
      if (u.match(/\/api\/clients\/\d+$/)) return ok(MEMBER)
      return ok({ records: [], entries: [], pledges: [], dates: [] })
    }))
    return { reads, posts }
  }

  // failed first read -> retry A pending -> add blackout -> refresh B pending
  async function failedThenRetryThenAdd() {
    const s = stubDeferred()
    const view = mount()
    await screen.findByText('Default Probe')
    await waitFor(() => expect(s.reads).toHaveLength(1))
    await act(async () => { s.reads[0].resolve(err(500)) })
    await screen.findByText(en['load.failedTitle'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['load.retry'] })) })
    await waitFor(() => expect(s.reads).toHaveLength(2)) // retry A, pending
    const form = screen.getByRole('button', { name: new RegExp(en['member.addBlackout']) }).closest('form')
    fireEvent.change(form.querySelector('input[type="date"]'), { target: { value: ADDED.start_date } })
    await act(async () => { fireEvent.submit(form) })
    await waitFor(() => expect(s.reads).toHaveLength(3)) // add-refresh B, pending
    expect(s.posts).toHaveLength(1)
    return { ...s, view, A: s.reads[1], B: s.reads[2] }
  }

  it('older EMPTY retry landing after the newer populated refresh does not erase the added blackout', async () => {
    const { A, B } = await failedThenRetryThenAdd()
    await act(async () => { B.resolve(ok({ unavailability: [ADDED] })) })
    expect(await screen.findByText('Christmas retreat')).toBeInTheDocument()
    await act(async () => { A.resolve(ok({ unavailability: [] })) })
    await settled()
    expect(screen.getByText('Christmas retreat')).toBeInTheDocument()
    expect(screen.queryByText(NO_BLACKOUTS)).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
  })

  it('older FAILURE landing after the newer success does not replace it with a load failure', async () => {
    const { A, B } = await failedThenRetryThenAdd()
    await act(async () => { B.resolve(ok({ unavailability: [ADDED] })) })
    expect(await screen.findByText('Christmas retreat')).toBeInTheDocument()
    await act(async () => { A.resolve(err(500)) })
    await settled()
    expect(screen.getByText('Christmas retreat')).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
  })

  it('older read finishing first does not end the newer loading state or claim "No blackout dates."', async () => {
    const { A, B } = await failedThenRetryThenAdd()
    await act(async () => { A.resolve(ok({ unavailability: [] })) })
    await settled()
    expect(screen.queryByText(NO_BLACKOUTS)).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    await act(async () => { B.resolve(ok({ unavailability: [ADDED] })) })
    expect(await screen.findByText('Christmas retreat')).toBeInTheDocument()
  })

  it('CONTROL: the current request failing still shows the load failure, and retry recovers', async () => {
    const s = await failedThenRetryThenAdd()
    await act(async () => { s.A.resolve(ok({ unavailability: [] })) })
    await act(async () => { s.B.resolve(err(500)) })
    expect(await screen.findByText(en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.queryByText(NO_BLACKOUTS)).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['load.retry'] })) })
    await waitFor(() => expect(s.reads).toHaveLength(4))
    await act(async () => { s.reads[3].resolve(ok({ unavailability: [ADDED] })) })
    expect(await screen.findByText('Christmas retreat')).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
  })

  it('CONTROL: the current request answering empty still says "No blackout dates."', async () => {
    const { A, B } = await failedThenRetryThenAdd()
    await act(async () => { A.resolve(err(500)) })
    await act(async () => { B.resolve(ok({ unavailability: [] })) })
    expect(await screen.findByText(NO_BLACKOUTS)).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
  })
})
