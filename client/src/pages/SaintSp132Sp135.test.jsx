// SP-064 (Saint uat MIN-28): read-only "past scheduled — fulfilment not
// recorded". The server decides which rows match (parish clock, SQL before
// pagination); the page only shows its per-row flag and asks the server for
// view=past_scheduled. No copy may say the Mass was missed or said.
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
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
const PAST = { id: 21, intention: 'For a past-dated row', requested_by: 'Synthetic', mass_date: '2026-10-04', mass_title: 'Sunday Mass', status: 'scheduled', stipend: null, past_scheduled: true }
const FUTURE = { id: 22, intention: 'For a future row', requested_by: 'Synthetic', mass_date: '2027-01-03', mass_title: 'Sunday Mass', status: 'scheduled', stipend: null, past_scheduled: false }
const LOADMORE_PAST = Array.from({ length: 50 }, (_, i) => ({ ...PAST, id: 100 + i, intention: `Past ${i}` }))

function stubMatchMedia(matches) {
  vi.stubGlobal('matchMedia', vi.fn(q => ({ matches: q === '(max-width: 767px)' ? matches : false, media: q, addEventListener() {}, removeEventListener() {} })))
}
function stubFetch(handler) {
  const urls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url); urls.push(u)
    if (u.includes('/api/mass-intentions?')) return handler(new URL(u, 'http://x').searchParams)
    return ok([])
  }))
  return urls
}
const book = () => render(<MemoryRouter initialEntries={['/mass-intentions']}><LocaleProvider><ToastProvider><Routes><Route path="/mass-intentions" element={<ConfirmProvider><MassIntentions /></ConfirmProvider>} /></Routes></ToastProvider></LocaleProvider></MemoryRouter>)
const { en, es } = STRINGS
const listUrls = urls => urls.filter(u => u.includes('/api/mass-intentions?'))
import NotFound from './NotFound'

const CANCEL_EMPTY = p => ok({ intentions: (p.get('status') || p.get('q')) ? [] : [FUTURE] })

describe('SP-132 filtered empty state is not "No Mass intentions yet"', () => {
  for (const loc of ['en', 'es']) {
    it(`${loc}: Cancelled filter with no matches says nothing matches the filter`, async () => {
      localStorage.setItem('ochr_locale', loc)
      const s = STRINGS[loc]
      stubFetch(CANCEL_EMPTY)
      book()
      await screen.findByText('For a future row')
      fireEvent.change(screen.getByLabelText(s['mi.allStatuses']), { target: { value: 'cancelled' } })
      expect(await screen.findByText(s['mi.filterNoMatchTitle'])).toBeInTheDocument()
      expect(screen.getByText(s['mi.filterNoMatchBody'])).toBeInTheDocument()
      expect(screen.queryByText(s['mi.emptyTitle'])).toBeNull()
    })
  }
  it('a search with no matches also uses the filter empty state', async () => {
    localStorage.setItem('ochr_locale', 'en')
    stubFetch(CANCEL_EMPTY)
    book()
    await screen.findByText('For a future row')
    fireEvent.change(screen.getByLabelText(en['mi.search']), { target: { value: 'zzz' } })
    expect(await screen.findByText(en['mi.filterNoMatchTitle'])).toBeInTheDocument()
  })
  it('a truly empty book still says "No Mass intentions yet"', async () => {
    localStorage.setItem('ochr_locale', 'en')
    stubFetch(() => ok({ intentions: [] }))
    book()
    expect(await screen.findByText(en['mi.emptyTitle'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.filterNoMatchTitle'])).toBeNull()
  })
})

describe('SP-135 NotFound page', () => {
  for (const loc of ['en', 'es']) {
    for (const home of ['/', '/login']) {
      it(`${loc} home=${home}: calm "Page not found" with a link home`, () => {
        localStorage.setItem('ochr_locale', loc)
        const s = STRINGS[loc]
        render(<MemoryRouter initialEntries={['/dashboard']}><LocaleProvider><NotFound home={home} /></LocaleProvider></MemoryRouter>)
        expect(screen.getByRole('heading', { name: s['notFound.title'] })).toBeInTheDocument()
        expect(screen.getByText(s['notFound.body'])).toBeInTheDocument()
        expect(screen.getByRole('link', { name: s['notFound.home'] })).toHaveAttribute('href', home)
      })
    }
  }
})
