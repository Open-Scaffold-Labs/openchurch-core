// PublicBulletin remaining chrome goes through strings.js + t() en+es.
// Restoring those literals in the component goes red. Org name, section
// bodies, liturgical feast / season, and the published date stay parish
// / API data. A 404 is still "no published bulletin".

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import PublicBulletin from './PublicBulletin'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const BULLETIN_SRC = readFileSync(join(HERE, 'PublicBulletin.jsx'), 'utf8')

const ORG = { name: 'St Test', slug: 'st-test', locale: 'en' }
const BULLETIN = {
  date: '2026-09-20',
  readings: 'Isaiah 55:1-9',
  announcements: 'Choir practice Tuesday',
  intentions: 'For the Rivera family',
  pastor_note: 'Peace be with you this week.',
}
const LITURGICAL = {
  feast_name: 'Ordinary Time',
  season: 'Ordinary Time',
  color: 'Green',
}

const ok = (b, status = 200) => ({ ok: true, status, json: async () => b })
const err = (s, b = { error: 'boom' }) => ({ ok: false, status: s, json: async () => b })

const HARD_EN = [
  'No bulletin yet',
  "hasn't published a bulletin online",
  "Couldn't load bulletin",
  'Weekly Bulletin',
  'Prayer & Mass Intentions',
  'From the Pastor',
  'Powered by OpenChurch',
]

const BULLETIN_KEYS = [
  'bulletin.notFound',
  'bulletin.notFoundBody',
  'bulletin.loadFailTitle',
  'bulletin.loadFailBody',
  'bulletin.title',
  'bulletin.readings',
  'bulletin.announcements',
  'bulletin.intentions',
  'bulletin.pastor',
  'bulletin.powered',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

let calls
const routes = (over = {}, org = ORG) => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET' })
    for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
    if (u.includes('/bulletin')) return ok({ org, bulletin: BULLETIN, liturgical: LITURGICAL })
    return ok({})
  }))
}

const mount = () => render(
  <MemoryRouter initialEntries={['/p/st-test/bulletin']}>
    <LocaleProvider>
      <Routes><Route path="/p/:slug/bulletin" element={<PublicBulletin />} /></Routes>
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

describe('PublicBulletin chrome is translated', () => {
  it('ENGLISH PAGE CHROME USES t() COPY; API CONTENT STAYS DATA', async () => {
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: 'St Test' })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['bulletin.title'])).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['bulletin.readings'] })).toBeInTheDocument()
    expect(screen.getByText('Isaiah 55:1-9')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['bulletin.announcements'] })).toBeInTheDocument()
    expect(screen.getByText('Choir practice Tuesday')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['bulletin.intentions'] })).toBeInTheDocument()
    expect(screen.getByText('For the Rivera family')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['bulletin.pastor'] })).toBeInTheDocument()
    expect(screen.getByText('Peace be with you this week.')).toBeInTheDocument()
    expect(screen.getByText('Ordinary Time')).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['bulletin.powered'])).toBeInTheDocument()
  })

  it('SPANISH PAGE CHROME IS SPANISH — NOT THE ENGLISH LABELS', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: 'St Test' })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['bulletin.title'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['bulletin.title'])).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['bulletin.readings'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['bulletin.readings'] })).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['bulletin.announcements'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['bulletin.announcements'] })).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['bulletin.intentions'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['bulletin.intentions'] })).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['bulletin.pastor'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['bulletin.pastor'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['bulletin.powered'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['bulletin.powered'])).toBeNull()
    // Parish-supplied content is still the API text — not inventively translated.
    expect(screen.getByText('Isaiah 55:1-9')).toBeInTheDocument()
    expect(screen.getByText('Choir practice Tuesday')).toBeInTheDocument()
    expect(screen.getByText('For the Rivera family')).toBeInTheDocument()
    expect(screen.getByText('Peace be with you this week.')).toBeInTheDocument()
    expect(screen.getByText('Ordinary Time')).toBeInTheDocument()
  })

  it('publicLocale from the bulletin payload is Spanish chrome', async () => {
    routes({}, { ...ORG, locale: 'es' })
    mount()
    expect(await screen.findByText(STRINGS.es['bulletin.title'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['bulletin.title'])).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['bulletin.readings'] })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.es['bulletin.pastor'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['bulletin.powered'])).toBeInTheDocument()
    expect(screen.getByText('St Test')).toBeInTheDocument()
    expect(screen.getByText('Choir practice Tuesday')).toBeInTheDocument()
  })

  it('not-found chrome follows the device locale and keeps unpublished honesty', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/bulletin': () => err(404) })
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['bulletin.notFound'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['bulletin.notFound'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['bulletin.notFoundBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['bulletin.notFoundBody'])).toBeNull()
    expect(STRINGS.en['bulletin.notFoundBody']).toMatch(/hasn't published a bulletin/i)
    expect(screen.queryByText('St Test')).toBeNull()
    expect(screen.queryByText('Isaiah 55:1-9')).toBeNull()
    expect(screen.queryByText(STRINGS.es['bulletin.title'])).toBeNull()
  })

  it('load-fail chrome follows the device locale and is not an unpublished claim', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/bulletin': () => err(500) })
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['bulletin.loadFailTitle'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['bulletin.loadFailTitle'])).toBeNull()
    expect(screen.getByText(STRINGS.es['bulletin.loadFailBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['bulletin.loadFailBody'])).toBeNull()
    expect(screen.queryByText(STRINGS.es['bulletin.notFound'])).toBeNull()
    expect(screen.queryByText(STRINGS.es['bulletin.notFoundBody'])).toBeNull()
    expect(screen.queryByText(/Failed \(500\)/)).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(BULLETIN_SRC)
    for (const key of BULLETIN_KEYS) {
      expect(BULLETIN_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(BULLETIN_SRC).toMatch(/useLocale\(/)
    expect(BULLETIN_SRC).toMatch(/setPublicLocale/)
    expect(BULLETIN_SRC).toMatch(/err === 'not-found'/)
    expect(BULLETIN_SRC).toMatch(/org\?\.name/)
    expect(BULLETIN_SRC).toMatch(/bulletin\.readings/)
    expect(BULLETIN_SRC).toMatch(/bulletin\.announcements/)
    expect(BULLETIN_SRC).toMatch(/bulletin\.intentions/)
    expect(BULLETIN_SRC).toMatch(/bulletin\.pastor_note/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(jsx).not.toMatch(/>\s*Readings\s*</)
    expect(jsx).not.toMatch(/>\s*Announcements\s*</)
    expect(STRINGS.en['bulletin.notFound']).toBe('No bulletin yet')
    expect(STRINGS.en['bulletin.title']).toBe('Weekly Bulletin')
    expect(STRINGS.en['bulletin.readings']).toBe('Readings')
    expect(STRINGS.en['bulletin.announcements']).toBe('Announcements')
    expect(STRINGS.en['bulletin.intentions']).toBe('Prayer & Mass Intentions')
    expect(STRINGS.en['bulletin.pastor']).toBe('From the Pastor')
    expect(STRINGS.en['bulletin.powered']).toBe('Powered by OpenChurch')
    expect(STRINGS.en['bulletin.notFoundBody']).toMatch(/hasn't published a bulletin/i)
    expect(STRINGS.es['bulletin.notFound']).toMatch(/bolet[ií]n/i)
    expect(STRINGS.es['bulletin.title']).toMatch(/bolet[ií]n/i)
    expect(STRINGS.es['bulletin.readings']).toMatch(/lectura/i)
    expect(STRINGS.es['bulletin.announcements']).toMatch(/aviso/i)
    expect(STRINGS.es['bulletin.intentions']).toMatch(/intencion/i)
    expect(STRINGS.es['bulletin.pastor']).toMatch(/p[aá]rroco/i)
    expect(STRINGS.es['bulletin.powered']).toMatch(/openchurch/i)
  })
})
