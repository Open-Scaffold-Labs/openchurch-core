// A failed linked-invoice read on the schedule drawer used to become [].
// The drawer only renders that list when it has rows, so a failure looked
// the same as an event with no invoices. FAILED is not an empty link.
// A real zero balance still renders as zero.

import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Schedule, { EventModal } from './Schedule'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const mondayOf = (d = new Date()) => {
  const x = new Date(d)
  const day = x.getDay()
  x.setDate(x.getDate() - (day === 0 ? 6 : day - 1))
  x.setHours(0, 0, 0, 0)
  return x
}
const addDays = (date, n) => {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}
const THIS_WED = iso(addDays(mondayOf(new Date()), 2))

const EVENT_A = {
  id: 17,
  title: 'Hall A',
  date: THIS_WED,
  start_time: '08:00',
  end_time: '09:00',
  type: 'meeting',
  assigned_to: [],
}
const EVENT_B = {
  id: 19,
  title: 'Hall B',
  date: THIS_WED,
  start_time: '10:00',
  end_time: '11:00',
  type: 'meeting',
  assigned_to: [],
}

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const refused = (status = 500) => ({ ok: false, status, json: async () => ({ error: 'no' }) })

const ISSUED = {
  id: 3,
  invoice_no: 'OF-3',
  title: 'Hall rental',
  status: 'issued',
  total: '40.50',
  amount_paid: 10,
}
const ZERO = {
  id: 4,
  title: 'Nothing due',
  status: 'issued',
  total: '0.00',
  amount_paid: 0,
}

function hold() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function stubInvoices(invoices, { locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/invoices')) return typeof invoices === 'function' ? invoices(u) : invoices
    if (u.includes('/api/liturgical')) return ok({ season: 'Ordinary Time', color: 'Green' })
    if (u.includes('/api/calendar/conflicts')) return ok({ conflicts: [] })
    if (u.includes('/api/availability')) return ok({ unavailability: [] })
    if (u.includes('/api/calendar')) return ok([EVENT_A, EVENT_B])
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/groups')) return ok({ groups: [] })
    if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
    return ok({})
  }))
}

function tree(event) {
  return (
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <EventModal
              event={event}
              onClose={() => {}}
              onSave={() => {}}
              onDelete={() => {}}
              members={[]}
            />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

function mountModal(event = EVENT_A) {
  return render(tree(event))
}

const en = () => STRINGS.en

function offerings() {
  return screen.getByText('Offerings & fees').closest('div')
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('linked invoices when the read did not load', () => {
  it('does not hide a refused invoice read, and offers retry', async () => {
    stubInvoices(refused())
    mountModal()
    const block = await waitFor(() => offerings())
    expect(within(block).getByText(en()['sched.invoicesUnread'])).toBeInTheDocument()
    expect(within(block).getByRole('button', { name: en()['load.retry'] })).toBeInTheDocument()
    expect(within(block).queryByText(/\$0\.00/)).not.toBeInTheDocument()
    expect(screen.queryByText(/no invoices/i)).not.toBeInTheDocument()
  })

  it('does not treat a thrown invoice read as no invoices', async () => {
    stubInvoices(() => { throw new Error('network') })
    mountModal()
    expect(await screen.findByText(en()['sched.invoicesUnread'])).toBeInTheDocument()
    expect(screen.queryByText(/no invoices/i)).not.toBeInTheDocument()
  })

  it('retries a refused read into the linked invoice', async () => {
    let reads = 0
    stubInvoices(() => {
      reads += 1
      return reads === 1 ? refused() : ok([ISSUED])
    })
    mountModal()
    expect(await screen.findByText(en()['sched.invoicesUnread'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en()['load.retry'] }))
    expect(await screen.findByText(/Hall rental/)).toBeInTheDocument()
    expect(screen.getByText(/\$30\.50 remaining/)).toBeInTheDocument()
    expect(screen.queryByText(en()['sched.invoicesUnread'])).not.toBeInTheDocument()
  })

  it('still hides the block when nothing is linked', async () => {
    stubInvoices(ok([]))
    mountModal()
    expect(await screen.findByText('Edit Event')).toBeInTheDocument()
    await waitFor(() => {
      const urls = fetch.mock.calls.map(c => String(c[0]))
      expect(urls.some(u => u.includes('/api/invoices?event=17'))).toBe(true)
    })
    expect(screen.queryByText('Offerings & fees')).not.toBeInTheDocument()
    expect(screen.queryByText(en()['sched.invoicesUnread'])).not.toBeInTheDocument()
  })

  it('hides a cancelled-only link without calling the read a failure', async () => {
    stubInvoices(ok([{ ...ISSUED, status: 'cancelled' }]))
    mountModal()
    expect(await screen.findByText('Edit Event')).toBeInTheDocument()
    await waitFor(() => {
      const urls = fetch.mock.calls.map(c => String(c[0]))
      expect(urls.some(u => u.includes('/api/invoices'))).toBe(true)
    })
    expect(screen.queryByText('Offerings & fees')).not.toBeInTheDocument()
    expect(screen.queryByText('Hall rental')).not.toBeInTheDocument()
  })

  it('shows the failure from the schedule page when that event is open', async () => {
    stubInvoices(refused())
    render(
      <MemoryRouter initialEntries={['/schedule?event=17']}>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <Routes>
                <Route path="/schedule" element={<Schedule />} />
              </Routes>
            </ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(en()['sched.invoicesUnread'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en()['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(/no invoices/i)).not.toBeInTheDocument()
  })
})

describe('linked invoice payloads that are not a list', () => {
  for (const [label, body] of [
    ['an object', {}],
    ['a null body', null],
    ['a row whose id is not a scalar integer', [{ id: true, title: 'Ghost fee', status: 'issued', total: 10, amount_paid: 0 }]],
    ['a valid row beside a row whose id is not a scalar integer', [ISSUED, { id: [7], title: 'Wrapped', status: 'issued', total: 1, amount_paid: 0 }]],
  ]) {
    it(`does not render ${label} as linked invoices`, async () => {
      stubInvoices(ok(body))
      mountModal()
      expect(await screen.findByText(en()['sched.invoicesUnread'])).toBeInTheDocument()
      expect(screen.queryByText('Hall rental')).not.toBeInTheDocument()
      expect(screen.queryByText('Ghost fee')).not.toBeInTheDocument()
      expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument()
    })
  }

  it('shows a boolean total as unavailable, never $0 or $1', async () => {
    stubInvoices(ok([{
      id: 8,
      title: 'Unreadable fee',
      status: 'issued',
      total: false,
      amount_paid: 0,
    }]))
    mountModal()
    expect(await screen.findByText(/Unreadable fee/)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(en()['money.unavailable']))).toBeInTheDocument()
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\$1\.00/)).not.toBeInTheDocument()
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
    expect(screen.queryByText(en()['sched.invoicesUnread'])).not.toBeInTheDocument()
  })

  it('still shows a real zero balance', async () => {
    stubInvoices(ok([ZERO]))
    mountModal()
    expect(await screen.findByText(/Nothing due/)).toBeInTheDocument()
    expect(screen.getByText(/\$0\.00 remaining/)).toBeInTheDocument()
    expect(screen.queryByText(en()['money.unavailable'])).not.toBeInTheDocument()
  })

  it('reads a string id and a decimal balance', async () => {
    stubInvoices(ok([{ ...ISSUED, id: '3' }]))
    mountModal()
    expect(await screen.findByText(/\$30\.50 remaining/)).toBeInTheDocument()
    expect(screen.queryByText(en()['sched.invoicesUnread'])).not.toBeInTheDocument()
  })
})

describe('a late invoice read does not cover a newer one', () => {
  it('keeps the newer invoice when an older refusal settles afterwards', async () => {
    let reads = 0
    const older = hold()
    const newer = hold()
    stubInvoices(() => {
      reads += 1
      if (reads === 1) return refused()
      if (reads === 2) return older.promise
      return newer.promise
    })
    mountModal()
    expect(await screen.findByText(en()['sched.invoicesUnread'])).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: en()['load.retry'] })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(reads).toBe(3)
    await act(async () => { newer.resolve(ok([ISSUED])) })
    expect(await screen.findByText(/Hall rental/)).toBeInTheDocument()
    await act(async () => { older.resolve(refused()); await older.promise })
    expect(screen.getByText(/Hall rental/)).toBeInTheDocument()
    expect(screen.queryByText(en()['sched.invoicesUnread'])).not.toBeInTheDocument()
  })

  it('does not file the previous event\'s invoices on the event open now', async () => {
    let reads = 0
    const late = hold()
    stubInvoices(() => {
      reads += 1
      if (reads === 1) return refused()
      if (reads === 2) return late.promise
      return ok([{ id: 9, title: 'Beta fee', status: 'paid', total: '10.00', amount_paid: '10.00' }])
    })
    const view = mountModal(EVENT_A)
    expect(await screen.findByText(en()['sched.invoicesUnread'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en()['load.retry'] }))
    expect(reads).toBe(2)
    view.rerender(tree(EVENT_B))
    expect(await screen.findByText(/Beta fee/)).toBeInTheDocument()
    await act(async () => {
      late.resolve(ok([{ id: 1, title: 'Alpha fee', status: 'issued', total: '80.00', amount_paid: 0 }]))
      await late.promise
    })
    expect(screen.getByText(/Beta fee/)).toBeInTheDocument()
    expect(screen.queryByText('Alpha fee')).not.toBeInTheDocument()
    expect(screen.queryByText(en()['sched.invoicesUnread'])).not.toBeInTheDocument()
    const urls = fetch.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('/api/invoices?event=19'))).toBe(true)
  })

  it('drops an invoice retry that resolves after the drawer unmounts', async () => {
    const late = hold()
    let reads = 0
    stubInvoices(() => {
      reads += 1
      return reads === 1 ? refused() : late.promise
    })
    const view = mountModal()
    expect(await screen.findByText(en()['sched.invoicesUnread'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en()['load.retry'] }))
    expect(reads).toBe(2)
    view.unmount()
    await act(async () => {
      late.resolve(ok([ISSUED]))
      await late.promise
    })
  })
})

describe('schedule invoice failure copy', () => {
  it('says the refused read in Spanish', async () => {
    const es = STRINGS.es
    stubInvoices(refused(), { locale: 'es' })
    mountModal()
    expect(await screen.findByText(es['sched.invoicesUnread'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['sched.invoicesUnread'])).not.toBeInTheDocument()
  })

  it('has neutral English and Spanish copy', () => {
    const overclaim = /nothing was lost|connection problem|not a parish|not an empty|no invoices|no se perdió|problema de conexión|no una parroquia|no hay facturas/i
    expect(STRINGS.en['sched.invoicesUnread']).toEqual(expect.any(String))
    expect(STRINGS.es['sched.invoicesUnread']).toEqual(expect.any(String))
    expect(STRINGS.es['sched.invoicesUnread']).not.toBe(STRINGS.en['sched.invoicesUnread'])
    expect(STRINGS.en['sched.invoicesUnread']).not.toMatch(overclaim)
    expect(STRINGS.es['sched.invoicesUnread']).not.toMatch(overclaim)
    expect(STRINGS.en['sched.invoicesUnread']).toMatch(/did not load/i)
    expect(STRINGS.en['sched.invoicesUnread']).toMatch(/try again/i)
    expect(STRINGS.es['sched.invoicesUnread']).toMatch(/inténtelo de nuevo/i)
  })
})
