// A failed pledge read on a member's profile used to become `{ pledges: [] }`,
// and the section hides when that array is empty. Failure then looked the
// same as a member with no pledges: the section was gone. UNKNOWN is not
// EMPTY. A real zero still renders as zero.

import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, Link } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MemberDetail from './MemberDetail'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const MEMBER = { id: 20013, name: 'Ada Lopez', email: 'ada@x.com', status: 'active' }
const OTHER = { id: 20014, name: 'Ben Cho', email: 'ben@x.com', status: 'active' }

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const refused = (status = 500) => ({ ok: false, status, json: async () => ({ error: 'no' }) })

const PLEDGE = {
  id: 4,
  member_id: 20013,
  amount: 25,
  frequency: 'monthly',
  status: 'active',
  period_total: '25.00',
  matched_total: 10,
  fulfillment: 0.4,
}

const ZERO = {
  id: 5,
  member_id: 20013,
  amount: 0,
  frequency: 'monthly',
  status: 'active',
  period_total: 0,
  matched_total: '0.00',
  fulfillment: 0,
}

const EMPTY_BOOK = { records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] }

function hold() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function stub(pledges, { locale, member = MEMBER, onPledges } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/pledges')) {
      if (onPledges) return onPledges(u)
      return typeof pledges === 'function' ? pledges() : pledges
    }
    if (u.includes('/donations')) return ok({ lines: [], total: 0, gift_count: 0 })
    if (u.match(/\/api\/clients\/\d+$/)) {
      const id = Number(u.match(/\/api\/clients\/(\d+)$/)[1])
      if (id === OTHER.id) return ok(OTHER)
      return ok(member.id === id ? member : { ...member, id })
    }
    return ok(EMPTY_BOOK)
  }))
}

function mount(id = MEMBER.id) {
  return render(
    <MemoryRouter initialEntries={[`/clients/${id}`]}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/clients/:id" element={<MemberDetail />} />
            </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

const Shell = () => (
  <MemoryRouter initialEntries={[`/clients/${MEMBER.id}`]}>
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Link to={`/clients/${OTHER.id}`}>go to other</Link>
          <Routes>
            <Route path="/clients/:id" element={<MemberDetail />} />
          </Routes>
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  </MemoryRouter>
)

const money = (n) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })

function pledgeSection() {
  const heading = screen.getByRole('heading', { name: STRINGS.en['member.activePledges'] })
  return heading.closest('section')
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('member pledges when the read did not load', () => {
  it('does not hide a refused pledge read, and offers retry', async () => {
    const en = STRINGS.en
    stub(refused())
    mount()
    expect(await screen.findByRole('heading', { name: MEMBER.name })).toBeInTheDocument()
    const section = await waitFor(() => pledgeSection())
    expect(within(section).getByText(en['member.pledgesUnread'])).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: en['load.retry'] })).toBeInTheDocument()
    expect(within(section).queryByText(money(0))).not.toBeInTheDocument()
    expect(screen.queryByText(/no pledges/i)).not.toBeInTheDocument()
  })

  it('does not treat a thrown pledge read as an empty section', async () => {
    const en = STRINGS.en
    stub(() => { throw new Error('network') })
    mount()
    expect(await screen.findByText(en['member.pledgesUnread'])).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: MEMBER.name })).toBeInTheDocument()
    expect(screen.queryByText(/no pledges/i)).not.toBeInTheDocument()
  })

  it('retries a refused read into the member\'s pledge', async () => {
    const en = STRINGS.en
    let reads = 0
    stub(() => {
      reads += 1
      return reads === 1 ? refused() : ok({ pledges: [PLEDGE] })
    })
    mount()
    expect(await screen.findByText(en['member.pledgesUnread'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en['load.retry'] }))
    expect(await screen.findByText(money(25))).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(screen.queryByText(en['member.pledgesUnread'])).not.toBeInTheDocument()
  })

  it('still hides the section when this member truly has no pledges', async () => {
    const en = STRINGS.en
    stub(ok({ pledges: [] }))
    mount()
    expect(await screen.findByRole('heading', { name: MEMBER.name })).toBeInTheDocument()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: en['member.activePledges'] })).not.toBeInTheDocument()
    expect(screen.queryByText(en['member.pledgesUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(/no pledges/i)).not.toBeInTheDocument()
  })

  it('hides another member\'s pledge without calling the read a failure', async () => {
    const en = STRINGS.en
    stub(ok({
      pledges: [{ ...PLEDGE, id: 8, member_id: OTHER.id, amount: 80, frequency: 'yearly' }],
    }))
    mount()
    expect(await screen.findByRole('heading', { name: MEMBER.name })).toBeInTheDocument()
    await waitFor(() => {
      const urls = fetch.mock.calls.map(c => String(c[0]))
      expect(urls.some(u => u.includes('/api/pledges'))).toBe(true)
    })
    expect(screen.queryByText(money(80))).not.toBeInTheDocument()
    expect(screen.queryByText(en['member.pledgesUnread'])).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: en['member.activePledges'] })).not.toBeInTheDocument()
  })
})

describe('member pledge payloads that are not a list', () => {
  for (const [label, body] of [
    ['an object without a list', {}],
    ['a bare array', []],
    ['a null list', { pledges: null }],
    ['a row whose id is not a scalar integer', { pledges: [{ id: true, member_id: 20013, amount: 10, frequency: 'monthly' }] }],
    ['a valid row beside a row whose id is not a scalar integer', {
      pledges: [PLEDGE, { id: [7], member_id: 20013, amount: 10, frequency: 'monthly' }],
    }],
  ]) {
    it(`does not render ${label} as this member's pledges`, async () => {
      const en = STRINGS.en
      stub(ok(body))
      mount()
      expect(await screen.findByText(en['member.pledgesUnread'])).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: MEMBER.name })).toBeInTheDocument()
      expect(screen.queryByText(money(25))).not.toBeInTheDocument()
      expect(screen.queryByText(money(10))).not.toBeInTheDocument()
      expect(screen.queryByText(money(0))).not.toBeInTheDocument()
    })
  }

  it('shows a boolean amount as unavailable, never $0 or 100%', async () => {
    const en = STRINGS.en
    stub(ok({
      pledges: [{
        id: 6,
        member_id: 20013,
        amount: false,
        frequency: 'monthly',
        status: 'active',
        period_total: false,
        matched_total: [],
        fulfillment: true,
      }],
    }))
    mount()
    expect(await screen.findByText(/\/ monthly/)).toBeInTheDocument()
    expect(screen.getAllByText(en['money.unavailable']).length).toBeGreaterThan(0)
    expect(screen.queryByText(money(0))).not.toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
    expect(screen.queryByText('100%')).not.toBeInTheDocument()
    expect(screen.queryByText(en['member.pledgesUnread'])).not.toBeInTheDocument()
  })

  it('still shows a real zero and a decimal string', async () => {
    const en = STRINGS.en
    stub(ok({
      pledges: [{
        id: '7',
        member_id: '20013',
        amount: '10.50',
        frequency: 'monthly',
        status: 'active',
        period_total: '0.00',
        matched_total: 0,
        fulfillment: '0',
      }],
    }))
    mount()
    expect(await screen.findByText(money(10.5), { exact: false })).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`${money(0).replace(/[$.]/g, '\\$&')} of ${money(0).replace(/[$.]/g, '\\$&')}`))).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.queryByText(en['money.unavailable'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['member.pledgesUnread'])).not.toBeInTheDocument()
  })

  it('still shows a pledge whose figures are actually zero', async () => {
    stub(ok({ pledges: [ZERO] }))
    mount()
    expect(await screen.findByText('0%')).toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(money(0).replace(/[$.]/g, '\\$&'))).length).toBeGreaterThan(0)
    expect(screen.queryByText(STRINGS.en['money.unavailable'])).not.toBeInTheDocument()
  })
})

describe('a late pledge read does not cover a newer one', () => {
  it('keeps the newer pledge when an older refusal settles afterwards', async () => {
    const en = STRINGS.en
    let reads = 0
    const older = hold()
    const newer = hold()
    stub(null, {
      onPledges: () => {
        reads += 1
        if (reads === 1) return refused()
        if (reads === 2) return older.promise
        return newer.promise
      },
    })
    mount()
    expect(await screen.findByText(en['member.pledgesUnread'])).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: en['load.retry'] })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(reads).toBe(3)
    await act(async () => { newer.resolve(ok({ pledges: [PLEDGE] })) })
    expect(await screen.findByText(money(25))).toBeInTheDocument()
    await act(async () => { older.resolve(refused()); await older.promise })
    expect(screen.getByText(money(25))).toBeInTheDocument()
    expect(screen.queryByText(en['member.pledgesUnread'])).not.toBeInTheDocument()
  })

  it('keeps the newer refusal when an older pledge settles afterwards', async () => {
    const en = STRINGS.en
    let reads = 0
    const older = hold()
    const newer = hold()
    stub(null, {
      onPledges: () => {
        reads += 1
        if (reads === 1) return refused()
        if (reads === 2) return older.promise
        return newer.promise
      },
    })
    mount()
    expect(await screen.findByText(en['member.pledgesUnread'])).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: en['load.retry'] })
    fireEvent.click(retry)
    fireEvent.click(retry)
    await act(async () => { newer.resolve(refused()) })
    expect(await screen.findByText(en['member.pledgesUnread'])).toBeInTheDocument()
    await act(async () => { older.resolve(ok({ pledges: [PLEDGE] })); await older.promise })
    expect(screen.getByText(en['member.pledgesUnread'])).toBeInTheDocument()
    expect(screen.queryByText(money(25))).not.toBeInTheDocument()
  })

  it('does not file a late read under the member who is open now', async () => {
    let reads = 0
    const late = hold()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/pledges')) {
        reads += 1
        if (reads === 1) return late.promise
        return ok({ pledges: [] })
      }
      if (u.includes('/donations')) return ok({ lines: [], total: 0, gift_count: 0 })
      if (u.endsWith(`/api/clients/${MEMBER.id}`)) return ok(MEMBER)
      if (u.endsWith(`/api/clients/${OTHER.id}`)) return ok(OTHER)
      return ok(EMPTY_BOOK)
    }))
    render(<Shell />)
    await waitFor(() => expect(reads).toBe(1))
    await act(async () => { fireEvent.click(screen.getByText('go to other')) })
    expect(await screen.findByRole('heading', { name: OTHER.name })).toBeInTheDocument()
    await act(async () => {
      late.resolve(ok({ pledges: [{ ...PLEDGE, amount: 999, period_total: 999, matched_total: 0, fulfillment: 0 }] }))
      await late.promise
    })
    expect(screen.getByRole('heading', { name: OTHER.name })).toBeInTheDocument()
    expect(screen.queryByText(money(999))).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: MEMBER.name })).not.toBeInTheDocument()
  })

  it('drops a pledge retry that resolves after the profile unmounts', async () => {
    const en = STRINGS.en
    const late = hold()
    let reads = 0
    stub(null, {
      onPledges: () => {
        reads += 1
        return reads === 1 ? refused() : late.promise
      },
    })
    const view = mount()
    expect(await screen.findByText(en['member.pledgesUnread'])).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en['load.retry'] }))
    expect(reads).toBe(2)
    view.unmount()
    await act(async () => {
      late.resolve(ok({ pledges: [PLEDGE] }))
      await late.promise
    })
  })
})

describe('member pledge failure copy', () => {
  it('says the refused read in Spanish', async () => {
    const es = STRINGS.es
    stub(refused(), { locale: 'es' })
    mount()
    expect(await screen.findByText(es['member.pledgesUnread'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['member.pledgesUnread'])).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: es['member.activePledges'] })).toBeInTheDocument()
  })

  it('has neutral English and Spanish copy', () => {
    const keys = ['member.pledgesUnread', 'load.retry', 'money.unavailable']
    const overclaim = /nothing was lost|connection problem|not a parish|not an empty|no pledges|no se perdió|problema de conexión|no una parroquia|padrón vacío|no hay promesas/i
    for (const key of keys) {
      expect(STRINGS.en[key], key).toEqual(expect.any(String))
      expect(STRINGS.es[key], key).toEqual(expect.any(String))
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(STRINGS.en['member.pledgesUnread']).not.toMatch(overclaim)
    expect(STRINGS.es['member.pledgesUnread']).not.toMatch(overclaim)
    expect(STRINGS.en['member.pledgesUnread']).toMatch(/did not load/i)
    expect(STRINGS.en['member.pledgesUnread']).toMatch(/try again/i)
    expect(STRINGS.es['member.pledgesUnread']).toMatch(/inténtelo de nuevo/i)
  })
})
