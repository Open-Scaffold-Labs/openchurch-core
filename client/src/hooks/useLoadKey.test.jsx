// Rule 2: DATA BELONGS TO THE KEY IT WAS FETCHED FOR.
//
// The founder rule these pin:
//   SAME KEY + refresh failure  → last known truthful data may remain, stale.
//   DIFFERENT KEY               → the old data must never wear the new label.
//
// Every case drives the real hook. The control comes first in each pair, so
// a test that passes because the feature was deleted is visible as the
// control going red too.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import { useLoad } from './useLoad.js'

// A probe that renders the hook's whole observable surface as text, so an
// assertion can never be satisfied by something adjacent.
function Probe({ week, fetcher, options }) {
  const load = useLoad(fetcher, [week], options)
  return (
    <div>
      <div data-testid="state">{load.state}</div>
      <div data-testid="data">{load.data == null ? 'NONE' : JSON.stringify(load.data)}</div>
      <div data-testid="stale">{String(load.isStale)}</div>
      <div data-testid="error">{load.error ?? 'NONE'}</div>
    </div>
  )
}

const at = (id) => screen.getByTestId(id).textContent
const settled = async (state) => waitFor(() => expect(at('state')).toBe(state))

describe('useLoad — dataset identity', () => {
  let calls
  beforeEach(() => { calls = [] })

  // Resolves with the key it was asked for, so a wrong-key render is
  // legible in the assertion rather than inferred.
  const byWeek = (overrides = {}) => vi.fn(async () => {
    const week = calls.length + 1
    calls.push(week)
    if (overrides[week] === 'fail') throw new Error(`boom week ${week}`)
    return overrides[week] ?? `money-week-${week}`
  })

  it('CONTROL: a same-key refresh that SUCCEEDS just updates the data', async () => {
    let n = 0
    const fetcher = vi.fn(async () => `v${++n}`)
    const { rerender } = render(<Probe week={1} fetcher={fetcher} />)
    await settled('ready')
    expect(at('data')).toBe('"v1"')
    rerender(<Probe week={1} fetcher={fetcher} />)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  })

  it('CONTROL: a same-key refresh that FAILS keeps the data and marks it stale', async () => {
    let n = 0
    const fetcher = vi.fn(async () => {
      if (++n === 1) return 'week-1-money'
      throw new Error('refresh failed')
    })
    const { rerender } = render(<Probe week={1} fetcher={fetcher} options={{ key: 'w1' }} />)
    await settled('ready')
    expect(at('data')).toBe('"week-1-money"')

    // Same key, forced re-run via a changed dep that is NOT the key.
    rerender(<Probe week={2} fetcher={fetcher} options={{ key: 'w1' }} />)
    await waitFor(() => expect(at('stale')).toBe('true'))
    // The rule: last known truthful data may remain.
    expect(at('data')).toBe('"week-1-money"')
    expect(at('state')).toBe('ready')
  })

  it('a KEY CHANGE must never show the previous dataset — not even while loading', async () => {
    let release
    const fetcher = vi.fn(() => new Promise(res => { release = res }))
    const { rerender } = render(<Probe week={1} fetcher={fetcher} />)
    act(() => release('week-1-money'))
    await settled('ready')
    expect(at('data')).toBe('"week-1-money"')

    // Week 2 begins. Before its response arrives the page must NOT be
    // showing week 1's number under week 2.
    rerender(<Probe week={2} fetcher={fetcher} />)
    expect(at('state')).toBe('loading')
    expect(at('data')).toBe('NONE')

    act(() => release('week-2-money'))
    await settled('ready')
    expect(at('data')).toBe('"week-2-money"')
  })

  it('a FAILURE AFTER A KEY CHANGE is failed, not stale — there is nothing to be stale about', async () => {
    let n = 0
    const fetcher = vi.fn(async () => {
      if (++n === 1) return 'week-1-money'
      throw new Error('week 2 unavailable')
    })
    const { rerender } = render(<Probe week={1} fetcher={fetcher} />)
    await settled('ready')

    rerender(<Probe week={2} fetcher={fetcher} />)
    await settled('failed')
    // THE WHOLE POINT: last week's money is gone, not relabelled.
    expect(at('data')).toBe('NONE')
    expect(at('stale')).toBe('false')
    expect(at('error')).toBe('week 2 unavailable')
  })

  it('an EMPTY new key does not inherit the old key’s rows', async () => {
    let n = 0
    const fetcher = vi.fn(async () => (++n === 1 ? ['a', 'b'] : []))
    const { rerender } = render(<Probe week={1} fetcher={fetcher} options={{ initial: [] }} />)
    await settled('ready')
    expect(at('data')).toBe('["a","b"]')

    rerender(<Probe week={2} fetcher={fetcher} options={{ initial: [] }} />)
    await settled('empty')
    expect(at('data')).toBe('[]')
  })

  it('A → B → A refetches A rather than serving a remembered copy', async () => {
    const seen = []
    const fetcher = vi.fn(async () => { seen.push('call'); return `n${seen.length}` })
    const { rerender } = render(<Probe week={1} fetcher={fetcher} />)
    await settled('ready')
    rerender(<Probe week={2} fetcher={fetcher} />)
    await settled('ready')
    rerender(<Probe week={1} fetcher={fetcher} />)
    await settled('ready')
    // Three loads, not two: there is deliberately no cache.
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(at('data')).toBe('"n3"')
  })

  it('RAPID A → B: a late response for A must not land under B', async () => {
    const resolvers = {}
    const fetcher = vi.fn((k = Object.keys(resolvers).length + 1) =>
      new Promise(res => { resolvers[Object.keys(resolvers).length + 1] = res }))

    const { rerender } = render(<Probe week={1} fetcher={fetcher} />)
    rerender(<Probe week={2} fetcher={fetcher} />)   // B starts before A returns

    // A comes back late.
    act(() => resolvers[1]('week-1-money'))
    await Promise.resolve()
    expect(at('data')).not.toBe('"week-1-money"')
    expect(at('state')).toBe('loading')

    act(() => resolvers[2]('week-2-money'))
    await settled('ready')
    expect(at('data')).toBe('"week-2-money"')
  })

  it('survives StrictMode’s mount/unmount/remount', async () => {
    const fetcher = vi.fn(async () => 'strict-value')
    render(
      <StrictMode>
        <Probe week={1} fetcher={fetcher} />
      </StrictMode>
    )
    await settled('ready')
    expect(at('data')).toBe('"strict-value"')
  })

  it('does not set state after unmount', async () => {
    let release
    const fetcher = vi.fn(() => new Promise(res => { release = res }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<Probe week={1} fetcher={fetcher} />)
    unmount()
    await act(async () => { release('late'); await Promise.resolve() })
    expect(spy).not.toHaveBeenCalledWith(
      expect.stringContaining('unmounted'), expect.anything(), expect.anything())
    spy.mockRestore()
  })

  it('two panels on one page keep their own identities', async () => {
    const a = vi.fn(async () => 'panel-a')
    const b = vi.fn(async () => 'panel-b')
    function TwoPanels({ week }) {
      const left = useLoad(a, [week])
      const right = useLoad(b, ['fixed'])
      return (
        <div>
          <span data-testid="left">{left.data ?? 'NONE'}</span>
          <span data-testid="right">{right.data ?? 'NONE'}</span>
        </div>
      )
    }
    const { rerender } = render(<TwoPanels week={1} />)
    await waitFor(() => expect(screen.getByTestId('left').textContent).toBe('panel-a'))
    expect(screen.getByTestId('right').textContent).toBe('panel-b')

    rerender(<TwoPanels week={2} />)
    // The right panel's key did not change, so its data stays put; the
    // left panel's did, so it reloads.
    expect(screen.getByTestId('right').textContent).toBe('panel-b')
    await waitFor(() => expect(a).toHaveBeenCalledTimes(2))
    expect(b).toHaveBeenCalledTimes(1)
  })
})
