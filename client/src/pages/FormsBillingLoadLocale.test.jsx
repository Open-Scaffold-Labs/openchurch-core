// A refused read of forms, the response inbox, or billing must stay a
// failure in the parish language. An empty inbox and a free plan are
// different sentences, and neither is the English load-failure copy.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Forms from './Forms'
import FormResponses from './FormResponses'
import Billing from './Billing'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      name: 'Secretary',
      role: 'admin',
      organization: { id: 1, name: 'St Test', slug: 'st-test', locale: 'en' },
    },
    token: 'test-token',
    loading: false,
  }),
}))

const dir = dirname(fileURLToPath(import.meta.url))
const es = STRINGS.es
const en = STRINGS.en

const ok = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
const refused = (status = 500) => ok({ error: 'no' }, status)

const FORM = {
  id: 42,
  title: 'Volunteer',
  slug: 'volunteer',
  fields: [],
}
const ONE_RESPONSE = {
  responses: [{
    id: 7,
    created_at: '2026-10-01T15:00:00Z',
    respondent_name: 'Ana',
    respondent_email: 'ana@example.com',
    answers: {},
  }],
  total: 1,
}
const PLAN = {
  planDetails: { id: 'free', name: 'Parish', description: 'The free plan', price: 0 },
  availablePlans: [],
  billing_status: 'active',
}

function spanish() {
  localStorage.setItem('ochr_locale', 'es')
}

function mount(ui) {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

describe('forms and billing load failures speak the parish language', () => {
  it('the three pages no longer hard-code the English load-failure sentences', () => {
    const forms = readFileSync(join(dir, 'Forms.jsx'), 'utf8')
    const responses = readFileSync(join(dir, 'FormResponses.jsx'), 'utf8')
    const billing = readFileSync(join(dir, 'Billing.jsx'), 'utf8')
    expect(forms).not.toMatch(/Couldn't load forms/)
    expect(responses).not.toMatch(/Couldn't load responses/)
    expect(responses).not.toMatch(/Couldn't export responses/)
    expect(billing).not.toMatch(/Couldn't load billing/)
  })

  it('a refused forms list is the Spanish form failure, not an empty office', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async () => refused()))
    mount(<Forms />)
    expect(await screen.findByRole('heading', { name: es['form.loadFailTitle'] })).toBeInTheDocument()
    expect(screen.getByText(es['form.loadFailBody'])).toBeInTheDocument()
    expect(screen.queryByText(en['form.loadFailTitle'])).toBeNull()
    expect(screen.queryByText(en['form.loadFailBody'])).toBeNull()
    expect(screen.queryByText(/Couldn't load forms/)).toBeNull()
    expect(screen.queryByText(/No forms yet/)).toBeNull()
  })

  it('a real empty forms list is not a load failure', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async () => ok({ forms: [] })))
    mount(<Forms />)
    expect(await screen.findByText(/No forms yet/)).toBeInTheDocument()
    expect(screen.queryByText(es['form.loadFailTitle'])).toBeNull()
    expect(screen.queryByText(es['form.loadFailBody'])).toBeNull()
  })

  it('a refused response inbox is the Spanish form failure, not an empty inbox', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/responses')) return refused()
      if (u.includes('/api/forms/')) return ok(FORM)
      return ok({})
    }))
    render(
      <MemoryRouter initialEntries={['/forms/42/responses']}>
        <Routes>
          <Route path="/forms/:id/responses" element={
            <LocaleProvider>
              <ToastProvider>
                <ConfirmProvider>
                  <FormResponses />
                </ConfirmProvider>
              </ToastProvider>
            </LocaleProvider>
          } />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: es['form.loadFailTitle'] })).toBeInTheDocument()
    expect(screen.getByText(es['form.loadFailBody'])).toBeInTheDocument()
    expect(screen.queryByText(en['form.loadFailTitle'])).toBeNull()
    expect(screen.queryByText(/Couldn't load responses/)).toBeNull()
    expect(screen.queryByText(/No responses yet/)).toBeNull()
    expect(screen.queryByText('Volunteer')).toBeNull()
  })

  it('a real empty inbox is not a load failure', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/responses')) return ok({ responses: [], total: 0 })
      if (u.includes('/api/forms/')) return ok(FORM)
      return ok({})
    }))
    render(
      <MemoryRouter initialEntries={['/forms/42/responses']}>
        <Routes>
          <Route path="/forms/:id/responses" element={
            <LocaleProvider>
              <ToastProvider>
                <ConfirmProvider>
                  <FormResponses />
                </ConfirmProvider>
              </ToastProvider>
            </LocaleProvider>
          } />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/No responses yet/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Volunteer' })).toBeInTheDocument()
    expect(screen.queryByText(es['form.loadFailTitle'])).toBeNull()
  })

  it('a client-side export failure uses the Spanish form sentence', async () => {
    spanish()
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('disk') })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/responses')) return ok(ONE_RESPONSE)
      if (u.includes('/api/forms/')) return ok(FORM)
      return ok({})
    }))
    render(
      <MemoryRouter initialEntries={['/forms/42/responses']}>
        <Routes>
          <Route path="/forms/:id/responses" element={
            <LocaleProvider>
              <ToastProvider>
                <ConfirmProvider>
                  <FormResponses />
                </ConfirmProvider>
              </ToastProvider>
            </LocaleProvider>
          } />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: /export csv/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }))
    expect(await screen.findByText(es['form.submitFail'])).toBeInTheDocument()
    expect(screen.queryByText(en['form.submitFail'])).toBeNull()
    expect(screen.queryByText(/Couldn't export responses/)).toBeNull()
  })

  it('a refused billing status is the Spanish load failure, not the plan', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async () => refused()))
    mount(<Billing />)
    expect(await screen.findByRole('heading', { name: es['load.failedTitle'] })).toBeInTheDocument()
    expect(screen.getByText(es['load.failedBody'])).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).toBeNull()
    expect(screen.queryByText(en['load.failedBody'])).toBeNull()
    expect(screen.queryByText(/Couldn't load billing/)).toBeNull()
    expect(screen.queryByText(/Billing & plan/)).toBeNull()
  })

  it('a loaded plan is not a load failure', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async () => ok(PLAN)))
    mount(<Billing />)
    expect(await screen.findByRole('heading', { name: /Billing & plan/ })).toBeInTheDocument()
    expect(screen.queryByText(es['load.failedTitle'])).toBeNull()
    expect(screen.queryByText(es['load.failedBody'])).toBeNull()
  })
})
