// A refused lapsed-member read used to set the card to null, so the
// parish saw no "Haven't shown up" card at all — the same screen as a
// request still in flight, and easy to read as "nobody is missing."

import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import Insights from './Insights'

const localeRef = { current: 'en' }

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: localeRef.current } },
    token: 't', loading: false,
  }),
}))

const SUMMARY = {
  summary: {
    member_count: 12,
    ytd_donations: 0,
    ai_this_month: 0,
    ai_last_month: 0,
    avg_attendance_rate: null,
    tracked_events: 0,
    pledge_fulfillment: null,
  },
  members_joined: [],
  donations_monthly: [],
  attendance_monthly: [],
  donations_by_category: [],
}

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

const routes = (lapsed) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  if (u.includes('/api/insights/lapsed')) return lapsed()
  if (u.includes('/api/insights')) return ok(SUMMARY)
  return ok({})
}))

const mount = () => render(
  <MemoryRouter><LocaleProvider>
    <Insights />
  </LocaleProvider></MemoryRouter>
)

const UNREAD = /absence list did not load/i
const NONE = /has been seen in the last/i
const ES_UNREAD = /no se pudo cargar la lista de ausencias/i
const ES_NONE = /han venido en las últimas/i
const TITLE = /haven't shown up recently/i

beforeEach(() => {
  localeRef.current = 'en'
  try { localStorage.removeItem('ochr_locale') } catch { /* jsdom */ }
  vi.unstubAllGlobals()
})

describe('a refused absence list is not everyone seen', () => {
  it('a 500 still shows the card and does not claim everyone was seen', async () => {
    routes(() => err(500))
    mount()
    expect(await screen.findByRole('status')).toHaveTextContent(UNREAD)
    expect(screen.getByRole('heading', { name: TITLE })).toBeInTheDocument()
    expect(screen.queryByText(NONE)).not.toBeInTheDocument()
  })

  it('a non-list body is unread, not everyone seen', async () => {
    routes(() => ok({ weeks: 3, members: null }))
    mount()
    expect(await screen.findByRole('status')).toHaveTextContent(UNREAD)
    expect(screen.queryByText(NONE)).not.toBeInTheDocument()
  })

  it('a true empty list still says everyone was seen', async () => {
    routes(() => ok({ weeks: 3, members: [] }))
    mount()
    expect(await screen.findByText(NONE)).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('a missing member is named', async () => {
    routes(() => ok({ weeks: 3, members: [{ id: 4, name: 'Ana Ruiz', email: '', phone: '', weeks_absent: 5 }] }))
    mount()
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
    expect(screen.queryByText(NONE)).not.toBeInTheDocument()
  })

  it('a later refused re-query does not keep the previous name', async () => {
    let call = 0
    routes(() => (++call === 1
      ? ok({ weeks: 3, members: [{ id: 4, name: 'Ana Ruiz', email: '', phone: '', weeks_absent: 5 }] })
      : err(500)))
    mount()
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument()
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '4' } })
    })
    expect(await screen.findByText(UNREAD)).toBeInTheDocument()
    expect(screen.queryByText('Ana Ruiz')).not.toBeInTheDocument()
  })

  it('Spanish names a refused list, not a parish where everyone came', async () => {
    localeRef.current = 'es'
    routes(() => err(500))
    mount()
    expect(await screen.findByRole('status')).toHaveTextContent(ES_UNREAD)
    expect(screen.queryByText(ES_NONE)).not.toBeInTheDocument()
  })
})
