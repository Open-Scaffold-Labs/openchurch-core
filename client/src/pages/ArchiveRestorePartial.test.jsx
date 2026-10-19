// A restore that came back incomplete must not be announced as complete.
//
// POST /api/vault/:id/restore answers 200 with BOTH `restored` and
// `not_restored`. The server is honest about the second half: a
// sacramental record that was pointed at somebody else while the member
// sat in the vault is NOT relinked (`not_restored.relinked`), and a
// cascaded child whose other parent has since gone is skipped
// (`not_restored.cascaded[]`, with a reason). The page used to toast
// "{label} is back in your parish records." on any 200 and drop the
// rest on the floor — after a card that had promised "and N connections
// that would be restored".
//
// The control comes first: a clean restore must still get the plain
// sentence, or the partial assertion proves nothing.

import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Archive from './Archive'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const ENTRY = {
  id: 77, kind: 'member', label: 'Maria Test',
  deleted_at: '2026-09-01T10:00:00Z', retention_until: '2026-10-01T10:00:00Z',
  summary: { cascaded_rows: 1, relinked_rows: 1 },
}
const LIST = { entries: [ENTRY], protected_kinds: [{ kind: 'member', noun: 'Member' }], retention_days: 30 }

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

const stubFetch = (restoreBody) => {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    calls.push([u, opts.method ?? 'GET'])
    if (u.match(/\/api\/vault\/77\/restore$/)) return ok(restoreBody)
    return ok(LIST)
  }))
  return calls
}

const renderPage = () =>
  render(
    <LocaleProvider><ToastProvider><ConfirmProvider>
      <Archive />
    </ConfirmProvider></ToastProvider></LocaleProvider>
  )

const PLAIN_SUCCESS = /is back in your parish records/i

// Press "Put this back", then answer the confirm dialog.
async function restore() {
  fireEvent.click(await screen.findByRole('button', { name: /put this back/i }))
  fireEvent.click(await screen.findByRole('button', { name: /^put it back$/i }))
}

beforeEach(() => vi.unstubAllGlobals())

describe('Archive — restore with not_restored', () => {
  it('CONTROL: an all-zero not_restored gets the plain success sentence and no partial notice', async () => {
    stubFetch({
      entry_id: 77, kind: 'member', label: 'Maria Test',
      restored: { records: 1, cascaded: 1, relinked: 1 },
      not_restored: { cascaded: [], relinked: 0 },
    })
    renderPage()
    await restore()
    expect(await screen.findByText(PLAIN_SUCCESS)).toBeInTheDocument()
    expect(screen.queryByText(/could not be (restored|put back)/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/is back, but/i)).not.toBeInTheDocument()
  })

  it('a relink the server refused is said out loud, and the plain sentence is not the only thing said', async () => {
    stubFetch({
      entry_id: 77, kind: 'member', label: 'Maria Test',
      restored: { records: 1, cascaded: 1, relinked: 0 },
      not_restored: { cascaded: [], relinked: 1 },
    })
    renderPage()
    await restore()
    // The member IS back — say so — but with the caveat attached.
    expect((await screen.findAllByText(/Maria Test is back, but/i)).length).toBeGreaterThan(0)
    // The count and the reason, in the parish's words.
    expect(screen.getByText(/1 connection could not be restored/i)).toBeInTheDocument()
    expect(screen.getByText(/points to another record/i)).toBeInTheDocument()
    // The unqualified sentence is a false claim here.
    expect(screen.queryByText(PLAIN_SUCCESS)).not.toBeInTheDocument()
  })

  it('a skipped cascaded child is counted with the reason the server gave', async () => {
    stubFetch({
      entry_id: 77, kind: 'member', label: 'Maria Test',
      restored: { records: 1, cascaded: 0, relinked: 1 },
      not_restored: {
        cascaded: [{ table: 'ochr_group_members', id: 5, reason: 'its related record is gone' }],
        relinked: 0,
      },
    })
    renderPage()
    await restore()
    expect((await screen.findAllByText(/Maria Test is back, but/i)).length).toBeGreaterThan(0)
    expect(screen.getByText(/1 related record could not be put back/i)).toBeInTheDocument()
    expect(screen.getByText(/no longer here/i)).toBeInTheDocument()
    expect(screen.queryByText(PLAIN_SUCCESS)).not.toBeInTheDocument()
  })

  it('a partial result still refreshes the list', async () => {
    const calls = stubFetch({
      restored: { records: 1, cascaded: 0, relinked: 0 },
      not_restored: { cascaded: [], relinked: 2 },
    })
    renderPage()
    await restore()
    await screen.findByText(/2 connections could not be restored/i)
    await waitFor(() => expect(calls.filter(([u, m]) => m === 'GET' && u.includes('/api/vault')).length).toBeGreaterThanOrEqual(2))
  })
})
