// SP-092 (Saint S4): Help finds "collection"; a confirmed count says
// "Confirmed" in words; the list has a server-applied From/To filter;
// the row no longer hides its actions behind hover on phones.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import HelpPanel from '../components/HelpPanel'
import Donations from './Donations'
import { MODULE_HELP, buildSearchIndex } from '../data/helpContent'
import { cashCountsUrl } from './Donations'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (b) => ({ ok: true, status: 200, json: async () => b })
const CONFIRMED = { id: 81, status: 'confirmed', verification: 'two_person', confirmed_by_name: 'Joseph',
  service_name: 'Sunday 10am', service_date: '2026-10-18', category: 'offertory',
  counted_by: 'Margaret', counted_by_user_id: 2, total: '120.00' }
const PENDING = { id: 82, status: 'pending', service_name: 'Vigil', service_date: '2026-09-06',
  category: 'offertory', counted_by: 'Margaret', counted_by_user_id: 2, total: '40.00' }
let calls
function stub() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/cash-counts/void-requests')) return ok([])
    if (u.includes('/api/donations/cash-counts?')) return ok([CONFIRMED])
    if (u.includes('/api/donations/cash-counts')) return ok([CONFIRMED, PENDING])
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [] })
    if (u.includes('/api/donations/summary')) return ok({ summary: null })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/donations')) return ok([])
    return ok({})
  }))
}
const view = () => render(
  <MemoryRouter initialEntries={['/donations']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Donations />
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)
beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale') })

describe('SP-092 rendered', () => {
  it('a confirmed count says Confirmed in text; a pending one says Pending', async () => {
    stub(); view()
    const row = await screen.findByTestId('cash-count-81', {}, { timeout: 4000 })
    expect(within(row).getByTestId('cash-count-status-81')).toHaveTextContent('Confirmed')
    expect(within(screen.getByTestId('cash-count-82')).getByTestId('cash-count-status-82')).toHaveTextContent('Pending')
  })

  it('From/To asks the server for that range and shows what it returns', async () => {
    stub(); view()
    await screen.findByTestId('cash-count-82', {}, { timeout: 4000 })
    fireEvent.change(screen.getByLabelText('Cash counts from date'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('Cash counts to date'), { target: { value: '2026-10-31' } })
    await waitFor(() => expect(calls).toContain('/api/donations/cash-counts?from=2026-10-01&to=2026-10-31'))
    await waitFor(() => expect(screen.queryByTestId('cash-count-82')).not.toBeInTheDocument())
    expect(screen.getByTestId('cash-count-81')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear dates' }))
    await waitFor(() => expect(screen.getByTestId('cash-count-82')).toBeInTheDocument())
  })

  it('a reversed range is refused in words and not sent', async () => {
    stub(); view()
    await screen.findByTestId('cash-count-82', {}, { timeout: 4000 })
    fireEvent.change(screen.getByLabelText('Cash counts to date'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('Cash counts from date'), { target: { value: '2026-10-01' } })
    expect(await screen.findByText(/The From date is after the To date/)).toBeInTheDocument()
    expect(calls).not.toContain('/api/donations/cash-counts?from=2026-10-01&to=2026-09-01')
  })

  it('row actions are not hover-only on phone widths', async () => {
    stub(); view()
    const row = await screen.findByTestId('cash-count-82', {}, { timeout: 4000 })
    const actions = within(row).getByRole('button', { name: 'Delete cash count' }).parentElement
    expect(actions.className).not.toMatch(/(^|\s)opacity-0/)
    expect(actions.className).toContain('sm:opacity-0')
    expect(row.className).toContain('flex-wrap')
  })

  it('Help search for "collection" shows the cash count topic', () => {
    render(<LocaleProvider><HelpPanel open onClose={() => {}} /></LocaleProvider>)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'collection' } })
    expect(screen.getAllByText(/Counting the collection \(cash count\)/).length).toBeGreaterThan(0)
  })
})

describe('SP-092 help search', () => {
  it('"collection" matches the cash-count help in Donations', () => {
    const hits = buildSearchIndex().filter(r =>
      `${r.title} ${r.text}`.toLowerCase().includes('collection'))
    expect(hits.some(r => r.id === 'donations' && /cash count/i.test(r.title))).toBe(true)
  })
  it('the help names the real controls', () => {
    const s = MODULE_HELP.donations.sections.find(x => /collection/i.test(x.title))
    expect(s.content).toContain('Cash Count')
    expect(s.content).toContain('Confirmed')
    expect(s.content).toContain('From and To')
  })
})

describe('SP-092 cashCountsUrl', () => {
  it('builds the range query only from what is set', () => {
    expect(cashCountsUrl('', '')).toBe('/api/donations/cash-counts')
    expect(cashCountsUrl('2026-10-01', '')).toBe('/api/donations/cash-counts?from=2026-10-01')
    expect(cashCountsUrl('', '2026-10-31')).toBe('/api/donations/cash-counts?to=2026-10-31')
    expect(cashCountsUrl('2026-10-01', '2026-10-31')).toBe('/api/donations/cash-counts?from=2026-10-01&to=2026-10-31')
  })
})
