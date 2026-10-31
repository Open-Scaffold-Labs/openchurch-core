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

import PageWrapper, { PageHeader, PAGE_WIDTH } from './PageWrapper'

describe('PageHeader (quiet craft 3)', () => {
  it('renders one serif title, optional subtitle, and actions on the right', () => {
    render(
      <PageHeader
        title="Members"
        subtitle="The parish register"
        actions={<button type="button">Add</button>}
      />,
    )
    const heading = screen.getByRole('heading', { level: 1, name: 'Members' })
    expect(heading).toHaveClass('font-display')
    expect(heading).toHaveClass('text-3xl')
    expect(screen.getByText('The parish register')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
    expect(document.querySelector('[data-page-header]')).toBeTruthy()
  })

  it('keeps leading icons quiet and non-decorative for a11y', () => {
    render(
      <PageHeader title="Check-in" leading={<span data-testid="lead-icon">icon</span>} />,
    )
    expect(screen.getByTestId('lead-icon').parentElement).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('PageWrapper type widths (quiet craft 3)', () => {
  beforeEach(() => {
    reduced.current = false
  })

  it.each([
    ['list', PAGE_WIDTH.list],
    ['record', PAGE_WIDTH.record],
    ['document', PAGE_WIDTH.document],
  ])('applies the %s content width', (type, expected) => {
    const { container } = render(
      <PageWrapper type={type}>
        <p>body</p>
      </PageWrapper>,
    )
    const wrap = container.querySelector('[data-page-type]')
    expect(wrap).toHaveAttribute('data-page-type', type)
    expect(wrap.className).toContain(expected.split(' ')[0])
  })

  it('renders PageHeader from title props (Getting Settled path)', () => {
    render(
      <PageWrapper title="Getting settled" subtitle="What is already true">
        <p>body</p>
      </PageWrapper>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Getting settled' })).toBeInTheDocument()
    expect(screen.getByText('What is already true')).toBeInTheDocument()
  })

  it('lets className override type width for full-bleed pages', () => {
    const { container } = render(
      <PageWrapper type="list" className="max-w-full flex flex-col">
        <p>calendar</p>
      </PageWrapper>,
    )
    expect(container.querySelector('[data-reduced-motion]').className).toContain('max-w-full')
  })
})
