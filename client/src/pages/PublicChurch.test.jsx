// PublicChurch contact-form chrome (OC-READY-01-035) and remaining page
// chrome (OC-READY-01-036) go through strings.js + t() en+es. Restoring
// those literals in the component goes red. POST body keys stay the
// connect contract; church / address / service-time content stays
// parish-supplied data; Give / events link targets stay /p/:slug/….

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import PublicChurch from './PublicChurch'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const CHURCH_SRC = readFileSync(join(HERE, 'PublicChurch.jsx'), 'utf8')

const CHURCH = { name: 'St Test', slug: 'st-test', locale: 'en' }
const PAGE = {
  church: CHURCH,
  page: { tagline: 'A parish', about: 'About us', service_times: 'Sundays 10am', address: '1 Church St' },
}
const FUNDS = { church: CHURCH, funds: [{ id: 1, name: 'General' }], giving_enabled: true }
const GROUPS = { groups: [{ id: 7, name: 'Choir' }] }

const ok = (b, status = 200) => ({ ok: true, status, json: async () => b })
const err = (s, b = { error: 'boom' }) => ({ ok: false, status: s, json: async () => b })

const HARD_EN = [
  'Get connected',
  'Thanks for reaching out!',
  'Someone from the church will be in touch soon.',
  'New here or want to join a ministry?',
  "We couldn't load this church's ministries",
  "I'm interested in",
  "I'm not sure yet",
  'Your name *',
  'Anything you\'d like us to know?',
  'Sending…',
]

const CONTACT_KEYS = [
  'contact.title',
  'contact.thanks',
  'contact.thanksBody',
  'contact.intro',
  'contact.groupsFail',
  'contact.interest',
  'contact.unsure',
  'contact.namePh',
  'contact.emailPh',
  'contact.phonePh',
  'contact.messagePh',
  'contact.send',
  'contact.sending',
  'contact.submitFail',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

let calls
const routes = (over = {}, church = CHURCH) => {
  calls = []
  const page = { ...PAGE, church }
  const funds = { ...FUNDS, church }
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
    if (u.includes('/funds')) return ok(funds)
    if (u.includes('/groups')) return ok(GROUPS)
    if (u.includes('/connect')) return ok({ ok: true }, 201)
    if (u.includes('/page')) return ok(page)
    return ok({})
  }))
}

const mount = () => render(
  <MemoryRouter initialEntries={['/p/st-test']}>
    <LocaleProvider>
      <Routes><Route path="/p/:slug" element={<PublicChurch />} /></Routes>
    </LocaleProvider>
  </MemoryRouter>,
)

const fillAndSubmit = async (namePh, sendRe) => {
  const name = await screen.findByPlaceholderText(namePh)
  fireEvent.change(name, { target: { value: 'Test Visitor' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: sendRe })) })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('PublicChurch contact form is translated (OC-READY-01-035)', () => {
  it('ENGLISH FORM AND THANK-YOU USE t() COPY', async () => {
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.en['contact.title'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['contact.intro'])).toBeInTheDocument()
    expect(await screen.findByText(STRINGS.en['contact.interest'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['contact.unsure'])).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.en['contact.namePh'])).toHaveAttribute(
      'aria-label',
      STRINGS.en['contact.namePh'],
    )
    expect(screen.getByPlaceholderText(STRINGS.en['contact.emailPh'])).toHaveAttribute(
      'aria-label',
      STRINGS.en['contact.emailPh'],
    )
    expect(screen.getByPlaceholderText(STRINGS.en['contact.phonePh'])).toHaveAttribute(
      'aria-label',
      STRINGS.en['contact.phonePh'],
    )
    expect(screen.getByPlaceholderText(STRINGS.en['contact.messagePh'])).toHaveAttribute(
      'aria-label',
      STRINGS.en['contact.messagePh'],
    )
    expect(screen.getByRole('button', { name: STRINGS.en['contact.send'] })).toBeInTheDocument()
  })

  it('SPANISH FORM CHROME IS SPANISH — NOT THE ENGLISH LABELS', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['contact.title'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['contact.title'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['contact.intro'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['contact.intro'])).toBeNull()
    expect(await screen.findByText(STRINGS.es['contact.interest'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['contact.interest'])).toBeNull()
    expect(screen.getByPlaceholderText(STRINGS.es['contact.namePh'])).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(STRINGS.en['contact.namePh'])).toBeNull()
    expect(screen.getByPlaceholderText(STRINGS.es['contact.emailPh'])).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(STRINGS.en['contact.emailPh'])).toBeNull()
    expect(screen.getByPlaceholderText(STRINGS.es['contact.phonePh'])).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.es['contact.messagePh'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['contact.send'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['contact.send'] })).toBeNull()
  })

  it('publicLocale from the page payload is Spanish chrome', async () => {
    routes({}, { ...CHURCH, locale: 'es' })
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['contact.title'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['contact.title'] })).toBeNull()
    expect(screen.getByPlaceholderText(STRINGS.es['contact.namePh'])).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(STRINGS.en['contact.namePh'])).toBeNull()
    expect(screen.getByPlaceholderText(STRINGS.es['contact.emailPh'])).toHaveAttribute(
      'aria-label',
      STRINGS.es['contact.emailPh'],
    )
    expect(screen.getByRole('button', { name: STRINGS.es['contact.send'] })).toBeInTheDocument()
  })

  it('groups-fail chrome follows the device locale', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/groups': () => err(500) })
    mount()
    expect(await screen.findByText(STRINGS.es['contact.groupsFail'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['contact.groupsFail'])).toBeNull()
    expect(screen.getByPlaceholderText(STRINGS.es['contact.namePh'])).toBeInTheDocument()
  })

  it('thank-you chrome is localized after a successful send', async () => {
    routes()
    mount()
    await fillAndSubmit(STRINGS.en['contact.namePh'], new RegExp(STRINGS.en['contact.send'], 'i'))
    expect(await screen.findByText(STRINGS.en['contact.thanks'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['contact.thanksBody'])).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(STRINGS.en['contact.namePh'])).toBeNull()
  })

  it('Spanish thank-you follows publicLocale', async () => {
    routes({}, { ...CHURCH, locale: 'es' })
    mount()
    await fillAndSubmit(STRINGS.es['contact.namePh'], new RegExp(STRINGS.es['contact.send'], 'i'))
    expect(await screen.findByText(STRINGS.es['contact.thanks'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['contact.thanksBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['contact.thanks'])).toBeNull()
  })

  it('submit still posts the same connect body — field keys unchanged', async () => {
    routes()
    mount()
    await screen.findByPlaceholderText(STRINGS.en['contact.namePh'])
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '7' } })
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['contact.namePh']), {
      target: { value: '  Test Visitor  ' },
    })
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['contact.emailPh']), {
      target: { value: '  visitor@example.com  ' },
    })
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['contact.phonePh']), {
      target: { value: '  555-0100  ' },
    })
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['contact.messagePh']), {
      target: { value: '  I would like to help  ' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(STRINGS.en['contact.send'], 'i') }))
    })
    await waitFor(() => {
      expect(calls.some(c => c.method === 'POST' && c.url.includes('/connect'))).toBe(true)
    })
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/connect'))
    expect(post.body).toEqual({
      group_id: '7',
      name: 'Test Visitor',
      email: 'visitor@example.com',
      phone: '555-0100',
      message: 'I would like to help',
    })
  })

  it('empty optional fields are still omitted on the POST', async () => {
    routes()
    mount()
    await fillAndSubmit(STRINGS.en['contact.namePh'], new RegExp(STRINGS.en['contact.send'], 'i'))
    await waitFor(() => {
      expect(calls.some(c => c.method === 'POST' && c.url.includes('/connect'))).toBe(true)
    })
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/connect'))
    expect(post.body).toEqual({ name: 'Test Visitor' })
    expect(post.body).not.toHaveProperty('group_id')
    expect(post.body).not.toHaveProperty('email')
    expect(post.body).not.toHaveProperty('phone')
    expect(post.body).not.toHaveProperty('message')
  })

  it('server data.error is still shown as returned — not re-translated here', async () => {
    routes({
      '/connect': () => err(400, { error: 'Name is required' }),
    })
    mount()
    const name = await screen.findByPlaceholderText(STRINGS.en['contact.namePh'])
    fireEvent.change(name, { target: { value: 'Test Visitor' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(STRINGS.en['contact.send'], 'i') }))
    })
    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeInTheDocument()
    })
    expect(screen.queryByText(STRINGS.en['contact.thanks'])).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(CHURCH_SRC)
    for (const key of CONTACT_KEYS) {
      expect(CHURCH_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(CHURCH_SRC).toMatch(/useLocale\(/)
    expect(CHURCH_SRC).toMatch(/setPublicLocale/)
    expect(CHURCH_SRC).toMatch(/group_id/)
    expect(CHURCH_SRC).toMatch(/\/connect/)
    expect(CHURCH_SRC).toMatch(/d\.error/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    // Short tokens that still appear as HTML attribute leftovers if the
    // form regresses to literals. Scan the live markup attributes only.
    expect(jsx).not.toMatch(/placeholder="Email"/)
    expect(jsx).not.toMatch(/aria-label="Email"/)
    expect(jsx).not.toMatch(/placeholder="Phone"/)
    expect(jsx).not.toMatch(/aria-label="Phone"/)
    expect(jsx).not.toMatch(/>\s*Send\s*</)
    expect(STRINGS.en['contact.thanks']).toBe('Thanks for reaching out!')
    expect(STRINGS.en['contact.namePh']).toBe('Your name *')
    expect(STRINGS.es['contact.thanks']).toMatch(/gracias/i)
    expect(STRINGS.es['contact.namePh']).toMatch(/nombre/i)
    expect(STRINGS.es['contact.emailPh']).toMatch(/correo/i)
    expect(STRINGS.es['contact.send']).toMatch(/enviar/i)
  })
})

const PAGE_HARD_EN = [
  'Church not found',
  "We couldn't find a published page at",
  "Couldn't load page",
  "didn't come back in a form we could read",
  'Service times',
  'Find us',
  'Get directions',
  'Upcoming events',
  'Powered by OpenChurch',
]

const PAGE_KEYS = [
  'church.notFound',
  'church.notFoundBefore',
  'church.notFoundAfter',
  'church.loadFailTitle',
  'church.loadFailBody',
  'church.unreadableBody',
  'church.serviceTimes',
  'church.welcome',
  'church.findUs',
  'church.directions',
  'church.events',
  'church.give',
  'church.powered',
]

describe('PublicChurch page chrome is translated (OC-READY-01-036)', () => {
  it('ENGLISH PAGE CHROME USES t() COPY; API CONTENT STAYS DATA', async () => {
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: 'St Test' })).toBeInTheDocument()
    expect(screen.getByText('A parish')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['church.serviceTimes'] })).toBeInTheDocument()
    expect(screen.getByText('Sundays 10am')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['church.welcome'] })).toBeInTheDocument()
    expect(screen.getByText('About us')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['church.findUs'] })).toBeInTheDocument()
    expect(screen.getByText('1 Church St')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.en['church.directions'] })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=1%20Church%20St',
    )
    expect(screen.getByRole('link', { name: STRINGS.en['church.events'] })).toHaveAttribute(
      'href',
      '/p/st-test/events',
    )
    expect(screen.getByRole('link', { name: STRINGS.en['church.give'] })).toHaveAttribute(
      'href',
      '/p/st-test/give',
    )
    expect(screen.getByText(STRINGS.en['church.powered'])).toBeInTheDocument()
  })

  it('SPANISH PAGE CHROME IS SPANISH — NOT THE ENGLISH LABELS', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: 'St Test' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.es['church.serviceTimes'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['church.serviceTimes'] })).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['church.welcome'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['church.welcome'] })).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['church.findUs'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['church.findUs'] })).toBeNull()
    expect(screen.getByRole('link', { name: STRINGS.es['church.directions'] })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: STRINGS.en['church.directions'] })).toBeNull()
    expect(screen.getByRole('link', { name: STRINGS.es['church.events'] })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: STRINGS.en['church.events'] })).toBeNull()
    expect(screen.getByRole('link', { name: STRINGS.es['church.give'] })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: STRINGS.en['church.give'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['church.powered'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['church.powered'])).toBeNull()
    // Parish-supplied content is still the API text — not inventively translated.
    expect(screen.getByText('A parish')).toBeInTheDocument()
    expect(screen.getByText('Sundays 10am')).toBeInTheDocument()
    expect(screen.getByText('About us')).toBeInTheDocument()
    expect(screen.getByText('1 Church St')).toBeInTheDocument()
  })

  it('publicLocale from the page payload is Spanish chrome', async () => {
    routes({}, { ...CHURCH, locale: 'es' })
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['church.serviceTimes'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['church.serviceTimes'] })).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['church.welcome'] })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.es['church.findUs'] })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.es['church.events'] })).toHaveAttribute(
      'href',
      '/p/st-test/events',
    )
    expect(screen.getByRole('link', { name: STRINGS.es['church.give'] })).toHaveAttribute(
      'href',
      '/p/st-test/give',
    )
    expect(screen.getByText(STRINGS.es['church.powered'])).toBeInTheDocument()
    expect(screen.getByText('St Test')).toBeInTheDocument()
    expect(screen.getByText('Sundays 10am')).toBeInTheDocument()
  })

  it('not-found chrome follows the device locale and keeps published-page honesty', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/page': () => err(404) })
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['church.notFound'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['church.notFound'] })).toBeNull()
    expect(screen.getByText((_, node) => (
      node.tagName === 'P'
      && (node.textContent || '').includes('/p/st-test')
      && (node.textContent || '').includes(STRINGS.es['church.notFoundBefore'].trim())
    ))).toBeInTheDocument()
    expect(STRINGS.en['church.notFoundBefore']).toMatch(/published page/i)
    expect(screen.queryByText('St Test')).toBeNull()
    expect(screen.queryByRole('link', { name: STRINGS.es['church.give'] })).toBeNull()
    expect(screen.queryByRole('link', { name: STRINGS.es['church.events'] })).toBeNull()
  })

  it('load-fail and unreadable chrome follow the device locale', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/page': () => err(500) })
    const { unmount } = mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['church.loadFailTitle'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['church.loadFailTitle'])).toBeNull()
    expect(screen.getByText(STRINGS.es['church.loadFailBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['church.loadFailBody'])).toBeNull()
    unmount()

    routes({ '/page': () => ok({}) })
    mount()
    expect(await screen.findByText(STRINGS.es['church.unreadableBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['church.unreadableBody'])).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['church.loadFailTitle'] })).toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
  })

  it('a church that genuinely has no giving still does not advertise it in Spanish', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({
      '/funds': () => ok({ church: { ...CHURCH, locale: 'es' }, funds: [], giving_enabled: false }),
    }, { ...CHURCH, locale: 'es' })
    mount()
    expect(await screen.findByRole('link', { name: STRINGS.es['church.events'] })).toHaveAttribute(
      'href',
      '/p/st-test/events',
    )
    expect(screen.queryByRole('link', { name: STRINGS.es['church.give'] })).toBeNull()
    expect(screen.queryByRole('link', { name: STRINGS.en['church.give'] })).toBeNull()
  })

  it('i18n strings and the page-chrome wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(CHURCH_SRC)
    for (const key of PAGE_KEYS) {
      expect(CHURCH_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(CHURCH_SRC).toMatch(/useLocale\(/)
    expect(CHURCH_SRC).toMatch(/setPublicLocale/)
    expect(CHURCH_SRC).toMatch(/to=\{`\/p\/\$\{slug\}\/events`\}/)
    expect(CHURCH_SRC).toMatch(/to=\{`\/p\/\$\{slug\}\/give`\}/)
    expect(CHURCH_SRC).toMatch(/err === 'not-found'/)
    expect(CHURCH_SRC).toMatch(/page\.service_times/)
    expect(CHURCH_SRC).toMatch(/page\.address/)
    expect(CHURCH_SRC).toMatch(/church\.name/)
    for (const phrase of PAGE_HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(jsx).not.toMatch(/>\s*Welcome\s*</)
    expect(jsx).not.toMatch(/>\s*Give\s*</)
    expect(STRINGS.en['church.notFound']).toBe('Church not found')
    expect(STRINGS.en['church.serviceTimes']).toBe('Service times')
    expect(STRINGS.en['church.welcome']).toBe('Welcome')
    expect(STRINGS.en['church.findUs']).toBe('Find us')
    expect(STRINGS.en['church.events']).toBe('Upcoming events')
    expect(STRINGS.en['church.give']).toBe('Give')
    expect(STRINGS.en['church.powered']).toBe('Powered by OpenChurch')
    expect(STRINGS.en['church.notFoundBefore']).toMatch(/published page/i)
    expect(STRINGS.es['church.notFound']).toMatch(/iglesia/i)
    expect(STRINGS.es['church.serviceTimes']).toMatch(/horario/i)
    expect(STRINGS.es['church.welcome']).toMatch(/bienvenid/i)
    expect(STRINGS.es['church.findUs']).toMatch(/encu[eé]ntre/i)
    expect(STRINGS.es['church.give']).toMatch(/donar/i)
    expect(STRINGS.es['church.powered']).toMatch(/openchurch/i)
  })
})
