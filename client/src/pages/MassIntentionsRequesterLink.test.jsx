// SP-052: the intention form can link the requester to a member of this
// parish. Red on removal of the picker or of requested_by_client_id from the
// save payload; EN/ES copy present and distinct.
import { ToastProvider } from '../components/ToastProvider'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const ROW = { id: 15, intention: 'For a safe journey', requested_by: 'The family', requested_by_client_id: 7, requester_name: 'Synthetic Linked', mass_date: null, status: 'open', stipend: null }
let calls

function stub() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url); calls.push({ u, init })
    if (u.includes('/api/clients/picker?')) return ok([{ id: 42, name: 'Synthetic Member' }])
    if (u.includes('/api/clients')) throw new Error('picker must not read the full roster: ' + u)
    if (/\/api\/mass-intentions(\/\d+)?$/.test(u) && init.method) return ok({ id: 99, intention: 'x', status: 'open' }, init.method === 'POST' ? 201 : 200)
    if (u.includes('/api/mass-intentions?')) return ok({ intentions: [ROW] })
    return ok([])
  }))
}
const book = () => render(<MemoryRouter initialEntries={['/mass-intentions']}><LocaleProvider><Routes><Route path="/mass-intentions" element={<ToastProvider><MassIntentions /></ToastProvider>} /></Routes></LocaleProvider></MemoryRouter>)
const saveBody = () => { const c = calls.find(c => c.init.method === 'POST' || c.init.method === 'PATCH'); return c && JSON.parse(c.init.body) }

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale'); stub() })
afterEach(() => vi.unstubAllGlobals())

describe('SP-052 requester member link', () => {
  it('a failed picker read says so; an empty result is not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('/api/clients/picker?') ? ok({ error: 'x' }, 500) : (String(url).includes('/api/mass-intentions?') ? ok({ intentions: [] }) : ok([]))))
    book()
    fireEvent.click(await screen.findByRole('button', { name: /add intention/i }))
    fireEvent.change(screen.getByLabelText(/link to member/i), { target: { value: 'Syn' } })
    expect(await screen.findByText(STRINGS.en['mi.linkMemberFailed'])).toBeTruthy()
  })

  it('EN and ES copy exist and differ', () => {
    for (const k of ['mi.linkMember', 'mi.linkMemberPlaceholder', 'mi.linkedMember', 'mi.unlinkMember', 'mi.linkMemberFailed']) {
      expect(STRINGS.en[k], k).toBeTruthy(); expect(STRINGS.es[k], k).toBeTruthy(); expect(STRINGS.es[k], k).not.toBe(STRINGS.en[k])
    }
  })

  it('create: search, pick a member, and the POST carries requested_by_client_id', async () => {
    book()
    fireEvent.click(await screen.findByRole('button', { name: /add intention/i }))
    fireEvent.change(screen.getByLabelText(/^intention$/i), { target: { value: 'For the parish' } })
    fireEvent.change(screen.getByLabelText(/link to member/i), { target: { value: 'Syn' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic Member' }))
    expect(screen.getByTestId('requester-linked').textContent).toContain('Synthetic Member')
    expect(calls.some(c => c.u.includes('/api/clients/picker?') && c.u.includes('search=Syn'))).toBe(true)
    expect(calls.some(c => /\/api\/clients\?/.test(c.u))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
    await waitFor(() => expect(saveBody()).toBeTruthy())
    expect(saveBody().requested_by_client_id).toBe(42)
    expect(saveBody().requested_by).toBe('Synthetic Member')
  })

  it('edit: an unchanged link is omitted', async () => {
    book()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    expect((await screen.findByTestId('requester-linked')).textContent).toContain('Synthetic Linked')
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
    await waitFor(() => expect(saveBody()).toBeTruthy())
    expect(saveBody()).not.toHaveProperty('requested_by_client_id')
  })

  it('edit: unlink sends null', async () => {
    book()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    fireEvent.click(await screen.findByRole('button', { name: /unlink/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
    await waitFor(() => expect(saveBody()).toBeTruthy())
    expect(saveBody().requested_by_client_id).toBeNull()
  })
})
