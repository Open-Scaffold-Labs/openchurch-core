// PublicGive user-visible chrome goes through strings.js + t() en+es.
// Hard-coded English not-found / thank-you / amount / frequency / fund /
// placeholder / aria copy is the remaining PublicGive defect after
// auth+Welcome localization. Restoring those literals in the component
// goes red. Frequency *values*, POST body, checkout redirect, and
// stub/not-configured honesty stay the giving contract.
// (OC-READY-01-034)

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import PublicGive from './PublicGive'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const GIVE_SRC = readFileSync(join(HERE, 'PublicGive.jsx'), 'utf8')

const CHURCH = { name: 'St Test', slug: 'st-test', locale: 'en' }
const OPEN = { church: CHURCH, funds: [{ id: 1, name: 'General Fund' }], giving_enabled: true }
const OFF = { church: CHURCH, funds: [], giving_enabled: false }

const ok = (b) => ({ ok: true, status: 200, json: async () => b })
const err = (s, b = { error: 'boom' }) => ({ ok: false, status: s, json: async () => b })

const HARD_EN = [
  "We couldn't check this church's giving just now",
  "That's a problem on our side",
  'parish office can still take your gift',
  'Church not found',
  "We couldn't find a church at",
  'Thank you!',
  'Your gift of',
  'was received',
  'It will repeat',
  'Back to home',
  "Online giving isn't set up",
  'Suggested amounts',
  'Other amount',
  'Choose a suggested amount',
  'One-time',
  'Choose a fund',
  'Your name',
  'you@example.com',
  "we'll send your receipt",
  'In memory of',
  'Processing…',
  'Powered by OpenChurch',
  'Something went wrong',
]

const GIVE_KEYS = [
  'give.loadFailTitle',
  'give.loadFailBody',
  'give.tryAgain',
  'give.loadFailOffice',
  'give.notFound',
  'give.notFoundBefore',
  'give.notFoundAfter',
  'give.title',
  'give.titleTo',
  'give.thanks',
  'give.receivedBefore',
  'give.receivedTo',
  'give.receivedAfter',
  'give.repeatsBefore',
  'give.repeatsAfter',
  'give.reference',
  'give.back',
  'give.backHome',
  'give.notSetUp',
  'give.amount',
  'give.suggested',
  'give.amountPh',
  'give.amountHelp',
  'give.frequency',
  'give.freqOnce',
  'give.freqMonthly',
  'give.freqWeekly',
  'give.fund',
  'give.chooseFund',
  'give.name',
  'give.required',
  'give.namePh',
  'give.email',
  'give.emailPh',
  'give.emailHelp',
  'give.note',
  'give.optional',
  'give.notePh',
  'give.submit',
  'give.submitAmount',
  'give.processing',
  'give.powered',
  'give.submitFail',
]

const SAME_IN_BOTH = new Set([
  'give.notFoundAfter',
  'give.repeatsAfter',
  'give.namePh',
])

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

let calls
const routes = (over = {}, church = CHURCH) => {
  calls = []
  const open = { church, funds: [{ id: 1, name: 'General Fund' }], giving_enabled: true }
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
    if (u.includes('/funds')) return ok(open)
    return ok({})
  }))
}

const mount = () => render(
  <MemoryRouter initialEntries={['/p/st-test/give']}>
    <LocaleProvider>
      <Routes><Route path="/p/:slug/give" element={<PublicGive />} /></Routes>
    </LocaleProvider>
  </MemoryRouter>,
)

const fillAndSubmit = async (amountPh, namePh, submitRe) => {
  await screen.findByPlaceholderText(amountPh)
  fireEvent.change(screen.getByPlaceholderText(namePh), { target: { value: 'Test Donor' } })
  fireEvent.change(screen.getByPlaceholderText(amountPh), { target: { value: '25' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: submitRe })) })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

describe('PublicGive chrome is translated (OC-READY-01-034)', () => {
  it('ENGLISH NOT-FOUND, FORM, AND THANK-YOU USE t() COPY', async () => {
    routes()
    mount()
    expect(await screen.findByRole('heading', {
      name: STRINGS.en['give.titleTo'].replace('{name}', 'St Test'),
    })).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['give.amount'])).toHaveAttribute(
      'placeholder',
      STRINGS.en['give.amountPh'],
    )
    expect(screen.getByLabelText(STRINGS.en['give.suggested'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['give.frequency'])).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: STRINGS.en['give.freqOnce'] })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: STRINGS.en['give.freqMonthly'] })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: STRINGS.en['give.freqWeekly'] })).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['give.fund'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['give.chooseFund'])).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.en['give.namePh'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['give.email'])).toHaveAttribute(
      'placeholder',
      STRINGS.en['give.emailPh'],
    )
    expect(screen.getByText(STRINGS.en['give.emailHelp'])).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.en['give.notePh'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['give.powered'])).toBeInTheDocument()
  })

  it('SPANISH FORM CHROME IS SPANISH — NOT THE ENGLISH LABELS', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes()
    mount()
    expect(await screen.findByRole('heading', {
      name: STRINGS.es['give.titleTo'].replace('{name}', 'St Test'),
    })).toBeInTheDocument()
    expect(screen.queryByRole('heading', {
      name: STRINGS.en['give.titleTo'].replace('{name}', 'St Test'),
    })).toBeNull()
    expect(screen.getByLabelText(STRINGS.es['give.amount'])).toHaveAttribute(
      'placeholder',
      STRINGS.es['give.amountPh'],
    )
    expect(screen.queryByLabelText(STRINGS.en['give.amount'])).toBeNull()
    expect(screen.getByText(STRINGS.es['give.frequency'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['give.frequency'])).toBeNull()
    expect(screen.getByRole('radio', { name: STRINGS.es['give.freqOnce'] })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: STRINGS.en['give.freqOnce'] })).toBeNull()
    expect(screen.getByLabelText(STRINGS.es['give.fund'])).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.es['give.emailPh'])).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(STRINGS.en['give.emailPh'])).toBeNull()
    expect(screen.getByPlaceholderText(STRINGS.es['give.notePh'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['give.powered'])).toBeNull()
    expect(screen.getByText(STRINGS.es['give.powered'])).toBeInTheDocument()
  })

  it('publicLocale from the funds payload is Spanish chrome', async () => {
    routes({}, { ...CHURCH, locale: 'es' })
    mount()
    expect(await screen.findByRole('heading', {
      name: STRINGS.es['give.titleTo'].replace('{name}', 'St Test'),
    })).toBeInTheDocument()
    expect(screen.queryByRole('heading', {
      name: STRINGS.en['give.titleTo'].replace('{name}', 'St Test'),
    })).toBeNull()
    expect(screen.getByLabelText(STRINGS.es['give.amount'])).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(STRINGS.en['give.amountPh'])).toBeNull()
    expect(screen.getByPlaceholderText(STRINGS.es['give.amountPh'])).toBeInTheDocument()
  })

  it('not-found and load-fail chrome follow the device locale', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/funds': () => err(404) })
    const { unmount } = mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['give.notFound'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['give.notFound'] })).toBeNull()
    expect(screen.getByText((_, node) => (
      node.tagName === 'P'
      && (node.textContent || '').includes('/p/st-test')
      && (node.textContent || '').includes(STRINGS.es['give.notFoundBefore'].trim())
    ))).toBeInTheDocument()
    unmount()

    routes({ '/funds': () => err(500) })
    mount()
    expect(await screen.findByRole('heading', { name: STRINGS.es['give.loadFailTitle'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['give.loadFailTitle'])).toBeNull()
    expect(screen.getByText(STRINGS.es['give.loadFailBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['give.tryAgain'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['give.loadFailOffice'])).toBeInTheDocument()
  })

  it('not-configured honesty is the same English sentence, and Spanish is an equivalent', async () => {
    expect(STRINGS.en['give.notSetUp']).toBe(
      "Online giving isn't set up for this church yet. Please check back soon.",
    )
    routes({ '/funds': () => ok(OFF) })
    const { unmount } = mount()
    expect(await screen.findByText(STRINGS.en['give.notSetUp'])).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['give.tryAgain'] })).toBeNull()
    unmount()

    localStorage.setItem('ochr_locale', 'es')
    routes({ '/funds': () => ok({ ...OFF, church: { ...CHURCH, locale: 'es' } }) })
    mount()
    expect(await screen.findByText(STRINGS.es['give.notSetUp'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['give.notSetUp'])).toBeNull()
    expect(screen.queryByRole('button', { name: STRINGS.es['give.tryAgain'] })).toBeNull()
  })

  it('thank-you chrome is localized; a monthly receipt shows the locale word', async () => {
    routes({
      '/give': () => ok({
        receipt: { amount: 25, fund: 'General Fund', reference: 'ch_test_1', recurring: 'monthly' },
      }),
    })
    mount()
    await fillAndSubmit(
      STRINGS.en['give.amountPh'],
      STRINGS.en['give.namePh'],
      /give \$|processing/i,
    )
    expect(await screen.findByRole('heading', { name: STRINGS.en['give.thanks'] })).toBeInTheDocument()
    expect(screen.getByText(/ch_test_1/)).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['give.freqMonthly'])).toBeInTheDocument()
    expect(screen.getByRole('link', {
      name: STRINGS.en['give.back'].replace('{name}', 'St Test'),
    })).toHaveAttribute('href', '/p/st-test')
  })

  it('submit still posts the same give body — frequency tokens unchanged', async () => {
    routes({ '/give': () => ok({ receipt: { amount: 25, fund: 'General Fund', reference: 'ch_test_2' } }) })
    mount()
    await screen.findByPlaceholderText(STRINGS.en['give.amountPh'])
    fireEvent.click(screen.getByRole('radio', { name: STRINGS.en['give.freqMonthly'] }))
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['give.namePh']), {
      target: { value: '  Test Donor  ' },
    })
    fireEvent.change(screen.getByLabelText(STRINGS.en['give.email']), {
      target: { value: '  donor@example.com  ' },
    })
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['give.notePh']), {
      target: { value: '  in thanks  ' },
    })
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['give.amountPh']), {
      target: { value: '25' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /give \$|processing/i }))
    })
    await waitFor(() => {
      expect(calls.some(c => c.method === 'POST' && c.url.includes('/give'))).toBe(true)
    })
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/give'))
    expect(post.body).toEqual({
      fund_id: 1,
      amount: 25,
      donor_name: 'Test Donor',
      donor_email: 'donor@example.com',
      message: 'in thanks',
      frequency: 'monthly',
    })
  })

  it('one-time still omits frequency on the POST', async () => {
    routes({ '/give': () => ok({ receipt: { amount: 25, fund: 'General Fund' } }) })
    mount()
    await fillAndSubmit(
      STRINGS.en['give.amountPh'],
      STRINGS.en['give.namePh'],
      /give \$|processing/i,
    )
    await waitFor(() => {
      expect(calls.some(c => c.method === 'POST' && c.url.includes('/give'))).toBe(true)
    })
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/give'))
    expect(post.body).toEqual({
      fund_id: 1,
      amount: 25,
      donor_name: 'Test Donor',
    })
    expect(post.body).not.toHaveProperty('frequency')
  })

  it('server data.error is still shown as returned — not re-translated here', async () => {
    routes({
      '/give': () => err(503, {
        error: 'Online giving is not set up for this church yet. Nothing was charged.',
      }),
    })
    mount()
    await fillAndSubmit(
      STRINGS.en['give.amountPh'],
      STRINGS.en['give.namePh'],
      /give \$|processing/i,
    )
    await waitFor(() => {
      expect(screen.getByText(/Nothing was charged/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('heading', { name: STRINGS.en['give.thanks'] })).toBeNull()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(GIVE_SRC)
    for (const key of GIVE_KEYS) {
      expect(GIVE_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      if (!SAME_IN_BOTH.has(key)) {
        expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
      }
    }
    expect(GIVE_SRC).toMatch(/useLocale\(/)
    expect(GIVE_SRC).toMatch(/setPublicLocale/)
    expect(GIVE_SRC).toMatch(/frequency === 'once' \? undefined : frequency/)
    expect(GIVE_SRC).toMatch(/d\.checkout_url/)
    expect(GIVE_SRC).toMatch(/window\.location\.assign/)
    expect(GIVE_SRC).toMatch(/giving_enabled !== false/)
    expect(GIVE_SRC).toMatch(/fund_id/)
    expect(GIVE_SRC).toMatch(/donor_name/)
    expect(GIVE_SRC).toMatch(/donor_email/)
    expect(GIVE_SRC).not.toMatch(/stripe/i)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['give.thanks']).toBe('Thank you!')
    expect(STRINGS.en['give.freqOnce']).toBe('One-time')
    expect(STRINGS.en['give.freqMonthly']).toBe('Monthly')
    expect(STRINGS.en['give.freqWeekly']).toBe('Weekly')
    expect(STRINGS.es['give.thanks']).toMatch(/gracias/i)
    expect(STRINGS.es['give.amount']).toMatch(/cantidad/i)
    expect(STRINGS.es['give.frequency']).toMatch(/frecuencia/i)
    expect(STRINGS.es['give.notFound']).toMatch(/iglesia/i)
  })
})
