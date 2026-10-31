// SP-100 (Saint 2026-10-22): after the only intention moved off Oct 25,
// the Oct 25 packet dropped the intentions section entirely — nothing
// said "none booked". A read that returned [] now prints that line; a
// packet with no intentions array at all never claims "none".
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import SundayPacket from './SundayPacket'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'Demo Church', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const BASE = {
  parish: 'Demo Church', date: '2026-10-25',
  plan: { title: 'Sunday Mass', elements: [] },
  serving: [{ title: 'Sunday Mass', start_time: '10:00:00', assigned: [] }],
  bulletin: null, lectionary: null, liturgical: null,
}

function view(packet) {
  vi.stubGlobal('fetch', vi.fn(async () => ok(packet)))
  return render(
    <MemoryRouter initialEntries={['/packet?date=2026-10-25']}>
      <LocaleProvider>
        <Routes><Route path="/packet" element={<SundayPacket />} /></Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => { vi.unstubAllGlobals() })

describe('Sunday Packet with no intentions (SP-100)', () => {
  it('keeps the section and says no intention is booked', async () => {
    view({ ...BASE, intentions: [] })
    expect(await screen.findByText(/Intentions for the Week/)).toBeTruthy()
    expect(screen.getByText('No intention booked for this week.')).toBeTruthy()
  })

  it('does not print the "none" line when intentions exist', async () => {
    view({ ...BASE, intentions: [{ formatted_intention: 'For the parish', mass_date: '2026-10-25', mass_title: 'Sunday Mass', mass_time: '10:00:00', status: 'scheduled' }] })
    expect(await screen.findByText(/For the parish/)).toBeTruthy()
    expect(screen.queryByText('No intention booked for this week.')).toBeNull()
  })

  it('never claims "none" when the packet carried no intentions list', async () => {
    const { intentions, ...noList } = { ...BASE, intentions: null }
    view(noList)
    expect((await screen.findAllByText(/Sunday Mass/)).length).toBeGreaterThan(0)
    expect(screen.queryByText('No intention booked for this week.')).toBeNull()
  })
})
