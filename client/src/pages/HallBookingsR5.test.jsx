// OC-CAT-1 r5 (TARS CHANGES at 2561db7c): an expired signing link is not
// offered for copying; the office renews it instead, and nothing new is
// offered while counsel's wording is missing.
//
// Red at 2561db7c: an expired sent agreement shows no expiry and offers
// "Replace" with the two-step warning; there is no renew action; a counsel-
// pending sent agreement still offers Replace; rotate's 409 counsel_pending
// reads as "That didn't save".
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import HallBookings from './HallBookings'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { role: 'admin', organization: { locale: 'en', tradition: 'general' } },
    loading: false,
  }),
}))

const EN = STRINGS.en
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function mount(ui, path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/hall" element={ui} />
          <Route path="/sign/hall/:token" element={ui} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

const BOOKING = {
  id: 9, host_name: 'Ada and Ben', event_kind: 'wedding', space_name: 'Fellowship Hall',
  starts_at: '2026-11-08T00:00:00.000Z', ends_at: '2026-11-08T06:00:00.000Z', status: 'held',
  time_zone: 'America/Los_Angeles', parish_name: 'Synthetic Hall Parish',
}
function detailWith(agreements) {
  return {
    ...BOOKING, payments: 'on_hold',
    milestones: [{ id: 1, kind: 'hall_rental', amount: '25.00', due_on: '2026-10-01', deposit_held: null }],
    beo: null, agreements, warnings: [], liturgical_status: 'known', liturgical: [], unplaced: [],
  }
}

function hallFetch(routes) {
  return vi.fn(async (url, init) => {
    const path = String(url)
    for (const [match, reply] of routes) {
      if (match(path, init)) return typeof reply === 'function' ? reply(path, init) : reply
    }
    if (path.includes('/api/sacraments')) return json(200, { records: [] })
    if (path.includes('/api/catering/spaces')) return json(200, { payments: 'on_hold', spaces: [{ id: 1, name: 'Fellowship Hall', space_kind: 'fellowship_hall' }] })
    if (path.endsWith('/api/catering/bookings')) return json(200, { payments: 'on_hold', bookings: [BOOKING] })
    return json(500, {})
  })
}

let writeText
beforeEach(() => {
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

const ES = STRINGS.es
const expiredSent = (extra = {}) => ({ id: 3, status: 'sent', counsel_pending: false, link_expired: true, copy_path: null, ...extra })

describe('TARS 1: an expired link is renewed, not copied', () => {
  it('an expired sent link shows no Copy, says it expired, and renews in one step', async () => {
    const calls = []
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/agreement/rotate'), (p, init) => { calls.push(JSON.parse(init.body)); return json(200, { payments: 'on_hold', copy_path: '/sign/hall/org000001.fresh' }) }],
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([expiredSent()]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    expect(await screen.findByText(EN['hall.linkExpired'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: EN['hall.copyLink'] })).toBeNull()
    expect(screen.queryByRole('button', { name: EN['hall.replaceLink'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: EN['hall.renewLink'] }))
    await waitFor(() => expect(calls).toEqual([{ confirm_replace: true }]))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/sign/hall/org000001.fresh`))
    expect(await screen.findByText(EN['hall.renewedCopied'])).toBeTruthy()
  })

  it('a live sent link keeps Copy and the two-step Replace', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{ id: 3, status: 'sent', counsel_pending: false, link_expired: false, copy_path: '/sign/hall/org000001.sample' }]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    expect(await screen.findByRole('button', { name: EN['hall.copyLink'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: EN['hall.replaceLink'] })).toBeTruthy()
    expect(screen.queryByRole('button', { name: EN['hall.renewLink'] })).toBeNull()
    expect(screen.queryByText(EN['hall.linkExpired'])).toBeNull()
  })
})

describe('TARS 2: nothing new is offered while counsel wording is missing', () => {
  it('a counsel-pending sent link offers no Replace, and Copy stays for read/decline', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{ id: 3, status: 'sent', counsel_pending: true, link_expired: false, copy_path: '/sign/hall/org000001.sample' }]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    expect(await screen.findByRole('button', { name: EN['hall.copyLink'] })).toBeTruthy()
    expect(screen.queryByRole('button', { name: EN['hall.replaceLink'] })).toBeNull()
    expect(screen.getByTestId('counsel-pending').textContent).toBe(EN['hall.counselPendingSent'])
  })

  it('a counsel-pending expired link offers no renew and says why', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([expiredSent({ counsel_pending: true })]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    expect((await screen.findByTestId('counsel-pending')).textContent).toBe(EN['hall.counselPendingExpired'])
    expect(screen.queryByRole('button', { name: EN['hall.renewLink'] })).toBeNull()
    expect(screen.queryByRole('button', { name: EN['hall.replaceLink'] })).toBeNull()
    expect(screen.queryByRole('button', { name: EN['hall.copyLink'] })).toBeNull()
  })

  it('a 409 counsel_pending from renew says the link was not changed', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/agreement/rotate'), json(409, { code: 'counsel_pending' })],
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([expiredSent()]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.renewLink'] }))
    expect(await screen.findByText(EN['hall.replaceCounsel'])).toBeTruthy()
  })

  it('the new strings exist in EN and ES', () => {
    for (const key of ['hall.linkExpired', 'hall.renewLink', 'hall.counselPendingExpired', 'hall.replaceCounsel']) {
      expect(EN[key]).toBeTruthy()
      expect(ES[key]).toBeTruthy()
    }
    expect(EN['hall.counselPendingExpired']).not.toMatch(/No link was issued/)
  })
})
