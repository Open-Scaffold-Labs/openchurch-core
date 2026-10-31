// Saint 2026-10-22 (move-intention probe): after moving an intention from
// Oct 25 to Nov 1 the toast said only "Intention updated." A move now
// names the day the intention is on, in EN and ES; a note-only edit keeps
// the plain toast.
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic', timezone: 'America/Los_Angeles' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const ROW = { id: 15, intention: 'For a safe journey', requested_by: 'The family', requested_by_client_id: null, mass_date: '2026-10-25', status: 'open', stipend: null }

function stub(writeBody) {
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url)
    if (/\/api\/mass-intentions(\/\d+)?$/.test(u) && init.method) return ok(writeBody)
    if (u.includes('/api/mass-intentions?')) return ok({ intentions: [ROW] })
    return ok([])
  }))
}
const book = () => render(<MemoryRouter initialEntries={['/mass-intentions']}><LocaleProvider><Routes><Route path="/mass-intentions" element={<ToastProvider><ConfirmProvider><MassIntentions /></ConfirmProvider></ToastProvider>} /></Routes></LocaleProvider></MemoryRouter>)
const { en, es } = STRINGS

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale') })
afterEach(() => vi.unstubAllGlobals())

describe('move toast names the new date', () => {
  it('EN and ES copy exist, carry {date}, and differ', () => {
    expect(en['mi.updatedToastDate']).toContain('{date}')
    expect(es['mi.updatedToastDate']).toContain('{date}')
    expect(es['mi.updatedToastDate']).not.toBe(en['mi.updatedToastDate'])
  })

  it('changing the date to Nov 1 says the intention is now on Nov 1', async () => {
    stub({ ...ROW, mass_date: '2026-11-01' })
    book()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en['mi.massDate']}`, 'i')), { target: { value: '2026-11-01' } })
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
    const toast = await screen.findByText(/Intention updated — now on .*Nov.*1/)
    expect(toast.textContent).not.toMatch(/Oct/)
    expect(screen.queryByText(en['mi.updatedToast'])).not.toBeInTheDocument()
  })

  async function moveTo(day, writeBody) {
    stub(writeBody)
    book()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en['mi.massDate']}`, 'i')), { target: { value: day } })
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
  }

  // R364-1: the toast names only a day the server says it stored.
  for (const [label, body] of [
    ['an explicit null mass_date', { ...ROW, mass_date: null }],
    ['a missing mass_date', (() => { const { mass_date, ...r } = ROW; return r })()],
    ['an unreadable mass_date', { ...ROW, mass_date: 'next Sunday' }],
  ]) {
    it(`${label} in the response gets the plain toast, not the typed day`, async () => {
      await moveTo('2026-11-01', body)
      expect(await screen.findByText(en['mi.updatedToast'])).toBeInTheDocument()
      expect(screen.queryByText(/now on/)).not.toBeInTheDocument()
      expect(screen.queryByText(/Nov/)).not.toBeInTheDocument()
    })
  }

  it('a returned day different from the typed one is the day named', async () => {
    await moveTo('2026-11-01', { ...ROW, mass_date: '2026-11-08' })
    const toast = await screen.findByText(/Intention updated — now on .*Nov.*8/)
    expect(toast.textContent).not.toMatch(/Nov\D*1\b/)
  })

  it('a note-only edit keeps the plain "Intention updated."', async () => {
    stub(ROW)
    book()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
    expect(await screen.findByText(en['mi.updatedToast'])).toBeInTheDocument()
  })
})
