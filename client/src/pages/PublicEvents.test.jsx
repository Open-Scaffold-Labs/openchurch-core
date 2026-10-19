// PublicEvents remaining chrome goes through strings.js + t() en+es.
// Restoring those literals in the component goes red. Event title,
// division, location, liturgical feast / season, and the ICS subscribe
// URL stay parish / API data. Church-not-found honesty stays a 404.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import PublicEvents from './PublicEvents'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const EVENTS_SRC = readFileSync(join(HERE, 'PublicEvents.jsx'), 'utf8')

const CHURCH = { name: 'St Test', slug: 'st-test', locale: 'en' }
const EVENT = {
  id: 11,
  title: 'Parish Picnic',
  service_division: 'Hospitality',
  date: '2026-09-20',
  time: '09:30:00',
  location: 'Parish Hall',
  liturgical_season: 'Ordinary Time',
  liturgical_color: 'Green',
  feast_name: 'Ordinary Time',
}

const ok = (b, status = 200) => ({ ok: true, status, json: async () => b })
const err = (s, b = { error: 'boom' }) => ({ ok: false, status: s, json: async () => b })

const HARD_EN = [
  'Church not found',
  "We couldn't find a church at",
  "Couldn't load events",
  'Upcoming events',
  'Add to your calendar',
  'Sync with Apple Calendar',
  'No upcoming public events scheduled',
  'Check back soon, or contact the church',
  'Powered by OpenChurch',
]

const EVENTS_KEYS = [
  'events.notFound',
  'events.notFoundBefore',
  'events.notFoundAfter',
  'events.loadFailTitle',
  'events.loadFailBody',
  'events.title',
  'events.addToCalendar',
  'events.calendarHelp',
  'events.subscribe',
  'events.emptyTitle',
  'events.emptyBody',
  'events.powered',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

let calls
const routes = (over = {}, church = CHURCH, events = [EVENT]) => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET' })
    for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
    if (u.includes('/events')) return ok({ church, events })
    return ok({})
  }))
}

const mount = () => render(
  <MemoryRouter initialEntries={['/p/st-test/events']}>
    <LocaleProvider>
      <Routes><Route path="/p/:slug/events" element={<PublicEvents />} /></Routes>
    </LocaleProvider>
  </MemoryRouter>,
)

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('PublicEvents chrome is translated', () => {
  it('ENGLISH PAGE CHROME USES t() COPY; API CONTENT STAYS DATA', async () => {
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: 'St Test' })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['events.title'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['events.addToCalendar'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['events.calendarHelp'])).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.en['events.subscribe'] })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/api\/public\/st-test\/events\.ics$/),
    )
    expect(screen.getByRole('link', { name: /\.ics/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/api/public/st-test/events.ics'),
    )
    expect(screen.getByRole('heading', { name: 'Parish Picnic' })).toBeInTheDocument()
    expect(screen.getByText('Hospitality')).toBeInTheDocument()
    expect(screen.getByText('Parish Hall')).toBeInTheDocument()
    expect(screen.getByText('Ordinary Time')).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['events.powered'])).toBeInTheDocument()
  })

  it('SPANISH PAGE CHROME IS SPANISH — NOT THE ENGLISH LABELS', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: 'St Test' })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['events.title'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['events.title'])).toBeNull()
    expect(screen.getByText(STRINGS.es['events.addToCalendar'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['events.addToCalendar'])).toBeNull()
    expect(screen.getByText(STRINGS.es['events.calendarHelp'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['events.calendarHelp'])).toBeNull()
    expect(screen.getByRole('link', { name: STRINGS.es['events.subscribe'] })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: STRINGS.en['events.subscribe'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['events.powered'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['events.powered'])).toBeNull()
    // Parish-supplied content is still the API text — not inventively translated.
    expect(screen.getByRole('heading', { name: 'Parish Picnic' })).toBeInTheDocument()
    expect(screen.getByText('Hospitality')).toBeInTheDocument()
    expect(screen.getByText('Parish Hall')).toBeInTheDocument()
    expect(screen.getByText('Ordinary Time')).toBeInTheDocument()
  })

  it('publicLocale from the events payload is Spanish chrome', async () => {
    routes({}, { ...CHURCH, locale: 'es' })
    mount()
    expect(await screen.findByText(STRINGS.es['events.title'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['events.title'])).toBeNull()
    expect(screen.getByText(STRINGS.es['events.addToCalendar'])).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.es['events.subscribe'] })).toHaveAttribute(
      'href',
      expect.stringMatching(/^webcal:\/\//),
    )
    expect(screen.getByText(STRINGS.es['events.powered'])).toBeInTheDocument()
    expect(screen.getByText('St Test')).toBeInTheDocument()
    expect(screen.getByText('Parish Picnic')).toBeInTheDocument()
  })

  it('not-found chrome follows the device locale and keeps church-not-found honesty', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/events': () => err(404) })
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['events.notFound'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['events.notFound'] })).toBeNull()
    expect(screen.getByText((_, node) => (
      node.tagName === 'P'
      && (node.textContent || '').includes('/st-test')
      && (node.textContent || '').includes(STRINGS.es['events.notFoundBefore'].trim())
    ))).toBeInTheDocument()
    expect(STRINGS.en['events.notFoundBefore']).toMatch(/church at/i)
    expect(STRINGS.en['events.notFoundAfter']).toMatch(/bulletin/i)
    expect(screen.queryByText('St Test')).toBeNull()
    expect(screen.queryByText('Parish Picnic')).toBeNull()
    expect(screen.queryByRole('link', { name: STRINGS.es['events.subscribe'] })).toBeNull()
  })

  it('load-fail chrome follows the device locale and does not surface the status', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/events': () => err(500) })
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['events.loadFailTitle'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['events.loadFailTitle'])).toBeNull()
    expect(screen.getByText(STRINGS.es['events.loadFailBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['events.loadFailBody'])).toBeNull()
    expect(screen.queryByText(/Failed \(500\)/)).toBeNull()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
  })

  it('empty upcoming list keeps the localized empty-state, not invented events', async () => {
    routes({}, CHURCH, [])
    const { unmount } = mount()
    expect(await screen.findByText(STRINGS.en['events.emptyTitle'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['events.emptyBody'])).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: STRINGS.en['events.subscribe'] })).toBeNull()
    expect(screen.queryByText('Parish Picnic')).toBeNull()
    unmount()

    localStorage.setItem('ochr_locale', 'es')
    routes({}, { ...CHURCH, locale: 'es' }, [])
    mount()
    expect(await screen.findByText(STRINGS.es['events.emptyTitle'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['events.emptyTitle'])).toBeNull()
    expect(screen.getByText(STRINGS.es['events.emptyBody'])).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: STRINGS.es['events.subscribe'] })).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(EVENTS_SRC)
    for (const key of EVENTS_KEYS) {
      expect(EVENTS_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(EVENTS_SRC).toMatch(/useLocale\(/)
    expect(EVENTS_SRC).toMatch(/setPublicLocale/)
    expect(EVENTS_SRC).toMatch(/err === 'not-found'/)
    expect(EVENTS_SRC).toMatch(/church\.name/)
    expect(EVENTS_SRC).toMatch(/ev\.title/)
    expect(EVENTS_SRC).toMatch(/ev\.location/)
    expect(EVENTS_SRC).toMatch(/webcal:\/\//)
    expect(EVENTS_SRC).toMatch(/events\.ics/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(jsx).not.toMatch(/>\s*Subscribe\s*</)
    expect(STRINGS.en['events.notFound']).toBe('Church not found')
    expect(STRINGS.en['events.title']).toBe('Upcoming events')
    expect(STRINGS.en['events.subscribe']).toBe('Subscribe')
    expect(STRINGS.en['events.powered']).toBe('Powered by OpenChurch')
    expect(STRINGS.en['events.notFoundBefore']).toMatch(/church at/i)
    expect(STRINGS.es['events.notFound']).toMatch(/iglesia/i)
    expect(STRINGS.es['events.title']).toMatch(/evento/i)
    expect(STRINGS.es['events.subscribe']).toMatch(/suscrib/i)
    expect(STRINGS.es['events.powered']).toMatch(/openchurch/i)
    expect(STRINGS.es['events.emptyTitle']).toMatch(/evento/i)
  })
})
