// The register's integrity surface. (Pass 8 §7–§13)
//
// Every capability here has existed on the server since migration 073 and
// none of it was reachable from the product: a parish could not retire an
// entry, could not undo retiring one, and could not see what had been
// corrected. The only destructive control the UI offered was the DELETE the
// server had deliberately abolished.
//
// Vocabulary matters as much as behaviour. Void is not delete.

import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import SacramentRecord from './SacramentRecord'

let ROLE = 'admin'
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: ROLE, organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false,
  }),
}))

const RECORD = {
  id: '7', client_id: null, type: 'baptism', date: '1953-03-14',
  member_name: 'Ana Delgado', minister: 'Fr. Ibarra', place: 'San Miguel',
  certificate_no: 'P8-1953', notes: null, voided_at: null, voided_reason: null,
}
const VOIDED = { ...RECORD, voided_at: '2026-08-01T00:00:00Z', voided_reason: 'Entered twice in the 1994 transcription' }

const AMENDMENTS = [{
  id: '1', kind: 'correction', reason: 'Corrected spelling from the original register notation.',
  before_json: { ...RECORD, member_name: 'Ana Delgada', updated_at: '2026-01-01' },
  after_json:  { ...RECORD, member_name: 'Ana Delgado', updated_at: '2026-02-02' },
  amended_by_name: 'Fr. Alvarez', amended_by_email: 'fr@x.com', created_at: '2026-02-02T10:00:00Z',
}]

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

const calls = []
const routes = (over = {}) => {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    for (const [frag, h] of Object.entries(over)) {
      if (u.includes(frag) && (opts.method || 'GET') !== 'GET') return h()
      if (u.endsWith(frag) && (opts.method || 'GET') === 'GET') return h()
    }
    if (u.includes('/amendments')) return ok({ amendments: AMENDMENTS })
    return ok(RECORD)
  }))
}

const mount = () => render(
  <MemoryRouter initialEntries={['/register/7']}>
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/register/:id" element={<SacramentRecord />} /></Routes>
    </ConfirmProvider></ToastProvider></LocaleProvider>
  </MemoryRouter>
)

// The shared confirm modal is an alertdialog, not a dialog — it is always
// asking a question that needs an answer before the page moves on.
const dialog = () => screen.getByRole('alertdialog')
const typeAndConfirm = async (value, buttonName) => {
  const d = dialog()
  const input = within(d).getByRole('textbox')
  fireEvent.change(input, { target: { value } })
  await act(async () => { fireEvent.click(within(d).getByRole('button', { name: buttonName })) })
}

beforeEach(() => { ROLE = 'admin'; vi.unstubAllGlobals() })

describe('the record itself', () => {
  it('shows the name as the register recorded it', async () => {
    routes(); mount()
    expect(await screen.findByText('Ana Delgado')).toBeInTheDocument()
    expect(screen.getByText('P8-1953')).toBeInTheDocument()
  })

  it('offers a certificate while the entry is active', async () => {
    routes(); mount()
    expect(await screen.findByRole('link', { name: /certificate/i })).toBeInTheDocument()
  })
})

describe('correcting an entry', () => {
  it('asks for the new value AND a reason, and sends both', async () => {
    routes()   // the PATCH response is irrelevant here; what is sent is the point
    mount()
    await screen.findByText('Ana Delgado')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /correct this entry/i })) })
    await typeAndConfirm('Ana Delgado Ruiz', /continue/i)
    await waitFor(() => expect(within(dialog()).getByText(/why is this being corrected/i)).toBeInTheDocument())
    await typeAndConfirm('Corrected spelling from the original register notation.', /save correction/i)

    await waitFor(() => {
      const patch = calls.find(c => c.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(patch.body.member_name).toBe('Ana Delgado Ruiz')
      expect(patch.body.reason).toMatch(/original register notation/)
    })
  })

  it('is refused to a viewer, with the rule visible rather than the button hidden', async () => {
    ROLE = 'viewer'; routes(); mount()
    await screen.findByText('Ana Delgado')
    const btn = screen.getByRole('button', { name: /correct this entry/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', expect.stringMatching(/staff and administrators/i))
  })
})

describe('voiding an entry', () => {
  it('says plainly that the record is preserved, and never says delete', async () => {
    routes(); mount()
    await screen.findByText('Ana Delgado')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^void$/i })) })

    const d = dialog()
    expect(within(d).getByText(/historical record will remain preserved/i)).toBeInTheDocument()
    expect(d.textContent).not.toMatch(/\bdelete\b|\bremove\b|permanently/i)
  })

  it('requires a reason and sends it', async () => {
    routes({ '/void': () => ok(VOIDED) }); mount()
    await screen.findByText('Ana Delgado')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^void$/i })) })
    await typeAndConfirm('Entered twice in the 1994 transcription', /void entry/i)
    await waitFor(() => {
      const post = calls.find(c => c.url.includes('/void') && c.method === 'POST')
      expect(post).toBeTruthy()
      expect(post.body.reason).toMatch(/1994/)
    })
  })

  it('cannot be confirmed without a reason', async () => {
    // A surviving mutant found this gap: every other test types a reason
    // before confirming, so making the field optional changed nothing that
    // was being watched. The reason IS the confirmation here — if it can be
    // skipped, voiding becomes a single unexplained click.
    routes(); mount()
    await screen.findByText('Ana Delgado')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^void$/i })) })
    const d = dialog()
    expect(within(d).getByRole('button', { name: /void entry/i })).toBeDisabled()
    fireEvent.change(within(d).getByRole('textbox'), { target: { value: 'Entered twice' } })
    expect(within(d).getByRole('button', { name: /void entry/i })).toBeEnabled()
  })

  it('refuses a reason too short to mean anything', async () => {
    routes(); mount()
    await screen.findByText('Ana Delgado')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^void$/i })) })
    await typeAndConfirm('x', /void entry/i)
    await waitFor(() => expect(screen.getByText(/a little more detail/i)).toBeInTheDocument())
    expect(calls.find(c => c.url.includes('/void') && c.method === 'POST')).toBeUndefined()
  })

  it('is admin-only — staff see the rule, not a hidden control', async () => {
    ROLE = 'staff'; routes(); mount()
    await screen.findByText('Ana Delgado')
    const btn = screen.getByRole('button', { name: /^void$/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', expect.stringMatching(/administrator/i))
  })
})

describe('a voided entry', () => {
  it('says it is void, keeps the reason, and offers no certificate', async () => {
    routes({ '/api/sacraments/7': () => ok(VOIDED) }); mount()
    expect(await screen.findByText(/this entry is void/i)).toBeInTheDocument()
    expect(screen.getByText(/Entered twice in the 1994 transcription/)).toBeInTheDocument()
    // §12 — the system must not certify as active what it marks void.
    expect(screen.queryByRole('link', { name: /certificate/i })).not.toBeInTheDocument()
    // The entry is still on the page. Void is not disappearance.
    expect(screen.getByText('Ana Delgado')).toBeInTheDocument()
  })

  it('offers restore instead of void, and cannot be corrected', async () => {
    routes({ '/api/sacraments/7': () => ok(VOIDED) }); mount()
    await screen.findByText(/this entry is void/i)
    expect(screen.getByRole('button', { name: /restore this entry/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /correct this entry/i })).toBeDisabled()
  })

  it('restoring requires a reason and does not erase the voiding', async () => {
    routes({ '/api/sacraments/7': () => ok(VOIDED), '/restore': () => ok(RECORD) }); mount()
    await screen.findByText(/this entry is void/i)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /restore this entry/i })) })
    expect(within(dialog()).getByText(/voiding stays in the history/i)).toBeInTheDocument()
    await typeAndConfirm('Voided in error; confirmed against the original book', /restore entry/i)
    await waitFor(() => {
      const post = calls.find(c => c.url.includes('/restore') && c.method === 'POST')
      expect(post.body.reason).toMatch(/original book/)
    })
  })
})

describe('history', () => {
  it('reads as words, with the actor and the reason — never raw JSON', async () => {
    routes(); mount()
    expect(await screen.findByText(/Corrected spelling from the original register notation/)).toBeInTheDocument()
    expect(screen.getByText(/Fr\. Alvarez/)).toBeInTheDocument()
    expect(screen.getByText(/Name in the register: Ana Delgada → Ana Delgado/)).toBeInTheDocument()
    // Machinery must not leak into a parish-facing history.
    expect(screen.queryByText(/updated_at|before_json|\{"/)).not.toBeInTheDocument()
  })

  it('a void reads as its reason, not as a raw timestamp diff', async () => {
    // Observed at 390px: the void row printed
    // "Voided: 2026-08-27T18:48:36.451Z → —" beneath the reason. For a void
    // or a restore, the kind and the reason are the whole content.
    routes({ '/amendments': () => ok({ amendments: [{
      id: '2', kind: 'void', reason: 'Entered twice in the 1994 transcription',
      before_json: { ...RECORD, voided_at: null, voided_reason: null },
      after_json:  { ...RECORD, voided_at: '2026-08-27T18:48:36.451Z', voided_reason: 'Entered twice in the 1994 transcription' },
      amended_by_name: 'Fr. Alvarez', created_at: '2026-08-27T18:48:36.451Z',
    }] }) })
    mount()
    expect(await screen.findByText(/Entered twice in the 1994 transcription/)).toBeInTheDocument()
    expect(screen.queryByText(/2026-08-27T18:48/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Voided:/)).not.toBeInTheDocument()
  })

  it('a history that fails to load does not cost the reader the entry', async () => {
    routes({ '/amendments': () => err(500) }); mount()
    expect(await screen.findByText('Ana Delgado')).toBeInTheDocument()
    expect(screen.getByText(/history of this entry couldn'?t be read/i)).toBeInTheDocument()
  })

  it('does not throw while the record has arrived and the history has not', async () => {
    // The two reads finish at different times on a real page. The record
    // resolved first, the history branch rendered against a null list, and
    // the page died with `Cannot read properties of null (reading 'map')` —
    // in a suite where both stubs resolved together and everything was green.
    let release
    const held = new Promise(res => { release = res })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/amendments')) { await held; return ok({ amendments: AMENDMENTS }) }
      return ok(RECORD)
    }))
    mount()
    expect(await screen.findByText('Ana Delgado')).toBeInTheDocument()
    await act(async () => { release() })
    expect(await screen.findByText(/Corrected spelling/)).toBeInTheDocument()
  })

  it('an entry never changed says so, rather than looking broken', async () => {
    routes({ '/amendments': () => ok({ amendments: [] }) }); mount()
    expect(await screen.findByText(/nothing has been changed since this entry was made/i)).toBeInTheDocument()
  })
})
