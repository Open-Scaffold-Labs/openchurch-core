// The server speaks canonical English liturgical tokens ('Ordinary Time',
// 'Green'). Four surfaces printed them raw, so a Spanish parish read
// "Ordinary Time · Green" and an Episcopal parish read "Ordinary Time"
// where its own practice says "Season after Pentecost":
//   - Schedule event modal, the liturgical chip under the date
//   - AI Studio, the preach-date chip (season and color)
//   - AI Studio, the liturgical suggestion chip and the prompt it seeds
//   - Bulletin editor, the auto-pulled liturgical chip
// They now resolve the token at display time with seasonLabel/colorLabel,
// the same helpers the Sacristy List and Service Planner already use.
// Unknown tokens still pass through unchanged. jsdom only.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from './index'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import LiturgicalSuggestion from '../components/LiturgicalSuggestion'
import { EventModal } from '../pages/Schedule'
import AI from '../pages/AI'
import Bulletin from '../pages/Bulletin'

let ORG = { id: 1, name: 'St Test', locale: 'en' }
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: ORG },
    token: 't', loading: false, canWrite: true, isAdmin: true, isViewer: false,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
let LIT = { season: 'Ordinary Time', color: 'Green', feast_name: null, ordinary_block: 'after_pentecost' }
function stub() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/liturgical')) return ok(LIT)
    if (u.includes('/api/bulletins')) return ok({ bulletins: [] })
    if (u.includes('/api/calendar/conflicts')) return ok({ conflicts: [] })
    if (u.includes('/api/availability')) return ok({ unavailable: [] })
    if (u.includes('/api/invoices')) return ok({ invoices: [] })
    if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
    return ok({})
  }))
}

const wrap = (node) => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    {node}
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

beforeEach(() => {
  vi.unstubAllGlobals()
  try { localStorage.clear() } catch { /* jsdom */ }
  ORG = { id: 1, name: 'St Test', locale: 'en' }
  LIT = { season: 'Ordinary Time', color: 'Green', feast_name: null, ordinary_block: 'after_pentecost' }
  stub()
})

const EVENT = { id: 17, title: 'Vigil', date: '2026-11-04', start_time: '08:00', end_time: '09:00', type: 'meeting', assigned_to: [] }

describe('Schedule event modal liturgical chip', () => {
  it('CONTROL: an English Roman parish still reads Ordinary Time', async () => {
    wrap(<EventModal event={EVENT} onClose={() => {}} onSave={() => {}} members={[]} />)
    expect(await screen.findByText('Ordinary Time')).toBeInTheDocument()
  })
  it('a Spanish parish reads Tiempo Ordinario, not the English token', async () => {
    ORG = { ...ORG, locale: 'es' }
    wrap(<EventModal event={EVENT} onClose={() => {}} onSave={() => {}} members={[]} />)
    expect(await screen.findByText('Tiempo Ordinario')).toBeInTheDocument()
    expect(screen.queryByText('Ordinary Time')).not.toBeInTheDocument()
  })
  it('an Episcopal parish reads its own name for counted time', async () => {
    ORG = { ...ORG, tradition: 'episcopal' }
    wrap(<EventModal event={EVENT} onClose={() => {}} onSave={() => {}} members={[]} />)
    expect(await screen.findByText('Season after Pentecost')).toBeInTheDocument()
    expect(screen.queryByText('Ordinary Time')).not.toBeInTheDocument()
  })
  it('an unknown season token passes through unchanged', async () => {
    ORG = { ...ORG, locale: 'es' }
    LIT = { season: 'Parish Jubilee', color: 'White' }
    wrap(<EventModal event={EVENT} onClose={() => {}} onSave={() => {}} members={[]} />)
    expect(await screen.findByText('Parish Jubilee')).toBeInTheDocument()
  })
})

describe('AI Studio liturgical suggestion chip', () => {
  it('a Spanish parish sees and seeds Tiempo Ordinario', async () => {
    ORG = { ...ORG, locale: 'es' }
    const onUse = vi.fn()
    wrap(<LiturgicalSuggestion type="sermon" prompt="" onUse={onUse} />)
    const chip = await screen.findByRole('button', { name: /Tiempo Ordinario/ })
    expect(chip.textContent).not.toMatch(/Ordinary Time/)
    fireEvent.click(chip)
    expect(onUse).toHaveBeenCalledTimes(1)
    expect(onUse.mock.calls[0][0]).toMatch(/Tiempo Ordinario/)
    expect(onUse.mock.calls[0][0]).not.toMatch(/Ordinary Time/)
  })
  it('a feast name still wins over the season', async () => {
    ORG = { ...ORG, locale: 'es' }
    LIT = { season: 'Ordinary Time', color: 'White', feast_name: 'All Saints', ordinary_block: 'after_pentecost' }
    wrap(<LiturgicalSuggestion type="sermon" prompt="" onUse={() => {}} />)
    expect(await screen.findByRole('button', { name: /All Saints/ })).toBeInTheDocument()
  })
})

describe('AI Studio preach-date chip', () => {
  it('a Spanish parish reads season and color in Spanish', async () => {
    ORG = { ...ORG, locale: 'es' }
    const { container } = wrap(<AI />)
    const input = await waitFor(() => {
      const el = container.querySelector('input[type="date"]')
      if (!el) throw new Error('no date input yet')
      return el
    })
    await act(async () => { fireEvent.change(input, { target: { value: '2026-11-08' } }) })
    expect(await screen.findByText(/Tiempo Ordinario\s*·\s*Verde/)).toBeInTheDocument()
    expect(screen.queryByText(/Ordinary Time\s*·\s*Green/)).not.toBeInTheDocument()
  })
})

describe('Bulletin editor liturgical chip', () => {
  it('CONTROL: English Roman parish reads Ordinary Time', async () => {
    wrap(<Bulletin />)
    expect(await screen.findByText('Ordinary Time')).toBeInTheDocument()
  })
  it('a Spanish parish reads Tiempo Ordinario', async () => {
    ORG = { ...ORG, locale: 'es' }
    wrap(<Bulletin />)
    expect(await screen.findByText('Tiempo Ordinario')).toBeInTheDocument()
    expect(screen.queryByText('Ordinary Time')).not.toBeInTheDocument()
  })
})
