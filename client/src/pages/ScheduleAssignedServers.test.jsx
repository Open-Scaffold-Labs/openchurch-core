// Schedule service drawer: assigned chips open the person they already
// know. The hop is /clients/:id. Remove stays a separate control.
//
// THE INVARIANT: opening a Mass the parish is preparing, a chip backed
// by a live client id is a profile hop. A missing id stays text. The
// assignment is still editable.
//
// Mutate any one of these and the matching test goes red:
//   1. The assigned chip no longer goes to /clients/:id
//   2. Alpha's chip opens Omega
//   3. A name without an id invents /clients/:something
//   4. Remove stops changing assigned_to

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Schedule from './Schedule'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const pad = (n) => String(n).padStart(2, '0')
const today = new Date()
const TODAY = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

const ALPHA = { id: 11, name: 'Ana Delgado', role: 'Lector' }
const OMEGA = { id: 22, name: 'Tomas Rivas', role: 'Server' }
const EVENT = {
  id: 40,
  title: 'Assigned Servers Mass',
  date: TODAY,
  start_time: '09:00',
  end_time: '10:15',
  type: 'service',
  assigned_to: [11, 22],
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

const stubFetch = (members = [ALPHA, OMEGA], event = EVENT) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/calendar/conflicts')) return ok({ conflicts: [] })
    if (u.includes('/api/calendar')) return ok([event])
    if (u.includes('/api/liturgical/range')) return ok({})
    if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
    if (u.includes('/api/mass-intentions/weekly')) return ok({ intentions: [] })
    if (u.includes('/api/mass-intentions/awaiting')) return ok({ intentions: [] })
    if (u.includes('/api/clients')) return ok(members)
    if (u.includes('/api/groups')) return ok({ groups: [] })
    if (u.includes('/api/invoices')) return ok([])
    if (u.includes('/api/availability')) return ok({ unavailability: [] })
    return ok({})
  }))
}

const wrap = () => render(
  <MemoryRouter>
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Schedule />
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  </MemoryRouter>
)

const openMass = async () => {
  const tiles = await screen.findAllByRole('button', { name: /Assigned Servers Mass/ })
  tiles[0].click()
  await waitFor(() => expect(screen.getByText('Assigned Members')).toBeInTheDocument())
}

beforeEach(() => vi.unstubAllGlobals())

describe('Schedule drawer assigned chips', () => {
  it('a named server opens that person', async () => {
    stubFetch()
    wrap()
    await openMass()

    expect(screen.getByRole('link', { name: /Ana Delgado/ }).getAttribute('href')).toBe('/clients/11')
    expect(screen.getByRole('link', { name: /Tomas Rivas/ }).getAttribute('href')).toBe('/clients/22')
  })

  it('Alpha is not Omega', async () => {
    stubFetch()
    wrap()
    await openMass()

    const alpha = screen.getByRole('link', { name: /Ana Delgado/ })
    const omega = screen.getByRole('link', { name: /Tomas Rivas/ })
    expect(alpha.getAttribute('href')).not.toBe(omega.getAttribute('href'))
  })

  it('a name without a real client id stays text', async () => {
    stubFetch(
      [{ id: 'not-an-id', name: 'Historical Name Only', role: 'Member' }],
      { ...EVENT, assigned_to: ['not-an-id'] },
    )
    wrap()
    await openMass()

    expect(screen.getByText('Historical Name Only')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Historical Name Only/ })).not.toBeInTheDocument()
    const hrefs = [...document.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs.some(h => h && /^\/clients\/(?!$).+/.test(h) && h !== '/clients')).toBe(false)
    expect(hrefs).not.toContain('/clients/undefined')
  })

  it('remove still drops that person from the assignment', async () => {
    stubFetch()
    wrap()
    await openMass()

    const chip = screen.getByRole('link', { name: /Ana Delgado/ }).closest('span')
    chip.querySelector('button').click()
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /Ana Delgado/ })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: /Tomas Rivas/ })).toBeInTheDocument()
  })
})
