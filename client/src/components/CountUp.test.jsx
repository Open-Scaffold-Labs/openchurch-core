import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import CountUp from './CountUp'

const fmt = (n) => `$${Math.round(n)}`
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('CountUp (quiet craft 2 — no animated metrics)', () => {
  it('shows the first value at once, with no count on load', () => {
    render(<p data-testid="v"><CountUp value={4182} format={fmt} /></p>)
    expect(screen.getByTestId('v').textContent).toBe('$4182')
  })

  it('jumps straight to the new value when the total changes', () => {
    const { rerender } = render(<p data-testid="v"><CountUp value={4182} format={fmt} /></p>)
    rerender(<p data-testid="v"><CountUp value={4302} format={fmt} /></p>)
    expect(screen.getByTestId('v').textContent).toBe('$4302')
  })

  it('never schedules a count even when motion is welcome', async () => {
    vi.stubGlobal('matchMedia', (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
    let now = 0
    const frames = []
    vi.stubGlobal('performance', { now: () => now })
    vi.stubGlobal('requestAnimationFrame', (cb) => { frames.push(cb); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const { rerender } = render(<p data-testid="v"><CountUp value={4182} format={fmt} /></p>)
    rerender(<p data-testid="v"><CountUp value={4302} format={fmt} /></p>)
    await act(async () => { now = 150; while (frames.length) frames.shift()(now) })
    expect(frames).toHaveLength(0)
    expect(screen.getByTestId('v').textContent).toBe('$4302')
  })
})
