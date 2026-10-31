// Beacon B-H1–H4 — live regions, tap targets, and expired counsel status.
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
    if (path.includes('/api/catering/spaces')) {
      return json(200, { payments: 'on_hold', spaces: [{ id: 1, name: 'Fellowship Hall', space_kind: 'fellowship_hall' }] })
    }
    if (path.endsWith('/api/catering/bookings')) return json(200, { payments: 'on_hold', bookings: [BOOKING] })
    return json(500, {})
  })
}

function mountHall() {
  return render(
    <MemoryRouter initialEntries={['/hall']}>
      <LocaleProvider>
        <Routes>
          <Route path="/hall" element={<HallBookings />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function mountSign() {
  return render(
    <MemoryRouter initialEntries={['/sign/hall/org000001.sample']}>
      <LocaleProvider>
        <Routes>
          <Route path="/sign/hall/:token" element={<SignHallAgreement />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => { localStorage.removeItem('ochr_locale') })

describe('Beacon B-H1: family expired live region', () => {
  it('marks sign.expired as a polite status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(410, { code: 'expired', payments: 'on_hold' })))
    mountSign()
    const el = await screen.findByTestId('sign-expired')
    expect(el.textContent).toBe(EN['sign.expired'])
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
  })
})

describe('Beacon B-H2: counsel banners announce politely', () => {
  it('office counsel-pending uses status + aria-live polite', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{
        id: 3, status: 'sent', counsel_pending: true, link_expired: false, copy_path: '/sign/hall/org000001.sample',
      }]))],
    ]))
    mountHall()
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    const el = await screen.findByTestId('counsel-pending')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
  })

  it('family counsel-pending uses status + aria-live polite', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {
      payments: 'on_hold', status: 'sent', counsel_pending: true,
      contract: 'Synthetic contract', consent: [{ id: 'effect', text: 'effect' }],
    })))
    mountSign()
    const el = await screen.findByTestId('counsel-pending')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
  })
})

describe('Beacon B-H3: tap targets at least 24px', () => {
  it('language toggles and Decline include min 24px classes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {
      payments: 'on_hold', status: 'sent', counsel_pending: false,
      contract: 'Synthetic contract', consent: [{ id: 'effect', text: 'effect' }],
    })))
    mountSign()
    await screen.findByText('Synthetic contract')
    for (const name of [EN['prefs.english'], EN['prefs.spanish'], EN['sign.decline']]) {
      const btn = screen.getByRole('button', { name })
      expect(btn.className).toMatch(/min-h-\[24px]/)
      expect(btn.className).toMatch(/min-w-\[24px]/)
    }
  })

  it('Banquet order and Release hold include min 24px classes', async () => {
    vi.stubGlobal('fetch', hallFetch([]))
    mountHall()
    const banquet = await screen.findByRole('button', { name: EN['hall.beoTitle'] })
    expect(banquet.className).toMatch(/min-h-\[24px]/)
    const release = screen.getByRole('button', { name: EN['hall.cancelHold'] })
    expect(release.className).toMatch(/min-h-\[24px]/)
  })
})

describe('Beacon B-H4 / SP-246: expired+counsel office status', () => {
  it('does not say Copy link ready when counsel-pending and expired', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{
        id: 3, status: 'sent', counsel_pending: true, link_expired: true, copy_path: null,
      }]))],
    ]))
    mountHall()
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    expect(await screen.findByText(EN['hall.status.sentExpired'])).toBeTruthy()
    expect(screen.queryByText(EN['hall.status.sent'])).toBeNull()
    expect(EN['hall.status.sentExpired']).not.toMatch(/Copy link ready/i)
  })
})
