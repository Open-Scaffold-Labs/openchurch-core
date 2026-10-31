// The profile total adds email-matched gifts and name-only gifts.
// A giving statement counts only the email-matched ones. Staff must see
// the name-matched portion labeled as such, or they will quote the
// profile figure as a statement figure.
//
// Synthetic fixtures only. An email-only history must not show the note.

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MemberDetail from './MemberDetail'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const MEMBER = {
  id: 20077,
  name: 'Rosa Vega',
  email: 'rosa@example.com',
  status: 'active',
}

const MIXED = {
  by: 'email',
  match_key: 'rosa@example.com',
  gift_count: 2,
  total: 190,
  lines: [
    { id: 1, donor_name: 'Rosa Vega', donor_email: 'rosa@example.com', amount: 40, live_amount: 40, category: 'offertory', method: 'check', date: '2026-01-15' },
    { id: 2, donor_name: 'Rosa Vega', donor_email: null, amount: 150, live_amount: 150, category: 'offertory', method: 'cash', date: '2026-02-02' },
  ],
}

const EMAIL_ONLY = {
  by: 'email',
  match_key: 'rosa@example.com',
  gift_count: 1,
  total: 40,
  lines: [
    { id: 1, donor_name: 'Rosa Vega', donor_email: 'rosa@example.com', amount: 40, live_amount: 40, category: 'offertory', method: 'check', date: '2026-01-15' },
  ],
}

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

function stubFetch(donations) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes(`/api/clients/${MEMBER.id}/donations`)) return ok(donations)
    if (u.match(/\/api\/clients\/\d+$/)) return ok(MEMBER)
    return ok({ records: [], entries: [], checkins: [], pledges: [], dates: [], unavailability: [] })
  }))
}

function mount() {
  return render(
    <MemoryRouter initialEntries={[`/clients/${MEMBER.id}`]}>
      <LocaleProvider><ToastProvider><ConfirmProvider>
        <Routes><Route path="/clients/:id" element={<MemberDetail />} /></Routes>
      </ConfirmProvider></ToastProvider></LocaleProvider>
    </MemoryRouter>,
  )
}

const NOTE = 'member.giftsNameMatchedNote'
const NAME_AMOUNT = '$150.00'

function noteText(locale) {
  return STRINGS[locale][NOTE].replaceAll('{amount}', NAME_AMOUNT)
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

const EN_NOTE = `Includes ${NAME_AMOUNT} matched by donor name only (no email on the gift).`
const ES_NOTE = `Incluye ${NAME_AMOUNT} emparejados solo por el nombre del donante (el donativo no tiene correo).`

describe('profile gifts matched by name', () => {
  it('names the amount matched by donor name, without a claim about statements', async () => {
    stubFetch(MIXED)
    mount()
    expect(await screen.findByText('$190.00')).toBeInTheDocument()
    const note = screen.getByTestId('name-matched-gifts')
    expect(note.textContent).toBe(EN_NOTE)
    expect(note.textContent).toBe(noteText('en'))
    expect(note.textContent).not.toMatch(/statement/i)
  })

  it('says the same thing in Spanish, with the name-matched amount', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch(MIXED)
    mount()
    await waitFor(() => expect(screen.getByTestId('name-matched-gifts')).toBeInTheDocument())
    const note = screen.getByTestId('name-matched-gifts')
    expect(note.textContent).toBe(ES_NOTE)
    expect(note.textContent).toBe(noteText('es'))
    expect(note.textContent).not.toMatch(/statement|estado de cuenta/i)
    expect(STRINGS.es[NOTE]).not.toBe(STRINGS.en[NOTE])
  })

  it('does not show the name-matched note when every gift has an email', async () => {
    stubFetch(EMAIL_ONLY)
    mount()
    expect((await screen.findAllByText('$40.00')).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('name-matched-gifts')).not.toBeInTheDocument()
    expect(screen.queryByText(/matched by name/i)).not.toBeInTheDocument()
  })
})
