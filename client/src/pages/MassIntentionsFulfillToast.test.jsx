// SP-063: marking an intention fulfilled confirms only after the server
// accepts the write. A refused or thrown save keeps the inline error and
// raises no success toast. The reload still belongs to the query captured
// before the write await (R313-1 delta) — the toast must not bring a stale
// reload back.
import { ToastProvider } from '../components/ToastProvider'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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

const { en, es } = STRINGS
const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const OPEN = { id: 15, intention: 'For a safe journey', requested_by: 'The family', requested_by_client_id: null, mass_date: '2026-10-18', mass_title: 'Sunday Mass', status: 'open', stipend: 10 }
const DONE = { ...OPEN, id: 16, intention: 'For the parish', status: 'fulfilled' }

function book() {
  return render(
    <MemoryRouter initialEntries={['/mass-intentions']}>
      <LocaleProvider>
        <Routes>
          <Route path="/mass-intentions" element={<ToastProvider><MassIntentions /></ToastProvider>} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

let writes
function stub({ row = OPEN, write } = {}) {
  writes = []
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url)
    if (/\/api\/mass-intentions(\/\d+)?$/.test(u) && init.method) {
      writes.push({ u, init })
      return write ? write(init) : ok({ id: row.id }, init.method === 'POST' ? 201 : 200)
    }
    if (u.includes('/api/mass-intentions?')) {
      reads += 1
      return ok({ intentions: [row] }, reads === 1 ? 200 : 200)
    }
    return ok([])
  }))
}

function deferredStub(row = OPEN) {
  writes = []
  const reqs = []
  vi.stubGlobal('fetch', vi.fn((url, init = {}) => {
    const u = String(url)
    if (u.includes('/api/mass-intentions?')) {
      return new Promise(resolve => {
        const p = new URL(u, 'http://x').searchParams
        reqs.push({ p: Object.fromEntries(p), settle: (body, status = 200) => resolve(ok(body, status)) })
      })
    }
    if (/\/api\/mass-intentions(\/\d+)?$/.test(u) && init.method) {
      return new Promise(resolve => {
        writes.push({ method: init.method, init, settle: (body, status) => resolve(ok(body, status)) })
      })
    }
    return Promise.resolve(ok([]))
  }))
  return reqs
}

const req = (reqs, match) => waitFor(() => {
  const r = reqs.find(x => !x.used && Object.entries(match).every(([k, v]) => (v === undefined ? !(k in x.p) : x.p[k] === v)))
  if (!r) throw new Error(`no pending request ${JSON.stringify(match)}`)
  r.used = true
  return r
}, { timeout: 2000 })

const settle = async (r, body, status) => {
  await act(async () => { r.settle(body, status); await Promise.resolve() })
  await act(async () => {})
}

async function editStatus(to, L = en) {
  fireEvent.click(await screen.findByRole('button', { name: L['mi.edit'] }))
  fireEvent.change(screen.getByLabelText(L['mi.status']), { target: { value: to } })
  fireEvent.click(screen.getByRole('button', { name: L['mi.saveChanges'] }))
}

const noSuccess = () => {
  expect(screen.queryByText(en['mi.fulfilledToast'])).not.toBeInTheDocument()
  expect(screen.queryByText(es['mi.fulfilledToast'])).not.toBeInTheDocument()
  expect(screen.queryByText(en['mi.updatedToast'])).not.toBeInTheDocument()
  expect(screen.queryByText(en['mi.addedToast'])).not.toBeInTheDocument()
}

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale') })
afterEach(() => vi.unstubAllGlobals())

describe('SP-063 fulfilment confirmation', () => {
  it('EN and ES copy exist, differ, and do not claim a Mass was missed or an obligation discharged', () => {
    expect(en['mi.fulfilledToast']).toBeTruthy()
    expect(es['mi.fulfilledToast']).toBeTruthy()
    expect(es['mi.fulfilledToast']).not.toBe(en['mi.fulfilledToast'])
    for (const text of [en['mi.fulfilledToast'], es['mi.fulfilledToast']]) {
      expect(text).not.toMatch(/missed|discharged|obligation|celebrated|canonical|stipend|elsewhere/i)
      expect(text).not.toMatch(/omitid|perdid|obligaci|can[oó]nic|estipendio|celebr/i)
    }
  })

  it('PATCH that sets fulfilled shows the fulfilment toast only after 200, not the update toast', async () => {
    stub()
    book()
    await editStatus('fulfilled')
    expect(await screen.findByText(en['mi.fulfilledToast'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.updatedToast'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['mi.addedToast'])).not.toBeInTheDocument()
    const patch = writes.find(w => w.init.method === 'PATCH')
    expect(JSON.parse(patch.init.body).status).toBe('fulfilled')
  })

  it('a new intention saved as fulfilled says marked fulfilled, not added', async () => {
    stub()
    book()
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(en['mi.add'], 'i') }))
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en['mi.intention']}$`, 'i')), { target: { value: 'For the parish' } })
    fireEvent.change(screen.getByLabelText(en['mi.status']), { target: { value: 'fulfilled' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en['mi.save']}`, 'i') }))
    expect(await screen.findByText(en['mi.fulfilledToast'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.addedToast'])).not.toBeInTheDocument()
    expect(writes.filter(w => w.init.method === 'POST')).toHaveLength(1)
  })

  it('saving a row that is already fulfilled keeps the update toast', async () => {
    stub({ row: DONE })
    book()
    fireEvent.click(await screen.findByRole('button', { name: en['mi.edit'] }))
    fireEvent.click(screen.getByRole('button', { name: en['mi.saveChanges'] }))
    expect(await screen.findByText(en['mi.updatedToast'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.fulfilledToast'])).not.toBeInTheDocument()
  })

  it('changing status to cancelled is an update, not a fulfilment', async () => {
    stub()
    book()
    await editStatus('cancelled')
    expect(await screen.findByText(en['mi.updatedToast'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.fulfilledToast'])).not.toBeInTheDocument()
  })

  it('says it in Spanish, and not in English', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stub()
    book()
    await editStatus('fulfilled', es)
    expect(await screen.findByText(es['mi.fulfilledToast'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.fulfilledToast'])).not.toBeInTheDocument()
  })

  it('500 shows the inline error and no success toast', async () => {
    stub({ write: () => ok({ error: 'x' }, 500) })
    book()
    await editStatus('fulfilled')
    expect(await screen.findByRole('alert')).toHaveTextContent(en['err.save'])
    noSuccess()
  })

  it('409 with no code shows the inline error and no success toast', async () => {
    stub({ write: () => ok({ error: 'This intention is not offered at a Mass yet — nothing was lost.' }, 409) })
    book()
    await editStatus('fulfilled')
    expect(await screen.findByRole('alert')).toHaveTextContent(en['err.save'])
    expect(screen.queryByText(/not offered at a Mass/i)).not.toBeInTheDocument()
    noSuccess()
  })

  it('409 date_conflict shows the refusal and no success toast', async () => {
    stub({ write: () => ok({ error: 'x', code: 'date_conflict' }, 409) })
    book()
    await editStatus('fulfilled')
    expect(await screen.findByText(en['mi.dateConflictRefused'])).toBeInTheDocument()
    noSuccess()
  })

  it('a thrown save shows the inline error and no success toast', async () => {
    stub({ write: () => { throw new TypeError('Failed to fetch') } })
    book()
    await editStatus('fulfilled')
    expect(await screen.findByRole('alert')).toHaveTextContent(en['err.save'])
    noSuccess()
  })

  it('shows no toast until the write resolves, and a filter change during the write does not reload the old query', async () => {
    const reqs = deferredStub()
    book()
    await settle(await req(reqs, { offset: '0', view: undefined }), { intentions: [OPEN] })
    await screen.findByText('For a safe journey')
    fireEvent.click(screen.getByRole('button', { name: en['mi.edit'] }))
    fireEvent.change(screen.getByLabelText(en['mi.status']), { target: { value: 'fulfilled' } })
    fireEvent.click(screen.getByRole('button', { name: en['mi.saveChanges'] }))
    const patch = await waitFor(() => {
      const w = writes.find(x => !x.used)
      if (!w) throw new Error('no write')
      w.used = true
      return w
    })
    expect(screen.queryByText(en['mi.fulfilledToast'])).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mi-past-filter'))
    await settle(await req(reqs, { offset: '0', view: 'past_scheduled' }), { intentions: [{ ...OPEN, id: 20, intention: 'Past row', past_scheduled: true }] })
    await screen.findByText('Past row')
    const mark = reqs.length
    await settle(patch, { id: 15 }, 200)
    expect(await screen.findByText(en['mi.fulfilledToast'])).toBeInTheDocument()
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
    const stale = reqs.slice(mark).filter(r => r.p.offset === '0' && !('view' in r.p))
    expect(stale).toHaveLength(0)
    expect(screen.queryByText('For a safe journey')).not.toBeInTheDocument()
    expect(screen.getByText('Past row')).toBeInTheDocument()
  })
})
