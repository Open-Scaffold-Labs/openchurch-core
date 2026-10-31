// SP-309 / SP-310 — Cash Count cancel guard, 44px steppers, labels, Esc.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Donations from './Donations'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (b) => ({ ok: true, status: 200, json: async () => b })
function stub() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/donations/cash-counts')) return ok([])
    if (u.includes('/api/donations/recurring')) return ok({ recurring: [] })
    if (u.includes('/api/donations/summary')) return ok({ summary: null })
    if (u.includes('/api/donations/by-fund')) return ok({ funds: [] })
    if (u.includes('/api/donations')) return ok([])
    return ok({})
  }))
}
const view = () => render(
  <MemoryRouter initialEntries={['/donations']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Donations />
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

async function openCashCount() {
  stub()
  view()
  fireEvent.click(await screen.findByRole('button', { name: 'Cash Count' }, {}, { timeout: 4000 }))
  return screen.findByRole('dialog', { name: /Cash Count/i }, {}, { timeout: 4000 })
}

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale') })

const dir = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(dir, 'Donations.jsx'), 'utf8')

describe('SP-310 source: steppers, labels, dialog, Esc', () => {
  it('DenomRow +/− are ≥44px and named with the denomination', () => {
    expect(SRC).toMatch(/min-h-\[44px\]\s+min-w-\[44px\]/)
    expect(SRC).toMatch(/aria-label=\{[^}]*decAria|don\.cc\.decAria/)
    expect(SRC).toMatch(/aria-label=\{[^}]*incAria|don\.cc\.incAria/)
    expect(SRC).toMatch(/don\.cc\.decAria/)
    expect(SRC).toMatch(/don\.cc\.incAria/)
  })

  it('Cash Count panel is a dialog; Esc uses the same close path as Cancel', () => {
    expect(SRC).toMatch(/CashCountDrawer[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"/)
    expect(SRC).toMatch(/useDialogFocus\(panelRef,\s*requestClose\)/)
  })

  it('X on Cash Count (and Add Donation) has an accessible close label', () => {
    // Both drawers' X buttons carry aria-label={t('don.close')}
    const closeHits = SRC.match(/aria-label=\{t\('don\.close'\)\}/g) || []
    expect(closeHits.length).toBeGreaterThanOrEqual(2)
  })

  it('Cancel is not a flex-1 twin sitting beside Save', () => {
    const drawer = SRC.slice(SRC.indexOf('function CashCountDrawer'), SRC.indexOf('function DonationModal'))
    const footer = drawer.slice(drawer.indexOf('{/* Sticky footer'))
    expect(footer).toMatch(/justify-between/)
    expect(footer).toMatch(/t\('don\.cancel'\)/)
    expect(footer).toMatch(/t\('don\.cc\.save'\)/)
    // Cancel and Save are no longer a pair of flex-1 siblings.
    expect(footer).not.toMatch(/flex-1[^\n]*\n[^\n]*don\.cancel[\s\S]{0,200}flex-1[^\n]*\n[^\n]*don\.cc\.save/)
    expect(footer).toMatch(/min-w-\[9rem\]/)
  })
})

describe('SP-309 / SP-310: discard guard', () => {
  it('Cancel with a non-zero count asks before closing', async () => {
    const panel = await openCashCount()
    // + on $20 three times → $60
    const inc20 = within(panel).getByRole('button', { name: 'Increase $20' })
    fireEvent.click(inc20)
    fireEvent.click(inc20)
    fireEvent.click(inc20)
    expect(within(panel).getAllByText('$60.00').length).toBeGreaterThanOrEqual(1)

    // Cancel is present and not adjacent as the only twin — click it
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
    const ask = await screen.findByRole('alertdialog', { name: /Discard this cash count/i })
    expect(ask).toBeTruthy()
    // Dismiss keep editing
    fireEvent.click(within(ask).getByRole('button', { name: /Cancel/i }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('dialog', { name: /Cash Count/i })).toBeInTheDocument()

    // Confirm discard
    fireEvent.click(within(screen.getByRole('dialog', { name: /Cash Count/i })).getByRole('button', { name: 'Cancel' }))
    const ask2 = await screen.findByRole('alertdialog', { name: /Discard this cash count/i })
    fireEvent.click(within(ask2).getByRole('button', { name: /Discard count/i }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Cash Count/i })).toBeNull())
  })

  it('Cancel with an empty count closes immediately', async () => {
    const panel = await openCashCount()
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Cash Count/i })).toBeNull())
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('Esc with a non-zero count asks the same discard question', async () => {
    const panel = await openCashCount()
    fireEvent.click(within(panel).getByRole('button', { name: 'Increase $5' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await screen.findByRole('alertdialog', { name: /Discard this cash count/i })).toBeTruthy()
    // Keep the count
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('dialog', { name: /Cash Count/i })).toBeInTheDocument()
  })
})

describe('SP-309/310 i18n keys', () => {
  it('en and es have discard + stepper aria keys', () => {
    for (const k of ['don.cc.discardTitle', 'don.cc.discardBody', 'don.cc.discardConfirm', 'don.cc.decAria', 'don.cc.incAria']) {
      expect(STRINGS.en[k]).toBeTruthy()
      expect(STRINGS.es[k]).toBeTruthy()
      expect(STRINGS.es[k]).not.toBe(STRINGS.en[k])
    }
    expect(STRINGS.en['don.cc.decAria']).toMatch(/\{denom\}/)
    expect(STRINGS.en['don.cc.incAria']).toMatch(/\{denom\}/)
  })
})
