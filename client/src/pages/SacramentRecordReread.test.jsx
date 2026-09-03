// The write landed; the re-read did not. (REG.1, C1)
//
// After a void/correct/restore the page re-reads the entry and its history,
// and until this fix it ignored what reload() returned. So when the POST
// succeeded and the GET that followed failed, the toast said "Entry voided.
// It remains in the register." while the page kept showing the pre-void
// entry — an active-looking record with a live Void button, for an entry the
// server had just marked void. On a high-trust register surface the screen
// must never assert more than it knows.

import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import SacramentRecord from './SacramentRecord'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Rector', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false,
  }),
}))

const RECORD = {
  id: '7', client_id: null, type: 'baptism', date: '1953-03-14',
  member_name: 'Ana Delgado', minister: 'Fr. Ibarra', place: 'San Miguel',
  certificate_no: 'P8-1953', notes: null, voided_at: null, voided_reason: null,
}
const VOIDED = { ...RECORD, voided_at: '2026-08-01T00:00:00Z', voided_reason: 'Entered twice in the 1994 transcription' }

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

// A stateful server: the record reads fine, the void succeeds, and then the
// record read fails N times before the truth (VOIDED) comes back.
const server = ({ failedRereads = 1 } = {}) => {
  let voided = false
  let failuresLeft = failedRereads
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url); const method = opts.method || 'GET'
    calls.push({ url: u, method })
    if (u.includes('/amendments')) return ok({ amendments: [] })
    if (u.includes('/void') && method === 'POST') { voided = true; return ok(VOIDED) }
    if (u.endsWith('/api/sacraments/7')) {
      if (voided && failuresLeft > 0) { failuresLeft--; return err(500) }
      return ok(voided ? VOIDED : RECORD)
    }
    return ok({})
  }))
  return calls
}

const mount = () => render(
  <MemoryRouter initialEntries={['/register/7']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/register/:id" element={<SacramentRecord />} /></Routes>
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

const voidIt = async () => {
  await screen.findByText('Ana Delgado')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^void$/i })) })
  const d = screen.getByRole('alertdialog')
  fireEvent.change(within(d).getByRole('textbox'), { target: { value: 'Entered twice in the 1994 transcription' } })
  await act(async () => { fireEvent.click(within(d).getByRole('button', { name: /void entry/i })) })
}

const NOTICE = /couldn'?t re-read the entry/i

beforeEach(() => vi.unstubAllGlobals())

describe('a write that saved but could not be re-read', () => {
  it('says so on the record, and does not offer Void on an entry just voided', async () => {
    server({ failedRereads: 1 }); mount()
    await voidIt()

    // The honest notice, on the record panel — not only in a toast that fades.
    expect(await screen.findByText(NOTICE)).toBeInTheDocument()

    // The pre-void entry may still be on screen (it is the last thing we
    // read), but the actions must not present it as an active record.
    const voidBtn = screen.queryByRole('button', { name: /^void$/i })
    if (voidBtn) expect(voidBtn).toBeDisabled()
    // And nothing here may certify it as active.
    expect(screen.queryByRole('link', { name: /certificate/i })).not.toBeInTheDocument()
  })

  it('a successful retry renders the VOID state and clears the notice', async () => {
    server({ failedRereads: 1 }); mount()
    await voidIt()
    await screen.findByText(NOTICE)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again/i })) })

    expect(await screen.findByText(/this entry is void/i)).toBeInTheDocument()
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /restore this entry/i })).toBeEnabled()
  })

  it('CONTROL — a write whose re-read succeeds shows no notice', async () => {
    server({ failedRereads: 0 }); mount()
    await voidIt()
    expect(await screen.findByText(/this entry is void/i)).toBeInTheDocument()
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
  })
})
