// SP-188 — two plans on one date. The packet printed only the oldest,
// and the packet opened from plan 56 showed plan 55. The planner gave
// no word that the date already had a plan, and the rail rows looked alike.

import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import SundayPacket from './SundayPacket'
import ServicePlanner from './ServicePlanner'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'Demo Church', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))
vi.mock('../components/ToastProvider', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }),
}))
vi.mock('../components/ConfirmProvider', () => ({ useConfirm: () => async () => false }))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const P55 = { id: 55, title: 'Vigil Mass', elements: [{ position: 1, kind: 'hymn', title: 'Vigil hymn' }] }
const P56 = { id: 56, title: 'Sunday 10:00 Mass', elements: [{ position: 1, kind: 'hymn', title: 'Ten hymn' }] }
const base = { parish: 'Demo Church', date: '2026-11-01', serving: [], intentions: [], bulletin: null, lectionary: null, liturgical: null }

function packetAt(entry, locale) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  const fetchMock = vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('plan_id=56')) return ok({ ...base, plan: P56, plans: [P55, P56], plan_id: 56 })
    return ok({ ...base, plan: P55, plans: [P55, P56], plan_id: null })
  })
  vi.stubGlobal('fetch', fetchMock)
  render(
    <MemoryRouter initialEntries={[entry]}>
      <LocaleProvider><Routes><Route path="/packet" element={<SundayPacket />} /></Routes></LocaleProvider>
    </MemoryRouter>,
  )
  return fetchMock
}

beforeEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

describe('SP-188 Sunday Packet with two plans on one date', () => {
  it('a date packet prints every plan, not only the oldest', async () => {
    packetAt('/packet?date=2026-11-01')
    expect(await screen.findByText('Ten hymn')).toBeInTheDocument()
    expect(screen.getByText('Vigil hymn')).toBeInTheDocument()
    expect(screen.getByTestId('pkt-multi-plan')).toBeInTheDocument()
  })

  it('a packet opened from plan 56 asks for and shows plan 56', async () => {
    const f = packetAt('/packet?date=2026-11-01&plan=56&from=planner')
    expect(await screen.findByText('Ten hymn')).toBeInTheDocument()
    expect(screen.queryByText('Vigil hymn')).not.toBeInTheDocument()
    expect(String(f.mock.calls[0][0])).toContain('plan_id=56')
    // the other plan is offered, never silently dropped
    expect(screen.getByTestId('pkt-show-all')).toBeInTheDocument()
  })

  it('Spanish copy for the multi-plan line', async () => {
    packetAt('/packet?date=2026-11-01', 'es')
    const line = await screen.findByTestId('pkt-multi-plan')
    expect(line.textContent).toBe(STRINGS.es['pkt.multiPlan'].replace('{n}', '2'))
  })
})

describe('SP-188 Service Planner same-date plans', () => {
  const PLANS = [
    { id: 56, date: '2026-11-01', title: 'Sunday 10:00 Mass', element_count: 1, same_date_count: 2 },
    { id: 55, date: '2026-11-01', title: 'Vigil Mass', element_count: 1, same_date_count: 2 },
  ]
  function mount(locale) {
    if (locale) localStorage.setItem('ochr_locale', locale)
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      const m = u.match(/\/api\/service-plans\/(\d+)/)
      if (m) return ok({ ...PLANS.find(p => String(p.id) === m[1]), elements: [] })
      if (u.includes('/api/service-plans')) return ok({ plans: PLANS })
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/organization')) return ok({ name: 'St Test' })
      if (u.includes('/api/liturgical')) return ok({ season: null, feast_name: null, color: null })
      return ok(null)
    }))
    render(
      <MemoryRouter initialEntries={['/service-planner?date=2026-11-01']}>
        <LocaleProvider><ServicePlanner /></LocaleProvider>
      </MemoryRouter>,
    )
  }

  it('the packet button carries the plan id', async () => {
    mount()
    const link = await screen.findByRole('link', { name: new RegExp(STRINGS.en['plan.packet']) })
    expect(link.getAttribute('href')).toContain('plan=56')
  })

  it('a calm notice names the other plan on the same date', async () => {
    mount()
    const note = await screen.findByTestId('plan-same-date')
    expect(note.getAttribute('role')).toBe('status')
    expect(note.textContent).toContain('Vigil Mass')
  })

  it('the new-plan date shows a notice when that date has plans', async () => {
    mount()
    const note = await screen.findByTestId('plan-new-same-date')
    expect(note.textContent).toContain('Vigil Mass')
  })

  it('rail rows mark same-date plans (EN + ES)', async () => {
    mount('es')
    const marks = await screen.findAllByTestId('plan-row-same-date')
    expect(marks).toHaveLength(2)
    expect(marks[0].textContent).toBe(STRINGS.es['plan.sameDateN'].replace('{n}', '2'))
  })
})

// R406-1 — an empty plan prints "no parts yet"; it is never dropped.
describe('R406-1 empty plans are rendered, not omitted', () => {
  const E55 = { id: 55, title: 'Vigil Mass', elements: [] }
  const E56 = { id: 56, title: 'Sunday 10:00 Mass', elements: [] }
  function mountEmpty(entry, locale) {
    if (locale) localStorage.setItem('ochr_locale', locale)
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('plan_id=56')) return ok({ ...base, plan: E56, plans: [E55, E56], plan_id: 56 })
      return ok({ ...base, plan: E55, plans: [E55, E56], plan_id: null })
    }))
    render(
      <MemoryRouter initialEntries={[entry]}>
        <LocaleProvider><Routes><Route path="/packet" element={<SundayPacket />} /></Routes></LocaleProvider>
      </MemoryRouter>,
    )
  }
  for (const loc of ['en', 'es']) {
    const s = STRINGS[loc]
    it(`${loc}: two empty plans on one date both show with the no-parts line`, async () => {
      mountEmpty('/packet?date=2026-11-01', loc)
      await screen.findByTestId('pkt-multi-plan')
      const secs = screen.getAllByTestId('pkt-plan')
      expect(secs).toHaveLength(2)
      expect(secs[0]).toHaveTextContent('Vigil Mass')
      expect(secs[1]).toHaveTextContent('Sunday 10:00 Mass')
      for (const sec of secs) expect(sec).toHaveTextContent(s['pkt.planEmpty'])
      expect(screen.queryByTestId('pkt-no-plan')).not.toBeInTheDocument()
      expect(screen.queryByText(s['pkt.noPlan'])).not.toBeInTheDocument()
    })
    it(`${loc}: a selected empty plan shows alone with the no-parts line`, async () => {
      mountEmpty('/packet?date=2026-11-01&plan=56', loc)
      await screen.findByTestId('pkt-show-all')
      const secs = screen.getAllByTestId('pkt-plan')
      expect(secs).toHaveLength(1)
      expect(secs[0]).toHaveTextContent('Sunday 10:00 Mass')
      expect(secs[0]).toHaveTextContent(s['pkt.planEmpty'])
      expect(screen.queryByText('Vigil Mass')).not.toBeInTheDocument()
      expect(screen.queryByTestId('pkt-no-plan')).not.toBeInTheDocument()
    })
  }
})
