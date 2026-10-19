// GIV-09 — a preview and an issued statement must not look alike.
//
// The server guarantees an issued statement is frozen. This pins the half the
// donor actually sees: which of the two documents is in their hands. A page
// that renders identical chrome for both would satisfy every server test and
// still hand someone a live preview that changes after they file their taxes.
//
// The issued case is asserted to render from snapshot_json ALONE — the fetch
// stub answers /issued/:id and nothing else, so a component that reached for
// live giving or the org row would fail rather than quietly succeed.

import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import DonorStatement from './DonorStatement'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, isAdmin: true, canWrite: true,
  }),
}))

const ok = b => ({ ok: true, status: 200, json: async () => b })

const SNAPSHOT = {
  snapshot_version: 1,
  tax_year: 2026,
  donor: { name: 'Rosa Vega', email: 'rosa@example.com', address: '9 Elm St' },
  organization: {
    name: 'St Brigid', address: '1 Old Address', tax_id: '11-1111111',
    signatory_name: 'Fr. Alvarez', signatory_title: 'Pastor', statement_letterhead: null,
  },
  lines: [{ donation_id: 1, date: '2026-03-01', amount: '500.00', refunded_total: '0.00',
            live_amount: '500.00', category: null, method: null, notes: null }],
  total: '500.00',
  gift_count: 1,
  unknown_at_issue: ['organization.statement_letterhead'],
}

const view = (search) => render(
  <MemoryRouter initialEntries={[`/donations/statements/rosa@example.com${search}`]}>
    <LocaleProvider>
      <Routes>
        <Route path="/donations/statements/:donorKey" element={<DonorStatement />} />
      </Routes>
    </LocaleProvider>
  </MemoryRouter>
)

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

describe('preview and issued are visibly different documents (GIV-09)', () => {
  it('AN ISSUED STATEMENT RENDERS FROM ITS SNAPSHOT AND SAYS SO', async () => {
    // Every call is recorded. Asserting the issued view reads ONLY the frozen
    // claim needs the CALL LIST, not a throwing stub: the component catches
    // fetch errors, so a stub that merely rejects would let a live read
    // through while the test still passed. (Measured: it did.)
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/api/giving-statements/issued/107')) {
        return ok({ statement: {
          id: 107, tax_year: 2026, statement_no: '2026-1', status: 'issued',
          snapshot_version: 1, snapshot_json: SNAPSHOT,
          issued_at: '2026-01-15T12:00:00Z', issued_by_name: 'Admin',
          superseded_at: null, superseded_by_id: null,
        } })
      }
      return ok({})
    }))

    view('?issued=107')
    const banner = await screen.findByTestId('statement-issued-banner', {}, { timeout: 4000 })
    // THE INVARIANT: the issued document never consults live giving.
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.some(u => u.includes('/api/giving-statements/donor'))).toBe(false)
    expect(calls.every(u => u.includes('/api/giving-statements/issued/'))).toBe(true)
    expect(banner.textContent).toMatch(/Issued statement/i)
    expect(banner.textContent).toMatch(/2026-1/)
    expect(screen.queryByTestId('statement-preview-banner')).toBeNull()
    // No way to issue again from an issued document.
    expect(screen.queryByRole('button', { name: /Issue statement/i })).toBeNull()
    // STMT-01: Issued (frozen) is not delivered. Removing this string goes red.
    expect(banner.textContent).toMatch(/Issued — not sent to donor/i)
    expect(screen.getByTestId('statement-issued-not-sent').className).toMatch(/print:hidden/)
    expect(screen.getByTestId('statement-issued-chrome-not-sent').textContent).toMatch(/Not sent to donor/i)
  })

  it('AN ISSUED STATEMENT SAYS IT WAS NOT SENT TO THE DONOR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ statement: {
      id: 107, tax_year: 2026, statement_no: '2026-1', status: 'issued',
      snapshot_version: 1, snapshot_json: SNAPSHOT,
      issued_at: '2026-01-15T12:00:00Z', issued_by_name: 'Admin',
      superseded_at: null, superseded_by_id: null,
    } })))
    view('?issued=107')
    const honesty = await screen.findByTestId('statement-issued-not-sent', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/has not emailed this statement/i)
    expect(honesty.textContent).not.toMatch(/sent successfully|delivered|email sent/i)
    expect(screen.getByTestId('statement-issued-banner').textContent).toMatch(/Issued — not sent to donor/i)
  })

  it('SPANISH ISSUED CHROME SAYS EMITIDO — NO ENVIADO AL DONANTE', async () => {
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn(async () => ok({ statement: {
      id: 107, tax_year: 2026, statement_no: '2026-1', status: 'issued',
      snapshot_version: 1, snapshot_json: SNAPSHOT,
      issued_at: '2026-01-15T12:00:00Z', issued_by_name: 'Admin',
      superseded_at: null, superseded_by_id: null,
    } })))
    view('?issued=107')
    const banner = await screen.findByTestId('statement-issued-banner', {}, { timeout: 4000 })
    expect(banner.textContent).toMatch(/Emitido — no enviado al donante/i)
    expect(screen.getByTestId('statement-issued-not-sent').textContent).toMatch(/no ha enviado/i)
    expect(screen.getByTestId('statement-issued-chrome-not-sent').textContent).toMatch(/No enviado al donante/i)
    localStorage.removeItem('ochr_locale')
  })

  it('UNKNOWN AT ISSUE IS SHOWN, NOT QUIETLY BLANK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ statement: {
      id: 107, tax_year: 2026, statement_no: '2026-1', status: 'issued',
      snapshot_version: 1, snapshot_json: SNAPSHOT,
      issued_at: '2026-01-15T12:00:00Z', issued_by_name: 'Admin',
      superseded_at: null, superseded_by_id: null,
    } })))
    view('?issued=107')
    const banner = await screen.findByTestId('statement-issued-banner', {}, { timeout: 4000 })
    expect(banner.textContent).toMatch(/Not known when issued/i)
    expect(banner.textContent).toMatch(/statement_letterhead/)
  })

  it('a superseded statement still shows what it claimed, and names its successor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ statement: {
      id: 107, tax_year: 2026, statement_no: '2026-1', status: 'superseded',
      snapshot_version: 1, snapshot_json: SNAPSHOT,
      issued_at: '2026-01-15T12:00:00Z', issued_by_name: 'Admin',
      superseded_at: '2026-03-01T12:00:00Z', superseded_by_id: 108,
    } })))
    view('?issued=107')
    const banner = await screen.findByTestId('statement-issued-banner', {}, { timeout: 4000 })
    expect(banner.textContent).toMatch(/Superseded by statement #108/i)
    // The original claim is still the one displayed.
    await waitFor(() => expect(document.body.textContent).toMatch(/\$500\.00/))
  })

  it('?issued= WINS EVEN WHEN ?year= IS ALSO ON THE URL', async () => {
    // Issuing navigates to a bare ?issued=<id>, so the year is normally absent
    // and the live effect is guarded by that alone. A hand-typed or future link
    // can carry both. If the preview effect still runs, live giving overwrites
    // the frozen claim and the page silently becomes a preview wearing an
    // issued banner — so the issued id has to win on its own merits.
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/api/giving-statements/issued/107')) {
        return ok({ statement: {
          id: 107, tax_year: 2026, statement_no: '2026-1', status: 'issued',
          snapshot_version: 1, snapshot_json: SNAPSHOT,
          issued_at: '2026-01-15T12:00:00Z', issued_by_name: 'Admin',
          superseded_at: null, superseded_by_id: null,
        } })
      }
      return ok({ year: 2026, donor: SNAPSHOT.donor, organization: SNAPSHOT.organization,
                  lines: [], total: 9999, gift_count: 0 })
    }))

    view('?year=2026&by=email&issued=107')
    await screen.findByTestId('statement-issued-banner', {}, { timeout: 4000 })
    await new Promise(r => setTimeout(r, 50))
    expect(calls.some(u => u.includes('/api/giving-statements/donor'))).toBe(false)
    expect(document.body.textContent).not.toMatch(/9,?999/)
  })

  it('A LOST RESPONSE THEN A RETRY IS ONE HISTORICAL CLAIM, NOT TWO', async () => {
    // The server replays a repeated issue_key. That guarantee is worth nothing
    // if the browser mints a new key per click: the first attempt commits, the
    // response is lost, the parish clicks again, and a SECOND tax claim is
    // written for the same donor and year.
    //
    // This is the product behaviour, not the API primitive. The stub commits
    // server-side and THEN throws, which is exactly the ambiguous case — the
    // caller cannot know whether the claim exists.
    const keysSeen = []
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url)
      if (u.includes('/api/giving-statements/issue')) {
        keysSeen.push(JSON.parse(init.body).issue_key)
        call += 1
        if (call === 1) throw new TypeError('Failed to fetch')   // committed, then lost
        return ok({ ok: true, replayed: true, statement: { id: 107 } })
      }
      if (u.includes('/api/giving-statements/donor')) {
        return ok({ year: 2026, by: 'email', key: 'rosa@example.com',
          donor: SNAPSHOT.donor, organization: SNAPSHOT.organization,
          lines: [{ id: 1, date: '2026-03-01', amount: '500.00', refunded_total: '0.00',
                    live_amount: '500.00', donor_name: 'Rosa Vega' }],
          total: 500, gift_count: 1 })
      }
      return ok({})
    }))

    view('?year=2026&by=email')
    const btn = await screen.findByRole('button', { name: /Issue statement/i }, { timeout: 4000 })

    fireEvent.click(btn)
    await waitFor(() => expect(keysSeen).toHaveLength(1))
    // The transport failed; the button frees up; the parish tries again.
    await waitFor(() => expect(btn.disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => expect(keysSeen).toHaveLength(2))

    expect(keysSeen[0]).toBeTruthy()
    expect(keysSeen[1]).toBe(keysSeen[0])
  })

  it('A ZERO CORRECTION READS AS A WITHDRAWAL, NOT A BROKEN DOCUMENT', async () => {
    // The donor is holding a tax statement that says $0.00. Without this, the
    // only honest reading available to them is "something went wrong".
    const ZERO = {
      ...SNAPSHOT, lines: [], total: '0.00', gift_count: 0,
      correction: {
        supersedes_statement_id: 107, supersedes_statement_no: '2026-1',
        donor_identity_from: 'superseded-statement', zero_is_a_claim: true,
        reason: 'The gifts this statement was issued from are no longer on file. This corrects the earlier statement to zero.',
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => ok({ statement: {
      id: 108, tax_year: 2026, statement_no: '2026-2', status: 'issued',
      snapshot_version: 1, snapshot_json: ZERO,
      issued_at: '2026-03-01T12:00:00Z', issued_by_name: 'Admin',
      superseded_at: null, superseded_by_id: null,
    } })))
    view('?issued=108')
    const banner = await screen.findByTestId('statement-issued-banner', {}, { timeout: 4000 })
    expect(banner.textContent).toMatch(/Corrected statement/i)
    expect(banner.textContent).toMatch(/supersedes No\. 2026-1/i)
    expect(banner.textContent).toMatch(/no longer on file/i)
    // The zero must be attributed to the parish, never left to look like a gap.
    expect(banner.textContent).toMatch(/because the parish says so/i)
    // And the donor identity is the one carried forward from the original.
    await waitFor(() => expect(document.body.textContent).toMatch(/Rosa Vega/))
  })

  it('A PREVIEW SAYS IT IS NOT ISSUED AND OFFERS TO ISSUE', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/api/giving-statements/donor')) {
        return ok({ year: 2026, by: 'email', key: 'rosa@example.com',
          donor: SNAPSHOT.donor, organization: SNAPSHOT.organization,
          lines: [{ id: 1, date: '2026-03-01', amount: '500.00', refunded_total: '0.00',
                    live_amount: '500.00', donor_name: 'Rosa Vega' }],
          total: 500, gift_count: 1 })
      }
      return ok({})
    }))

    view('?year=2026&by=email')
    const banner = await screen.findByTestId('statement-preview-banner', {}, { timeout: 4000 })
    expect(banner.textContent).toMatch(/not issued/i)
    expect(banner.textContent).toMatch(/will change if a gift is refunded/i)
    expect(screen.queryByTestId('statement-issued-banner')).toBeNull()
    expect(screen.getByRole('button', { name: /Issue statement/i })).toBeTruthy()
    // Preview must not wear issued-delivery honesty; Issued ≠ Preview stays intact.
    expect(banner.textContent).not.toMatch(/Issued — not sent to donor/i)
    expect(screen.queryByTestId('statement-issued-not-sent')).toBeNull()
    expect(screen.queryByTestId('statement-issued-chrome-not-sent')).toBeNull()
  })
})
