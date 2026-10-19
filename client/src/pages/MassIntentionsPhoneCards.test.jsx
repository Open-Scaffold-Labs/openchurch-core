// SP-057 (MIN-20): at phone width (≤767px, the app shell's breakpoint) the
// intention book was a sideways-scrolling table: "Requested by" truncated
// and Offering/Status/Actions needed horizontal scroll. Phone now renders a
// card list of the SAME rows, fields and handlers. Only one layout is in the
// DOM. jsdom does not evaluate CSS, so this asserts structure via a stubbed
// matchMedia; no visual claim is made here.
import { ToastProvider } from '../components/ToastProvider'
import { render, screen, within, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions from './MassIntentions'

const authState = vi.hoisted(() => ({ canWrite: true, role: 'admin' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: authState.role, organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: authState.canWrite, isAdmin: authState.role === 'admin',
  }),
}))

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const LONG_REQUESTER = 'The Hernández-Villalobos family of Saint Brigid'
const ROWS = [
  { id: 15, intention: 'For a safe journey', note: 'Grandparents travelling', requested_by: LONG_REQUESTER, requested_by_client_id: null, mass_date: '2027-03-07', mass_title: 'Sunday Mass', mass_time: '10:00', status: 'scheduled', stipend: '15.00' },
  { id: 16, intention: 'For the parish', requested_by: null, requester_name: 'Synthetic Linked', requested_by_client_id: 7, mass_date: null, mass_title: null, status: 'fulfilled', stipend: null },
]

let mqListeners, mqMatches
function stubMatchMedia(matches) {
  mqListeners = []; mqMatches = matches
  vi.stubGlobal('matchMedia', vi.fn(q => ({
    get matches() { return q === '(max-width: 767px)' ? mqMatches : false },
    media: q,
    addEventListener: (_, fn) => mqListeners.push(fn),
    removeEventListener: (_, fn) => { mqListeners = mqListeners.filter(f => f !== fn) },
  })))
}
function stubFetch() {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url); calls.push({ u, init })
    if (/\/api\/mass-intentions\/\d+$/.test(u) && init.method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) }
    if (u.includes('/api/mass-intentions?')) return ok({ intentions: ROWS })
    return ok([])
  }))
  return calls
}
const book = () => render(<MemoryRouter initialEntries={['/mass-intentions']}><LocaleProvider><ToastProvider><Routes><Route path="/mass-intentions" element={<MassIntentions />} /></Routes></ToastProvider></LocaleProvider></MemoryRouter>)
const { en } = STRINGS

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale'); authState.canWrite = true; authState.role = 'admin' })
afterEach(() => vi.unstubAllGlobals())

describe('SP-057 phone card list', () => {
  it('phone: one card per row, no table, each card carries the full row fields', async () => {
    stubMatchMedia(true); stubFetch()
    book()
    const cards = await screen.findAllByTestId('mi-card')
    expect(cards).toHaveLength(ROWS.length)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    const [a, b] = cards
    expect(within(a).getByText('For a safe journey')).toBeInTheDocument()
    expect(within(a).getByText('Grandparents travelling')).toBeInTheDocument()
    expect(within(a).getByText(LONG_REQUESTER)).toBeInTheDocument()
    expect(within(a).getByText(/15/)).toBeInTheDocument()
    expect(within(a).getByText(en['mi.scheduled'])).toBeInTheDocument()
    expect(within(a).getByText(/Sunday Mass/)).toBeInTheDocument()
    for (const k of ['mi.requestedBy', 'mi.offeringShort', 'mi.status']) expect(within(a).getByText(en[k])).toBeInTheDocument()
    expect(within(b).getByText('Synthetic Linked')).toBeInTheDocument()
    expect(within(b).getByText(en['mi.fulfilled'])).toBeInTheDocument()
    expect(within(b).getByText(en['mi.massAsOfferedUnknown'])).toBeInTheDocument()
  })

  it('phone + canWrite: each card has edit and delete with the same labels and handlers', async () => {
    stubMatchMedia(true); const calls = stubFetch()
    vi.stubGlobal('confirm', () => true)
    book()
    const cards = await screen.findAllByTestId('mi-card')
    for (const c of cards) {
      expect(within(c).getByRole('button', { name: en['mi.edit'] })).toBeInTheDocument()
      expect(within(c).getByRole('button', { name: en['mi.delete'] })).toBeInTheDocument()
    }
    expect(screen.getAllByRole('button', { name: en['mi.edit'] })).toHaveLength(ROWS.length)
    fireEvent.click(within(cards[0]).getByRole('button', { name: en['mi.edit'] }))
    expect(await screen.findByDisplayValue('For a safe journey')).toBeInTheDocument()
  })

  it('phone + viewer: no edit or delete controls', async () => {
    authState.canWrite = false; authState.role = 'viewer'
    stubMatchMedia(true); stubFetch()
    book()
    await screen.findAllByTestId('mi-card')
    expect(screen.queryByRole('button', { name: en['mi.edit'] })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en['mi.delete'] })).not.toBeInTheDocument()
  })

  it('CONTROL desktop: the table, and no cards', async () => {
    stubMatchMedia(false); stubFetch()
    book()
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.queryByTestId('mi-cards')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: en['mi.edit'] })).toHaveLength(ROWS.length)
    expect(screen.getByText(en['mi.massAsOfferedUnknown'])).toBeInTheDocument()
  })

  it('crossing the breakpoint swaps layouts without refetching', async () => {
    stubMatchMedia(false); const calls = stubFetch()
    book()
    await screen.findByRole('table')
    const reads = calls.filter(c => c.u.includes('/api/mass-intentions?')).length
    await act(async () => { mqMatches = true; mqListeners.forEach(fn => fn({ matches: true })) })
    expect(await screen.findAllByTestId('mi-card')).toHaveLength(ROWS.length)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(calls.filter(c => c.u.includes('/api/mass-intentions?')).length).toBe(reads)
  })
})

// R312-1 (TARS on #312 at a61966fb): an unbroken requester or Mass title
// pushed the card's 1fr grid track (automatic min = min-content) past the
// card. jsdom cannot measure layout, so this pins the CSS contract that the
// built-app 390px check (/workspace/oc-312-review) measured; the visual
// proof is that check, not this test.
describe('R312-1 phone card is bounded for unbroken stored text', () => {
  const UNBROKEN_REQ = 'TheHernandezVillalobosMontenegroFamilyOfSaintBrigidParishRequestingThisMass'
  const UNBROKEN_TITLE = 'SolemnHighMassOfThanksgivingForTheFeastOfSaintBrigidOfKildareAndAllTheSaintsOfIreland'
  const LONG = [{ id: 31, intention: 'For the repose of Synthetic One', requested_by: UNBROKEN_REQ, requested_by_client_id: null, mass_date: '2027-02-01', mass_title: UNBROKEN_TITLE, mass_time: '10:00', status: 'scheduled', stipend: '15.00' },
    { id: 32, intention: 'For a safe journey', requested_by: 'Synthetic Two', requested_by_client_id: null, mass_date: null, mass_title: null, status: 'open', stipend: '10.00' }]
  function stubLong() {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const u = String(url); calls.push({ u, init })
      if (/\/api\/mass-intentions\/\d+$/.test(u) && init.method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) }
      if (u.includes('/api/mass-intentions?')) return ok({ intentions: LONG })
      return ok([])
    }))
    return calls
  }

  it('the value track can shrink, unbroken text breaks anywhere, and actions do not shrink', async () => {
    stubMatchMedia(true); stubLong()
    book()
    const card = (await screen.findAllByTestId('mi-card'))[0]
    expect(card.className).toMatch(/(^|\s)min-w-0(\s|$)/)
    expect(card.className).toContain('[overflow-wrap:anywhere]')
    const fields = within(card).getByTestId('mi-card-fields')
    expect(fields.className).toContain('grid-cols-[auto_minmax(0,1fr)]')
    expect(fields.className).not.toMatch(/grid-cols-\[auto_1fr\]/)
    expect(within(card).getByText(UNBROKEN_REQ).className).toMatch(/(^|\s)min-w-0(\s|$)/)
    const mass = within(card).getByTestId('mi-card-mass')
    expect(mass.className).toMatch(/min-w-0/); expect(mass.className).toMatch(/flex-1/)
    expect(within(card).getByRole('button', { name: en['mi.delete'] }).closest('.shrink-0')).not.toBeNull()
    // Nothing truncated: the full stored values are in the card.
    expect(within(card).getByText(UNBROKEN_REQ)).toBeInTheDocument()
    expect(within(card).getByText(new RegExp(UNBROKEN_TITLE))).toBeInTheDocument()
  })

  it('CONTROL desktop: the table cells keep their existing classes (no wrapping change)', async () => {
    stubMatchMedia(false); stubLong()
    book()
    const table = await screen.findByRole('table')
    expect(table.innerHTML).not.toContain('overflow-wrap:anywhere')
    expect(table.innerHTML).not.toContain('minmax(0,1fr)')
  })

  it('phone Delete on a card deletes THAT card\'s intention id, once', async () => {
    stubMatchMedia(true); const calls = stubLong()
    book()
    const card = (await screen.findAllByTestId('mi-card')).find(c => within(c).queryByText('For a safe journey'))
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: en['mi.delete'] })) })
    await waitFor(() => expect(calls.filter(c => c.init.method === 'DELETE')).toHaveLength(1))
    expect(calls.find(c => c.init.method === 'DELETE').u).toMatch(/\/api\/mass-intentions\/32$/)
  })
})
