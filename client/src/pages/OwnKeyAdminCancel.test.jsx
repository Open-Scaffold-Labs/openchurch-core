// José, 2026-10-23:
//  (1) Own-key AI has no monthly limit: the meter and help copy must not
//      claim one.
//  (2) Cancelling a recurring gift or an invoice is admin-only. Staff see no
//      Cancel/Clear control and an honest note saying only an admin can.
import { render, screen, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import AiQuotaMeter from '../components/AiQuotaMeter'
import { MODULE_HELP, FAQ } from '../data/helpContent'
import Donations from './Donations'
import Offerings from './Offerings'

const who = vi.hoisted(() => ({ role: 'staff' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Sam', role: who.role, organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: who.role === 'admin',
  }),
}))

const ok = (b, status = 200) => ({ ok: status < 400, status, json: async () => b })
const wrap = (ui) => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

describe('own-key AI has no monthly limit', () => {
  it('meter says own key, no monthly limit, and shows no N / limit count', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({
      plan: 'free', used: 25, limit: null, remaining: null, exceeded: false, own_key: true,
      period_start: '2026-10-01T00:00:00.000Z', period_end: '2026-11-01T00:00:00.000Z',
    })))
    wrap(<AiQuotaMeter />)
    const pill = await screen.findByTestId('ai-quota-own-key')
    expect(pill).toHaveTextContent(STRINGS.en['quota.ownKey'])
    expect(screen.queryByText(/\/ 20/)).toBeNull()
    expect(screen.queryByText(STRINGS.en['quota.unlimited'])).toBeNull()
  })

  it('help copy does not claim a monthly AI limit', () => {
    const ai = MODULE_HELP['ai-studio']
    const text = [ai.overview, ...ai.features].join(' ')
    expect(text).not.toMatch(/20 on Free|500 on Parish|Monthly quota by plan/)
    expect(text).toMatch(/no monthly AI limit/i)
    const plan = FAQ.find(f => /What does OpenChurch cost/.test(f.q))
    expect(plan).toBeTruthy()
    expect(plan.a).not.toMatch(/500 AI generations|\d+ AI (uses|generations)|monthly AI limit/i)
  })

  it('has the own-key string in both locales, and they differ', () => {
    expect(STRINGS.en['quota.ownKey']).toBeTruthy()
    expect(STRINGS.es['quota.ownKey']).toBeTruthy()
    expect(STRINGS.es['quota.ownKey']).not.toBe(STRINGS.en['quota.ownKey'])
  })
})

const REC = { id: 7, donor_name: 'Rita Recurring', amount: '25.00', frequency: 'monthly', next_charge_date: '2026-11-01', fund_name: 'General' }
const STOPPED = { id: 8, donor_name: 'Stan Stopped', amount: '10.00', frequency: 'weekly', last_failed_at: '2026-10-20T00:00:00.000Z' }

function donationsFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('void-requests')) return ok([])
    if (u.includes('cash-counts')) return ok([])
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [REC], needs_attention: [STOPPED] })
    if (u.includes('/api/donations/summary')) return ok({ month_total: '0.00', week_total: '0.00', largest: '0.00', donor_count: 0 })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/donations')) return ok([])
    return ok({})
  }))
}

describe('recurring gift cancel is admin-only', () => {
  beforeEach(() => { donationsFetch() })
  it('staff see no Cancel or Clear and an honest note', async () => {
    who.role = 'staff'
    wrap(<Donations />)
    await screen.findByText('Rita Recurring')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    expect(screen.getAllByText('Only a parish admin can cancel a recurring gift.').length).toBeGreaterThan(0)
  })
  it('admins still see Cancel and Clear', async () => {
    who.role = 'admin'
    wrap(<Donations />)
    await screen.findByText('Rita Recurring')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
    expect(screen.queryByText('Only a parish admin can cancel a recurring gift.')).toBeNull()
  })
})

const ROW = { id: 9, title: 'Wedding — Ruiz', status: 'issued', total: '100.00', amount_paid: '0.00', payer_name: 'Ruiz', created_at: '2026-09-01T15:00:00.000Z' }
const DETAIL = { ...ROW, invoice_no: 'OFF-9', category: 'wedding', subtotal: '100.00', waived_amount: '0', amount_paid: '0',
  lines: [{ id: 1, description: 'Church use', qty: 1, amount: '100.00' }], payments: [] }

function offeringsFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/fee-schedules')) return ok([])
    if (u.includes('/api/clients')) return ok([])
    if (/\/api\/invoices\/\d+$/.test(u)) return ok(DETAIL)
    if (u.includes('/api/invoices')) return ok([ROW])
    return ok({})
  }))
}

describe('invoice cancel is admin-only', () => {
  beforeEach(() => { offeringsFetch() })
  const en = STRINGS.en
  it('staff see no Cancel invoice and an honest note', async () => {
    who.role = 'staff'
    wrap(<Offerings />)
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(en['bil.adminOnlyCancel'])
    expect(within(dialog).queryByRole('button', { name: en['bil.cancelInvoice'] })).toBeNull()
  })
  it('admins still see Cancel invoice', async () => {
    who.role = 'admin'
    wrap(<Offerings />)
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('button', { name: en['bil.cancelInvoice'] })).toBeInTheDocument()
    expect(within(dialog).queryByText(en['bil.adminOnlyCancel'])).toBeNull()
  })
})
