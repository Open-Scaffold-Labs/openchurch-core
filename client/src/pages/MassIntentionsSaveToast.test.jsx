// SP-055 (uat MIN-16): saving an intention showed no confirmation. A landed
// write now raises a success toast (added / updated). A refused or thrown
// save shows its inline message and NO toast. The toast confirms the write
// only; it fires before the reload and never claims the list refreshed.
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
const ROW = { id: 15, intention: 'For a safe journey', requested_by: 'The family', requested_by_client_id: null, mass_date: null, status: 'open', stipend: null }

function stub({ write = (init) => ok({ id: 99 }, init.method === 'POST' ? 201 : 200), list = () => ok({ intentions: [ROW] }) } = {}) {
  const calls = []
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url); calls.push({ u, init })
    if (/\/api\/mass-intentions(\/\d+)?$/.test(u) && init.method) return write(init)
    if (u.includes('/api/mass-intentions?')) return list(++reads)
    return ok([])
  }))
  return calls
}
const book = () => render(<MemoryRouter initialEntries={['/mass-intentions']}><LocaleProvider><Routes><Route path="/mass-intentions" element={<ToastProvider><MassIntentions /></ToastProvider>} /></Routes></LocaleProvider></MemoryRouter>)

async function addAndSave(L = STRINGS.en) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(L['mi.add'], 'i') }))
  fireEvent.change(screen.getByLabelText(new RegExp(`^${L['mi.intention']}$`, 'i')), { target: { value: 'For the parish' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${L['mi.save']}`, 'i') }))
}

const { en, es } = STRINGS

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale') })
afterEach(() => vi.unstubAllGlobals())

describe('SP-055 save confirmation', () => {
  it('EN and ES copy exist and differ', () => {
    for (const k of ['mi.addedToast', 'mi.updatedToast']) {
      expect(en[k], k).toBeTruthy(); expect(es[k], k).toBeTruthy(); expect(es[k], k).not.toBe(en[k])
    }
  })

  it('POST 201 shows "added"', async () => {
    const calls = stub()
    book()
    await addAndSave()
    expect(await screen.findByText(en['mi.addedToast'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.updatedToast'])).not.toBeInTheDocument()
    expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(1)
  })

  it('PATCH 200 shows "updated"', async () => {
    stub()
    book()
    fireEvent.click(await screen.findByRole('button', { name: /edit intention/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
    expect(await screen.findByText(en['mi.updatedToast'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.addedToast'])).not.toBeInTheDocument()
  })

  it('409 date_conflict shows the inline refusal and NO toast', async () => {
    stub({ write: () => ok({ error: 'x', code: 'date_conflict' }, 409) })
    book()
    await addAndSave()
    expect(await screen.findByText(en['mi.dateConflictRefused'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.addedToast'])).not.toBeInTheDocument()
  })

  it('500 shows err.save inline and NO toast', async () => {
    stub({ write: () => ok({ error: 'x' }, 500) })
    book()
    await addAndSave()
    expect(await screen.findByText(en['err.save'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.addedToast'])).not.toBeInTheDocument()
  })

  it('a thrown save shows err.save inline and NO toast', async () => {
    stub({ write: () => { throw new TypeError('Failed to fetch') } })
    book()
    await addAndSave()
    expect(await screen.findByText(en['err.save'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.addedToast'])).not.toBeInTheDocument()
  })

  it('a landed write whose reload fails still confirms the write, and the reload failure keeps its own message', async () => {
    stub({ list: n => (n === 1 ? ok({ intentions: [ROW] }) : ok({ error: 'x' }, 500)) })
    book()
    await addAndSave()
    expect(await screen.findByText(en['mi.addedToast'])).toBeInTheDocument()
    // The book does not paint itself empty: the existing row stays, or a load failure is shown.
    await waitFor(() => expect(screen.queryByText(/no intentions/i)).not.toBeInTheDocument())
  })

  it('says it in Spanish', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stub()
    book()
    await addAndSave(es)
    expect(await screen.findByText(es['mi.addedToast'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.addedToast'])).not.toBeInTheDocument()
  })
})
