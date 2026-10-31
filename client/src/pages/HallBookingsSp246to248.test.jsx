// SP-246 / SP-248: expired hall link copy must not say "Copy link ready"
// or promise the family a new link while counsel may block renew.
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import HallBookings from './HallBookings'
import SignHallAgreement from './SignHallAgreement'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { role: 'admin', organization: { locale: 'en', tradition: 'general' } },
    loading: false,
  }),
}))

const EN = STRINGS.en
const ES = STRINGS.es
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

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

function mountHall(path = '/hall') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/hall" element={<HallBookings />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => { localStorage.removeItem('ochr_locale') })

describe('SP-246 expired office status', () => {
  it('shows sentExpired, not Copy link ready, when the link is expired', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{
        id: 3, status: 'sent', counsel_pending: false, link_expired: true, copy_path: null,
      }]))],
    ]))
    mountHall()
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    expect(await screen.findByText(EN['hall.status.sentExpired'])).toBeTruthy()
    expect(screen.queryByText(EN['hall.status.sent'])).toBeNull()
    expect(EN['hall.status.sentExpired']).not.toMatch(/Copy link ready/i)
    expect(ES['hall.status.sentExpired']).not.toMatch(/listo para copiar/i)
  })

  it('keeps Copy link ready only while the link is live', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{
        id: 3, status: 'sent', counsel_pending: false, link_expired: false, copy_path: '/sign/hall/org000001.sample',
      }]))],
    ]))
    mountHall()
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    expect(await screen.findByText(EN['hall.status.sent'])).toBeTruthy()
    expect(screen.queryByText(EN['hall.status.sentExpired'])).toBeNull()
  })
})

describe('SP-248 family expired copy (option A)', () => {
  it('does not promise a new link', async () => {
    expect(EN['sign.expired']).toContain('Contact the parish')
    expect(EN['sign.expired']).not.toMatch(/ask the parish for a new/i)
    expect(ES['sign.expired']).toContain('Comuníquese con la parroquia')
    expect(ES['sign.expired']).not.toMatch(/Pida uno nuevo/i)
    vi.stubGlobal('fetch', vi.fn(async () => json(410, { code: 'expired', payments: 'on_hold' })))
    render(
      <MemoryRouter initialEntries={['/sign/hall/org000001.sample']}>
        <LocaleProvider>
          <Routes>
            <Route path="/sign/hall/:token" element={<SignHallAgreement />} />
          </Routes>
        </LocaleProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(EN['sign.expired'])).toBeTruthy()
  })
})
