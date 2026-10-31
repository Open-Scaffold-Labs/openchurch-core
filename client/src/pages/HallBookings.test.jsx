// The hall page says, in English and in Spanish, that nothing is charged.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, '..', 'App.jsx'), 'utf8')

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url)
    if (path.includes('/api/catering/spaces')) {
      return { ok: true, json: async () => ({ payments: 'on_hold', spaces: [] }) }
    }
    if (path.includes('/api/catering/bookings')) {
      return { ok: true, json: async () => ({ payments: 'on_hold', bookings: [] }) }
    }
    if (path.includes('/api/hall-sign/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          payments: 'on_hold',
          status: 'sent',
          email_verified: false,
          contract: 'Nada se cobra.',
          consent: [{ id: 'money', text: 'Desde esta página no se cobra nada.' }],
        }),
      }
    }
    return { ok: false, status: 500, json: async () => ({}) }
  }))
})

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

describe('hall copy', () => {
  it('keeps the payments-hold sentence in both languages', () => {
    expect(STRINGS.en['hall.paymentsHold']).toMatch(/Nothing is charged/)
    expect(STRINGS.es['hall.paymentsHold']).toMatch(/no se cobra nada/)
    expect(STRINGS.en['nav.Hall']).toBe('Hall')
    expect(STRINGS.es['nav.Hall']).toBe('Salón')
    for (const key of Object.keys(STRINGS.en).filter(k => k.startsWith('hall.') || k.startsWith('sign.'))) {
      expect(STRINGS.es[key], key).toBeTruthy()
    }
  })

  it('shows the hold on an empty hall book', async () => {
    mount(<HallBookings />, '/hall')
    expect(await screen.findByText(STRINGS.en['hall.paymentsHold'])).toBeTruthy()
    expect(await screen.findByText(STRINGS.en['hall.emptyTitle'])).toBeTruthy()
  })

  it('lists a room after it is saved', async () => {
    const spaces = []
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const path = String(url)
      if (path.includes('/api/catering/spaces') && init?.method === 'POST') {
        spaces.push({ id: 1, name: 'Fellowship Hall', space_kind: 'fellowship_hall' })
        return { ok: true, json: async () => ({ payments: 'on_hold', space: spaces[0] }) }
      }
      if (path.includes('/api/catering/spaces')) {
        return { ok: true, json: async () => ({ payments: 'on_hold', spaces: [...spaces] }) }
      }
      if (path.includes('/api/catering/bookings')) {
        return { ok: true, json: async () => ({ payments: 'on_hold', bookings: [] }) }
      }
      return { ok: false, status: 500, json: async () => ({}) }
    }))
    mount(<HallBookings />, '/hall')
    await screen.findByText(STRINGS.en['hall.emptyTitle'])
    fireEvent.change(screen.getByLabelText(STRINGS.en['hall.spaceName']), { target: { value: 'Fellowship Hall' } })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['hall.addSpace'] }))
    expect(await screen.findByRole('option', { name: 'Fellowship Hall' })).toBeTruthy()
  })

  it('the signing page is outside the signed-in shell and shows the hold', async () => {
    expect(APP).toMatch(/path="\/hall"/)
    expect(APP).toMatch(/path="\/sign\/hall\/:token"/)
    const publicSlice = APP.slice(APP.indexOf('path="/kiosk/:token"'), APP.indexOf('path="/*"'))
    expect(publicSlice).toMatch(/sign\/hall/)
    mount(<SignHallAgreement />, '/sign/hall/org000001.sample')
    await waitFor(() => expect(screen.getByText(STRINGS.en['sign.hold'])).toBeTruthy())
    expect(screen.getByText('Desde esta página no se cobra nada.')).toBeTruthy()
  })

  it('shows the agreement before approval, copies an absolute link, and refuses a bad lock', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const detail = {
      payments: 'on_hold',
      id: 9,
      host_name: 'Ada and Ben',
      event_kind: 'wedding',
      space_name: 'Sanctuary',
      parish_name: 'Synthetic Hall Parish',
      time_zone: 'America/Los_Angeles',
      starts_at: '2026-11-08T00:00:00.000Z',
      ends_at: '2026-11-08T06:00:00.000Z',
      status: 'held',
      milestones: [{ id: 1, kind: 'hall_rental', amount: '25.00', due_on: '2026-10-01', deposit_held: null }],
      beo: { table_count: 8, chair_count: 64, layout: 'Banquet', guaranteed_count: null, guaranteed_locked: false, when_en: 'Nov 7, 2026, 4:00 PM–10:00 PM' },
      agreements: [{ id: 3, status: 'sent', contract_sha256: 'abc', copy_path: '/sign/hall/org000001.sample', email_verified: false }],
      warnings: [{ source: 'schedule', title: 'Sunday Mass', date: '2026-11-15', during: 'sunday_mass' }],
      liturgical_status: 'known',
      liturgical: [{ feast_name: 'All Saints' }],
      unplaced: [],
    }
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const path = String(url)
      if (path.includes('/api/sacraments')) {
        return { ok: true, status: 200, json: async () => ({ records: [{ id: 4, member_name: 'Own Couple', date: '2026-11-14' }] }) }
      }
      if (path.endsWith('/beo/lock') || path.includes('/beo/lock')) {
        return { ok: false, status: 409, json: async () => ({ code: 'guaranteed_count', payments: 'on_hold' }) }
      }
      if (path.includes('/api/catering/bookings/9')) {
        return { ok: true, status: 200, json: async () => detail }
      }
      if (path.includes('/api/catering/spaces')) {
        return { ok: true, json: async () => ({ payments: 'on_hold', spaces: [{ id: 1, name: 'Sanctuary', space_kind: 'sanctuary' }] }) }
      }
      if (path.includes('/api/catering/bookings')) {
        return { ok: true, json: async () => ({ payments: 'on_hold', bookings: [{ id: 9, host_name: 'Ada and Ben', event_kind: 'wedding', space_name: 'Sanctuary', starts_at: detail.starts_at, ends_at: detail.ends_at, status: 'held', time_zone: 'America/Los_Angeles', parish_name: 'Synthetic Hall Parish' }] }) }
      }
      return { ok: false, status: 500, json: async () => ({}) }
    }))
    mount(<HallBookings />, '/hall')
    expect(await screen.findByText(/Nov 7, 2026/)).toBeTruthy()
    expect(screen.queryByText(/Nov 8/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['hall.beoTitle'] }))
    expect((await screen.findAllByRole('combobox', { name: STRINGS.en['hall.marriage'] })).length).toBeGreaterThan(0)
    expect((await screen.findAllByRole('option', { name: /Own Couple/ })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: STRINGS.en['hall.send'] })).toBeNull()
    expect(screen.getByText(STRINGS.en['hall.status.sent'])).toBeTruthy()
    expect(screen.queryByText('sent')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['hall.copyLink'] }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/sign/hall/org000001.sample`))
    fireEvent.change(screen.getByLabelText(STRINGS.en['hall.lock']), { target: { value: '70' } })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['hall.lock'] }))
    expect(await screen.findByText(STRINGS.en['hall.lockRefused'])).toBeTruthy()
    expect(screen.getByText(STRINGS.en['hall.sundayMass'])).toBeTruthy()
    expect(screen.getAllByText(/\$25\.00/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Synthetic Hall Parish').length).toBeGreaterThan(0)
    const printed = document.querySelector('[data-testid="beo-print"]')
    expect(printed).toBeTruthy()
    expect(printed.textContent).toMatch(/8/)
    expect(printed.textContent).not.toMatch(/70/)
    expect(screen.getByRole('button', { name: STRINGS.en['hall.voidUnsigned'] })).toBeTruthy()
  })

  it('says when the marriage register failed to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const path = String(url)
      if (path.includes('/api/sacraments')) return { ok: false, status: 500, json: async () => ({}) }
      if (path.includes('/api/catering/spaces')) {
        return { ok: true, json: async () => ({ payments: 'on_hold', spaces: [{ id: 1, name: 'Sanctuary', space_kind: 'sanctuary' }] }) }
      }
      if (path.includes('/api/catering/bookings')) {
        return { ok: true, json: async () => ({ payments: 'on_hold', bookings: [] }) }
      }
      return { ok: false, status: 500, json: async () => ({}) }
    }))
    mount(<HallBookings />, '/hall')
    expect(await screen.findByText(STRINGS.en['hall.marriagesFailed'])).toBeTruthy()
    expect(screen.queryByRole('option', { name: STRINGS.en['hall.marriageNone'] })).toBeNull()
  })
})
