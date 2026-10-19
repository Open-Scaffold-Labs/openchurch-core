// SP-064 (Saint uat MIN-28): read-only "past scheduled — fulfilment not
// recorded". The server decides which rows match (parish clock, SQL before
// pagination); the page only shows its per-row flag and asks the server for
// view=past_scheduled. No copy may say the Mass was missed or said.
import { ToastProvider } from '../components/ToastProvider'
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
const book = () => render(<MemoryRouter initialEntries={['/mass-intentions']}><LocaleProvider><ToastProvider><Routes><Route path="/mass-intentions" element={<MassIntentions />} /></Routes></ToastProvider></LocaleProvider></MemoryRouter>)
const { en, es } = STRINGS
const listUrls = urls => urls.filter(u => u.includes('/api/mass-intentions?'))

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale'); stubMatchMedia(false) })
afterEach(() => vi.unstubAllGlobals())

describe('SP-064 past scheduled indicator + filter', () => {
  it('EN read: the flag shows only on rows the server marked, with neutral copy (never missed/said)', async () => {
    stubFetch(() => ok({ intentions: [PAST, FUTURE] }))
    book()
    const tags = await screen.findAllByTestId('mi-past-scheduled')
    expect(tags).toHaveLength(1)
    expect(tags[0]).toHaveTextContent(en['mi.pastScheduled'])
    expect(within(screen.getByText('For a past-dated row').closest('tr')).getByTestId('mi-past-scheduled')).toBeInTheDocument()
    expect(within(screen.getByText('For a future row').closest('tr')).queryByTestId('mi-past-scheduled')).toBeNull()
    for (const k of ['mi.pastScheduled', 'mi.pastScheduledFilter', 'mi.pastScheduledEmptyTitle', 'mi.pastScheduledEmptyBody']) {
      expect(en[k]).toBeTruthy(); expect(es[k]).toBeTruthy()
      expect(en[k]).not.toMatch(/missed|said|celebrated|discharged|overdue/i)
      expect(es[k]).not.toMatch(/perdid|omitid|celebrad|cumplid[ao]s?\b|vencid/i)
    }
  })

  it('ES read on phone cards: the flag renders in Spanish on the card', async () => {
    localStorage.setItem('ochr_locale', 'es'); stubMatchMedia(true)
    stubFetch(() => ok({ intentions: [PAST] }))
    book()
    const card = (await screen.findAllByTestId('mi-card'))[0]
    expect(within(card).getByTestId('mi-past-scheduled')).toHaveTextContent(es['mi.pastScheduled'])
  })

  it('filter asks the SERVER (view=past_scheduled) with status and search preserved, and Load more keeps it', async () => {
    const urls = stubFetch(p => ok({ intentions: p.get('view') === 'past_scheduled' ? (p.get('offset') === '0' ? LOADMORE_PAST : [PAST]) : [PAST, FUTURE] }))
    book()
    await screen.findByText('For a future row')
    const btn = screen.getByTestId('mi-past-filter')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(listUrls(urls).every(u => !u.includes('view='))).toBe(true)
    fireEvent.change(screen.getByLabelText(en['mi.allStatuses']), { target: { value: 'scheduled' } })
    fireEvent.change(screen.getByLabelText(en['mi.search']), { target: { value: 'Past' } })
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    await screen.findByText('Past 0')
    const last = new URL(listUrls(urls).at(-1), 'http://x').searchParams
    expect(Object.fromEntries(last)).toMatchObject({ view: 'past_scheduled', status: 'scheduled', q: 'Past', offset: '0', limit: '50' })
    expect(screen.queryByText('For a future row')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['mi.loadMore'] }))
    await waitFor(() => expect(new URL(listUrls(urls).at(-1), 'http://x').searchParams.get('offset')).toBe('50'))
    expect(new URL(listUrls(urls).at(-1), 'http://x').searchParams.get('view')).toBe('past_scheduled')
  })

  it('EN empty: filter on with no matches shows the dedicated neutral empty state, not "No Mass intentions yet"', async () => {
    stubFetch(p => ok({ intentions: p.get('view') ? [] : [FUTURE] }))
    book()
    await screen.findByText('For a future row')
    fireEvent.click(screen.getByTestId('mi-past-filter'))
    expect(await screen.findByText(en['mi.pastScheduledEmptyTitle'])).toBeInTheDocument()
    expect(screen.getByText(en['mi.pastScheduledEmptyBody'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.emptyTitle'])).toBeNull()
  })

  it('ES empty', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch(p => ok({ intentions: p.get('view') ? [] : [FUTURE] }))
    book()
    await screen.findByText('For a future row')
    fireEvent.click(screen.getByTestId('mi-past-filter'))
    expect(await screen.findByText(es['mi.pastScheduledEmptyTitle'])).toBeInTheDocument()
    expect(screen.getByTestId('mi-past-filter')).toHaveTextContent(es['mi.pastScheduledFilter'])
  })

  it('failure (EN and ES): a failed filtered read is an error, never an empty "nothing past scheduled"', async () => {
    for (const loc of ['en', 'es']) {
      localStorage.setItem('ochr_locale', loc)
      stubFetch(p => (p.get('view') ? ok({ error: 'x' }, 500) : ok({ intentions: [FUTURE] })))
      const { unmount } = book()
      await screen.findByText('For a future row')
      fireEvent.click(screen.getByTestId('mi-past-filter'))
      expect(await screen.findByRole('alert')).toHaveTextContent(STRINGS[loc]['mi.loadFailed'])
      expect(screen.queryByText(STRINGS[loc]['mi.pastScheduledEmptyTitle'])).toBeNull()
      expect(screen.queryByText('For a future row')).toBeNull() // no stale unfiltered rows under the pressed filter
      unmount(); vi.unstubAllGlobals(); stubMatchMedia(false)
    }
  })
})
