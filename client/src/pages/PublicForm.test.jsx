// PublicForm leftover chrome (Levi knock-out #3) goes through
// strings.js + t() en+es. Restoring those literals in the component
// goes red. Form title, description, field labels, options, help_text,
// and API error text stay parish / API data. POST answers + contact
// stay the submit contract.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import PublicForm from './PublicForm'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const FORM_SRC = readFileSync(join(HERE, 'PublicForm.jsx'), 'utf8')

const FORM = {
  slug: 'volunteer',
  title: 'Volunteer Interest',
  description: 'Tell us how you can help.',
  fields: [
    {
      id: 'role',
      type: 'select',
      label: 'Preferred ministry',
      required: true,
      options: ['Hospitality', 'Choir'],
    },
    {
      id: 'days',
      type: 'multiselect',
      label: 'Available days',
      required: true,
      options: ['Sunday', 'Wednesday'],
    },
    {
      id: 'notes',
      type: 'long_text',
      label: 'Anything else',
      required: false,
      help_text: 'Optional details from the parish.',
    },
  ],
  org: { locale: 'en' },
}

const ok = (b, status = 200) => ({ ok: true, status, json: async () => b })
const err = (s, b = { error: 'boom' }) => ({ ok: false, status: s, json: async () => b })

const HARD_EN = [
  'Form not available',
  "We couldn't find an open form at",
  "Couldn't load the form",
  'Please try again in a moment.',
  'Your response to',
  'was received.',
  'Your name',
  'Only used to contact you about your response.',
  '— Select —',
  'Too many submissions from this network',
  'Submitting…',
  'Powered by OpenChurch',
]

const FORM_KEYS = [
  'form.notFound',
  'form.notFoundBefore',
  'form.notFoundAfter',
  'form.loadFailTitle',
  'form.loadFailBody',
  'form.thanks',
  'form.receivedBefore',
  'form.receivedAfter',
  'form.name',
  'form.email',
  'form.emailHelp',
  'form.select',
  'form.fieldRequired',
  'form.rateLimited',
  'form.submit',
  'form.submitting',
  'form.powered',
  'form.submitFail',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

let calls
const routes = (over = {}, body = FORM) => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
    if (u.includes('/submit')) return ok({ id: 1, created_at: '2026-09-18T00:00:00.000Z' }, 201)
    if (u.includes('/forms/')) return ok(body)
    return ok({})
  }))
}

const mount = () => render(
  <MemoryRouter initialEntries={['/p/st-test/forms/volunteer']}>
    <LocaleProvider>
      <Routes><Route path="/p/:slug/forms/:formSlug" element={<PublicForm />} /></Routes>
    </LocaleProvider>
  </MemoryRouter>,
)

const fillRequired = (nameLabel, emailLabel) => {
  fireEvent.change(screen.getByLabelText('Preferred ministry'), { target: { value: 'Hospitality' } })
  fireEvent.click(screen.getByLabelText('Sunday'))
  fireEvent.change(screen.getByLabelText(nameLabel), { target: { value: '  Ana Probe  ' } })
  fireEvent.change(screen.getByLabelText(emailLabel), { target: { value: '  ana@example.com  ' } })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  sessionStorage.removeItem('ochr:form-submitted:st-test:volunteer')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
  sessionStorage.removeItem('ochr:form-submitted:st-test:volunteer')
})

describe('PublicForm leftover chrome is translated', () => {
  it('ENGLISH PAGE CHROME USES t() COPY; API CONTENT STAYS DATA', async () => {
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: 'Volunteer Interest' })).toBeInTheDocument()
    expect(screen.getByText('Tell us how you can help.')).toBeInTheDocument()
    expect(screen.getByLabelText('Preferred ministry')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: STRINGS.en['form.select'] })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Hospitality' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Choir' })).toBeInTheDocument()
    expect(screen.getByText('Available days')).toBeInTheDocument()
    expect(screen.getByLabelText('Sunday')).toBeInTheDocument()
    expect(screen.getByLabelText('Wednesday')).toBeInTheDocument()
    expect(screen.getByLabelText('Anything else')).toBeInTheDocument()
    expect(screen.getByText('Optional details from the parish.')).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['form.name'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['form.email'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['form.emailHelp'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['form.submit'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['form.powered'])).toBeInTheDocument()
  })

  it('SPANISH PAGE CHROME IS SPANISH — NOT THE ENGLISH LABELS', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: 'Volunteer Interest' })).toBeInTheDocument()
    expect(screen.getByText('Tell us how you can help.')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: STRINGS.es['form.select'] })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: STRINGS.en['form.select'] })).toBeNull()
    expect(screen.getByLabelText(STRINGS.es['form.name'])).toBeInTheDocument()
    expect(screen.queryByLabelText(STRINGS.en['form.name'])).toBeNull()
    expect(screen.getByLabelText(STRINGS.es['form.email'])).toBeInTheDocument()
    expect(screen.queryByLabelText(STRINGS.en['form.email'])).toBeNull()
    expect(screen.getByText(STRINGS.es['form.emailHelp'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['form.emailHelp'])).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.es['form.submit'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['form.submit'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['form.powered'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['form.powered'])).toBeNull()
    expect(screen.getByLabelText('Preferred ministry')).toBeInTheDocument()
    expect(screen.getByText('Available days')).toBeInTheDocument()
    expect(screen.getByLabelText('Sunday')).toBeInTheDocument()
    expect(screen.getByText('Optional details from the parish.')).toBeInTheDocument()
  })

  it('publicLocale from the form payload is Spanish chrome', async () => {
    routes({}, { ...FORM, org: { locale: 'es' } })
    mount()
    expect(await screen.findByText(STRINGS.es['form.powered'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['form.powered'])).toBeNull()
    expect(screen.getByRole('option', { name: STRINGS.es['form.select'] })).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.es['form.name'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['form.submit'] })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Volunteer Interest' })).toBeInTheDocument()
    expect(screen.getByLabelText('Preferred ministry')).toBeInTheDocument()
  })

  it('not-found chrome follows the device locale and keeps the guessed path', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/forms/': () => err(404) })
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['form.notFound'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['form.notFound'] })).toBeNull()
    expect(screen.getByText((_, node) => (
      node.tagName === 'P'
      && (node.textContent || '').includes('/p/st-test/forms/volunteer')
      && (node.textContent || '').includes(STRINGS.es['form.notFoundBefore'].trim())
    ))).toBeInTheDocument()
    expect(STRINGS.en['form.notFoundBefore']).toMatch(/open form at/i)
    expect(STRINGS.en['form.notFoundAfter']).toMatch(/bulletin/i)
    expect(screen.queryByText('Volunteer Interest')).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.es['form.submit'] })).toBeNull()
  })

  it('load-fail chrome follows the device locale and does not surface the status', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/forms/': () => err(500) })
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['form.loadFailTitle'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['form.loadFailTitle'])).toBeNull()
    expect(screen.getByText(STRINGS.es['form.loadFailBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['form.loadFailBody'])).toBeNull()
    expect(screen.queryByText(/Failed \(500\)/)).toBeNull()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
  })

  it('thank-you chrome is localized; form title stays API data', async () => {
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: 'Volunteer Interest' })).toBeInTheDocument()
    fillRequired(STRINGS.en['form.name'], STRINGS.en['form.email'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.en['form.submit'] })) })
    expect(await screen.findByRole('heading', { name: STRINGS.en['form.thanks'] })).toBeInTheDocument()
    expect(screen.getByText((_, node) => (
      node.tagName === 'P'
      && (node.textContent || '').includes('Volunteer Interest')
      && (node.textContent || '').includes(STRINGS.en['form.receivedBefore'].trim())
      && (node.textContent || '').includes(STRINGS.en['form.receivedAfter'].trim())
    ))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['form.submit'] })).toBeNull()
  })

  it('submit still posts the same answers and trimmed contact', async () => {
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: 'Volunteer Interest' })).toBeInTheDocument()
    fillRequired(STRINGS.en['form.name'], STRINGS.en['form.email'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.en['form.submit'] })) })
    await waitFor(() => {
      expect(calls.some(c => c.method === 'POST' && c.url.includes('/submit'))).toBe(true)
    })
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/submit'))
    expect(post.body).toEqual({
      answers: { role: 'Hospitality', days: ['Sunday'] },
      respondent_name: 'Ana Probe',
      respondent_email: 'ana@example.com',
    })
  })

  it('required-multiselect chrome interpolates the API label', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes()
    mount()
    expect(await screen.findByLabelText('Preferred ministry')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Preferred ministry'), { target: { value: 'Choir' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.es['form.submit'] })) })
    expect(screen.getByText(STRINGS.es['form.fieldRequired'].replace('{label}', 'Available days'))).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['form.fieldRequired'].replace('{label}', 'Available days'))).toBeNull()
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })

  it('rate-limited chrome follows the locale; API data.error stays data', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/submit': () => err(429) })
    const { unmount } = mount()
    expect(await screen.findByLabelText('Preferred ministry')).toBeInTheDocument()
    fillRequired(STRINGS.es['form.name'], STRINGS.es['form.email'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.es['form.submit'] })) })
    expect(await screen.findByText(STRINGS.es['form.rateLimited'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['form.rateLimited'])).toBeNull()
    expect(screen.queryByRole('heading', { name: STRINGS.es['form.thanks'] })).toBeNull()
    unmount()
    sessionStorage.removeItem('ochr:form-submitted:st-test:volunteer')

    routes({ '/submit': () => err(400, { error: 'Preferred ministry is required' }) })
    mount()
    expect(await screen.findByLabelText('Preferred ministry')).toBeInTheDocument()
    fillRequired(STRINGS.es['form.name'], STRINGS.es['form.email'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.es['form.submit'] })) })
    expect(await screen.findByText('Preferred ministry is required')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.es['form.thanks'] })).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(FORM_SRC)
    for (const key of FORM_KEYS) {
      expect(FORM_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(FORM_SRC).toMatch(/useLocale\(/)
    expect(FORM_SRC).toMatch(/setPublicLocale/)
    expect(FORM_SRC).toMatch(/err === 'not-found'/)
    expect(FORM_SRC).toMatch(/form\.title/)
    expect(FORM_SRC).toMatch(/form\.description/)
    expect(FORM_SRC).toMatch(/field\.label/)
    expect(FORM_SRC).toMatch(/field\.help_text/)
    expect(FORM_SRC).toMatch(/field\.options/)
    expect(FORM_SRC).toMatch(/respondent_name/)
    expect(FORM_SRC).toMatch(/respondent_email/)
    expect(jsx).not.toMatch(/>\s*Submit\s*</)
    expect(jsx).not.toMatch(/>\s*Thank you\s*</)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['form.notFound']).toBe('Form not available')
    expect(STRINGS.en['form.thanks']).toBe('Thank you')
    expect(STRINGS.en['form.submit']).toBe('Submit')
    expect(STRINGS.en['form.powered']).toBe('Powered by OpenChurch')
    expect(STRINGS.en['form.select']).toBe('— Select —')
    expect(STRINGS.en['form.notFoundBefore']).toMatch(/open form at/i)
    expect(STRINGS.es['form.notFound']).toMatch(/formulario/i)
    expect(STRINGS.es['form.thanks']).toMatch(/gracias/i)
    expect(STRINGS.es['form.submit']).toMatch(/enviar/i)
    expect(STRINGS.es['form.powered']).toMatch(/openchurch/i)
    expect(STRINGS.es['form.name']).toMatch(/nombre/i)
    expect(STRINGS.es['form.select']).toMatch(/seleccion/i)
  })
})
