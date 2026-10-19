// A failed invoice read used to become "No invoices yet" or a row of
// $0.00. A save that came back without an id closed the form and looked
// finished. UNKNOWN is not EMPTY. FAILED is not ZERO.

import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Offerings from './Offerings'
import InvoicePrint from './InvoicePrint'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, isAdmin: true, canWrite: true,
  }),
}))

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const refused = (status = 500, body = { error: 'Failed to load invoices' }) => ({
  ok: false, status, json: async () => body,
})

const ROW = {
  id: 9,
  title: 'Wedding — Ruiz',
  status: 'issued',
  total: null,
  amount_paid: null,
  payer_name: 'Ruiz',
  created_at: '2026-09-01T15:00:00.000Z',
}

const ZERO_ROW = {
  id: 8,
  title: 'Draft hall',
  status: 'draft',
  total: 0,
  amount_paid: 0,
  payer_name: 'Hall',
  created_at: '2026-09-02T15:00:00.000Z',
}

const DETAIL = {
  id: 9,
  title: 'Wedding — Ruiz',
  status: 'issued',
  invoice_no: 'OFF-9',
  category: 'wedding',
  total: '100.00',
  subtotal: '100.00',
  waived_amount: '0',
  amount_paid: '0',
  payer_name: 'Ruiz',
  created_at: '2026-09-01T15:00:00.000Z',
  lines: [{ id: 1, description: 'Church use', qty: 1, amount: '100.00' }],
  payments: [],
}

function stubFetch(impl) {
  vi.stubGlobal('fetch', vi.fn(impl))
}

function pageFetch({ invoices = ok([]), catalog = ok([]), clients = ok([]), detail, post } = {}) {
  return async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    if (method === 'POST' && post) return post(u, opts)
    if (u.includes('/api/fee-schedules')) return catalog
    if (u.includes('/api/clients')) return clients
    if (detail && /\/api\/invoices\/\d+$/.test(u)) return typeof detail === 'function' ? detail() : detail
    if (u.includes('/api/invoices')) return typeof invoices === 'function' ? invoices() : invoices
    return ok({})
  }
}

function mountOfferings() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Offerings />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function mountPrint() {
  return render(
    <MemoryRouter initialEntries={['/offerings/9/print']}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/offerings/:id/print" element={<InvoicePrint />} />
            </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('invoices when the list did not load', () => {
  it('does not call a refused list a parish with no invoices, and offers retry', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({ invoices: refused() }))
    mountOfferings()
    expect(await screen.findByText(en['bil.listFailedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(en['bil.emptyTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['bil.new'] })).toBeDisabled()
  })

  it('does not call a body that is not a list an empty parish', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({ invoices: ok({ invoices: [ROW] }) }))
    mountOfferings()
    expect(await screen.findByText(en['bil.listFailedBody'])).toBeInTheDocument()
    expect(screen.queryByText(en['bil.emptyTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText('Wedding — Ruiz')).not.toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('still says when the parish truly has no invoices', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({ invoices: ok([]) }))
    mountOfferings()
    expect(await screen.findByText(en['bil.emptyTitle'])).toBeInTheDocument()
    expect(screen.queryByText(en['bil.listFailedBody'])).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['bil.new'] })).toBeEnabled()
  })

  it('shows a missing invoice total as unavailable, never $0.00', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({ invoices: ok([ROW]) }))
    mountOfferings()
    expect(await screen.findByText(/Wedding — Ruiz/)).toBeInTheDocument()
    expect(screen.getByText(en['money.unavailable'])).toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.queryByText(en['bil.emptyTitle'])).not.toBeInTheDocument()
  })

  it('still shows a real zero on a draft whose total is zero', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({ invoices: ok([ZERO_ROW]) }))
    mountOfferings()
    expect(await screen.findByText(/Draft hall/)).toBeInTheDocument()
    expect(screen.getByText('$0.00')).toBeInTheDocument()
    expect(screen.queryByText(en['money.unavailable'])).not.toBeInTheDocument()
  })

  it('retry after a refusal can show a truly empty list', async () => {
    const en = STRINGS.en
    let reads = 0
    stubFetch(pageFetch({
      invoices: () => {
        reads += 1
        return reads === 1 ? refused() : ok([])
      },
    }))
    mountOfferings()
    expect(await screen.findByText(en['bil.listFailedBody'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en['load.retry'] }))
    expect(await screen.findByText(en['bil.emptyTitle'])).toBeInTheDocument()
    expect(screen.queryByText(en['bil.listFailedBody'])).not.toBeInTheDocument()
  })

  it('says the refused list in Spanish', async () => {
    const es = STRINGS.es
    localStorage.setItem('ochr_locale', 'es')
    stubFetch(pageFetch({ invoices: refused() }))
    mountOfferings()
    expect(await screen.findByText(es['bil.listFailedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['bil.listFailedBody'])).not.toBeInTheDocument()
    expect(screen.queryByText(es['bil.emptyTitle'])).not.toBeInTheDocument()
  })
})

async function openDraft() {
  stubFetch(pageFetch({ invoices: ok([]) }))
  mountOfferings()
  fireEvent.click(await screen.findByRole('button', { name: STRINGS.en['bil.new'] }))
  const title = await screen.findByPlaceholderText(STRINGS.en['bil.titlePh'])
  fireEvent.change(title, { target: { value: 'Johnson wedding' } })
  fireEvent.change(screen.getByPlaceholderText(STRINGS.en['bil.payerPh']), { target: { value: 'Ada Lopez' } })
  fireEvent.click(screen.getByRole('button', { name: STRINGS.en['bil.addLine'] }))
  fireEvent.change(screen.getByLabelText(STRINGS.en['bil.lineDesc']), { target: { value: 'Hall' } })
  fireEvent.change(screen.getByLabelText(STRINGS.en['bil.lineAmount']), { target: { value: '80' } })
  return title
}

function replacePost(response) {
  const base = fetch.getMockImplementation()
  fetch.mockImplementation(async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'POST' && String(url).includes('/api/invoices')) return response
    return base(url, opts)
  })
}

describe('invoices when a save did not land', () => {
  it('keeps the draft and does not say saved when the server refuses', async () => {
    const en = STRINGS.en
    const title = await openDraft()
    replacePost(refused(500, { error: 'Failed to create invoice' }))
    fireEvent.click(screen.getByRole('button', { name: en['bil.saveDraft'] }))
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText(en['err.save'])).toBeInTheDocument()
    expect(within(dialog).queryByText('Failed to create invoice')).not.toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(title).toHaveValue('Johnson wedding')
  })

  it('keeps the draft when a 200 body is not an invoice', async () => {
    const en = STRINGS.en
    const title = await openDraft()
    replacePost(ok({}))
    fireEvent.click(screen.getByRole('button', { name: en['bil.saveDraft'] }))
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText(en['err.save'])).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(title).toHaveValue('Johnson wedding')
    expect(screen.queryByText(/Wedding — Ruiz/)).not.toBeInTheDocument()
  })

  it('still shows a validation refusal and keeps what was typed', async () => {
    const title = await openDraft()
    replacePost(refused(400, { error: 'Member not found' }))
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['bil.saveDraft'] }))
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText('Member not found')).toBeInTheDocument()
    expect(title).toHaveValue('Johnson wedding')
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('keeps a payment amount when the response is not a recorded payment', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({
      invoices: ok([{ ...ROW, total: '100.00', amount_paid: '0.00' }]),
      detail: ok(DETAIL),
      post: () => ok({}),
    }))
    mountOfferings()
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: en['bil.recordPayment'] }))
    const amount = within(dialog).getByLabelText(en['bil.amount'])
    fireEvent.change(amount, { target: { value: '25' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en['bil.recordPayment'] }))
    expect(await within(dialog).findByText(en['err.save'])).toBeInTheDocument()
    expect(amount).toHaveValue('25')
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })
})

describe('invoice detail and the printed sheet', () => {
  it('does not paint $0.00 when the detail did not load', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({
      invoices: ok([{ ...ROW, total: '40.00', amount_paid: '0.00' }]),
      detail: refused(500, { error: 'Failed to load invoice' }),
    }))
    mountOfferings()
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(en['bil.detailFailedBody'])).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: en['load.retry'] })).toBeInTheDocument()
    expect(within(dialog).queryByText('$0.00')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Failed to load')).not.toBeInTheDocument()
  })

  it('does not treat a detail without lines as an empty bill of $0.00', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({
      invoices: ok([{ ...ROW, total: '40.00', amount_paid: '0.00' }]),
      detail: ok({ id: 9, title: 'Wedding — Ruiz', status: 'issued', total: null }),
    }))
    mountOfferings()
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(en['bil.detailFailedBody'])).toBeInTheDocument()
    expect(within(dialog).queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('does not print $0.00 when the sheet did not load', async () => {
    const en = STRINGS.en
    stubFetch(async (url) => (/\/api\/invoices\/9$/.test(String(url)) ? refused() : ok({})))
    mountPrint()
    expect(await screen.findByText(en['bil.detailFailedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.queryByText(en['bil.sheetFooter'])).not.toBeInTheDocument()
  })

  it('prints a missing total as unavailable, never $0.00', async () => {
    const en = STRINGS.en
    stubFetch(async () => ok({
      ...DETAIL,
      total: null,
      subtotal: null,
      amount_paid: null,
      lines: [{ id: 1, description: 'Church use', qty: 1, amount: null }],
    }))
    mountPrint()
    expect(await screen.findByText('Church use')).toBeInTheDocument()
    expect(screen.getAllByText(en['money.unavailable']).length).toBeGreaterThan(0)
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('says the unread sheet in Spanish', async () => {
    const es = STRINGS.es
    localStorage.setItem('ochr_locale', 'es')
    stubFetch(async () => refused())
    mountPrint()
    expect(await screen.findByText(es['bil.detailFailedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['bil.detailFailedBody'])).not.toBeInTheDocument()
  })
})

describe('invoice honesty copy exists in English and Spanish', () => {
  const keys = ['bil.listFailedBody', 'bil.detailFailedBody', 'bil.membersUnread', 'money.unavailable', 'err.save', 'load.retry', 'bil.emptyTitle']

  it('has each string in both locales, and the two locales differ', () => {
    for (const key of keys) {
      expect(STRINGS.en[key], key).toEqual(expect.any(String))
      expect(STRINGS.es[key], key).toEqual(expect.any(String))
      expect(STRINGS.en[key].length, key).toBeGreaterThan(0)
      expect(STRINGS.es[key].length, key).toBeGreaterThan(0)
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    const readKeys = ['bil.listFailedBody', 'bil.detailFailedBody', 'bil.membersUnread']
    const overclaim = /nothing was lost|connection problem|not a parish|not an empty|no se perdió|problema de conexión|no una parroquia|padrón vacío/i
    for (const key of readKeys) {
      expect(STRINGS.en[key], key).not.toMatch(overclaim)
      expect(STRINGS.es[key], key).not.toMatch(overclaim)
      expect(STRINGS.en[key], key).toMatch(/did not load/i)
      expect(STRINGS.en[key], key).toMatch(/try again/i)
      expect(STRINGS.es[key], key).toMatch(/inténtelo de nuevo/i)
    }
    expect(STRINGS.en['err.save']).toMatch(/nothing was lost/i)
  })
})

const ISSUED = {
  ...DETAIL,
  status: 'issued',
  total: '100.00',
  subtotal: '100.00',
  amount_paid: '0.00',
  payments: [],
}

const PAID = {
  ...DETAIL,
  status: 'paid',
  total: '100.00',
  subtotal: '100.00',
  amount_paid: '100.00',
  payments: [{ id: 5, amount: '100.00', method: 'cash', received_at: '2026-10-01T15:00:00.000Z' }],
}

function hold() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function isDetailUrl(url) {
  return /\/api\/invoices\/\d+$/.test(String(url))
}

describe('invoice figures and ids keep their shape', () => {
  it('does not turn a false total into $0.00, and still shows a decimal zero', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({
      invoices: ok([
        { ...ROW, id: 9, total: false, amount_paid: false },
        { ...ZERO_ROW, id: 8, total: '0.00', amount_paid: '0.00' },
      ]),
    }))
    mountOfferings()
    expect(await screen.findByText(/Wedding — Ruiz/)).toBeInTheDocument()
    expect(screen.getByText(/Draft hall/)).toBeInTheDocument()
    expect(screen.getByText(en['money.unavailable'])).toBeInTheDocument()
    expect(screen.getByText('$0.00')).toBeInTheDocument()
  })

  it('does not render a list row whose id is not a scalar integer', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({
      invoices: ok([{ ...ROW, id: [9], total: 40 }]),
    }))
    mountOfferings()
    expect(await screen.findByText(en['bil.listFailedBody'])).toBeInTheDocument()
    expect(screen.queryByText(/Wedding — Ruiz/)).not.toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('does not paint a detail whose lines or payments are not entries', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({
      invoices: ok([{ ...ROW, total: '40.00', amount_paid: '0.00' }]),
      detail: ok({ id: 9, title: 'Wedding — Ruiz', status: 'issued', total: '40.00', lines: [null], payments: [null] }),
    }))
    mountOfferings()
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(en['bil.detailFailedBody'])).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: en['load.retry'] })).toBeInTheDocument()
    expect(within(dialog).queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('shows a false line amount as unavailable and keeps a real zero', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({
      invoices: ok([{ ...ROW, total: '100.00', amount_paid: '0.00' }]),
      detail: ok({
        ...DETAIL,
        lines: [{ id: 1, description: 'Church use', qty: 1, amount: false }],
        amount_paid: '0.00',
        total: '100.00',
      }),
    }))
    mountOfferings()
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Church use')).toBeInTheDocument()
    expect(within(dialog).getAllByText(en['money.unavailable']).length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('$0.00').length).toBeGreaterThan(0)
  })

  it('does not print a sheet whose entries are null', async () => {
    const en = STRINGS.en
    stubFetch(async () => ok({
      id: 9, title: 'Wedding — Ruiz', status: 'issued', total: 0,
      lines: [null], payments: [null],
    }))
    mountPrint()
    expect(await screen.findByText(en['bil.detailFailedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.queryByText(en['bil.sheetFooter'])).not.toBeInTheDocument()
  })

  it('prints a false line amount as unavailable and a decimal zero as $0.00', async () => {
    const en = STRINGS.en
    stubFetch(async () => ok({
      ...DETAIL,
      lines: [{ id: 1, description: 'Church use', qty: 1, amount: false }],
      amount_paid: '0.00',
      total: '0.00',
      subtotal: '0.00',
    }))
    mountPrint()
    expect(await screen.findByText('Church use')).toBeInTheDocument()
    expect(screen.getAllByText(en['money.unavailable']).length).toBeGreaterThan(0)
    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0)
  })

  it('does not close a draft when the id is only coercible', async () => {
    const en = STRINGS.en
    const title = await openDraft()
    replacePost(ok({ id: true }))
    fireEvent.click(screen.getByRole('button', { name: en['bil.saveDraft'] }))
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText(en['err.save'])).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(title).toHaveValue('Johnson wedding')
  })

  it('does not close a draft when the id is wrapped in an array', async () => {
    const en = STRINGS.en
    const title = await openDraft()
    replacePost(ok({ id: [7] }))
    fireEvent.click(screen.getByRole('button', { name: en['bil.saveDraft'] }))
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText(en['err.save'])).toBeInTheDocument()
    expect(title).toHaveValue('Johnson wedding')
  })

  it('closes a draft when the id is a real string', async () => {
    await openDraft()
    replacePost(ok({ id: '12' }))
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['bil.saveDraft'] }))
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(STRINGS.en['bil.titlePh'])).not.toBeInTheDocument()
    })
    expect(screen.queryByText(STRINGS.en['err.save'])).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('Johnson wedding')).not.toBeInTheDocument()
  })

  it('keeps a payment amount when the payment id is only coercible', async () => {
    const en = STRINGS.en
    stubFetch(pageFetch({
      invoices: ok([{ ...ROW, total: '100.00', amount_paid: '0.00' }]),
      detail: ok(DETAIL),
      post: () => ok({ id: [7] }),
    }))
    mountOfferings()
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: en['bil.recordPayment'] }))
    const amount = within(dialog).getByLabelText(en['bil.amount'])
    fireEvent.change(amount, { target: { value: '25' } })
    fireEvent.click(within(dialog).getAllByRole('button', { name: en['bil.recordPayment'] }).at(-1))
    expect(await within(dialog).findByText(en['err.save'])).toBeInTheDocument()
    expect(amount).toHaveValue('25')
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })
})

describe('a late invoice read does not replace a newer payment', () => {
  async function pay(dialog, amount) {
    const en = STRINGS.en
    const buttons = within(dialog).getAllByRole('button', { name: en['bil.recordPayment'] })
    fireEvent.click(buttons[buttons.length - 1])
    const input = await within(dialog).findByLabelText(en['bil.amount'])
    fireEvent.change(input, { target: { value: amount } })
    const submit = within(dialog).getAllByRole('button', { name: en['bil.recordPayment'] })
    fireEvent.click(submit[submit.length - 1])
  }

  it('keeps the paid sheet when an older unpaid read settles afterwards', async () => {
    const en = STRINGS.en
    let detailCalls = 0
    const older = hold()
    const newer = hold()
    stubFetch(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      if (method === 'POST' && /\/payments$/.test(u)) return ok({ id: 5, status: 'recorded' })
      if (method === 'GET' && isDetailUrl(u)) {
        detailCalls += 1
        if (detailCalls === 1) return ok(ISSUED)
        if (detailCalls === 2) return refused(500)
        if (detailCalls === 3) return older.promise.then(() => ok(ISSUED))
        return newer.promise.then(() => ok(PAID))
      }
      if (u.includes('/api/invoices')) return ok([{ ...ROW, total: '100.00', amount_paid: '0.00', status: 'issued' }])
      return ok([])
    })
    mountOfferings()
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Church use')).toBeInTheDocument()
    await pay(dialog, '100')
    expect(await within(dialog).findByText(en['bil.detailFailedBody'])).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: en['load.retry'] }))
    await pay(dialog, '100')
    await act(async () => { newer.resolve() })
    expect(await within(dialog).findByText(en['bil.status.paid'])).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: en['bil.recordPayment'] })).not.toBeInTheDocument()
    expect(within(dialog).queryByText(en['err.save'])).not.toBeInTheDocument()
    await act(async () => { older.resolve(); await older.promise; await Promise.resolve() })
    expect(within(dialog).getByText(en['bil.status.paid'])).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: en['bil.recordPayment'] })).not.toBeInTheDocument()
    expect(within(dialog).queryByText(en['bil.detailFailedBody'])).not.toBeInTheDocument()
    expect(within(dialog).getAllByText('$100.00').length).toBeGreaterThan(0)
  })

  it('does not put an older failure over a newer paid sheet', async () => {
    const en = STRINGS.en
    let detailCalls = 0
    const older = hold()
    const newer = hold()
    stubFetch(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      if (method === 'POST' && /\/payments$/.test(u)) return ok({ id: 5, status: 'recorded' })
      if (method === 'GET' && isDetailUrl(u)) {
        detailCalls += 1
        if (detailCalls === 1) return ok(ISSUED)
        if (detailCalls === 2) return refused(500)
        if (detailCalls === 3) return older.promise.then(() => refused(500))
        return newer.promise.then(() => ok(PAID))
      }
      if (u.includes('/api/invoices')) return ok([{ ...ROW, total: '100.00', amount_paid: '0.00', status: 'issued' }])
      return ok([])
    })
    mountOfferings()
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    await pay(dialog, '100')
    expect(await within(dialog).findByText(en['bil.detailFailedBody'])).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: en['load.retry'] }))
    await pay(dialog, '100')
    await act(async () => { newer.resolve() })
    expect(await within(dialog).findByText(en['bil.status.paid'])).toBeInTheDocument()
    await act(async () => { older.resolve(); await older.promise; await Promise.resolve() })
    expect(within(dialog).getByText(en['bil.status.paid'])).toBeInTheDocument()
    expect(within(dialog).queryByText(en['bil.detailFailedBody'])).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: en['bil.recordPayment'] })).not.toBeInTheDocument()
  })

  it('does not let an older list replace the list read after a payment', async () => {
    let listCalls = 0
    const olderList = hold()
    const newerList = hold()
    const issuedRow = { ...ROW, total: '100.00', amount_paid: '0.00', status: 'issued' }
    const paidRow = { ...ROW, total: '100.00', amount_paid: '100.00', status: 'paid' }
    let detailCalls = 0
    stubFetch(async (url, opts = {}) => {
      const u = String(url)
      const method = opts.method || 'GET'
      if (method === 'POST' && /\/payments$/.test(u)) return ok({ id: 5, status: 'recorded' })
      if (method === 'GET' && isDetailUrl(u)) {
        detailCalls += 1
        return ok(detailCalls === 1 ? ISSUED : PAID)
      }
      if (u.includes('/api/invoices')) {
        listCalls += 1
        if (listCalls === 1) return ok([issuedRow])
        if (listCalls === 2) return olderList.promise.then(() => ok([issuedRow]))
        return newerList.promise.then(() => ok([paidRow]))
      }
      return ok([])
    })
    mountOfferings()
    fireEvent.click(await screen.findByRole('button', { name: /Wedding — Ruiz/ }))
    const dialog = await screen.findByRole('dialog')
    expect(screen.getByText('Balance $100.00')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(STRINGS.en['bil.filterStatus']), { target: { value: 'paid' } })
    await act(async () => { await Promise.resolve() })
    expect(listCalls).toBeGreaterThanOrEqual(2)
    const buttons = within(dialog).getAllByRole('button', { name: STRINGS.en['bil.recordPayment'] })
    fireEvent.click(buttons[buttons.length - 1])
    const input = await within(dialog).findByLabelText(STRINGS.en['bil.amount'])
    fireEvent.change(input, { target: { value: '100' } })
    fireEvent.click(within(dialog).getAllByRole('button', { name: STRINGS.en['bil.recordPayment'] }).at(-1))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(listCalls).toBeGreaterThanOrEqual(3)
    await act(async () => { newerList.resolve() })
    expect(await screen.findByRole('button', { name: /Wedding — Ruiz/ })).toBeInTheDocument()
    expect(screen.queryByText('Balance $100.00')).not.toBeInTheDocument()
    await act(async () => { olderList.resolve(); await olderList.promise; await Promise.resolve() })
    expect(screen.queryByText('Balance $100.00')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Wedding — Ruiz/ })).toBeInTheDocument()
  })
})
