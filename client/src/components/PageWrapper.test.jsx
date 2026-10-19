// Component probe: PageWrapper takes the duration-0 / skip path when
// prefers-reduced-motion is set. Mutate the hook wiring or the
// data-reduced-motion attribute and this goes red.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { reduced } = vi.hoisted(() => ({ reduced: { current: false } }))

vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useReducedMotion: () => reduced.current,
  }
})

import PageWrapper from './PageWrapper'

describe('PageWrapper reduced-motion path (OC-READY-01-015)', () => {
  beforeEach(() => {
    reduced.current = false
  })

  it('skips the hidden entrance when the user prefers reduced motion', () => {
    reduced.current = true
    const { container } = render(
      <PageWrapper>
        <p>the office</p>
      </PageWrapper>,
    )
    const wrap = container.querySelector('[data-reduced-motion]')
    expect(wrap).toHaveAttribute('data-reduced-motion', 'reduce')
    expect(screen.getByText('the office')).toBeVisible()
    expect(wrap.style.opacity === '' || wrap.style.opacity === '1').toBe(true)
  })

  it('keeps the ceremonial entrance attribute when motion is welcome', () => {
    reduced.current = false
    const { container } = render(
      <PageWrapper>
        <p>the book</p>
      </PageWrapper>,
    )
    expect(container.querySelector('[data-reduced-motion]')).toHaveAttribute(
      'data-reduced-motion',
      'full',
    )
    expect(screen.getByText('the book')).toBeInTheDocument()
  })
})
