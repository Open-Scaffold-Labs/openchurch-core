// A refused GET /api/fee-schedules used to become [], and the catalog
// tab said "No catalog items yet".

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Offerings from './Offerings'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, isAdmin: true, canWrite: true,
  }),
}))

const FEE = { id: 1, name: 'Hall rental', category: 'facility', amount: 100, active: true }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 500, json: async () => ({ error: 'no' }) })

function stub({ invoices = ok([]), catalog = ok([]), locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/fee-schedules')) return catalog
    if (u.includes('/api/invoices')) return invoices
    if (u.includes('/api/clients')) return ok([])
    return ok({})
  }))
}

function mount() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Offerings />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

async function openCatalog() {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Catalog' }))
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('the offerings catalog when the schedule did not load', () => {
  it('does not call a refused schedule a parish with no offerings', async () => {
    const en = STRINGS.en
    stub({ catalog: refused() })
    await openCatalog()
    expect(await screen.findByText(en['bil.catalogUnread'])).toBeInTheDocument()
    expect(screen.queryByText(en['bil.catalogEmptyTitle'])).not.toBeInTheDocument()
  })

  it('does not call a schedule that is not a list an empty catalog', async () => {
    const en = STRINGS.en
    stub({ catalog: ok({ fees: [FEE] }) })
    await openCatalog()
    expect(await screen.findByText(en['bil.catalogUnread'])).toBeInTheDocument()
    expect(screen.queryByText('Hall rental')).not.toBeInTheDocument()
    expect(screen.queryByText(en['bil.catalogEmptyTitle'])).not.toBeInTheDocument()
  })

  it('still says when the parish truly has no catalog items', async () => {
    const en = STRINGS.en
    stub({ catalog: ok([]) })
    await openCatalog()
    expect(await screen.findByText(en['bil.catalogEmptyTitle'])).toBeInTheDocument()
    expect(screen.queryByText(en['bil.catalogUnread'])).not.toBeInTheDocument()
  })

  it('shows a fee that did load', async () => {
    const en = STRINGS.en
    stub({ catalog: ok([FEE]) })
    await openCatalog()
    expect(await screen.findByText('Hall rental')).toBeInTheDocument()
    expect(screen.queryByText(en['bil.catalogEmptyTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['bil.catalogUnread'])).not.toBeInTheDocument()
  })

  it('keeps a loaded catalog when the invoice list is refused', async () => {
    const en = STRINGS.en
    stub({ invoices: refused(), catalog: ok([FEE]) })
    await openCatalog()
    expect(await screen.findByText('Hall rental')).toBeInTheDocument()
    expect(screen.queryByText(en['bil.catalogUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['bil.catalogEmptyTitle'])).not.toBeInTheDocument()
  })

  it('says the refused catalog in Spanish', async () => {
    const es = STRINGS.es
    stub({ catalog: refused(), locale: 'es' })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: es['bil.tab.catalog'] }))
    expect(await screen.findByText(es['bil.catalogUnread'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['bil.catalogUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(es['bil.catalogEmptyTitle'])).not.toBeInTheDocument()
  })
})

describe('[money-review] no write on an unread catalog; latest load owns the catalog', () => {
  it('offers no add-item action when the catalog did not load, and does when it is truly empty', async () => {
    const en = STRINGS.en
    stub({ catalog: refused() })
    await openCatalog()
    expect(await screen.findByText(en['bil.catalogUnread'])).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: new RegExp(en['bil.addItem']) })).not.toBeInTheDocument()
  })

  it('a truly empty catalog still offers add-item (control)', async () => {
    const en = STRINGS.en
    stub({ catalog: ok([]) })
    await openCatalog()
    expect(await screen.findByText(en['bil.catalogEmptyTitle'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(en['bil.addItem']) })).toBeInTheDocument()
  })

  // Deferred responses resolved in a controlled order; no timers.
  function stubDeferredCatalog() {
    const pending = []
    vi.stubGlobal('fetch', vi.fn((url) => {
      const u = String(url)
      if (u.includes('/api/fee-schedules')) return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      if (u.includes('/api/invoices')) return Promise.resolve(ok([]))
      if (u.includes('/api/clients')) return Promise.resolve(ok([]))
      return Promise.resolve(ok({}))
    }))
    return pending
  }
  async function twoLoads(en) {
    const pending = stubDeferredCatalog()
    mount()
    await waitFor(() => expect(pending.length).toBe(1))
    fireEvent.change(screen.getByLabelText(en['bil.filterStatus']), { target: { value: 'draft' } })
    await waitFor(() => expect(pending.length).toBe(2))
    return pending
  }

  it('an older failed catalog read arriving after a newer success does not wipe it', async () => {
    const en = STRINGS.en
    const [older, newer] = await twoLoads(en)
    await act(async () => { newer.resolve(ok([FEE])) })
    await act(async () => { older.resolve(refused()) })
    fireEvent.click(screen.getByRole('button', { name: 'Catalog' }))
    expect(await screen.findByText('Hall rental')).toBeInTheDocument()
    expect(screen.queryByText(en['bil.catalogUnread'])).not.toBeInTheDocument()
  })

  it('an older successful catalog read arriving after a newer failure does not replace it', async () => {
    const en = STRINGS.en
    const [older, newer] = await twoLoads(en)
    await act(async () => { newer.resolve(refused()) })
    await act(async () => { older.resolve(ok([FEE])) })
    fireEvent.click(screen.getByRole('button', { name: 'Catalog' }))
    expect(await screen.findByText(en['bil.catalogUnread'])).toBeInTheDocument()
    expect(screen.queryByText('Hall rental')).not.toBeInTheDocument()
  })
})

// R301-1 (TARS): rejected fetches settle independently, and the catalog is
// unknown (no empty wording, no Add, no POST) until a successful list read.
describe('[money-review] R301-1 catalog readiness', () => {
  const offline = () => Promise.reject(new TypeError('offline'))
  const posted = () => fetch.mock.calls.some(([u, o]) => String(u).includes('/api/fee-schedules') && o?.method === 'POST')
  const addBtn = (en) => screen.queryByRole('button', { name: new RegExp(en['bil.addItem']) })
  function stubWith({ catalog, invoices }) {
    vi.stubGlobal('fetch', vi.fn((url, o) => {
      const u = String(url)
      if (u.includes('/api/fee-schedules') && !o?.method) return catalog()
      if (u.includes('/api/invoices')) return invoices()
      if (u.includes('/api/clients')) return Promise.resolve(ok([]))
      return Promise.resolve(ok({}))
    }))
  }

  it('a rejected catalog fetch with successful invoices: unread, no Add/POST, invoices kept', async () => {
    const en = STRINGS.en
    const INV = { id: 9, title: 'Wedding — Ruiz', status: 'draft', total: 300, balance: 300, lines: [] }
    stubWith({ catalog: offline, invoices: () => Promise.resolve(ok([INV])) })
    mount()
    expect(await screen.findByText(/Wedding — Ruiz/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Catalog' }))
    expect(await screen.findByText(en['bil.catalogUnread'])).toBeInTheDocument()
    expect(screen.queryByText(en['bil.catalogEmptyTitle'])).not.toBeInTheDocument()
    expect(addBtn(en)).not.toBeInTheDocument()
    expect(posted()).toBe(false)
  })

  it('a rejected invoice fetch with a successful catalog keeps the real catalog', async () => {
    const en = STRINGS.en
    stubWith({ catalog: () => Promise.resolve(ok([FEE])), invoices: offline })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Catalog' }))
    expect(await screen.findByText('Hall rental')).toBeInTheDocument()
    expect(screen.queryByText(en['bil.catalogUnread'])).not.toBeInTheDocument()
    expect(addBtn(en)).toBeInTheDocument()
  })

  it('while the first catalog read is pending: no false-empty, no Add, no POST; resolves to known', async () => {
    const en = STRINGS.en
    let release
    stubWith({ catalog: () => new Promise(r => { release = () => r(ok([])) }), invoices: () => Promise.resolve(ok([])) })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Catalog' }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    expect(screen.queryByText(en['bil.catalogEmptyTitle'])).not.toBeInTheDocument()
    expect(addBtn(en)).not.toBeInTheDocument()
    expect(posted()).toBe(false)
    await act(async () => { release() })
    expect(await screen.findByText(en['bil.catalogEmptyTitle'])).toBeInTheDocument()
    expect(addBtn(en)).toBeInTheDocument()
  })

  it('an open form keeps typed values and cannot save when a reload leaves the catalog unread', async () => {
    const en = STRINGS.en
    let n = 0
    stubWith({ catalog: () => (n++ === 0 ? Promise.resolve(ok([FEE])) : offline()), invoices: () => Promise.resolve(ok([])) })
    const base = fetch.getMockImplementation()
    fetch.mockImplementation((url, o) => (o?.method === 'DELETE' ? Promise.resolve({ ok: true, status: 204, json: async () => ({}) }) : base(url, o)))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Catalog' }))
    expect(await screen.findByText('Hall rental')).toBeInTheDocument()
    fireEvent.click(addBtn(en))
    fireEvent.change(screen.getByPlaceholderText(en['bil.feeNamePh']), { target: { value: 'Funeral' } })
    // Removing another fee reloads the catalog; that reload is rejected.
    fireEvent.click(screen.getByRole('button', { name: en['bil.removeFee'] }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: en['bil.feeRemoveConfirm'] }).length).toBeGreaterThan(1))
    fireEvent.click(screen.getAllByRole('button', { name: en['bil.feeRemoveConfirm'] }).at(-1))
    expect(await screen.findByText(en['bil.catalogUnread'])).toBeInTheDocument()
    expect(screen.getByPlaceholderText(en['bil.feeNamePh'])).toHaveValue('Funeral')
    const save = screen.getAllByRole('button', { name: new RegExp(en['bil.addItem']) }).at(-1)
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(posted()).toBe(false)
  })
})
