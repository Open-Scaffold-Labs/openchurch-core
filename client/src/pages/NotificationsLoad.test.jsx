// Pilot 1 for the load contract. (Pass 7 §5)
//
// Notifications was chosen because it is the smallest page in the app with
// the defect — 161 lines, two reads — and because it is genuinely two
// panels, so partial failure gets exercised in the simplest possible place.
//
// Before: `r.ok ? r.json() : { scheduled: [] }` turned a 500 on either
// endpoint into "Nothing queued right now." with no error shown, because the
// .catch only fired for a network or parse error.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import Notifications from './Notifications'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false,
  }),
}))

const SCHEDULED = [{ id: 's1', notification_type: 'event_reminder', recipient_email: 'a@x.com', status: 'pending', send_at: '2026-09-01T10:00:00Z' }]
const LOG       = [{ id: 'l1', notification_type: 'task_assigned',  recipient_email: 'b@x.com', status: 'delivered', created_at: '2026-08-26T10:00:00Z' }]

const ok  = (body) => ({ ok: true,  status: 200, json: async () => body })
const err = (status) => ({ ok: false, status, json: async () => ({ error: 'boom' }) })
const bad = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })

const stub = (sched, logr) => vi.stubGlobal('fetch', vi.fn(async (url) =>
  String(url).includes('/scheduled') ? sched() : logr()))

const mount = () => render(
  <MemoryRouter><LocaleProvider><Notifications /></LocaleProvider></MemoryRouter>
)

const QUEUED_CLAIM = /nothing queued right now/i
const SENT_CLAIM   = /nothing sent yet/i
const FAILED       = /this didn'?t load|some of this didn'?t load/i

beforeEach(() => vi.unstubAllGlobals())

describe('CONTROL — behaviour must be equivalent to before', () => {
  it('renders both panels with their rows and no failure copy', async () => {
    stub(() => ok({ scheduled: SCHEDULED }), () => ok({ log: LOG }))
    mount()
    expect(await screen.findByText(/event reminder/i)).toBeInTheDocument()
    expect(screen.getByText(/task assigned/i)).toBeInTheDocument()
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
    expect(screen.queryByText(QUEUED_CLAIM)).not.toBeInTheDocument()
  })

  it('a genuinely empty pipeline still gets the welcoming copy', async () => {
    stub(() => ok({ scheduled: [] }), () => ok({ log: [] }))
    mount()
    expect(await screen.findByText(QUEUED_CLAIM)).toBeInTheDocument()
    expect(screen.getByText(SENT_CLAIM)).toBeInTheDocument()
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
  })
})

describe('FAILURE must never read as empty', () => {
  for (const [label, sched] of [
    ['a 500',           () => err(500)],
    ['a 403',           () => err(403)],
    ['a malformed body', bad],
  ]) {
    it(`${label} on the queue does not claim nothing is queued`, async () => {
      stub(sched, () => ok({ log: LOG }))
      mount()
      await waitFor(() => expect(screen.getByText(FAILED)).toBeInTheDocument())
      expect(screen.queryByText(QUEUED_CLAIM)).not.toBeInTheDocument()
    })
  }

  it('PARTIAL: one panel failing leaves the other usable', async () => {
    stub(() => err(500), () => ok({ log: LOG }))
    mount()
    await waitFor(() => expect(screen.getByText(FAILED)).toBeInTheDocument())
    expect(screen.getByText(/task assigned/i)).toBeInTheDocument()
    expect(screen.queryByText(QUEUED_CLAIM)).not.toBeInTheDocument()
  })

  it('a failed count reads as a dash, not as zero', async () => {
    stub(() => err(500), () => ok({ log: [] }))
    mount()
    await waitFor(() => expect(screen.getByText(FAILED)).toBeInTheDocument())
    expect(screen.getByText(/\(—\)/)).toBeInTheDocument()
  })
})

describe('RETRY recovers in place', () => {
  it('a retry after a 500 fills the panel without a page reload', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (!String(url).includes('/scheduled')) return ok({ log: LOG })
      return ++call === 1 ? err(500) : ok({ scheduled: SCHEDULED })
    }))
    mount()
    await waitFor(() => expect(screen.getByText(FAILED)).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again/i })) })
    await waitFor(() => expect(screen.getByText(/event reminder/i)).toBeInTheDocument())
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
  })
})
