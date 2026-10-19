// LOCALE-L1-12 — Sunday Packet Mass/serving clock follows the language.
// Hard-coded AM/PM printed English on a Spanish packet.
//
// Mutate any one of these and the matching test goes red:
//   1. fmtTime concatenates 'AM' / 'PM'
//   2. Serving line ignores dateLocale
//   3. Intention mass_time ignores dateLocale

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import SundayPacket, { fmtTime } from './SundayPacket'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKET_SRC = readFileSync(join(HERE, 'SundayPacket.jsx'), 'utf8')
const jsx = PACKET_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'Demo Church', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

const PACKET = {
  parish: 'Demo Church',
  date: '2026-09-13',
  plan: { title: 'Sunday Mass', elements: [] },
  serving: [{ title: 'Sunday Mass', start_time: '09:00:00', assigned: [] }],
  intentions: [{
    formatted_intention: 'For the parish',
    mass_date: '2026-09-14',
    mass_title: 'Daily Mass',
    mass_time: '09:00:00',
    status: 'scheduled',
  }],
  bulletin: null,
  lectionary: null,
  liturgical: null,
}

function view() {
  return render(
    <MemoryRouter initialEntries={['/packet?date=2026-09-13']}>
      <LocaleProvider>
        <Routes>
          <Route path="/packet" element={<SundayPacket />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/api/packet')) return ok(PACKET)
    return ok({})
  }))
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('LOCALE-L1-12 Sunday Packet time', () => {
  it('fmtTime uses toLocaleTimeString — hard-coded AM/PM goes red', () => {
    expect(PACKET_SRC).toMatch(/toLocaleTimeString\(dateLocale/)
    expect(jsx).not.toMatch(/['"]AM['"]/)
    expect(jsx).not.toMatch(/['"]PM['"]/)
    expect(fmtTime('09:00:00', 'en-US')).toMatch(/9:00/)
    expect(fmtTime('21:30:00', 'en-US')).toMatch(/9:30/)
    expect(fmtTime(null)).toBeNull()
  })

  it('EN serving line shows a morning clock', async () => {
    view()
    expect(await screen.findByText(/Sunday Mass/)).toBeInTheDocument()
    expect(screen.getAllByText(/9:00/).length).toBeGreaterThan(0)
  })

  it('SPANISH NINE O\'CLOCK IS NOT THE HARD-EN AM/PM PAIR', async () => {
    localStorage.setItem('ochr_locale', 'es')
    view()
    expect(await screen.findByText(/Daily Mass/)).toBeInTheDocument()
    const en = fmtTime('09:00:00', 'en-US')
    const es = fmtTime('09:00:00', 'es')
    expect(es).toBeTruthy()
    expect(es).not.toBe(en)
    expect(screen.queryByText(/9:00\s*AM/i)).toBeNull()
  })

  it('call sites pass dateLocale into fmtTime', () => {
    expect(PACKET_SRC).toMatch(/fmtTime\(s\.start_time,\s*dateLocale\)/)
    expect(PACKET_SRC).toMatch(/fmtTime\(r\.mass_time,\s*dateLocale\)/)
  })
})
