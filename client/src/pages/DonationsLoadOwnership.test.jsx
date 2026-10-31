// TARS CHANGES on #352 at a3c12ef0:
// R352-1 failure copy claims a cause ("connection problem") and no loss
//        ("not gone") that a 403/500/malformed body cannot prove.
// R352-2 side reads committed unusable 200 bodies ({} / null entries).
// R352-3 an older load could overwrite a newer one; a failed reload kept
//        the previous side rows while saying they were left off; a pending
//        "Load more" could append onto a replaced list.
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Donations from './Donations'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, canWrite: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = (status = 500) => ({ ok: false, status, json: async () => ({ error: 'no' }) })
const gift = (i, who = 'Donor') => ({ id: i, donor_name: `${who} ${i}`, amount: '10.00', category: 'tithe', date: '2026-10-01', method: 'cash' })
const cashRow = { id: 7, status: 'pending', total: '25.00', count_date: '2026-10-01', counted_by: 'Usher', breakdown: {} }
const fundRow = { category: 'building fund', total: '0.00', count: 0 }
const recRow = { id: 9, donor_name: 'Rec Donor', amount: '20.00', frequency: 'monthly', status: 'active' }

function deferred() {
  let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve }
}

// Each route is a queue: one entry per call; the last entry repeats.
function stub(queues) {
  const q = { list: [ok([])], summary: [ok({ donor_count: 0 })], cash: [ok([])],
    byFund: [ok({ funds: [] })], recurring: [ok({ recurring: [], needs_attention: [] })], page2: [ok([])], ...queues }
  const take = (k) => { const v = q[k].length > 1 ? q[k].shift() : q[k][0]; return v }
  const reply = async (v) => { const r = await (v && v.promise ? v.promise : v); if (r instanceof Error) throw r; return r }
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/funds')) return ok({ funds: [], provider: 'stub' })
    if (u.includes('/api/donations/recurring')) return reply(take('recurring'))
    if (u.includes('/api/donations/summary')) return reply(take('summary'))
    if (u.includes('/api/donations/by-fund')) return reply(take('byFund'))
    if (u.includes('/cash-counts/void-requests')) return ok([]) // 124: own read; not a cash-count row
    if (u.includes('/api/donations/cash-counts')) return reply(take('cash'))
    if (u.includes('/api/donations') && u.includes('offset=50')) return reply(take('page2'))
    if (u.includes('/api/donations')) return reply(take('list'))
    return ok({})
  }))
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/donations']}>
      <LocaleProvider><ToastProvider><ConfirmProvider><Donations /></ConfirmProvider></ToastProvider></LocaleProvider>
    </MemoryRouter>,
  )
}
const CLAIMS = /connection problem|not gone|are not gone|nothing was lost/i

beforeEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

describe('R352-1 failure copy makes no unsupported cause or no-loss claim', () => {
  it('refused log/trend and failed side sections say only that they did not load', async () => {
    stub({ list: [refused(403)], cash: [refused()] })
    mount()
    const log = (await screen.findByText("The donation log didn't load")).closest('[role="status"]')
    expect(log.textContent).not.toMatch(CLAIMS)
    const trend = screen.getByText("Giving trends didn't load").parentElement
    expect(trend.textContent).not.toMatch(CLAIMS)
    const side = screen.getByText(/Couldn't load cash count sessions/)
    expect(side.textContent).not.toMatch(CLAIMS)
    expect(log.textContent).toMatch(/Try again/)
  })
})

describe('R352-2 unusable side bodies are failed, genuine empty stays empty', () => {
  const cases = [
    ['cash-counts 200 {}', { cash: [ok({})] }, 'cash count sessions'],
    ['cash-counts null entry', { cash: [ok([null])] }, 'cash count sessions'],
    ['by-fund 200 {}', { byFund: [ok({})] }, 'giving by fund'],
    ['by-fund wrong collection type', { byFund: [ok({ funds: 'x' })] }, 'giving by fund'],
    ['by-fund null entry', { byFund: [ok({ funds: [null] })] }, 'giving by fund'],
    ['recurring 200 {}', { recurring: [ok({})] }, 'recurring gifts'],
    ['recurring null entry', { recurring: [ok({ recurring: [null], needs_attention: [] })] }, 'recurring gifts'],
    ['needs_attention wrong type', { recurring: [ok({ recurring: [], needs_attention: {} })] }, 'recurring gifts'],
  ]
  for (const [name, over, section] of cases) {
    it(`${name} is named as not loaded and the page still renders`, async () => {
      stub(over)
      mount()
      expect(await screen.findByText(new RegExp(`Couldn't load ${section}`))).toBeTruthy()
      expect(screen.getByText('No donations yet')).toBeTruthy()
    })
  }
  it('control: valid empty side reads show no notice', async () => {
    stub({})
    mount()
    expect(await screen.findByText('No donations yet')).toBeTruthy()
    expect(screen.queryByText(/Couldn't load/)).toBeNull()
  })
  it('control: real side rows, including a zero fund total, render with no notice', async () => {
    stub({ cash: [ok([cashRow])], byFund: [ok({ funds: [fundRow] })], recurring: [ok({ recurring: [recRow], needs_attention: [] })] })
    mount()
    expect(await screen.findByText('Cash Count Sessions')).toBeTruthy()
    expect(screen.getByText('Giving by Fund')).toBeTruthy()
    expect(screen.getAllByText('building fund').length).toBeGreaterThan(0)
    expect(screen.getByText('Recurring Gifts')).toBeTruthy()
    expect(screen.queryByText(/Couldn't load/)).toBeNull()
  })
})

describe('R352-3 the newest load owns the page', () => {
  it('an older failure arriving after a newer success does not overwrite it', async () => {
    const late = deferred()
    stub({ list: [refused(), late, ok([gift(1, 'Fresh')])] })
    mount()
    const retry = await screen.findByRole('button', { name: 'Try again' })
    fireEvent.click(retry) // load 2: pending
    fireEvent.click(retry) // load 3: success
    expect(await screen.findByText('Fresh 1')).toBeTruthy()
    await act(async () => { late.resolve(refused()) })
    await act(async () => {})
    expect(screen.getByText('Fresh 1')).toBeTruthy()
    expect(screen.queryByText("The donation log didn't load")).toBeNull()
  })

  it('an older success arriving after a newer failure does not overwrite it', async () => {
    const late = deferred()
    stub({ list: [refused(), late, refused()] })
    mount()
    const retry = await screen.findByRole('button', { name: 'Try again' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    await act(async () => {})
    await act(async () => { late.resolve(ok([gift(1, 'Stale')])) })
    await act(async () => {})
    expect(screen.queryByText('Stale 1')).toBeNull()
    expect(screen.getByText("The donation log didn't load")).toBeTruthy()
  })

  it('a failed reload does not keep showing the previous side rows', async () => {
    stub({
      list: [ok([gift(1)]), new Error('offline')],
      cash: [ok([cashRow])],
      byFund: [ok({ funds: [fundRow] })],
      recurring: [refused()],
    })
    mount()
    expect(await screen.findByText('Cash Count Sessions')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/Couldn't load cash count sessions, giving by fund, recurring gifts/)).toBeTruthy()
    // R360-2: the cash section stays reachable to show its failure and
    // retry, but keeps none of the previous load's rows.
    await waitFor(() => expect(screen.queryByTestId('cash-count-7')).toBeNull())
    expect(screen.getByTestId('cash-counts-failed')).toBeTruthy()
    expect(screen.queryByText('Giving by Fund')).toBeNull()
  })

  it('a pending "Load more" does not append onto a replaced list', async () => {
    const page = deferred()
    stub({
      list: [ok(Array.from({ length: 50 }, (_, i) => gift(i + 1))), ok([gift(500, 'Reloaded')])],
      recurring: [refused(), ok({ recurring: [], needs_attention: [] })],
      page2: [page],
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Reloaded 500')).toBeTruthy()
    await act(async () => { page.resolve(ok([gift(51, 'OldPage')])) })
    await act(async () => {})
    expect(screen.queryByText('OldPage 51')).toBeNull()
  })
})

// TARS re-review at 37631a59: object-only validation let wrong-typed
// consumed fields through, and Load more could start during a refresh
// with the old list's offset.
describe('R352-2 consumed fields are validated per view', () => {
  const OBJ = { unexpected: 'object' }
  const sideCases = [
    ['recurring donor_name object', { recurring: [ok({ recurring: [{ ...recRow, donor_name: OBJ }], needs_attention: [] })] }, 'recurring gifts'],
    ['needs_attention amount missing', { recurring: [ok({ recurring: [], needs_attention: [{ ...recRow, amount: undefined }] })] }, 'recurring gifts'],
    ['recurring id missing (cannot cancel)', { recurring: [ok({ recurring: [{ ...recRow, id: undefined }], needs_attention: [] })] }, 'recurring gifts'],
    ['cash service_name object', { cash: [ok([{ ...cashRow, service_name: OBJ }])] }, 'cash count sessions'],
    ['cash category object', { cash: [ok([{ ...cashRow, category: OBJ }])] }, 'cash count sessions'],
    ['cash id missing (cannot confirm)', { cash: [ok([{ ...cashRow, id: null }])] }, 'cash count sessions'],
    ['fund category object', { byFund: [ok({ funds: [{ ...fundRow, category: OBJ }] })] }, 'giving by fund'],
    ['fund total not numeric', { byFund: [ok({ funds: [{ ...fundRow, total: 'abc' }] })] }, 'giving by fund'],
  ]
  for (const [name, over, section] of sideCases) {
    it(`${name} is named as not loaded and nothing crashes`, async () => {
      stub(over)
      mount()
      expect(await screen.findByText(new RegExp(`Couldn't load ${section}`))).toBeTruthy()
      expect(screen.getByText('No donations yet')).toBeTruthy()
    })
  }
  for (const [name, row] of [
    ['donor_name object', { ...gift(1), donor_name: {} }],
    ['donor_name missing', { ...gift(1), donor_name: undefined }],
    ['amount object', { ...gift(1), amount: {} }],
    ['id missing', { ...gift(1), id: undefined }],
  ]) {
    it(`first page with a malformed log row (${name}) says the log did not load`, async () => {
      stub({ list: [ok([row])] })
      mount()
      expect(await screen.findByText("The donation log didn't load")).toBeTruthy()
    })
  }
  it('a malformed next page is refused, not appended', async () => {
    stub({ list: [ok(Array.from({ length: 50 }, (_, i) => gift(i + 1)))], page2: [ok([{ ...gift(51), donor_name: {} }])] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByText(/The next page of gifts didn't load/)).toBeTruthy()
    expect(screen.getByText('Donor 50')).toBeTruthy()
  })
  it('control: optional fields absent and zero amounts still render', async () => {
    stub({
      list: [ok([{ ...gift(1), amount: 0 }])],
      cash: [ok([{ ...cashRow, total: '0.00', service_name: null }])],
      byFund: [ok({ funds: [fundRow] })],
      recurring: [ok({ recurring: [{ ...recRow, donor_name: null, fund_name: null }], needs_attention: [] })],
    })
    mount()
    expect(await screen.findByText('Donor 1')).toBeTruthy()
    expect(screen.getByText('Cash Count Sessions')).toBeTruthy()
    expect(screen.getByText('Recurring Gifts')).toBeTruthy()
    expect(screen.queryByText(/Couldn't load/)).toBeNull()
  })
})

describe('R352-3 Load more cannot start while a refresh is in flight', () => {
  it('during a pending refresh, Load more fetches nothing with the old offset and appends nothing', async () => {
    const refresh = deferred()
    const page = deferred()
    stub({
      list: [ok(Array.from({ length: 50 }, (_, i) => gift(i + 1))), refresh],
      recurring: [refused(), ok({ recurring: [], needs_attention: [] })],
      page2: [page],
    })
    mount()
    const more = await screen.findByRole('button', { name: 'Load more' })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' })) // refresh pending
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await act(async () => {})
    const pageCalls = fetch.mock.calls.filter(([u]) => String(u).includes('offset=50'))
    expect(pageCalls).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Load more' }).disabled).toBe(true)
    await act(async () => { refresh.resolve(ok([gift(500, 'Reloaded')])) })
    await act(async () => { page.resolve(ok([gift(51, 'OldPage')])) })
    await act(async () => {})
    expect(screen.getByText('Reloaded 500')).toBeTruthy()
    expect(screen.queryByText('OldPage 51')).toBeNull()
    expect(more).toBeTruthy()
  })
  it('after the refresh settles, Load more works again from the new list', async () => {
    const refresh = deferred()
    stub({
      list: [ok(Array.from({ length: 50 }, (_, i) => gift(i + 1))), refresh],
      recurring: [refused(), ok({ recurring: [], needs_attention: [] })],
      page2: [ok([gift(151, 'Next')])],
    })
    mount()
    await screen.findByRole('button', { name: 'Load more' })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await act(async () => { refresh.resolve(ok(Array.from({ length: 50 }, (_, i) => gift(i + 101, 'New')))) })
    const btn = await screen.findByRole('button', { name: 'Load more' })
    await waitFor(() => expect(btn.disabled).toBe(false))
    fireEvent.click(btn)
    expect(await screen.findByText('Next 151')).toBeTruthy()
  })
})

// TARS re-review at c7a09386: fund.count is rendered ("N gifts") but was
// not validated, so {count:{unexpected:'object'}} reached React as a child.
// Audit while there: recurring next_charge_date and the summary tiles.
describe('R352-2 every rendered field is validated (re-review 2)', () => {
  it('a fund count that is an object is named as not loaded and does not crash', async () => {
    stub({ byFund: [ok({ funds: [{ ...fundRow, total: '5.00', count: { unexpected: 'object' } }] })] })
    mount()
    expect(await screen.findByText(/Couldn't load giving by fund/)).toBeTruthy()
    expect(screen.queryByText('Giving by Fund')).toBeNull()
    expect(screen.getByText('No donations yet')).toBeTruthy()
  })
  it('a fund count that is missing or fractional is named as not loaded', async () => {
    stub({ byFund: [ok({ funds: [{ ...fundRow, count: undefined }, { ...fundRow, category: 'x', count: 1.5 }] })] })
    mount()
    expect(await screen.findByText(/Couldn't load giving by fund/)).toBeTruthy()
  })
  it('control: a valid zero count renders "0 gifts"', async () => {
    stub({ byFund: [ok({ funds: [{ category: 'building fund', total: '0.00', count: 0 }] })] })
    mount()
    expect(await screen.findByText('0 gifts')).toBeTruthy()
    expect(screen.queryByText(/Couldn't load/)).toBeNull()
  })
  it('control: valid counts render, singular and plural', async () => {
    stub({ byFund: [ok({ funds: [{ category: 'tithe', total: '10.00', count: 1 }, { category: 'building fund', total: '30.00', count: 3 }] })] })
    mount()
    expect(await screen.findByText('1 gift')).toBeTruthy()
    expect(screen.getByText('3 gifts')).toBeTruthy()
    expect(screen.queryByText(/Couldn't load/)).toBeNull()
  })
  it('a recurring next_charge_date that is an object is named as not loaded', async () => {
    stub({ recurring: [ok({ recurring: [{ ...recRow, next_charge_date: { unexpected: 'object' } }], needs_attention: [] })] })
    mount()
    expect(await screen.findByText(/Couldn't load recurring gifts/)).toBeTruthy()
  })
  it('a summary tile value that is an object shows — and the totals notice, not $NaN', async () => {
    stub({ summary: [ok({ month_total: { unexpected: 'object' }, week_total: '0.00', largest: '0.00', donor_count: '0' })] })
    mount()
    expect(await screen.findByText(/These totals didn't load/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/NaN/)
  })
})
