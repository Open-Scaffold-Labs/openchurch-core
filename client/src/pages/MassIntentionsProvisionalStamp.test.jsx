// R355-1 (TARS on #355): after bulk "Mark said", the row shown before the
// authoritative reload must not present the PLANNED Mass's cached title or
// time as the fulfilment. The linked Mass may have moved since the page
// read it, so even a "same day" match against the cache proves nothing.
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
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

const { en } = STRINGS
const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const CACHED = {
  id: 7, intention: 'For the Rivera family', requested_by: 'Ana',
  mass_date: '2020-01-15', mass_title: 'Morning Mass', mass_time: '07:00', calendar_event_id: 40,
  status: 'scheduled', stipend: '12.50', past_scheduled: true,
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

// reload: what the list read returns after the mark — a value, an Error
// (thrown), or a deferred that the test resolves later.
function stub({ markedDay, reload }) {
  let marked = false
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url)
    if (u.includes('/api/mass-intentions/bulk-mark-said')) {
      const body = JSON.parse(init.body)
      marked = true
      return ok({ batch_id: body.request_id, replayed: false, marked: [{ id: '7', fulfilled_date: markedDay }], excluded: [] })
    }
    if (u.includes('/api/mass-intentions')) {
      if (!marked) return ok({ intentions: [CACHED] })
      const r = reload && reload.promise ? await reload.promise : reload
      if (r instanceof Error) throw r
      return r
    }
    return ok([])
  }))
}

async function markSaid(day) {
  render(
    <MemoryRouter initialEntries={['/mass-intentions']}>
      <LocaleProvider><ToastProvider><ConfirmProvider>
        <Routes><Route path="/mass-intentions" element={<MassIntentions />} /></Routes>
      </ConfirmProvider></ToastProvider></LocaleProvider>
    </MemoryRouter>,
  )
  fireEvent.click(await screen.findByLabelText(en['mi.markSaidSelect'].replace('{name}', 'For the Rivera family')))
  fireEvent.click(screen.getByTestId('mi-mark-said-open'))
  if (day) {
    fireEvent.change(await screen.findByLabelText(`${en['mi.markSaidDate']} For the Rivera family`), { target: { value: day } })
  }
  fireEvent.click(await screen.findByTestId('mi-mark-said-commit'))
  await screen.findByTestId('mi-mark-said-result')
}
const row = () => screen.getByText('For the Rivera family').closest('tr')

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })))
})
afterEach(() => vi.unstubAllGlobals())

describe('R355-1 provisional marked row', () => {
  it('(a) moved Mass, reload pending: the cached planned title/time are not shown as fulfilled', async () => {
    const pending = deferred()
    stub({ markedDay: '2020-01-15', reload: pending })
    await markSaid()
    await waitFor(() => expect(row()).toHaveTextContent(en['mi.fulfilled']))
    expect(row()).toHaveTextContent(/Jan(uary)? 15, 2020/)
    expect(row()).not.toHaveTextContent('Morning Mass')
    expect(row()).not.toHaveTextContent('07:00')
    await act(async () => { pending.resolve(ok({ intentions: [{ ...CACHED, status: 'fulfilled', mass_title: null, mass_time: null, past_scheduled: false }] })) })
  })

  it('(a) moved Mass, reload fails: the planned title/time still never appear as fulfilled', async () => {
    stub({ markedDay: '2020-01-15', reload: new Error('offline') })
    await markSaid()
    await waitFor(() => expect(row()).toHaveTextContent(en['mi.fulfilled']))
    await act(async () => {})
    expect(row()).not.toHaveTextContent('Morning Mass')
    expect(row()).not.toHaveTextContent('07:00')
  })

  it('(b) same day, reload succeeds: the actual recorded snapshot is shown', async () => {
    stub({ markedDay: '2020-01-15', reload: ok({ intentions: [{ ...CACHED, status: 'fulfilled', mass_title: 'Morning Mass', mass_time: '07:00', past_scheduled: false }] }) })
    await markSaid()
    await waitFor(() => expect(row()).toHaveTextContent('Morning Mass'))
    expect(row()).toHaveTextContent('07:00')
    expect(row()).toHaveTextContent(en['mi.fulfilled'])
  })

  it('(c) different day, reload pending: the confirmed day shows without the planned Mass', async () => {
    const pending = deferred()
    stub({ markedDay: '2020-01-16', reload: pending })
    await markSaid('2020-01-16')
    await waitFor(() => expect(row()).toHaveTextContent(/Jan(uary)? 16, 2020/))
    expect(row()).toHaveTextContent(en['mi.fulfilled'])
    expect(row()).not.toHaveTextContent('Morning Mass')
    await act(async () => { pending.resolve(ok({ intentions: [] })) })
  })
})
