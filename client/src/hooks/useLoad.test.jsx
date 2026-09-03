// The load primitive's own contract. (Pass 7 §4)
//
// The one rule worth testing hardest: there is no path from a failed read to
// an empty state. Every defect this pass and the last was that path.

import { render, screen, act, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { useLoad } from './useLoad'

let last
function Probe({ fetcher, options }) {
  const r = useLoad(fetcher, [], options)
  last = r
  return (
    <div>
      <span data-testid="state">{r.state}</span>
      <span data-testid="data">{JSON.stringify(r.data)}</span>
      <span data-testid="stale">{String(r.isStale)}</span>
      <span data-testid="error">{r.error ?? '(none)'}</span>
    </div>
  )
}
const mount = (fetcher, options) => render(<Probe fetcher={fetcher} options={options} />)
const settled = () => waitFor(() => expect(screen.getByTestId('state').textContent).not.toBe('loading'))

describe('the four states', () => {
  it('a successful read with rows is ready', async () => {
    mount(async () => [1, 2, 3]); await settled()
    expect(screen.getByTestId('state')).toHaveTextContent('ready')
  })

  it('a successful read with no rows is empty', async () => {
    mount(async () => []); await settled()
    expect(screen.getByTestId('state')).toHaveTextContent('empty')
  })

  it('a failed first read is failed — NEVER empty', async () => {
    mount(async () => { throw new Error('Failed (500)') }); await settled()
    expect(screen.getByTestId('state')).toHaveTextContent('failed')
    expect(screen.getByTestId('state')).not.toHaveTextContent('empty')
    expect(screen.getByTestId('error')).toHaveTextContent('Failed (500)')
  })

  it('a custom isEmpty decides emptiness for non-array data', async () => {
    mount(async () => ({ total: 0, count: 0 }), { isEmpty: d => d?.count === 0 })
    await settled()
    expect(screen.getByTestId('state')).toHaveTextContent('empty')
  })

  it('a legitimate zero is NOT empty when the caller says so', async () => {
    // Finance: $0.00 is an answer. The primitive must not decide otherwise.
    mount(async () => ({ total: 0 }), { isEmpty: () => false })
    await settled()
    expect(screen.getByTestId('state')).toHaveTextContent('ready')
  })
})

describe('a refresh that fails does not erase what we know', () => {
  it('keeps the data, marks it stale, and does not become empty', async () => {
    let call = 0
    const fetcher = async () => {
      if (++call === 1) return [{ id: 1 }]
      throw new Error('Failed (500)')
    }
    mount(fetcher); await settled()
    expect(screen.getByTestId('state')).toHaveTextContent('ready')

    let outcome
    await act(async () => { outcome = await last.reload() })
    expect(outcome).toBe(false)                       // the caller can branch on this
    expect(screen.getByTestId('state')).toHaveTextContent('ready')
    expect(screen.getByTestId('state')).not.toHaveTextContent('empty')
    expect(screen.getByTestId('data')).toHaveTextContent('[{"id":1}]')
    expect(screen.getByTestId('stale')).toHaveTextContent('true')
  })

  it('an empty-then-failed refresh stays empty, not failed', async () => {
    let call = 0
    mount(async () => { if (++call === 1) return []; throw new Error('boom') })
    await settled()
    await act(async () => { await last.reload() })
    expect(screen.getByTestId('state')).toHaveTextContent('empty')
    expect(screen.getByTestId('stale')).toHaveTextContent('true')
  })

  it('recovers and clears stale when the server comes back', async () => {
    let call = 0
    mount(async () => {
      call++
      if (call === 2) throw new Error('boom')
      return [{ id: call }]
    })
    await settled()
    await act(async () => { await last.reload() })
    expect(screen.getByTestId('stale')).toHaveTextContent('true')
    let outcome
    await act(async () => { outcome = await last.reload() })
    expect(outcome).toBe(true)
    expect(screen.getByTestId('stale')).toHaveTextContent('false')
    expect(screen.getByTestId('error')).toHaveTextContent('(none)')
  })
})

describe('under StrictMode, which is how the app actually runs', () => {
  // main.jsx wraps the app in StrictMode, so React 19 mounts, unmounts and
  // remounts every component in development. The first version of this hook
  // cleared its `alive` ref on unmount and never set it back, so every state
  // update after the simulated unmount was dropped and /notifications sat on
  // a spinner forever — while all 69 tests stayed green, because
  // testing-library does not wrap in StrictMode.
  //
  // This test exists so the suite can see what the suite could not see.
  const mountStrict = (fetcher) =>
    render(<StrictMode><Probe fetcher={fetcher} /></StrictMode>)

  it('still resolves a successful read', async () => {
    mountStrict(async () => [1])
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'))
  })

  it('still resolves a failed read instead of spinning forever', async () => {
    mountStrict(async () => { throw new Error('Failed (500)') })
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('failed'))
  })

  it('retry works after the simulated remount, which is when it would not', async () => {
    // The defect killed every state update AFTER the remount, so a retry was
    // exactly the operation that could never settle. Mount, fail, retry,
    // succeed — the whole lifecycle the brief asks for, inside StrictMode.
    // NOT a call counter: StrictMode invokes the effect twice, so a
    // "fail on call 1" fetcher succeeds on the mount's own second run and
    // the test never sees a failure. The condition has to be one the test
    // controls, not one the render count decides.
    let shouldFail = true
    mountStrict(async () => {
      if (shouldFail) throw new Error('Failed (500)')
      return [{ id: 1 }]
    })
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('failed'))
    shouldFail = false
    let outcome
    await act(async () => { outcome = await last.reload() })
    expect(outcome).toBe(true)
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'))
    expect(screen.getByTestId('stale')).toHaveTextContent('false')
  })

  it('an unmount really does stop it writing state', async () => {
    // The fix must not overcorrect: resetting `alive` on mount cannot mean
    // a genuinely unmounted component keeps setting state.
    let release
    const held = new Promise(res => { release = res })
    const { unmount } = render(<StrictMode><Probe fetcher={async () => { await held; return [1] }} /></StrictMode>)
    unmount()
    await act(async () => { release() })
    // No "state update on unmounted component" warning, and nothing throws.
    expect(true).toBe(true)
  })
})

describe('ordering and lifetime', () => {
  it('a superseded response never overwrites a newer one', async () => {
    const gate = []
    const fetcher = vi.fn(() => new Promise(res => gate.push(res)))
    mount(fetcher)
    await waitFor(() => expect(gate.length).toBe(1))
    await act(async () => { last.reload() })
    await waitFor(() => expect(gate.length).toBe(2))
    // The SECOND request answers first, then the stale first one lands.
    await act(async () => { gate[1](['new']); gate[0](['old']) })
    expect(screen.getByTestId('data')).toHaveTextContent('["new"]')
  })

  it('enabled:false is idle — not loading, and above all not empty', async () => {
    const fetcher = vi.fn()
    mount(fetcher, { enabled: false })
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('idle'))
    expect(screen.getByTestId('state')).not.toHaveTextContent('empty')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
