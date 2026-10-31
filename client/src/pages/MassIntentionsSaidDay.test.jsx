// SP-088 (Saint, 21 Oct): after bulk "Mark said", is a day typed into
// "Day it was said" — not the scheduled Mass's day — visible afterwards?
// The book reads a fulfilled row's mass_date from fulfilled_mass_date
// (server SELECT_COLS), so the list's Mass column and the Edit form's
// Mass date both carry the said day. This guards that it stays visible.
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const { en } = STRINGS
const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const SCHEDULED = {
  id: 7, intention: 'For the Rivera family', requested_by: 'Ana',
  mass_date: '2020-01-15', mass_title: 'Morning Mass', calendar_event_id: 40,
  status: 'scheduled', stipend: '12.50', past_scheduled: true,
}
// What GET /api/mass-intentions returns after the bulk write recorded
// fulfilled_mass_date = 2020-01-16 for this row.
// L3: a different day is stamped with no Mass title/time.
const SAID_LATE = { ...SCHEDULED, status: 'fulfilled', mass_date: '2020-01-16', mass_title: null, mass_time: null, past_scheduled: false }

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })))
})
afterEach(() => vi.unstubAllGlobals())

describe('SP-088 the day it was said stays visible', () => {
  it('a non-default said day shows in the list and in the Edit form', async () => {
    let marked = false
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const u = String(url)
      if (u.includes('/api/mass-intentions/bulk-mark-said')) {
        const body = JSON.parse(init.body)
        marked = true
        return ok({ batch_id: body.request_id, replayed: false, marked: [{ id: '7', fulfilled_date: '2020-01-16' }], excluded: [] })
      }
      if (u.includes('/api/mass-intentions')) return ok({ intentions: [marked ? SAID_LATE : SCHEDULED] })
      return ok([])
    }))
    render(
      <MemoryRouter initialEntries={['/mass-intentions']}>
        <LocaleProvider><ToastProvider><ConfirmProvider>
          <Routes><Route path="/mass-intentions" element={<MassIntentions />} /></Routes>
        </ConfirmProvider></ToastProvider></LocaleProvider>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByLabelText(en['mi.markSaidSelect'].replace('{name}', 'For the Rivera family')))
    fireEvent.click(screen.getByTestId('mi-mark-said-open'))
    const day = await screen.findByLabelText(`${en['mi.markSaidDate']} For the Rivera family`)
    fireEvent.change(day, { target: { value: '2020-01-16' } })
    fireEvent.click(screen.getByTestId('mi-mark-said-commit'))
    await screen.findByTestId('mi-mark-said-result')
    await waitFor(() => expect(fetch.mock.calls.filter(([u]) => String(u).includes('/api/mass-intentions?')).length).toBeGreaterThan(1))

    const row = screen.getByText('For the Rivera family').closest('tr')
    await waitFor(() => expect(row).toHaveTextContent(/Jan(uary)? 16, 2020/))
    expect(row).not.toHaveTextContent(/Jan(uary)? 15, 2020/)
    expect(row).toHaveTextContent(en['mi.fulfilled'])
    // The planned Mass (Jan 15) is not presented as the Mass of Jan 16.
    expect(row).not.toHaveTextContent('Morning Mass')

    fireEvent.click(within(row).getByRole('button', { name: en['mi.edit'] }))
    const input = await screen.findByLabelText(en['mi.massDate'])
    expect(input).toHaveValue('2020-01-16')
  })
})
