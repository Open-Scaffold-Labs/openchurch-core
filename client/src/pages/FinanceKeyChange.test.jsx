// OLD DATA UNDER A NEW LABEL — attempted on the page it would matter most.
//
// Finance keys its summary and ledger reads on [start, end]. Before the
// useLoad key contract, moving the date range kept the PREVIOUS range's
// figures on screen for the whole of the new load — and left them there
// permanently if the new read failed, marked only "stale". On this page
// that is one period's money presented as another's.
//
// Finance.jsx is NOT modified by this. The contract fixes it from inside
// the hook, and this test is here to prove that claim rather than assert it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { useLoad } from '../hooks/useLoad.js'

// The exact call shape Finance.jsx uses (Finance.jsx:120).
function SummaryPanel({ start, end }) {
  const qs = `start=${start}&end=${end}`
  const summaryLoad = useLoad(
    async () => {
      const res = await fetch(`/api/finance/summary?${qs}`)
      if (!res.ok) throw new Error(`Failed (${res.status})`)
      return res.json()
    },
    [start, end],
    { isEmpty: () => false }
  )
  const summary = summaryLoad.data
  return (
    <div>
      <h2 data-testid="label">{start} → {end}</h2>
      <div data-testid="state">{summaryLoad.state}</div>
      <div data-testid="total">{summary ? `$${summary.total}` : 'NO FIGURE'}</div>
      <div data-testid="stale">{String(summaryLoad.isStale)}</div>
    </div>
  )
}

const txt = (id) => screen.getByTestId(id).textContent

describe('Finance date range — money never wears the wrong period', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('CONTROL: a range loads and shows its own figure', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ total: '1000.00' }) })
    render(<SummaryPanel start="2026-01-01" end="2026-01-31" />)
    await waitFor(() => expect(txt('state')).toBe('ready'))
    expect(txt('total')).toBe('$1000.00')
  })

  it('while the NEW range loads, the OLD range’s money is not on screen', async () => {
    let release
    fetch.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ total: '1000.00' }) }))
    const { rerender } = render(<SummaryPanel start="2026-01-01" end="2026-01-31" />)
    await waitFor(() => expect(txt('total')).toBe('$1000.00'))

    fetch.mockImplementationOnce(() => new Promise(res => { release = res }))
    rerender(<SummaryPanel start="2026-02-01" end="2026-02-28" />)

    // The heading has already changed. The figure must not still be
    // January's.
    expect(txt('label')).toBe('2026-02-01 → 2026-02-28')
    expect(txt('total')).toBe('NO FIGURE')
    expect(txt('state')).toBe('loading')

    await act(async () => { release({ ok: true, status: 200, json: async () => ({ total: '250.00' }) }) })
    await waitFor(() => expect(txt('total')).toBe('$250.00'))
  })

  it('if the NEW range FAILS, the old figure does not stay under the new heading', async () => {
    fetch.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ total: '1000.00' }) }))
    const { rerender } = render(<SummaryPanel start="2026-01-01" end="2026-01-31" />)
    await waitFor(() => expect(txt('total')).toBe('$1000.00'))

    fetch.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    rerender(<SummaryPanel start="2026-02-01" end="2026-02-28" />)

    await waitFor(() => expect(txt('state')).toBe('failed'))
    expect(txt('total')).toBe('NO FIGURE')
    // Not "stale": there is nothing here that is an out-of-date answer to
    // the question being asked.
    expect(txt('stale')).toBe('false')
  })

  it('CONTROL: a failed refresh of the SAME range still keeps its figure, marked stale', async () => {
    fetch.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ total: '1000.00' }) }))
    function Wrapper({ nonce }) {
      const load = useLoad(
        async () => {
          const res = await fetch('/api/finance/summary?start=2026-01-01&end=2026-01-31')
          if (!res.ok) throw new Error(`Failed (${res.status})`)
          return res.json()
        },
        [nonce],
        { isEmpty: () => false, key: '2026-01-01|2026-01-31' }
      )
      return (
        <div>
          <div data-testid="state">{load.state}</div>
          <div data-testid="total">{load.data ? `$${load.data.total}` : 'NO FIGURE'}</div>
          <div data-testid="stale">{String(load.isStale)}</div>
        </div>
      )
    }
    const { rerender } = render(<Wrapper nonce={1} />)
    await waitFor(() => expect(txt('total')).toBe('$1000.00'))

    fetch.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    rerender(<Wrapper nonce={2} />)
    await waitFor(() => expect(txt('stale')).toBe('true'))
    // Same dataset, so the last truthful figure may remain.
    expect(txt('total')).toBe('$1000.00')
  })
})
