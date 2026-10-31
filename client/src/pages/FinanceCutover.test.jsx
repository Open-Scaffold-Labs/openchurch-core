// Cutover scoreboard: UNKNOWN must never render as $0.00, and the
// sign-off form appears only when every line is a complete match.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import FinanceCutover from './FinanceCutover'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } }, token: 't', loading: false }),
}))

const line = (key, status, oc, old, v, mis = 0) => ({ key, status, openchurch_cents: oc, old_system_cents: old, variance_cents: v, mismatched_accounts: mis })
const READY = { as_of: '2027-06-30', complete: true, cutover_ready: true, errors: [],
  lines: ['cash', 'receivables', 'deposits', 'payables', 'trial_balance'].map(k => line(k, 'match', 1000, 1000, 0)) }
const INCOMPLETE = { as_of: '2027-06-30', complete: false, cutover_ready: false, errors: [{ row: 3 }],
  lines: ['cash', 'receivables', 'deposits', 'payables', 'trial_balance'].map(k => line(k, 'incomplete', 0, null, null)) }

function mockFetch(board) {
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).endsWith('/signoffs') ) return { ok: true, json: async () => ({ signoffs: [] }) }
    return { ok: true, json: async () => board }
  })
}
const renderPage = () => render(<MemoryRouter><LocaleProvider><ToastProvider><FinanceCutover /></ToastProvider></LocaleProvider></MemoryRouter>)
async function runBoard() {
  fireEvent.change(screen.getByLabelText('Old system trial balance (CSV)'), { target: { value: 'account_code,amount\n1110,10.00' } })
  fireEvent.change(screen.getAllByLabelText('As of')[0], { target: { value: '2027-06-30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run scoreboard' }))
  await screen.findByText('Scoreboard as of 2027-06-30')
}

describe('FinanceCutover', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows UNKNOWN, never $0.00, for an incomplete file, and no sign-off form', async () => {
    mockFetch(INCOMPLETE); renderPage(); await runBoard()
    const cash = within(screen.getByTestId('line-cash'))
    expect(cash.getAllByText('UNKNOWN')).toHaveLength(2)
    expect(screen.getByRole('status').textContent).toMatch(/Incomplete: 1 row/)
    expect(screen.queryByRole('button', { name: 'Record sign-off' })).toBeNull()
  })

  it('offers the sign-off only when cutover ready', async () => {
    mockFetch(READY); renderPage(); await runBoard()
    expect(screen.getByRole('status').textContent).toMatch(/Cutover ready/)
    expect(within(screen.getByTestId('line-trial_balance')).getByText('Match')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Record sign-off' })).toBeTruthy()
    await waitFor(() => expect(screen.getByText('No sign-off recorded yet.')).toBeTruthy())
  })

  it('Atlas P1-1: says it is a staff record, never a signature, in form and history', async () => {
    globalThis.fetch = vi.fn(async (url) => String(url).endsWith('/signoffs')
      ? { ok: true, json: async () => ({ signoffs: [{ id: 1, accountant_name: 'Ana Ruiz', signed_on: '2027-07-01', as_of: '2027-06-30', recorded_by_name: 'Treasurer' }] }) }
      : { ok: true, json: async () => READY })
    renderPage(); await runBoard()
    expect(screen.getByText(/This is a staff record, not the accountant's signature\./)).toBeTruthy()
    expect(screen.getByText('Date the accountant confirmed')).toBeTruthy()
    expect(await screen.findByText('Treasurer recorded that Ana Ruiz confirmed on 2027-07-01 the books as of 2027-06-30')).toBeTruthy()
    expect(screen.queryByText(/signed/i)).toBeNull()
  })
})
