// SP-266 / SP-267 / SP-269 / SP-270 — stipend follow-up UI (José 2026-10-28).
// SP-268 Release deferred 2026-10-28 3:44 PM PT.
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions from './MassIntentions'
import { parishTodayIso } from '../utils/markSaid'

const auth = vi.hoisted(() => ({ role: 'admin' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1, name: 'Secretary', role: auth.role,
      organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic', timezone: 'America/Los_Angeles' },
    },
    token: 't', loading: false, canWrite: auth.role !== 'viewer', isAdmin: auth.role === 'admin',
  }),
}))

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const { en, es } = STRINGS
const today = parishTodayIso('America/Los_Angeles')

const OPEN = {
  id: 101, intention: 'Open walk-in', requested_by: 'Teresa', requested_by_client_id: null,
  mass_date: '2026-11-01', stipend: '10.00', received_date: '2026-10-28', payment_method: 'cash',
  status: 'open', note: null, voided_at: null, open_stipend_liability: '10.00',
}
const FULFILLED = {
  id: 102, intention: 'Said Mass intention', requested_by: 'Teresa', requested_by_client_id: null,
  mass_date: '2026-10-04', stipend: '10.00', received_date: '2026-10-03', payment_method: 'cash',
  status: 'fulfilled', note: null, voided_at: null, open_stipend_liability: '10.00',
  fulfilled_mass_date: '2026-10-04', entered_history: true,
}
const VOIDED_HELD = {
  id: 103, intention: 'Cancelled held', requested_by: 'Teresa', requested_by_client_id: null,
  mass_date: '2026-10-10', stipend: '10.00', received_date: '2026-10-09', payment_method: 'cash',
  status: 'cancelled', note: null, voided_at: '2026-10-28T12:00:00Z', void_reason: 'test',
  open_stipend_liability: '10.00', was_fulfilled: false,
}
// F468-1: fulfilled-then-voided without fulfilment_label must not offer Disposition.
const FULFILLED_VOIDED = {
  id: 104, intention: 'Said then voided', requested_by: 'Teresa', requested_by_client_id: null,
  mass_date: '2026-10-04', stipend: '10.00', received_date: '2026-10-03', payment_method: 'cash',
  status: 'cancelled', note: null, voided_at: '2026-10-28T12:00:00Z', void_reason: 'error',
  open_stipend_liability: '10.00', was_fulfilled: true, entered_history: true,
}

const wrap = (node, entry = '/mass-intentions') => render(
  <MemoryRouter initialEntries={[entry]}>
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Routes><Route path="/mass-intentions" element={node} /></Routes>
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  </MemoryRouter>,
)

let calls
beforeEach(() => {
  auth.role = 'admin'
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
    const u = String(url)
    if (u.includes('/api/mass-intentions?')) return ok({ intentions: [OPEN, FULFILLED, VOIDED_HELD, FULFILLED_VOIDED] })
    if (u.includes('/api/events')) return ok([])
    if (u.match(/\/api\/mass-intentions\/\d+\/(void|disposition)$/)) return ok({ ok: true })
    if (u.endsWith('/api/mass-intentions') && init?.method === 'POST') {
      return ok({ id: 999, ...JSON.parse(init.body), status: 'open' }, 201)
    }
    return ok([])
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('SP-269 source label', () => {
  it('EN and ES label fin.src_mass_stipend (not the raw key)', () => {
    expect(en['fin.src_mass_stipend']).toBe('Mass stipend')
    expect(es['fin.src_mass_stipend']).toBe('Estipendio de Misa')
    expect(en['fin.src_mass_stipend']).not.toBe('fin.src_mass_stipend')
  })
})

describe('SP-266 received date + payment method on the form', () => {
  it('Add form defaults received date to parish today and shows method', async () => {
    wrap(<MassIntentions />)
    await screen.findByText('Open walk-in')
    fireEvent.click(screen.getByRole('button', { name: en['mi.add'] }))
    const received = await screen.findByTestId('mi-received-date')
    expect(received).toHaveValue(today)
    expect(screen.getByTestId('mi-payment-method')).toHaveValue('cash')
  })

  it('client refuses save when stipend set without received date', async () => {
    wrap(<MassIntentions />)
    await screen.findByText('Open walk-in')
    fireEvent.click(screen.getByRole('button', { name: en['mi.add'] }))
    fireEvent.change(screen.getByLabelText(en['mi.intention']), { target: { value: 'For Joseph' } })
    fireEvent.change(screen.getByLabelText(en['mi.offering']), { target: { value: '10' } })
    fireEvent.change(await screen.findByTestId('mi-received-date'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: en['mi.save'] }))
    expect(await screen.findByRole('alert')).toHaveTextContent(en['mi.receivedRequired'])
    expect(calls.filter(c => c.method === 'POST' && c.url.endsWith('/api/mass-intentions'))).toHaveLength(0)
  })
})

describe('SP-267 admin void and disposition (SP-268 Release deferred)', () => {
  it('admin sees Void and Disposition; no Release; staff sees neither', async () => {
    wrap(<MassIntentions />)
    await screen.findByText('Open walk-in')
    // Open row still offers Void; fulfilled+held 2330 does not (N449-3).
    expect(screen.getAllByTestId('mi-void')).toHaveLength(1)
    expect(screen.getByTestId('mi-disposition')).toBeInTheDocument()
    expect(screen.queryByTestId('mi-release')).not.toBeInTheDocument()

    cleanup()
    auth.role = 'staff'
    wrap(<MassIntentions />)
    await screen.findByText('Open walk-in')
    // Staff can edit/delete but not void/disposition
    expect(screen.queryByTestId('mi-void')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mi-disposition')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mi-release')).not.toBeInTheDocument()
  })

  it('void panel posts reason + disposition', async () => {
    wrap(<MassIntentions />)
    await screen.findByText('Open walk-in')
    fireEvent.click(screen.getAllByTestId('mi-void')[0])
    const panel = await screen.findByTestId('mi-stipend-action')
    fireEvent.change(within(panel).getByTestId('mi-void-reason'), { target: { value: 'Duplicate entry' } })
    fireEvent.change(within(panel).getByTestId('mi-disposition-kind'), { target: { value: 'refunded' } })
    fireEvent.click(within(panel).getByTestId('mi-stipend-action-confirm'))
    await waitFor(() => {
      const post = calls.find(c => c.method === 'POST' && c.url.includes('/void'))
      expect(post?.body?.reason).toBe('Duplicate entry')
      expect(post?.body?.disposition?.kind).toBe('refunded')
    })
  })

  it('N449-3: no Void on fulfilled row with held stipend; EN/ES refuse copy', async () => {
    wrap(<MassIntentions />)
    await screen.findByText('Said Mass intention')
    // Only the open row's Void button is present
    const voids = screen.getAllByTestId('mi-void')
    expect(voids).toHaveLength(1)
    // Fulfilled row text is present but no per-row void next to it via count
    expect(screen.getByText('Said Mass intention')).toBeInTheDocument()
    expect(en['mi.voidFulfilledHeld']).toMatch(/fulfilled Mass intention with a held stipend cannot be voided yet/i)
    expect(es['mi.voidFulfilledHeld']).toMatch(/intención de Misa cumplida con un estipendio retenido/i)
    expect(en['mi.voidFulfilledHeld']).not.toBe(es['mi.voidFulfilledHeld'])
  })
})
