// Decision 8 (José, 2026-10-19): fulfilled Mass-intention history is kept.
// The book offers no delete on a fulfilled, previously recorded, or voided
// row, marks a voided row, and shows the server's refusal sentence.
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions, { isIntentionHistory } from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const base = { requested_by: 'Synthetic family', requested_by_client_id: null, stipend: null, note: null }
const ROWS = [
  { ...base, id: 1, intention: 'Open row', mass_date: null, status: 'open' },
  { ...base, id: 2, intention: 'Fulfilled row', mass_date: '2032-04-01', mass_title: 'Sunday Mass', status: 'fulfilled' },
  { ...base, id: 3, intention: 'Voided row', mass_date: null, status: 'cancelled', voided_at: '2032-04-02T10:00:00Z' },
]
const { en, es } = STRINGS

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/api/mass-intentions?')) return ok({ intentions: ROWS })
    return ok([])
  }))
})
afterEach(() => vi.unstubAllGlobals())

const book = () => render(<MemoryRouter initialEntries={['/mass-intentions']}><LocaleProvider><Routes><Route path="/mass-intentions" element={<ToastProvider><ConfirmProvider><MassIntentions /></ConfirmProvider></ToastProvider>} /></Routes></LocaleProvider></MemoryRouter>)

describe('Decision 8 — fulfilled history in the book', () => {
  it('EN and ES refusal copy exist and differ', () => {
    for (const k of ['mi.fulfilledLocked', 'mi.fulfilledHistory', 'mi.voidedLocked', 'mi.voided']) {
      expect(en[k], k).toBeTruthy(); expect(es[k], k).toBeTruthy(); expect(es[k], k).not.toBe(en[k])
    }
  })

  it('history rows are recognised', () => {
    expect(isIntentionHistory(ROWS[0])).toBe(false)
    expect(isIntentionHistory(ROWS[1])).toBe(true)
    expect(isIntentionHistory(ROWS[2])).toBe(true)
    expect(isIntentionHistory({ status: 'open', fulfilment_label: 'previously recorded fulfilment' })).toBe(true)
    // R339-1: a reopened legacy row (no stamp, no label) is still history.
    expect(isIntentionHistory({ status: 'open', entered_history: true })).toBe(true)
    expect(isIntentionHistory({ status: 'open', entered_history: false })).toBe(false)
  })

  it('only the open row offers delete; the voided row is marked', async () => {
    book()
    const openRow = (await screen.findAllByText('Open row'))[0].closest('tr')
    const fulfilledRow = screen.getAllByText('Fulfilled row')[0].closest('tr')
    const voidedRow = screen.getAllByText('Voided row')[0].closest('tr')
    expect(within(openRow).queryByRole('button', { name: en['mi.delete'] })).toBeInTheDocument()
    expect(within(fulfilledRow).queryByRole('button', { name: en['mi.delete'] })).not.toBeInTheDocument()
    expect(within(voidedRow).queryByRole('button', { name: en['mi.delete'] })).not.toBeInTheDocument()
    expect(within(voidedRow).getByTestId('mi-voided')).toHaveTextContent(en['mi.voided'])
  })
})
