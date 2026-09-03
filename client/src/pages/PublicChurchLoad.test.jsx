// A public page has no session, no error console and no reason to doubt what
// it says. (Pass 9 §9–§10)
//
// Two claims it was making on a failed read:
//   - the Give button disappeared, telling a parishioner who came to give
//     that this church has no way to receive it
//   - the ministry picker emptied, implying a parish with no ministries
//
// Both from `r.ok ? r.json() : { … }` with a catch that agreed.

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import PublicChurch from './PublicChurch'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

// The real shape, read off server/src/routes/publicEvents.js rather than
// guessed — the first version omitted `page` entirely and every test died on
// `Cannot read properties of undefined (reading 'service_times')`, which
// looked exactly like a component defect for a minute.
const PAGE = {
  church: { name: 'St Test', slug: 'st-test', locale: 'en' },
  page: { tagline: 'A parish', about: 'About us', service_times: 'Sundays 10am', address: '1 Church St' },
}
const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

const routes = (over = {}) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
  if (u.includes('/funds'))  return ok({ church: PAGE.church, funds: [{ id: 1, name: 'General' }], giving_enabled: true })
  if (u.includes('/groups')) return ok({ groups: [{ id: 1, name: 'Choir' }] })
  return ok(PAGE)
}))

const mount = () => render(
  <MemoryRouter initialEntries={['/c/st-test']}>
    <LocaleProvider>
      <Routes><Route path="/c/:slug" element={<PublicChurch />} /></Routes>
    </LocaleProvider>
  </MemoryRouter>
)

const give = () => screen.queryAllByText(/give/i)
const MINISTRIES_UNREAD = /couldn'?t load this church'?s ministries/i

beforeEach(() => vi.unstubAllGlobals())

describe('CONTROL — a church with giving set up', () => {
  it('offers giving', async () => {
    routes(); mount()
    await waitFor(() => expect(give().length).toBeGreaterThan(0))
    expect(screen.queryByText(MINISTRIES_UNREAD)).not.toBeInTheDocument()
  })

  it('a church that genuinely has NO giving does not advertise it', async () => {
    // The real reason the gate exists. A true negative must stay negative.
    routes({ '/funds': () => ok({ church: PAGE.church, funds: [], giving_enabled: false }) })
    mount()
    await waitFor(() => expect(screen.getByText(/St Test/)).toBeInTheDocument())
    await waitFor(() => expect(give().length).toBe(0))
  })
})

describe('a 200 that is not a page', () => {
  it('does not throw the generic crash screen at a parishioner', async () => {
    // Observed at runtime: an unexpected 200 body with no `page` object threw
    // "Cannot read properties of undefined (reading 'service_times')" and the
    // boundary rendered "Something went wrong. We've logged it on our end."
    // on a public page — to a visitor with no console and no retry but the URL.
    routes({ '/page': () => ok({}) }); mount()
    expect(await screen.findByText(/didn'?t come back in a form we could read/i)).toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
  })

  it('renders what DID arrive when only a section is missing', async () => {
    routes({ '/page': () => ok({ church: PAGE.church }) }); mount()
    expect(await screen.findByText(/St Test/)).toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
  })
})

describe('a failed read must not answer for the parish', () => {
  for (const status of [500, 503]) {
    it(`a ${status} on funds does not remove the way to give`, async () => {
      routes({ '/funds': () => err(status) }); mount()
      await waitFor(() => expect(screen.getByText(/St Test/)).toBeInTheDocument())
      await waitFor(() => expect(give().length).toBeGreaterThan(0))
    })
  }

  it('a network failure on funds does not remove it either', async () => {
    routes({ '/funds': () => { throw new TypeError('Failed to fetch') } }); mount()
    await waitFor(() => expect(screen.getByText(/St Test/)).toBeInTheDocument())
    await waitFor(() => expect(give().length).toBeGreaterThan(0))
  })

  it('a failed ministries read says so, and the form still works', async () => {
    routes({ '/groups': () => err(500) }); mount()
    expect(await screen.findByText(MINISTRIES_UNREAD)).toBeInTheDocument()
    // The visitor can still reach out — our outage must not block them.
    expect(screen.getByPlaceholderText(/name/i)).toBeInTheDocument()
  })

  it('a 404 on ministries is a real absence, not a failure', async () => {
    // No public page for this church: an empty picker IS the truth.
    routes({ '/groups': () => err(404) }); mount()
    await waitFor(() => expect(screen.getByText(/St Test/)).toBeInTheDocument())
    expect(screen.queryByText(MINISTRIES_UNREAD)).not.toBeInTheDocument()
  })
})
