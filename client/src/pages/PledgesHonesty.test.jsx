// A failed pledge read used to become an empty book ("No pledges yet")
// or a $0.00 expected/received pair. A save that came back without a
// pledge id closed the form and looked finished.

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Pledges from './Pledges'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, isAdmin: true, canWrite: true,
  }),
}))

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const refused = (status = 500, body = { error: 'Failed to load pledges' }) => ({
  ok: false, status, json: async () => body,
})

const NAMED = {
  id: 4,
  member_name: 'Ada Lopez',
  member_email: 'ada@example.com',
  amount: 25,
  frequency: 'monthly',
  status: 'active',
  period_total: null,
  matched_total: null,
  fulfillment: null,
}

const ZERO = {
  id: 5,
  member_name: 'Ben Cho',
  donor_email: 'ben@example.com',
  amount: 10,
  frequency: 'one_time',
  status: 'active',
  period_total: 0,
  matched_total: 0,
  fulfillment: 0,
}

function stub(pledges, { clients = ok([]), locale, onFetch } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    if (onFetch) {
      const handled = await onFetch(u, method, opts)
      if (handled) return handled
    }
    if (u.includes('/api/clients')) return typeof clients === 'function' ? clients() : clients
    if (u.includes('/api/pledges')) return typeof pledges === 'function' ? pledges(u, method) : pledges
    return ok({})
  }))
}

function mount() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Pledges />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

const zeroMoney = (0).toLocaleString(undefined, { style: 'currency', currency: 'USD' })

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('pledges when the list did not load', () => {
  it('does not call a refused list a parish with no pledges, and offers retry', async () => {
    const en = STRINGS.en
    stub(refused())
    mount()
    expect(await screen.findByText(en['plg.loadFailedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(en['plg.emptyTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(zeroMoney)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New pledge' })).toBeDisabled()
  })

  it('does not call a body that is not a pledge list an empty book', async () => {
    const en = STRINGS.en
    stub(ok({}))
    mount()
    expect(await screen.findByText(en['plg.loadFailedBody'])).toBeInTheDocument()
    expect(screen.queryByText(en['plg.emptyTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText('Ada Lopez')).not.toBeInTheDocument()
  })

  it('does not call a bare array an empty book', async () => {
    const en = STRINGS.en
    stub(ok([]))
    mount()
    expect(await screen.findByText(en['plg.loadFailedBody'])).toBeInTheDocument()
    expect(screen.queryByText(en['plg.emptyTitle'])).not.toBeInTheDocument()
  })

  it('still says when the parish truly has no pledges', async () => {
    const en = STRINGS.en
    stub(ok({ pledges: [] }))
    mount()
    expect(await screen.findByText(en['plg.emptyTitle'])).toBeInTheDocument()
    expect(screen.queryByText(en['plg.loadFailedBody'])).not.toBeInTheDocument()
    for (const button of screen.getAllByRole('button', { name: 'New pledge' })) {
      expect(button).toBeEnabled()
    }
  })

  it('shows a missing total as unavailable, never $0', async () => {
    const en = STRINGS.en
    stub(ok({ pledges: [NAMED] }))
    mount()
    expect(await screen.findByText('Ada Lopez')).toBeInTheDocument()
    expect(screen.getAllByText(en['money.unavailable']).length).toBeGreaterThan(0)
    expect(screen.queryByText(zeroMoney)).not.toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
    expect(screen.queryByText(en['plg.emptyTitle'])).not.toBeInTheDocument()
  })

  it('still shows a real zero when nothing has been pledged or received yet', async () => {
    const en = STRINGS.en
    stub(ok({ pledges: [ZERO] }))
    mount()
    expect(await screen.findByText('Ben Cho')).toBeInTheDocument()
    expect(screen.getAllByText(zeroMoney).length).toBeGreaterThan(0)
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.queryByText(en['money.unavailable'])).not.toBeInTheDocument()
  })

  it('retry after a refusal can show a truly empty book', async () => {
    const en = STRINGS.en
    let reads = 0
    stub(() => {
      reads += 1
      return reads === 1 ? refused() : ok({ pledges: [] })
    })
    mount()
    expect(await screen.findByText(en['plg.loadFailedBody'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en['load.retry'] }))
    expect(await screen.findByText(en['plg.emptyTitle'])).toBeInTheDocument()
    expect(screen.queryByText(en['plg.loadFailedBody'])).not.toBeInTheDocument()
  })

  it('says the refused list in Spanish', async () => {
    const es = STRINGS.es
    stub(refused(), { locale: 'es' })
    mount()
    expect(await screen.findByText(es['plg.loadFailedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['plg.loadFailedBody'])).not.toBeInTheDocument()
    expect(screen.queryByText(es['plg.emptyTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['plg.emptyTitle'])).not.toBeInTheDocument()
  })
})

describe('pledges when a save did not land', () => {
  async function openNew() {
    stub(ok({ pledges: [] }))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'New pledge' }))
    const amount = await screen.findByLabelText('Amount')
    fireEvent.change(amount, { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText(/Donor email/i), { target: { value: 'ada@example.com' } })
    return amount
  }

  it('keeps the amount and does not say saved when the server refuses', async () => {
    const en = STRINGS.en
    const amount = await openNew()
    fetch.mockImplementation(async (url, opts = {}) => {
      const u = String(url)
      if ((opts.method || 'GET') === 'POST' && u.includes('/api/pledges')) {
        return refused(500, { error: 'Failed to create pledge' })
      }
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/pledges')) return ok({ pledges: [] })
      return ok({})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create pledge' }))
    expect(await screen.findByText(en['err.save'])).toBeInTheDocument()
    expect(screen.queryByText('Failed to create pledge')).not.toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'New pledge' })).toBeInTheDocument()
    expect(amount).toHaveValue(40)
  })

  it('keeps the amount when a 200 body is not a pledge', async () => {
    const en = STRINGS.en
    const amount = await openNew()
    fetch.mockImplementation(async (url, opts = {}) => {
      const u = String(url)
      if ((opts.method || 'GET') === 'POST' && u.includes('/api/pledges')) return ok({})
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/pledges')) return ok({ pledges: [] })
      return ok({})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create pledge' }))
    expect(await screen.findByText(en['err.save'])).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'New pledge' })).toBeInTheDocument()
    expect(amount).toHaveValue(40)
  })

  it('still shows a validation refusal and keeps what was typed', async () => {
    const amount = await openNew()
    fetch.mockImplementation(async (url, opts = {}) => {
      const u = String(url)
      if ((opts.method || 'GET') === 'POST' && u.includes('/api/pledges')) {
        return refused(400, { error: 'A member or donor email is required' })
      }
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/pledges')) return ok({ pledges: [] })
      return ok({})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create pledge' }))
    expect(await screen.findByText('A member or donor email is required')).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(amount).toHaveValue(40)
  })

  it('says when the member list did not load', async () => {
    const en = STRINGS.en
    stub(ok({ pledges: [] }), { clients: refused(500, { error: 'no' }) })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'New pledge' }))
    expect(await screen.findByText(en['plg.membersUnread'])).toBeInTheDocument()
  })
})

describe('pledge honesty copy exists in English and Spanish', () => {
  const keys = ['plg.loadFailedBody', 'plg.emptyTitle', 'plg.emptyBody', 'plg.membersUnread', 'money.unavailable', 'err.save', 'load.retry']

  it('has each string in both locales, and the two locales differ', () => {
    for (const key of keys) {
      expect(STRINGS.en[key], key).toEqual(expect.any(String))
      expect(STRINGS.es[key], key).toEqual(expect.any(String))
      expect(STRINGS.en[key].length, key).toBeGreaterThan(0)
      expect(STRINGS.es[key].length, key).toBeGreaterThan(0)
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    const readKeys = ['plg.loadFailedBody', 'plg.membersUnread']
    const overclaim = /nothing was lost|connection problem|not a parish|not an empty|no se perdió|problema de conexión|no una parroquia|padrón vacío/i
    for (const key of readKeys) {
      expect(STRINGS.en[key], key).not.toMatch(overclaim)
      expect(STRINGS.es[key], key).not.toMatch(overclaim)
      expect(STRINGS.en[key], key).toMatch(/did not load/i)
      expect(STRINGS.en[key], key).toMatch(/try again/i)
      expect(STRINGS.es[key], key).toMatch(/inténtelo de nuevo/i)
    }
    expect(STRINGS.en['money.unavailable']).toMatch(/unavailable/i)
    expect(STRINGS.en['err.save']).toMatch(/nothing was lost/i)
  })
})

describe('pledge totals stay inside the loaded list', () => {
  it('does not render the summary as money when the list failed', async () => {
    stub(refused())
    mount()
    expect(await screen.findByText(STRINGS.en['plg.loadFailedBody'])).toBeInTheDocument()
    expect(screen.queryByText('Expected')).not.toBeInTheDocument()
    expect(screen.queryByText('Received')).not.toBeInTheDocument()
  })
})

describe('pledge figures and ids keep their shape', () => {
  it('does not turn a boolean, array, or blank into zero or a full bar', async () => {
    const en = STRINGS.en
    stub(ok({
      pledges: [{
        id: 6,
        member_name: 'Cara Diaz',
        amount: false,
        frequency: 'monthly',
        status: 'active',
        period_total: false,
        matched_total: [],
        fulfillment: true,
      }],
    }))
    mount()
    expect(await screen.findByText('Cara Diaz')).toBeInTheDocument()
    expect(screen.getAllByText(en['money.unavailable']).length).toBeGreaterThan(0)
    expect(screen.queryByText(zeroMoney)).not.toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
    expect(screen.queryByText('100%')).not.toBeInTheDocument()
  })

  it('still reads a decimal string and a real zero', async () => {
    const tenFifty = (10.5).toLocaleString(undefined, { style: 'currency', currency: 'USD' })
    stub(ok({
      pledges: [{
        id: '7',
        member_name: 'Dana Ortiz',
        amount: '10.50',
        frequency: 'monthly',
        status: 'active',
        period_total: '0.00',
        matched_total: 0,
        fulfillment: '0',
      }],
    }))
    mount()
    expect(await screen.findByText('Dana Ortiz')).toBeInTheDocument()
    expect(screen.getByText(tenFifty)).toBeInTheDocument()
    expect(screen.getAllByText(zeroMoney).length).toBeGreaterThan(0)
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['money.unavailable'])).not.toBeInTheDocument()
  })

  it('does not render a pledge whose id is not a scalar integer', async () => {
    const en = STRINGS.en
    stub(ok({
      pledges: [{ id: true, member_name: 'Ada Lopez', amount: 10, frequency: 'monthly', status: 'active' }],
    }))
    mount()
    expect(await screen.findByText(en['plg.loadFailedBody'])).toBeInTheDocument()
    expect(screen.queryByText('Ada Lopez')).not.toBeInTheDocument()
    expect(screen.queryByText(zeroMoney)).not.toBeInTheDocument()
  })

  it('does not treat a coerced id as a created pledge', async () => {
    const en = STRINGS.en
    const amount = await openNewFromEmpty()
    fetch.mockImplementation(async (url, opts = {}) => {
      const u = String(url)
      if ((opts.method || 'GET') === 'POST' && u.includes('/api/pledges')) return ok({ id: true })
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/pledges')) return ok({ pledges: [] })
      return ok({})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create pledge' }))
    expect(await screen.findByText(en['err.save'])).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'New pledge' })).toBeInTheDocument()
    expect(amount).toHaveValue(40)
  })

  it('does not treat an id wrapped in an array as a created pledge', async () => {
    const en = STRINGS.en
    const amount = await openNewFromEmpty()
    fetch.mockImplementation(async (url, opts = {}) => {
      const u = String(url)
      if ((opts.method || 'GET') === 'POST' && u.includes('/api/pledges')) return ok({ id: [7] })
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/pledges')) return ok({ pledges: [] })
      return ok({})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create pledge' }))
    expect(await screen.findByText(en['err.save'])).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(amount).toHaveValue(40)
  })

  it('accepts a real string id and closes the new pledge', async () => {
    const amount = await openNewFromEmpty()
    fetch.mockImplementation(async (url, opts = {}) => {
      const u = String(url)
      if ((opts.method || 'GET') === 'POST' && u.includes('/api/pledges')) return ok({ id: '7' })
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/pledges')) return ok({ pledges: [] })
      return ok({})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create pledge' }))
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'New pledge' })).not.toBeInTheDocument()
    })
    expect(screen.queryByText(STRINGS.en['err.save'])).not.toBeInTheDocument()
    expect(amount).not.toBeInTheDocument()
  })

  it('does not close an edit when the returned id is a different pledge', async () => {
    const en = STRINGS.en
    stub(ok({
      pledges: [{
        id: 4, member_name: 'Ada Lopez', donor_email: 'ada@example.com',
        amount: 25, frequency: 'monthly', status: 'active',
        period_total: '25.00', matched_total: 0, fulfillment: 0,
      }],
    }))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit pledge' }))
    const amount = await screen.findByLabelText('Amount')
    fetch.mockImplementation(async (url, opts = {}) => {
      const u = String(url)
      if ((opts.method || 'GET') === 'PATCH' && u.includes('/api/pledges/4')) return ok({ id: 9 })
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/pledges')) return ok({ pledges: [] })
      return ok({})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save pledge' }))
    expect(await screen.findByText(en['err.save'])).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Edit pledge' })).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(amount).toHaveValue(25)
  })

  it('closes an edit when the returned id is that pledge', async () => {
    stub(ok({
      pledges: [{
        id: 4, member_name: 'Ada Lopez', donor_email: 'ada@example.com',
        amount: 25, frequency: 'monthly', status: 'active',
        period_total: '25.00', matched_total: 0, fulfillment: 0,
      }],
    }))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit pledge' }))
    await screen.findByRole('heading', { name: 'Edit pledge' })
    const row = {
      id: 4, member_name: 'Ada Lopez', donor_email: 'ada@example.com',
      amount: 25, frequency: 'monthly', status: 'active',
      period_total: '25.00', matched_total: 0, fulfillment: 0,
    }
    fetch.mockImplementation(async (url, opts = {}) => {
      const u = String(url)
      if ((opts.method || 'GET') === 'PATCH' && u.includes('/api/pledges/4')) return ok({ id: '4' })
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/pledges')) return ok({ pledges: [row] })
      return ok({})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save pledge' }))
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Edit pledge' })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Edit pledge' })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['err.save'])).not.toBeInTheDocument()
  })
})

async function openNewFromEmpty() {
  stub(ok({ pledges: [] }))
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'New pledge' }))
  const amount = await screen.findByLabelText('Amount')
  fireEvent.change(amount, { target: { value: '40' } })
  fireEvent.change(screen.getByLabelText(/Donor email/i), { target: { value: 'ada@example.com' } })
  return amount
}
