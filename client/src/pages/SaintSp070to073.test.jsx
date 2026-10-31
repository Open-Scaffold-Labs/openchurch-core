// Saint 2026-10-19 Monday probe: SP-070 (This week), SP-071 (unassigned
// tag on sheet + packet), SP-073 (weekday on Mass picker labels),
// MIN-37 (help finds "weekly sheet" and describes it truthfully).
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import SacristySheet from './SacristySheet'
import SundayPacket from './SundayPacket'
import HelpPanel from '../components/HelpPanel'
import { formatMassOptionLabel } from './MassIntentions'
import { MODULE_HELP, FAQ } from '../data/helpContent'
import { isUnassigned } from '../utils/intentionAssignment'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', timezone: 'UTC' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const { en, es } = STRINGS
const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const ROWS = [
  { id: 1, mass_date: '2026-10-25', status: 'open', calendar_event_id: null, formatted_intention: 'UNASSIGNED ROW' },
  { id: 2, mass_date: '2026-10-25', status: 'scheduled', calendar_event_id: 40, mass_title: 'Sunday Mass', mass_time: '10:00', formatted_intention: 'ASSIGNED ROW' },
  { id: 3, mass_date: '2026-10-24', status: 'fulfilled', calendar_event_id: null, formatted_intention: 'FULFILLED NO MASS' },
]

function stub() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/liturgical')) return ok(null)
    if (u.includes('/api/mass-intentions/weekly')) return ok({ intentions: ROWS, generated_at: '2026-10-19T19:00:00Z', timezone: 'UTC', intention_total: ROWS.length })
    if (u.includes('/api/packet')) return ok({ parish: 'St Test', date: '2026-10-25', plan: null, serving: [], intentions: ROWS, bulletin: null, lectionary: null, liturgical: null })
    return ok({})
  }))
}
const sheet = (path) => render(
  <MemoryRouter initialEntries={[path]}><LocaleProvider><Routes>
    <Route path="/mass-intentions/print" element={<SacristySheet />} />
  </Routes></LocaleProvider></MemoryRouter>)

beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-19T19:00:00Z')) // Monday
  stub()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('SP-070 This week', () => {
  it('is disabled on the default week and returns there from another week', async () => {
    sheet('/mass-intentions/print?start=2026-10-03')
    const btn = await screen.findByTestId('sheet-this-week')
    expect(btn).toHaveTextContent(en['sheet.thisWeek'])
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('sheet-this-week')).toBeDisabled())
    // Monday Oct 19 → the coming weekend: Saturday Oct 24 – Friday Oct 30.
    expect(screen.getByTestId('sheet-week-range').textContent).toMatch(/October 24/)
  })
})

describe('SP-071 unassigned intentions are marked, and still printed', () => {
  it('sheet', async () => {
    sheet('/mass-intentions/print?start=2026-10-24')
    expect(await screen.findByText('UNASSIGNED ROW')).toBeInTheDocument()
    const tags = screen.getAllByTestId('sheet-unassigned')
    expect(tags).toHaveLength(1)
    expect(tags[0]).toHaveTextContent(en['sheet.unassigned'])
    expect(tags[0].closest('li')).toHaveTextContent('UNASSIGNED ROW')
    expect(screen.getByText('ASSIGNED ROW')).toBeInTheDocument()
    expect(screen.getByText('FULFILLED NO MASS')).toBeInTheDocument()
  })
  it('packet', async () => {
    render(<MemoryRouter initialEntries={['/packet?date=2026-10-25']}><LocaleProvider><Routes>
      <Route path="/packet" element={<SundayPacket />} /></Routes></LocaleProvider></MemoryRouter>)
    expect(await screen.findByText(/UNASSIGNED ROW/)).toBeInTheDocument()
    const tags = screen.getAllByTestId('pkt-unassigned')
    expect(tags).toHaveLength(1)
    expect(tags[0]).toHaveTextContent(en['pkt.intentionUnassigned'])
    expect(tags[0].closest('li')).toHaveTextContent('UNASSIGNED ROW')
  })
  it('EN and ES keys exist and differ', () => {
    for (const k of ['sheet.thisWeek', 'sheet.unassigned', 'pkt.intentionUnassigned']) {
      expect(en[k]).toBeTruthy(); expect(es[k]).toBeTruthy(); expect(es[k]).not.toBe(en[k])
    }
  })
})

describe('SP-073 Mass picker labels carry the weekday', () => {
  const m = { id: 9, date: '2026-10-26', title: '[Sample] Sunday Mass', start_time: '10:00:00' }
  it('English and Spanish, from the stored calendar day', () => {
    expect(formatMassOptionLabel(m, 'en-US')).toBe('Mon, Oct 26, 2026 — [Sample] Sunday Mass (10:00)')
    expect(formatMassOptionLabel(m, 'es-ES')).toBe('lun, 26 oct 2026 — [Sample] Sunday Mass (10:00)')
  })
})

describe('MIN-37 help: weekly sheet', () => {
  it('a search for "weekly sheet" finds an entry', () => {
    render(<LocaleProvider><HelpPanel open onClose={() => {}} /></LocaleProvider>)
    fireEvent.change(screen.getByPlaceholderText(en['help.searchPh']), { target: { value: 'weekly sheet' } })
    expect(screen.queryByText(en['help.nothingFound'])).not.toBeInTheDocument()
    expect(screen.getAllByText(en['help.miWeeklySheetTitle']).length).toBeGreaterThan(0)
  })
  it('help no longer says the sheet lists the week\u2019s Masses', () => {
    const blob = JSON.stringify([MODULE_HELP.intentions, FAQ])
    expect(blob).not.toMatch(/week\\u2019s Masses and intentions|week’s Masses and intentions/)
    expect(en['help.miWeeklySheetBody']).toContain('does not list Masses that have no intention')
    expect(en['help.miWeeklySheetBody']).toContain(en['sheet.unassigned'])
    expect(es['help.miWeeklySheetBody']).toContain(es['sheet.unassigned'])
  })
})

// R331-1 / R331-2 (TARS review of #331).
const HIST = { id: 4, mass_date: '2026-10-25', status: 'open', calendar_event_id: null, fulfilment_label: 'previously recorded fulfilment', formatted_intention: 'HISTORICAL ROW' }
function stubWith(rows, serving = []) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/liturgical')) return ok(null)
    if (u.includes('/api/mass-intentions/weekly')) return ok({ intentions: rows, generated_at: '2026-10-19T19:00:00Z', timezone: 'UTC', intention_total: rows.length })
    if (u.includes('/api/packet')) return ok({ parish: 'St Test', date: '2026-10-25', plan: null, serving, intentions: rows, bulletin: null, lectionary: null, liturgical: null })
    return ok({})
  }))
}
const packet = () => render(<MemoryRouter initialEntries={['/packet?date=2026-10-25']}><LocaleProvider><Routes>
  <Route path="/packet" element={<SundayPacket />} /></Routes></LocaleProvider></MemoryRouter>)

describe.each([['en', en], ['es', es]])('R331 controls (%s)', (loc, S) => {
  beforeEach(() => { localStorage.setItem('ochr_locale', loc) })
  afterEach(() => { localStorage.removeItem('ochr_locale') })

  it('R331-1: an unstaffed serving slot keeps its wording; only the intention needs a Mass', async () => {
    stubWith([ROWS[0]], [{ title: 'SERVING SLOT', start_time: '10:00:00', assigned: [] }])
    packet()
    const slot = (await screen.findByText(/SERVING SLOT/)).closest('li')
    expect(slot).toHaveTextContent(S['pkt.unassigned'])
    expect(slot).not.toHaveTextContent(S['pkt.intentionUnassigned'])
    expect(S['pkt.unassigned']).not.toBe(S['pkt.intentionUnassigned'])
    const tags = screen.getAllByTestId('pkt-unassigned')
    expect(tags).toHaveLength(1)
    expect(tags[0]).toHaveTextContent(S['pkt.intentionUnassigned'])
    expect(tags[0].closest('li')).toHaveTextContent('UNASSIGNED ROW')
  })

  it('R331-2: a previously recorded fulfilment keeps its label on the packet, with no needs-a-Mass tag', async () => {
    stubWith([HIST, ...ROWS])
    packet()
    const row = (await screen.findByText(/HISTORICAL ROW/)).closest('li')
    expect(row).toHaveTextContent(S['pkt.previouslyRecorded'])
    expect(row.querySelector('[data-testid="pkt-unassigned"]')).toBeNull()
    expect(screen.getAllByTestId('pkt-unassigned')).toHaveLength(1)
  })

  it('R331-2: the same on the sheet', async () => {
    stubWith([HIST, ...ROWS])
    sheet('/mass-intentions/print?start=2026-10-24')
    const row = (await screen.findByText('HISTORICAL ROW')).closest('li')
    expect(row).toHaveTextContent(S['sheet.previouslyRecorded'])
    expect(row.querySelector('[data-testid="sheet-unassigned"]')).toBeNull()
    expect(screen.getAllByTestId('sheet-unassigned')).toHaveLength(1)
  })
})

describe('R331-2 isUnassigned uses known statuses only', () => {
  it('controls', () => {
    expect(isUnassigned({ status: 'open', calendar_event_id: null })).toBe(true)
    expect(isUnassigned({ status: 'scheduled', calendar_event_id: null })).toBe(true)
    expect(isUnassigned({ status: 'scheduled', calendar_event_id: 4 })).toBe(false)
    expect(isUnassigned({ status: 'fulfilled', calendar_event_id: null })).toBe(false)
    expect(isUnassigned({ status: 'cancelled', calendar_event_id: null })).toBe(false)
    expect(isUnassigned({ calendar_event_id: null })).toBe(false)
    expect(isUnassigned({ status: 'weird', calendar_event_id: null })).toBe(false)
    expect(isUnassigned({ status: 'open', calendar_event_id: null, mass_date: '2026-10-25', fulfilment_label: 'previously recorded fulfilment' })).toBe(false)
  })
})

describe('Help: Fulfilled status wording', () => {
  it('matches the approved how-to', () => {
    const blob = JSON.stringify(MODULE_HELP.intentions)
    expect(blob).toContain('Recorded as fulfilled in the intention book.')
    expect(blob).not.toContain('The Mass was celebrated.')
  })
})
