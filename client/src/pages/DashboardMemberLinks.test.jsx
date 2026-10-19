// Dashboard names a person it already has. The hop is /clients/:id —
// the same route #34 keeps in the URL. A missing or garbled id is not
// a member we invent from the label.
//
// Mutate any one of these and the matching test goes red:
//   1. New Members names stay spans
//   2. Recently Added rows stay unlinked
//   3. A nameless / non-integer id is treated as /clients/:something
//   4. The New Members row arrow stops going to the roll

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { DailyBriefing, MembersTab, memberProfileHref } from './Dashboard'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const todayIso = () => new Date().toISOString()

const MARIA = { id: 1, name: 'Maria Garcia', role: 'Member', created_at: todayIso() }
const DANIEL = { id: 2, name: 'Daniel Martinez', role: 'Member', created_at: todayIso() }

const wrap = (node) => render(
  <MemoryRouter>
    <LocaleProvider>
      {node}
    </LocaleProvider>
  </MemoryRouter>
)

describe('memberProfileHref', () => {
  it('only a positive integer becomes a person URL', () => {
    expect(memberProfileHref(1)).toBe('/clients/1')
    expect(memberProfileHref('44')).toBe('/clients/44')
    expect(memberProfileHref(0)).toBeNull()
    expect(memberProfileHref(-3)).toBeNull()
    expect(memberProfileHref(1.5)).toBeNull()
    expect(memberProfileHref('not-an-id')).toBeNull()
    expect(memberProfileHref('')).toBeNull()
    expect(memberProfileHref(null)).toBeNull()
    expect(memberProfileHref(undefined)).toBeNull()
  })
})

describe('Daily Briefing New Members', () => {
  it('a named new member opens that person; the row arrow still opens the roll', () => {
    wrap(<DailyBriefing data={{ calEvents: [], schedule: [], tasks: [], members: [MARIA, DANIEL] }} />)

    const maria = screen.getByRole('link', { name: 'Maria Garcia' })
    expect(maria.getAttribute('href')).toBe('/clients/1')
    const daniel = screen.getByRole('link', { name: 'Daniel Martinez' })
    expect(daniel.getAttribute('href')).toBe('/clients/2')

    expect(screen.getByRole('link', { name: /open new members/i }).getAttribute('href')).toBe('/clients')
  })

  it('a name without a member id stays text — no invented person', () => {
    wrap(<DailyBriefing data={{
      calEvents: [],
      schedule: [],
      tasks: [],
      members: [{ name: 'Historical Name Only', role: 'Member', created_at: todayIso() }],
    }} />)

    expect(screen.getByText('Historical Name Only')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Historical Name Only' })).not.toBeInTheDocument()
    const hrefs = [...document.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs.some(h => h && h.startsWith('/clients/') && h !== '/clients')).toBe(false)
  })

  it('today\'s event and task titles are not person hops', () => {
    const today = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`
    wrap(<DailyBriefing data={{
      calEvents: [{ id: 9, title: 'Sunday Service', date: today, start_time: '09:00', end_time: '10:00' }],
      schedule: [],
      tasks: [{ id: 3, title: 'Unlock the hall', category: 'OPENING', priority: 'HIGH', status: 'OPEN' }],
      members: [],
    }} />)

    expect(screen.getByText('Sunday Service')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Sunday Service' })).not.toBeInTheDocument()
    expect(screen.getByText('Unlock the hall')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Unlock the hall' })).not.toBeInTheDocument()
  })
})

describe('Members tab Recently Added', () => {
  it('a recent member row opens that person', () => {
    wrap(<MembersTab data={{ members: [MARIA], memberStats: { total: 1, active: 1, newWeek: 1 } }} />)

    const row = screen.getByRole('link', { name: /Maria Garcia/ })
    expect(row.getAttribute('href')).toBe('/clients/1')
    expect(screen.getByRole('link', { name: /view all/i }).getAttribute('href')).toBe('/clients')
  })

  it('a row without an id does not invent /clients/undefined', () => {
    wrap(<MembersTab data={{
      members: [{ name: 'Unlinked Visitor', email: 'x@example.com', created_at: todayIso() }],
      memberStats: { total: 1, active: 1, newWeek: 1 },
    }} />)

    expect(screen.getByText('Unlinked Visitor')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Unlinked Visitor/ })).not.toBeInTheDocument()
    const hrefs = [...document.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).not.toContain('/clients/undefined')
    expect(hrefs).not.toContain('/clients/null')
  })

  it('a non-array roster is a failed read, not "No members yet"', () => {
    wrap(<MembersTab data={{ members: {}, memberStats: { total: 4, active: 4, newWeek: 1 } }} />)
    expect(screen.getAllByText(STRINGS.en['mem.listFailed']).length).toBeGreaterThan(0)
    expect(screen.queryByText('No members yet.')).not.toBeInTheDocument()
    expect(screen.queryByText('No data yet.')).not.toBeInTheDocument()
  })

  it('an explicit failed flag is not an empty roll, even when the rows were cleared', () => {
    wrap(<MembersTab data={{ members: [], membersFailed: true, memberStats: null }} />)
    expect(screen.getAllByText(STRINGS.en['mem.listFailed']).length).toBeGreaterThan(0)
    expect(screen.queryByText('No members yet.')).not.toBeInTheDocument()
  })

  it('CONTROL: a real empty array may say there are no members', () => {
    wrap(<MembersTab data={{ members: [], membersFailed: false, memberStats: { total: 0, active: 0, newWeek: 0 } }} />)
    expect(screen.getByText('No members yet.')).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['mem.listFailed'])).not.toBeInTheDocument()
  })
})

describe('Daily Briefing does not call a failed roster "no new members"', () => {
  it('a 200 object is the load-failed sentence', () => {
    wrap(<DailyBriefing data={{ calEvents: [], schedule: [], tasks: [], members: {} }} />)
    expect(screen.getByText(STRINGS.en['mem.listFailed'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['dash.sum.noNew'])).not.toBeInTheDocument()
  })

  it('CONTROL: an empty array may say nobody joined this week', () => {
    wrap(<DailyBriefing data={{ calEvents: [], schedule: [], tasks: [], members: [] }} />)
    expect(screen.getByText(STRINGS.en['dash.sum.noNew'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['mem.listFailed'])).not.toBeInTheDocument()
  })
})
