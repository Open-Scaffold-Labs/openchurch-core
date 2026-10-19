// Schedule assigned chips open the person they already know.
//
// THE INVARIANT: a chip is a profile hop only when it is backed by a
// real client id AND the picker was asked to link (Schedule drawer).
// A missing or garbled id stays text. Remove stays a separate control.
// Groups / Events leave linkProfiles off, so their chips stay text.
//
// Mutate any one of these and the matching test goes red:
//   1. A named chip with a live id no longer goes to /clients/:id
//   2. Alpha's chip opens Omega
//   3. A name without a real id invents /clients/:something
//   4. The remove control stops changing the assignment
//   5. linkProfiles off still grows profile links

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import MemberPicker, { assignedMemberHref } from './MemberPicker'

const ALPHA = { id: 11, name: 'Ana Delgado', role: 'Lector' }
const OMEGA = { id: 22, name: 'Tomas Rivas', role: 'Server' }

const wrap = (node) => render(<MemoryRouter>{node}</MemoryRouter>)

describe('assignedMemberHref', () => {
  it('only a positive integer becomes a person URL', () => {
    expect(assignedMemberHref(11)).toBe('/clients/11')
    expect(assignedMemberHref('22')).toBe('/clients/22')
    expect(assignedMemberHref(0)).toBeNull()
    expect(assignedMemberHref(-3)).toBeNull()
    expect(assignedMemberHref(1.5)).toBeNull()
    expect(assignedMemberHref('not-an-id')).toBeNull()
    expect(assignedMemberHref('')).toBeNull()
    expect(assignedMemberHref(null)).toBeNull()
    expect(assignedMemberHref(undefined)).toBeNull()
  })
})

describe('Schedule assigned chips', () => {
  it('a chip backed by a real client id opens that person', () => {
    wrap(
      <MemberPicker
        members={[ALPHA, OMEGA]}
        value={[ALPHA.id, OMEGA.id]}
        onChange={() => {}}
        linkProfiles
      />
    )

    expect(screen.getByRole('link', { name: /Ana Delgado/ }).getAttribute('href')).toBe('/clients/11')
    expect(screen.getByRole('link', { name: /Tomas Rivas/ }).getAttribute('href')).toBe('/clients/22')
  })

  it('Alpha is not Omega', () => {
    wrap(
      <MemberPicker
        members={[ALPHA, OMEGA]}
        value={[ALPHA.id, OMEGA.id]}
        onChange={() => {}}
        linkProfiles
      />
    )

    const alpha = screen.getByRole('link', { name: /Ana Delgado/ })
    const omega = screen.getByRole('link', { name: /Tomas Rivas/ })
    expect(alpha.getAttribute('href')).toBe('/clients/11')
    expect(omega.getAttribute('href')).toBe('/clients/22')
    expect(alpha.getAttribute('href')).not.toBe(omega.getAttribute('href'))
  })

  it('a name without a real client id stays text — no invented person', () => {
    wrap(
      <MemberPicker
        members={[{ id: 'not-an-id', name: 'Historical Name Only', role: 'Member' }]}
        value={['not-an-id']}
        onChange={() => {}}
        linkProfiles
      />
    )

    expect(screen.getByText('Historical Name Only')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Historical Name Only/ })).not.toBeInTheDocument()
    const hrefs = [...document.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).not.toContain('/clients/undefined')
    expect(hrefs).not.toContain('/clients/null')
    expect(hrefs.some(h => h && h.startsWith('/clients/'))).toBe(false)
  })

  it('remove still drops that person from the assignment', () => {
    const onChange = vi.fn()
    wrap(
      <MemberPicker
        members={[ALPHA, OMEGA]}
        value={[ALPHA.id, OMEGA.id]}
        onChange={onChange}
        linkProfiles
      />
    )

    const chip = screen.getByRole('link', { name: /Ana Delgado/ }).closest('span')
    chip.querySelector('button').click()
    expect(onChange).toHaveBeenCalledWith([OMEGA.id])
  })

  it('without linkProfiles the chips stay text — Groups and Events are unchanged', () => {
    wrap(
      <MemberPicker
        members={[ALPHA]}
        value={[ALPHA.id]}
        onChange={() => {}}
      />
    )

    expect(screen.getByText('Ana Delgado')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Ana Delgado/ })).not.toBeInTheDocument()
  })
})
