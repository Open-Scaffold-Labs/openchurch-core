// Sunday Packet "Serving This Day" names open the person the join already
// resolved. The hop is /clients/:id — the same route #34 keeps in the URL.
//
// THE INVARIANT: a serving name is a profile hop only when the packet
// join produced a real client id. A display name alone is never enough.
// A stale / garbled / missing id stays the text it is.
//
// Mutate any one of these and the matching test goes red:
//   1. A joined { id, name } no longer links to /clients/:id
//   2. Alpha's name opens Omega
//   3. A name-only string (or object without a real id) invents a person
//   4. The Mass title itself becomes a person hop
//   5. Back chrome from=schedule is lost (wrong Mass / wrong parent)

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import SundayPacket, { servingPersonHref, servingPersonName, groupPacketIntentions } from './SundayPacket'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ALPHA = { id: 11, name: 'Ana Delgado' }
const OMEGA = { id: 22, name: 'Tomas Rivas' }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

const packet = (serving, intentions = []) => ({
  parish: 'St Test',
  date: '2026-09-13',
  plan: { title: 'Sunday Mass', elements: [] },
  serving,
  intentions,
  bulletin: null,
  lectionary: null,
  liturgical: null,
})

const stub = (serving, intentions) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  if (u.includes('/api/packet')) return ok(packet(serving, intentions))
  return ok({})
}))

const view = () => render(
  <MemoryRouter initialEntries={['/packet?date=2026-09-13&from=schedule']}>
    <LocaleProvider>
      <Routes>
        <Route path="/packet" element={<SundayPacket />} />
      </Routes>
    </LocaleProvider>
  </MemoryRouter>
)

beforeEach(() => vi.unstubAllGlobals())

describe('servingPersonHref', () => {
  it('only a joined positive integer id becomes a person URL', () => {
    expect(servingPersonHref({ id: 11, name: 'Ana Delgado' })).toBe('/clients/11')
    expect(servingPersonHref({ id: '22', name: 'Tomas Rivas' })).toBe('/clients/22')
    expect(servingPersonHref({ id: 0, name: 'Zero' })).toBeNull()
    expect(servingPersonHref({ id: -3, name: 'Neg' })).toBeNull()
    expect(servingPersonHref({ id: 1.5, name: 'Frac' })).toBeNull()
    expect(servingPersonHref({ id: 'not-an-id', name: 'Garbled' })).toBeNull()
    expect(servingPersonHref({ name: 'Name Only' })).toBeNull()
    expect(servingPersonHref('Ana Delgado')).toBeNull()
    expect(servingPersonHref(null)).toBeNull()
  })

  it('never derives a URL from the display name', () => {
    expect(servingPersonName({ id: 11, name: 'Ana Delgado' })).toBe('Ana Delgado')
    expect(servingPersonName('Ana Delgado')).toBe('Ana Delgado')
    expect(servingPersonHref('Ana Delgado')).toBeNull()
  })
})

describe('Sunday Packet serving line', () => {
  it('a joined id opens that person; Schedule return stays Schedule', async () => {
    stub([{ title: 'Sunday Mass', start_time: '09:00', assigned: [ALPHA, OMEGA] }])
    view()

    await waitFor(() => expect(screen.getByText('Serving This Day')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Ana Delgado' }).getAttribute('href')).toBe('/clients/11')
    expect(screen.getByRole('link', { name: 'Tomas Rivas' }).getAttribute('href')).toBe('/clients/22')
    expect(screen.getByRole('link', { name: /^schedule$/i }).getAttribute('href')).toBe('/schedule')
  })

  it('Alpha is not Omega', async () => {
    stub([{ title: 'Sunday Mass', start_time: '09:00', assigned: [ALPHA, OMEGA] }])
    view()

    await waitFor(() => expect(screen.getByRole('link', { name: 'Ana Delgado' })).toBeInTheDocument())
    const alpha = screen.getByRole('link', { name: 'Ana Delgado' })
    const omega = screen.getByRole('link', { name: 'Tomas Rivas' })
    expect(alpha.getAttribute('href')).not.toBe(omega.getAttribute('href'))
  })

  it('a name-only string stays text — never a person invented from the label', async () => {
    stub([{ title: 'Sunday Mass', start_time: '09:00', assigned: ['Historical Name Only'] }])
    view()

    await waitFor(() => expect(screen.getByText('Historical Name Only')).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Historical Name Only' })).not.toBeInTheDocument()
    const hrefs = [...document.querySelectorAll('a[href^="/clients/"]')].map(a => a.getAttribute('href'))
    expect(hrefs).toEqual([])
  })

  it('an object with a name but no real id stays text', async () => {
    stub([{ title: 'Sunday Mass', start_time: '09:00', assigned: [{ name: 'Cecilia Moreno' }] }])
    view()

    await waitFor(() => expect(screen.getByText('Cecilia Moreno')).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Cecilia Moreno' })).not.toBeInTheDocument()
    expect([...document.querySelectorAll('a')].map(a => a.getAttribute('href')))
      .not.toContain('/clients/undefined')
  })

  it('the Mass title is not a person hop', async () => {
    stub([{ title: 'Sunday Mass', start_time: '09:00', assigned: [ALPHA] }])
    view()

    await waitFor(() => expect(screen.getByText('Sunday Mass')).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Sunday Mass' })).not.toBeInTheDocument()
  })
})

describe('Sunday Packet unknown Mass as offered', () => {
  it('groups a fulfilled NULL-stamp row under unknown, not a date', () => {
    const days = groupPacketIntentions([
      { mass_date: '2026-09-13', formatted_intention: 'Dated' },
      { mass_date: null, formatted_intention: '† Legacy unknown', status: 'fulfilled' },
    ])
    expect(days.map(([d]) => d)).toEqual(['2026-09-13', null])
    expect(days[1][1][0].formatted_intention).toMatch(/Legacy unknown/)
  })

  it('labels a reopened stamped row previously recorded fulfilment', async () => {
    stub([], [{
      formatted_intention: '† Reopened stamp',
      status: 'scheduled',
      mass_date: '2026-09-13',
      mass_title: 'Sunday Mass',
      mass_time: '09:00',
      fulfilment_label: 'previously recorded fulfilment',
    }])
    view()
    expect(await screen.findByText('previously recorded fulfilment')).toBeInTheDocument()
    expect(screen.queryByText('fulfilled')).not.toBeInTheDocument()
    expect(screen.queryByText('Fulfilled')).not.toBeInTheDocument()
  })

  it('prints unknown chrome for a fulfilled row with NULL stamps', async () => {
    stub([], [{
      formatted_intention: '† Legacy unknown',
      status: 'fulfilled',
      mass_date: null,
      mass_title: null,
      mass_time: null,
    }])
    view()

    await waitFor(() => expect(screen.getByText('† Legacy unknown')).toBeInTheDocument())
    expect(screen.getAllByText('Mass as offered unknown').length).toBeGreaterThan(0)
  })
})
