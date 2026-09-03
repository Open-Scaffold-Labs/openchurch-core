// The public giving path, end to end. (Pass 10 §3–§4)
//
// Pass 9 kept the Give button visible on the church page when the funds state
// was unknown, reasoning that the giving page is the authority. This page was
// not being honest either — so that reasoning moved the lie one screen along.
//
// The control is what makes it damning: before this pass a 500 and a parish
// that genuinely has no giving produced BYTE-IDENTICAL output, and the copy
// told the visitor to "check back soon" — right for one of those, useless for
// the other.
//
// The server is already exemplary and these tests pin that it stays so: with
// no provider configured it answers 503 "Nothing was charged" and writes no
// donation row. PROVIDER STUB is not MONEY MOVED.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import PublicGive from './PublicGive'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const CHURCH = { name: 'St Test', slug: 'st-test', locale: 'en' }
const OPEN   = { church: CHURCH, funds: [{ id: 1, name: 'General Fund' }], giving_enabled: true }
const OFF    = { church: CHURCH, funds: [], giving_enabled: false }

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s, b = { error: 'boom' }) => ({ ok: false, status: s, json: async () => b })
const bad = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })

let calls
const routes = (over = {}) => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
    if (u.includes('/funds')) return ok(OPEN)
    return ok({})
  }))
}

const mount = () => render(
  <MemoryRouter initialEntries={['/p/st-test/give']}>
    <LocaleProvider>
      <Routes><Route path="/p/:slug/give" element={<PublicGive />} /></Routes>
    </LocaleProvider>
  </MemoryRouter>
)

const NOT_SET_UP  = /isn'?t set up for this church yet/i
const COULD_NOT   = /couldn'?t check this church'?s giving/i
const THANK_YOU   = /thank you/i

// Handles read off the real markup, not guessed. The first version looked
// for a "your name" placeholder; the field's placeholder is a person's name
// ("Consuelo Ibáñez"), and the amount's is "Other amount". Guessing at the
// DOM is how a test ends up asserting against a page that does not exist.
const nameField   = () => screen.getByPlaceholderText(/Consuelo/i)
const amountField = () => screen.getByPlaceholderText(/other amount/i)
const submitBtn   = () => screen.getByRole('button', { name: /give \$|processing/i })

const fillAndSubmit = async () => {
  // Wait for the amount field too — not only the name. A brief race used to
  // leave the page on the spinner between findBy(name) and this helper when
  // setPublicLocale's identity churn re-triggered the load effect; waiting
  // here keeps the assertion honest even if that regresses.
  await screen.findByPlaceholderText(/other amount/i)
  fireEvent.change(nameField(),   { target: { value: 'Test Donor' } })
  fireEvent.change(amountField(), { target: { value: '25' } })
  await act(async () => { fireEvent.click(submitBtn()) })
}

beforeEach(() => vi.unstubAllGlobals())

describe('CONTROL — the two states that must never look alike', () => {
  it('A. giving configured: the form is offered', async () => {
    routes(); mount()
    await waitFor(() => expect(screen.queryByText(NOT_SET_UP)).not.toBeInTheDocument())
    expect(screen.queryByText(COULD_NOT)).not.toBeInTheDocument()
    expect(await screen.findByPlaceholderText(/other amount/i)).toBeInTheDocument()
  })

  it('B. giving genuinely not configured: says so, calmly, with no retry', async () => {
    routes({ '/funds': () => ok(OFF) }); mount()
    expect(await screen.findByText(NOT_SET_UP)).toBeInTheDocument()
    expect(screen.queryByText(COULD_NOT)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })
})

describe('FAILED is not UNCONFIGURED', () => {
  for (const [label, handler] of [
    ['C. a 500',            () => err(500)],
    ['C. a 503',            () => err(503)],
    ['D. a malformed body', bad],
    ['C. a dropped connection', () => { throw new TypeError('Failed to fetch') }],
  ]) {
    it(`${label} must not claim the parish cannot receive gifts`, async () => {
      routes({ '/funds': handler }); mount()
      expect(await screen.findByText(COULD_NOT)).toBeInTheDocument()
      expect(screen.queryByText(NOT_SET_UP)).not.toBeInTheDocument()
      // A visitor who cannot give online should still be told how to give.
      expect(screen.getByText(/parish office can still take your gift/i)).toBeInTheDocument()
    })
  }

  it('a 404 is a real absence and keeps its own answer', async () => {
    routes({ '/funds': () => err(404) }); mount()
    expect(await screen.findByText(/church not found/i)).toBeInTheDocument()
    expect(screen.queryByText(COULD_NOT)).not.toBeInTheDocument()
  })

  it('§11 the chain: page fails, visitor retries, page recovers without a reload', async () => {
    let first = true
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (!String(url).includes('/funds')) return ok({})
      if (first) { first = false; return err(500) }
      return ok(OPEN)
    }))
    mount()
    expect(await screen.findByText(COULD_NOT)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again/i })) })
    await waitFor(() => expect(screen.queryByText(COULD_NOT)).not.toBeInTheDocument())
    expect(screen.queryByText(NOT_SET_UP)).not.toBeInTheDocument()
  })
})

describe('a gift is not received until the server says it was', () => {
  it('E. the provider being unavailable is reported, and no thank-you is shown', async () => {
    // The real 503 the server sends when no provider is configured.
    routes({ '/give': () => err(503, { error: 'Online giving is not set up for this church yet. Nothing was charged.' }) })
    mount()
    await screen.findByPlaceholderText(/Consuelo/i)
    await fillAndSubmit()
    await waitFor(() => expect(screen.getByText(/Nothing was charged/i)).toBeInTheDocument())
    expect(screen.queryByText(THANK_YOU)).not.toBeInTheDocument()
  })

  it('F. a failed submission never becomes a recorded gift', async () => {
    routes({ '/give': () => err(402, { error: 'Payment could not be processed. No charge was made.' }) })
    mount()
    await screen.findByPlaceholderText(/Consuelo/i)
    await fillAndSubmit()
    await waitFor(() => expect(screen.getByText(/No charge was made/i)).toBeInTheDocument())
    expect(screen.queryByText(THANK_YOU)).not.toBeInTheDocument()
  })

  it('a network failure mid-submit does not thank anyone', async () => {
    routes({ '/give': () => { throw new TypeError('Failed to fetch') } })
    mount()
    await screen.findByPlaceholderText(/Consuelo/i)
    await fillAndSubmit()
    await waitFor(() => expect(screen.queryByText(THANK_YOU)).not.toBeInTheDocument())
  })

  it('G. a real success is thanked, once the server has said so', async () => {
    routes({ '/give': () => ok({ receipt: { amount: 25, fund: 'General Fund', reference: 'ch_test_1' } }) })
    mount()
    await screen.findByPlaceholderText(/Consuelo/i)
    await fillAndSubmit()
    expect(await screen.findByText(THANK_YOU)).toBeInTheDocument()
    expect(screen.getByText(/ch_test_1/)).toBeInTheDocument()
  })
})
