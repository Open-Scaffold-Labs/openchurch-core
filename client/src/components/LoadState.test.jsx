// The render guard's own contract. (Pass 9 §8)
//
// The property that matters: there is no input for which this renders the
// EMPTY branch while the load is still in flight, and no input for which it
// calls children() without real data.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import LoadState from './LoadState'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { organization: { locale: 'en' } }, token: 't', loading: false }),
}))

const show = (load) => render(
  <LocaleProvider>
    <LoadState load={load} empty={<p>EMPTY BRANCH</p>} idle={<p>IDLE BRANCH</p>}>
      {rows => <p>ROWS: {rows.length}</p>}
    </LoadState>
  </LocaleProvider>
)
const make = (over) => ({ state: 'ready', data: [], error: null, isStale: false, reload: () => {}, retrying: false, ...over })

describe('the branch each state reaches', () => {
  it('loading shows neither the empty branch nor the rows', () => {
    show(make({ state: 'loading', data: null }))
    expect(screen.queryByText('EMPTY BRANCH')).not.toBeInTheDocument()
    expect(screen.queryByText(/ROWS:/)).not.toBeInTheDocument()
  })

  it('failed shows the failure, never the empty branch', () => {
    show(make({ state: 'failed', data: null, error: 'Failed (500)' }))
    expect(screen.getByText(/didn'?t load/i)).toBeInTheDocument()
    expect(screen.queryByText('EMPTY BRANCH')).not.toBeInTheDocument()
  })

  it('empty shows the empty branch', () => {
    show(make({ state: 'empty', data: [] }))
    expect(screen.getByText('EMPTY BRANCH')).toBeInTheDocument()
  })

  it('ready calls children with the data', () => {
    show(make({ state: 'ready', data: [1, 2, 3] }))
    expect(screen.getByText('ROWS: 3')).toBeInTheDocument()
  })

  it('idle shows the idle branch — we have not asked', () => {
    show(make({ state: 'idle', data: null }))
    expect(screen.getByText('IDLE BRANCH')).toBeInTheDocument()
    expect(screen.queryByText('EMPTY BRANCH')).not.toBeInTheDocument()
  })
})

describe('the property the crash taught us', () => {
  it('children is NEVER called while data could still be null', () => {
    const child = vi.fn(() => <p>called</p>)
    for (const state of ['idle', 'loading', 'failed']) {
      render(
        <LocaleProvider>
          <LoadState load={make({ state, data: null, error: 'x' })}>{child}</LoadState>
        </LocaleProvider>
      )
    }
    expect(child).not.toHaveBeenCalled()
  })

  it('stale data is shown WITH its warning, not replaced by one', () => {
    show(make({ state: 'ready', data: [1, 2], isStale: true, error: 'Failed (500)' }))
    expect(screen.getByText('ROWS: 2')).toBeInTheDocument()
    expect(screen.getByText(/didn'?t load/i)).toBeInTheDocument()
  })
})
