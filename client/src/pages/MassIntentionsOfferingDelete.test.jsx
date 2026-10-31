// SP-133 (José adopted TARS #62 comment 6380227296 item 3, 2026-10-23):
// once an offering amount is recorded, the book offers no delete for any
// role, and a server refusal shows the honest sentence pointing to Void.
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions, { hasRecordedOffering } from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const base = { requested_by: 'Synthetic family', requested_by_client_id: null, note: null, mass_date: null, status: 'open' }
const ROWS = [
  { ...base, id: 1, intention: 'No offering row', stipend: null },
  { ...base, id: 2, intention: 'Offering row', stipend: '10.00' },
  { ...base, id: 3, intention: 'Zero offering row', stipend: '0.00' },
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

describe('SP-133 — recorded offering blocks delete in the book', () => {
  it('EN and ES copy exist, differ, and point to void / correct', () => {
    for (const k of ['mi.offeringRecordedDelete', 'mi.offeringClearRefused']) {
      expect(en[k], k).toBeTruthy(); expect(es[k], k).toBeTruthy(); expect(es[k], k).not.toBe(en[k])
    }
    expect(en['mi.offeringRecordedDelete']).toMatch(/void it with a reason/)
    expect(es['mi.offeringRecordedDelete']).toMatch(/anularla/)
  })

  it('null is no offering; an explicit 0.00 is a recorded offering', () => {
    expect(hasRecordedOffering({ stipend: null })).toBe(false)
    expect(hasRecordedOffering({})).toBe(false)
    expect(hasRecordedOffering({ stipend: '0.00' })).toBe(true)
    expect(hasRecordedOffering({ stipend: 0 })).toBe(true)
    expect(hasRecordedOffering({ stipend: '10.00' })).toBe(true)
  })

  it('only the no-offering row offers delete', async () => {
    book()
    const none = (await screen.findAllByText('No offering row'))[0].closest('tr')
    const offered = screen.getAllByText('Offering row')[0].closest('tr')
    const zero = screen.getAllByText('Zero offering row')[0].closest('tr')
    expect(within(none).queryByRole('button', { name: en['mi.delete'] })).toBeInTheDocument()
    expect(within(offered).queryByRole('button', { name: en['mi.delete'] })).not.toBeInTheDocument()
    expect(within(zero).queryByRole('button', { name: en['mi.delete'] })).not.toBeInTheDocument()
  })
})
