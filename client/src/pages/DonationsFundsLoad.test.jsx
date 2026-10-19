// A refused GET /api/funds used to become { funds: [] }, so the drawer
// said "No funds yet" and, with no provider on that invented body, that
// online giving was in test mode.

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Donations from './Donations'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, canWrite: true,
  }),
}))

const FUND = { id: 3, name: 'Building Fund', description: 'Roof', active: true }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })

function stub({ funds = ok({ funds: [], provider: 'stub' }), locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/funds')) return funds
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [], needs_attention: [] })
    if (u.includes('/api/donations/summary')) return ok({ donor_count: 0, total: 0 })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/donations/cash-counts')) return ok([])
    if (u.includes('/api/donations')) return ok([])
    return ok({})
  }))
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/donations']}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Donations />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

async function openFunds() {
  mount()
  const button = await screen.findByRole('button', { name: /funds/i })
  fireEvent.click(button)
}

const EMPTY = 'No funds yet. Add one above to start collecting designated gifts.'
const TEST_MODE = /test mode/i

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('giving funds when the list did not load', () => {
  it('does not call a refused list a parish with no funds, or test mode', async () => {
    const en = STRINGS.en
    stub({ funds: refused() })
    await openFunds()
    expect(await screen.findByText(en['giv.fundsUnread'])).toBeInTheDocument()
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument()
    expect(screen.queryByText(TEST_MODE)).not.toBeInTheDocument()
  })

  it('does not call a body that is not a fund list an empty parish', async () => {
    const en = STRINGS.en
    stub({ funds: ok({ funds: { name: 'Building Fund' }, provider: 'stub' }) })
    await openFunds()
    expect(await screen.findByText(en['giv.fundsUnread'])).toBeInTheDocument()
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument()
    expect(screen.queryByText(TEST_MODE)).not.toBeInTheDocument()
    expect(screen.queryByText('Building Fund')).not.toBeInTheDocument()
  })

  it('still says when the parish truly has no funds, and names test mode', async () => {
    const en = STRINGS.en
    stub({ funds: ok({ funds: [], provider: 'stub' }) })
    await openFunds()
    expect(await screen.findByText(EMPTY)).toBeInTheDocument()
    expect(screen.getByText(TEST_MODE)).toBeInTheDocument()
    expect(screen.queryByText(en['giv.fundsUnread'])).not.toBeInTheDocument()
  })

  it('shows a fund that did load, without the test-mode banner when giving is live', async () => {
    const en = STRINGS.en
    stub({ funds: ok({ funds: [FUND], provider: 'live' }) })
    await openFunds()
    expect(await screen.findByText('Building Fund')).toBeInTheDocument()
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument()
    expect(screen.queryByText(en['giv.fundsUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(TEST_MODE)).not.toBeInTheDocument()
  })

  it('says the refused list in Spanish', async () => {
    const es = STRINGS.es
    stub({ funds: refused(), locale: 'es' })
    await openFunds()
    expect(await screen.findByText(es['giv.fundsUnread'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['giv.fundsUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument()
  })
})

describe('[money-review] no write against an unread or loading fund list', () => {
  const addBtn = () => screen.getByRole('button', { name: /add fund/i })
  const typeName = () => fireEvent.change(screen.getByPlaceholderText(/fund name/i), { target: { value: 'Roof Fund' } })

  it('Add fund stays disabled when the fund list did not load, and no POST is sent', async () => {
    const en = STRINGS.en
    stub({ funds: refused() })
    await openFunds()
    expect(await screen.findByText(en['giv.fundsUnread'])).toBeInTheDocument()
    typeName()
    expect(addBtn()).toBeDisabled()
    fireEvent.submit(addBtn().closest('form'))
    expect(fetch.mock.calls.some(([u, o]) => String(u).includes('/api/funds') && o?.method === 'POST')).toBe(false)
  })

  it('Add fund stays disabled while the fund list is still loading (no overlapping reload)', async () => {
    let release
    stub()
    const base = fetch.getMockImplementation()
    fetch.mockImplementation((url, o) => String(url).includes('/api/funds') && !o?.method
      ? new Promise(r => { release = () => r(ok({ funds: [FUND], provider: 'stub' })) })
      : base(url, o))
    await openFunds()
    await waitFor(() => expect(release).toBeTypeOf('function'))
    typeName()
    expect(addBtn()).toBeDisabled()
    await act(async () => { release() })
    expect(await screen.findByText('Building Fund')).toBeInTheDocument()
    expect(addBtn()).not.toBeDisabled()
  })

  it('a loaded empty list still allows Add fund (control)', async () => {
    stub()
    await openFunds()
    expect(await screen.findByText(EMPTY)).toBeInTheDocument()
    typeName()
    expect(addBtn()).not.toBeDisabled()
  })
})
