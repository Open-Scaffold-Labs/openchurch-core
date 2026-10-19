// Data belongs to the member it was fetched for — including data that
// arrives late. (Mini boss fight: the wrong-truth problem.)
//
// THE DEFECT, reproduced in Chromium against the real stack before this
// test existed: Alpha's donations read fails; the secretary presses "Try
// again"; while that retry is in flight she moves on to Omega; Omega's
// profile loads, header and gifts; then Alpha's retry resolves and the
// gifts panel under Omega's name reads "1 gift · $555.55" — Alpha's money.
//
// The main effect already guarded this (its `cancelled` flag), and the
// sub-sections are unmounted by the spinner between members. `retryGifts`
// was the one writer that lived on the page across a member change and
// captured the OLD id in its closure. Every value that reaches this page's
// state must carry, and be checked against, the id it was fetched for.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes, Link } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MemberDetail from './MemberDetail'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const ALPHA = { id: 31001, name: 'AAA Alpha', email: 'alpha@x.com', status: 'active' }
const OMEGA = { id: 31002, name: 'ZZZ Omega', email: 'omega@x.com', status: 'active' }
const ALPHA_GIFTS = { lines: [{ id: 1, amount: '555.55', date: '2026-08-01', category: 'tithe', method: 'cash' }], total: 555.55, gift_count: 1 }
const OMEGA_GIFTS = { lines: [{ id: 2, amount: '999.99', date: '2026-08-02', category: 'tithe', method: 'cash' }], total: 999.99, gift_count: 1 }

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

// A link the test can click to change members WITHOUT unmounting the page,
// which is how the real app navigates between profiles.
const Shell = () => (
  <MemoryRouter initialEntries={[`/clients/${ALPHA.id}`]}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Link to={`/clients/${OMEGA.id}`}>go to omega</Link>
      <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

beforeEach(() => vi.unstubAllGlobals())

describe("a retry that resolves after the member changed", () => {
  it("files Alpha's gifts nowhere, and Omega keeps Omega's", async () => {
    let alphaDonationCalls = 0
    let releaseAlpha
    const heldAlpha = new Promise(r => { releaseAlpha = r })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.endsWith(`/api/clients/${ALPHA.id}`)) return ok(ALPHA)
      if (u.endsWith(`/api/clients/${OMEGA.id}`)) return ok(OMEGA)
      if (u.includes(`/api/clients/${ALPHA.id}/donations`)) {
        alphaDonationCalls++
        if (alphaDonationCalls === 1) return err(500)          // the first read fails
        await heldAlpha                                       // the retry is slow
        return ok(ALPHA_GIFTS)
      }
      if (u.includes(`/api/clients/${OMEGA.id}/donations`)) return ok(OMEGA_GIFTS)
      return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })
    }))
    render(<Shell />)

    // Alpha, with a failed gifts read and a Try again.
    await screen.findByRole('heading', { name: ALPHA.name })
    const retry = await screen.findByRole('button', { name: /try again/i })
    await act(async () => { fireEvent.click(retry) })
    expect(alphaDonationCalls).toBe(2)

    // Move on to Omega while Alpha's retry is still in flight.
    await act(async () => { fireEvent.click(screen.getByText('go to omega')) })
    await screen.findByRole('heading', { name: OMEGA.name })
    await waitFor(() => expect(screen.getAllByText(/\$999\.99/).length).toBeGreaterThan(0))

    // Now Alpha's retry lands.
    await act(async () => { releaseAlpha(); await heldAlpha })
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })

    expect(screen.getByRole('heading', { name: OMEGA.name })).toBeInTheDocument()
    expect(screen.queryAllByText(/\$555\.55/)).toHaveLength(0)  // Alpha's money is not under Omega
    expect(screen.getAllByText(/\$999\.99/).length).toBeGreaterThan(0)  // and Omega's is still there
  })

  it("control: the same retry on the SAME member still fills the panel", async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.endsWith(`/api/clients/${ALPHA.id}`)) return ok(ALPHA)
      if (u.includes(`/api/clients/${ALPHA.id}/donations`)) return ++calls === 1 ? err(500) : ok(ALPHA_GIFTS)
      return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })
    }))
    render(<Shell />)
    await screen.findByRole('heading', { name: ALPHA.name })
    const retry = await screen.findByRole('button', { name: /try again/i })
    await act(async () => { fireEvent.click(retry) })
    await waitFor(() => expect(screen.getAllByText(/\$555\.55/).length).toBeGreaterThan(0))
  })
})

// ⌘K / in-app links change /clients/:id without unmounting this page.
// The previous member's answer — a 404, a 500, or the profile itself —
// is not an answer about the member in the URL now.
describe('the profile belongs to the id in the URL', () => {
  it("a 404 for Alpha is not 'Member not found' for Omega", async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.endsWith(`/api/clients/${ALPHA.id}`)) return err(404)
      if (u.endsWith(`/api/clients/${OMEGA.id}`)) return ok(OMEGA)
      if (u.includes(`/api/clients/${OMEGA.id}/donations`)) return ok(OMEGA_GIFTS)
      return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })
    }))
    render(<Shell />)

    expect(await screen.findByText(/member not found/i)).toBeInTheDocument()

    await act(async () => { fireEvent.click(screen.getByText('go to omega')) })

    expect(await screen.findByRole('heading', { name: OMEGA.name })).toBeInTheDocument()
    expect(screen.queryByText(/member not found/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/belongs to another organization/i)).not.toBeInTheDocument()
    expect(screen.getAllByText(/\$999\.99/).length).toBeGreaterThan(0)
  })

  it("a 500 for Alpha is not a load failure for Omega", async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.endsWith(`/api/clients/${ALPHA.id}`)) return err(500)
      if (u.endsWith(`/api/clients/${OMEGA.id}`)) return ok(OMEGA)
      if (u.includes(`/api/clients/${OMEGA.id}/donations`)) return ok(OMEGA_GIFTS)
      return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })
    }))
    render(<Shell />)

    await waitFor(() => expect(screen.getAllByText(/couldn'?t be read|could not be read|didn'?t load/i).length).toBeGreaterThan(0))

    await act(async () => { fireEvent.click(screen.getByText('go to omega')) })

    expect(await screen.findByRole('heading', { name: OMEGA.name })).toBeInTheDocument()
    expect(screen.queryByText(/couldn'?t be read|could not be read|didn'?t load/i)).not.toBeInTheDocument()
  })

  it("does not keep Alpha's name on screen while Omega's profile is still in flight", async () => {
    let releaseOmega
    const heldOmega = new Promise(r => { releaseOmega = r })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.endsWith(`/api/clients/${ALPHA.id}`)) return ok(ALPHA)
      if (u.endsWith(`/api/clients/${OMEGA.id}`)) {
        await heldOmega
        return ok(OMEGA)
      }
      if (u.includes(`/api/clients/${ALPHA.id}/donations`)) return ok(ALPHA_GIFTS)
      if (u.includes(`/api/clients/${OMEGA.id}/donations`)) return ok(OMEGA_GIFTS)
      return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })
    }))
    render(<Shell />)
    await screen.findByRole('heading', { name: ALPHA.name })
    await waitFor(() => expect(screen.getAllByText(/\$555\.55/).length).toBeGreaterThan(0))

    await act(async () => { fireEvent.click(screen.getByText('go to omega')) })

    expect(screen.queryByRole('heading', { name: ALPHA.name })).not.toBeInTheDocument()
    expect(screen.queryByText(/\$555\.55/)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: OMEGA.name })).not.toBeInTheDocument()

    await act(async () => { releaseOmega() })
    expect(await screen.findByRole('heading', { name: OMEGA.name })).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText(/\$999\.99/).length).toBeGreaterThan(0))
    expect(screen.queryByRole('heading', { name: ALPHA.name })).not.toBeInTheDocument()
    expect(screen.queryByText(/\$555\.55/)).not.toBeInTheDocument()
  })
})
