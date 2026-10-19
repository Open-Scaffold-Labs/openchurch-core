// Version-1 giving statements stored a gift date as the locale text of a
// JS Date ("Tue Sep 1"), not as YYYY-MM-DD. The statement must show that
// civil day from the snapshot's tax year when the weekday agrees, and the
// raw stored text when it does not. new Date('Tue Sep 1') is 2001 in V8,
// and splitting on 'T' deletes "Tue" and "Thu".

import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import DonorStatement, { fmtDateLong } from './DonorStatement'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, isAdmin: true, canWrite: true,
  }),
}))

const ok = b => ({ ok: true, status: 200, json: async () => b })

function long(year, monthIndex, day) {
  return new Date(year, monthIndex, day).toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  })
}

const ORG = {
  name: 'St Brigid', address: '1 Old Address', tax_id: '11-1111111',
  signatory_name: 'Fr. Alvarez', signatory_title: 'Pastor', statement_letterhead: null,
}
const DONOR = { name: 'Rosa Vega', email: 'rosa@example.com', address: '9 Elm St' }

function line(donationId, date, amount) {
  return {
    donation_id: donationId, date, amount, refunded_total: '0.00',
    live_amount: amount, category: 'tithe', method: 'cash', notes: null,
  }
}

function statement({ id, no, status, version, lines, total, supersededBy, correction }) {
  return {
    statement: {
      id, tax_year: 2026, statement_no: no, status,
      snapshot_version: version,
      snapshot_json: {
        snapshot_version: version,
        tax_year: 2026,
        donor: DONOR,
        organization: ORG,
        lines,
        total,
        gift_count: lines.length,
        unknown_at_issue: [],
        ...(correction ? { correction } : {}),
      },
      issued_at: '2026-01-15T12:00:00Z',
      issued_by_name: 'Admin',
      superseded_at: supersededBy ? '2026-03-01T12:00:00Z' : null,
      superseded_by_id: supersededBy,
    },
  }
}

function viewIssued(id) {
  return (
    <MemoryRouter initialEntries={[`/donations/statements/rosa@example.com?issued=${id}`]}>
      <LocaleProvider>
        <Routes>
          <Route path="/donations/statements/:donorKey" element={<DonorStatement />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('version-1 gift dates render as the recorded civil day', () => {
  it('Tue and Thu values use the tax year, and a capital T is not a separator', () => {
    expect(fmtDateLong('Tue Sep 1', 2026)).toBe(long(2026, 8, 1))
    expect(fmtDateLong('Thu Sep 3', 2026)).toBe(long(2026, 8, 3))
    expect(fmtDateLong('2026-09-27', 2026)).toBe(long(2026, 8, 27))
    expect(fmtDateLong('2026-09-27T00:00:00.000Z', 2026)).toBe(long(2026, 8, 27))
    expect(fmtDateLong('Tue Sep 1', 2026)).not.toMatch(/Invalid Date/)
    expect(fmtDateLong('Thu Sep 3', 2026)).not.toMatch(/Invalid Date/)
  })

  it('does not roll Feb 29 into March when the tax year is not a leap year', () => {
    // 2026-02-29 overflows to Sunday March 1. Dropping the overflow check
    // would print that rolled day because the weekday still says Sun.
    expect(fmtDateLong('Sun Feb 29', 2026)).toBe('Sun Feb 29')
    expect(fmtDateLong('Sun Feb 29', 2026)).not.toBe(long(2026, 2, 1))
  })

  it('a weekday mismatch and any other shape stay the raw stored text', () => {
    // 27 September 2026 is a Sunday. "Mon" does not agree.
    expect(fmtDateLong('Mon Sep 27', 2026)).toBe('Mon Sep 27')
    expect(fmtDateLong('not a date', 2026)).toBe('not a date')
    expect(fmtDateLong('Sun September 27', 2026)).toBe('Sun September 27')
    expect(fmtDateLong('Mon Sep 27', 2026)).not.toMatch(/Invalid Date/)
  })

  it('does not call new Date on a legacy string', () => {
    const Real = globalThis.Date
    function GuardedDate(...args) {
      if (args.length === 1 && typeof args[0] === 'string' && !/^\d{4}-\d{2}-\d{2}T/.test(args[0])) {
        throw new Error(`new Date() on a non-instant string: ${args[0]}`)
      }
      return new Real(...args)
    }
    GuardedDate.prototype = Real.prototype
    GuardedDate.now = Real.now.bind(Real)
    GuardedDate.parse = Real.parse.bind(Real)
    GuardedDate.UTC = Real.UTC.bind(Real)
    vi.stubGlobal('Date', GuardedDate)

    expect(fmtDateLong('Tue Sep 1', 2026)).toBe(long(2026, 8, 1))
    expect(fmtDateLong('Thu Sep 3', 2026)).toBe(long(2026, 8, 3))
    expect(fmtDateLong('Mon Sep 27', 2026)).toBe('Mon Sep 27')
  })

  it('a v1 original and a v2 correction render side by side', async () => {
    const v1 = statement({
      id: 11, no: '2026-1', status: 'superseded', version: 1, supersededBy: 12,
      total: '24.00',
      lines: [line(1, 'Tue Sep 1', '11.00'), line(2, 'Thu Sep 3', '13.00')],
    })
    const v2 = statement({
      id: 12, no: '2026-2', status: 'issued', version: 2, supersededBy: null,
      total: '27.00',
      lines: [line(3, '2026-09-27', '27.00')],
      correction: {
        supersedes_statement_id: 11,
        supersedes_statement_no: '2026-1',
        donor_identity_from: 'live-rows',
        zero_is_a_claim: false,
        reason: 'Corrects the earlier statement.',
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const id = String(url).match(/\/issued\/(\d+)/)?.[1]
      if (id === '11') return ok(v1)
      if (id === '12') return ok(v2)
      return ok({})
    }))

    render(
      <>
        {viewIssued(11)}
        {viewIssued(12)}
      </>
    )

    const banners = await screen.findAllByTestId('statement-issued-banner', {}, { timeout: 4000 })
    expect(banners).toHaveLength(2)
    const text = banners.map(b => b.textContent).join('\n')
    expect(text).toMatch(/Superseded by statement #12/)
    expect(text).toMatch(/supersedes No\. 2026-1/)

    await waitFor(() => {
      expect(document.body.textContent).toContain(long(2026, 8, 1))
      expect(document.body.textContent).toContain(long(2026, 8, 3))
      expect(document.body.textContent).toContain(long(2026, 8, 27))
    })
    expect(document.body.textContent).not.toContain('Tue Sep 1')
    expect(document.body.textContent).not.toContain('Thu Sep 3')
    expect(document.body.textContent).not.toMatch(/Invalid Date/)
  })

  it('a mismatched weekday renders raw on the statement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(statement({
      id: 11, no: '2026-1', status: 'issued', version: 1, supersededBy: null,
      total: '10.00',
      lines: [line(1, 'Mon Sep 27', '10.00'), line(2, 'not a date', '1.00')],
    }))))
    render(viewIssued(11))
    await screen.findByTestId('statement-issued-banner', {}, { timeout: 4000 })
    await waitFor(() => expect(document.body.textContent).toContain('Mon Sep 27'))
    expect(document.body.textContent).toContain('not a date')
    // The gift table only. The "Issued" line elsewhere on the page is a
    // different date and is not this claim.
    const cells = screen.getAllByRole('cell').map(c => c.textContent)
    expect(cells).toContain('Mon Sep 27')
    expect(cells).toContain('not a date')
    expect(cells).not.toContain(long(2026, 8, 27))
    expect(document.body.textContent).not.toMatch(/Invalid Date/)
  })
})
