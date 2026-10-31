// SP-087: the weekly sheet for a past week printed a scheduled intention
// whose Mass date had passed with only its offering ("$10.00"), while the
// book flags the same row "Past scheduled — fulfilment not recorded".
// The sheet now carries the same reminder, worded as in the book.
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import SacristySheet from './SacristySheet'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', timezone: 'America/Los_Angeles' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const ROWS = [
  { id: 1, mass_date: '2026-10-04', mass_title: 'Sunday Mass', mass_time: '09:00', status: 'scheduled', stipend: '10.00', formatted_intention: 'PAST SCHEDULED SAMPLE', requested_by: 'Sample' },
  { id: 2, mass_date: '2026-10-04', mass_title: 'Sunday Mass', mass_time: '11:00', status: 'fulfilled', stipend: '10.00', formatted_intention: 'FULFILLED SAMPLE', requested_by: 'Sample' },
  { id: 3, mass_date: '2026-10-30', mass_title: 'Weekday Mass', mass_time: '08:00', status: 'scheduled', stipend: '10.00', formatted_intention: 'FUTURE SAMPLE', requested_by: 'Sample' },
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-21T19:00:00Z'))
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/mass-intentions/weekly')) {
      return ok({ intentions: ROWS, timezone: 'America/Los_Angeles', generated_at: '2026-10-21T19:00:00Z', intention_total: ROWS.length })
    }
    if (u.includes('/api/liturgical')) return ok({ season: 'ordinary', color: 'green' })
    return ok({ date: null, undated_waiting: false, undated_waiting_count: 0 })
  }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('SP-087 weekly sheet past-scheduled marker', () => {
  it('a past scheduled row says fulfilment is not recorded, like the book; fulfilled and future rows do not', async () => {
    render(
      <MemoryRouter initialEntries={['/mass-intentions/print?start=2026-10-03']}>
        <LocaleProvider>
          <Routes><Route path="/mass-intentions/print" element={<SacristySheet />} /></Routes>
        </LocaleProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('PAST SCHEDULED SAMPLE')).toBeInTheDocument())
    const markers = screen.queryAllByTestId('sheet-past-scheduled')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toHaveTextContent(STRINGS.en['mi.pastScheduled'])
    const pastRow = screen.getByText('PAST SCHEDULED SAMPLE').closest('li')
    expect(pastRow).toContainElement(markers[0])
    expect(pastRow).toHaveTextContent('$10.00')
    expect(screen.getByText('FULFILLED SAMPLE').closest('li')).not.toHaveTextContent(STRINGS.en['mi.pastScheduled'])
    expect(screen.getByText('FUTURE SAMPLE').closest('li')).not.toHaveTextContent(STRINGS.en['mi.pastScheduled'])
    for (const m of markers) expect(m.textContent).not.toMatch(/missed|said|celebrated/i)
  })
})
