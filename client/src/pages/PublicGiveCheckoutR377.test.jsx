// TARS #377 R377-1/R377-2: the PublicGive caller boundary. Invalid
// checkout responses never navigate or show a receipt; a failed or
// uncertain opener keeps the gift unresolved with no second POST.
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import PublicGive from './PublicGive'
import { giftOpenedOutsideNote, giftPageDidNotOpenNote, giftReopenLabel, giftStartOverLabel } from '../native/planPurchase'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))
const openSystemBrowser = vi.fn(async () => true)
vi.mock('../native/systemBrowser.js', () => ({ openSystemBrowser: (...a) => openSystemBrowser(...a) }))

const VALID = 'https://checkout.example.com/s/abc'
let posts, checkoutValue, assign
function setup(locale) {
  const OPEN = { church: { name: 'St Test', slug: 'st-test', locale }, funds: [{ id: 1, name: 'General Fund' }], giving_enabled: true }
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    if (opts?.method === 'POST') { posts += 1; return { ok: true, status: 200, json: async () => ({ checkout_url: checkoutValue, receipt: { id: 9 } }) } }
    return { ok: true, status: 200, json: async () => OPEN }
  }))
}
beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  posts = 0
  openSystemBrowser.mockReset()
  assign = vi.fn()
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...new URL('https://parish.example.org/p/st-test/give'), href: 'https://parish.example.org/p/st-test/give', origin: 'https://parish.example.org', assign })
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function fillAndGive(locale) {
  render(
    <MemoryRouter initialEntries={['/p/st-test/give']}>
      <LocaleProvider><Routes><Route path="/p/:slug/give" element={<PublicGive />} /></Routes></LocaleProvider>
    </MemoryRouter>,
  )
  const S = STRINGS[locale]
  await screen.findByPlaceholderText(S['give.amountPh'])
  fireEvent.change(screen.getByPlaceholderText(S['give.namePh']), { target: { value: 'Test Donor' } })
  fireEvent.change(screen.getByPlaceholderText(S['give.amountPh']), { target: { value: '25' } })
  const form = screen.getByPlaceholderText(S['give.amountPh']).closest('form')
  await act(async () => { fireEvent.submit(form) })
  return form
}

describe('R377-1: invalid checkout responses never navigate', () => {
  const bad = ['mailto:donor@example.test', 'tel:+15555550100', '/billing', '#checkout', 'not a url', 42, { u: VALID }, 'javascript:void(0)', 'https://u:p@checkout.example.com/']
  for (const value of bad) {
    for (const native of [false, true]) {
      it(`${JSON.stringify(value)} (${native ? 'shell' : 'web'})`, async () => {
        if (native) vi.stubEnv('VITE_CAPACITOR', '1')
        checkoutValue = value; setup('en')
        const form = await fillAndGive('en')
        expect(assign).not.toHaveBeenCalled()
        expect(openSystemBrowser).not.toHaveBeenCalled()
        expect(screen.queryByText(STRINGS.en['give.thanks'])).toBeNull()
        expect(screen.getByRole('alert')).toHaveTextContent(giftPageDidNotOpenNote('en'))
        await act(async () => { fireEvent.submit(form) })
        expect(posts).toBe(1)
      })
    }
  }
  it('valid https on the web navigates to the validated URL', async () => {
    checkoutValue = VALID; setup('en')
    await fillAndGive('en')
    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith(VALID)
  })
})

describe('R377-2: failed or uncertain opener keeps the gift unresolved', () => {
  for (const locale of ['en', 'es']) {
    for (const mode of ['false', 'reject', 'deferred-success']) {
      it(`${mode} (${locale})`, async () => {
        vi.stubEnv('VITE_CAPACITOR', '1')
        checkoutValue = VALID; setup(locale)
        let resolveOpen
        if (mode === 'false') openSystemBrowser.mockResolvedValueOnce(false)
        if (mode === 'reject') openSystemBrowser.mockRejectedValueOnce(new Error('x'))
        if (mode === 'deferred-success') openSystemBrowser.mockImplementationOnce(() => new Promise((r) => { resolveOpen = r }))
        const form = await fillAndGive(locale)
        expect(posts).toBe(1)
        expect(openSystemBrowser).toHaveBeenCalledTimes(1)
        // While pending or after failure, a resubmit sends no new POST.
        await act(async () => { fireEvent.submit(form) })
        expect(posts).toBe(1)
        if (mode === 'deferred-success') {
          await act(async () => { resolveOpen(true) })
          expect(screen.getByText(giftOpenedOutsideNote(locale))).toBeInTheDocument()
        } else {
          expect(screen.getByRole('alert')).toHaveTextContent(giftPageDidNotOpenNote(locale))
        }
        expect(screen.queryByText(STRINGS[locale]['give.thanks'])).toBeNull()
        // Retry reopens the same checkout, never a new POST.
        openSystemBrowser.mockResolvedValueOnce(true)
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: giftReopenLabel(locale) })) })
        expect(openSystemBrowser).toHaveBeenCalledTimes(2)
        expect(openSystemBrowser).toHaveBeenLastCalledWith(VALID)
        expect(posts).toBe(1)
        expect(screen.getByText(giftOpenedOutsideNote(locale))).toBeInTheDocument()
        await act(async () => { fireEvent.submit(form) })
        expect(posts).toBe(1)
        // Only an explicit new gift starts another attempt.
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: giftStartOverLabel(locale) })) })
        await act(async () => { fireEvent.submit(form) })
        expect(posts).toBe(2)
      })
    }
  }
})

// TARS #377 R377-1 remaining: a null/empty checkout field, or a response
// with no checkout and no usable receipt, must stay unconfirmed.
describe('R377-1: absent checkout or missing receipt is never "gift received"', () => {
  const RECEIPT = { amount: 25, fund: 'General Fund', reference: 'ch_test_1', recurring: null }
  const cases = [
    ['null checkout', { checkout_url: null }],
    ['empty checkout', { checkout_url: '' }],
    ['null checkout with receipt', { checkout_url: null, receipt: RECEIPT }],
    ['missing checkout, no receipt', { ok: true }],
    ['missing checkout, receipt without reference', { ok: true, receipt: { amount: 25 } }],
  ]
  function setupBody(locale, body, status = 200) {
    const OPEN = { church: { name: 'St Test', slug: 'st-test', locale }, funds: [{ id: 1, name: 'General Fund' }], giving_enabled: true }
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (opts?.method === 'POST') { posts += 1; return { ok: true, status, json: async () => body } }
      return { ok: true, status: 200, json: async () => OPEN }
    }))
  }
  for (const locale of ['en', 'es']) {
    const S = STRINGS[locale]
    for (const [label, body] of cases) {
      for (const native of [false, true]) {
        it(`${label} (${locale}, ${native ? 'shell' : 'web'})`, async () => {
          if (native) vi.stubEnv('VITE_CAPACITOR', '1')
          setupBody(locale, body)
          const form = await fillAndGive(locale)
          expect(assign).not.toHaveBeenCalled()
          expect(openSystemBrowser).not.toHaveBeenCalled()
          expect(screen.queryByText(S['give.thanks'])).toBeNull()
          expect(screen.queryByText(S['give.receivedBefore'], { exact: false })).toBeNull()
          expect(screen.getByRole('alert')).toHaveTextContent(giftPageDidNotOpenNote(locale))
          expect(screen.getByRole('button', { name: giftStartOverLabel(locale) })).toBeInTheDocument()
          await act(async () => { fireEvent.submit(form) })
          expect(posts).toBe(1)
        })
      }
    }
    it(`genuine 201 receipt still shows thanks (${locale})`, async () => {
      setupBody(locale, { ok: true, receipt: RECEIPT }, 201)
      await fillAndGive(locale)
      expect(screen.getByText(S['give.thanks'])).toBeInTheDocument()
      expect(screen.getByText('ch_test_1')).toBeInTheDocument()
      expect(assign).not.toHaveBeenCalled()
      expect(posts).toBe(1)
    })
  }
})

// TARS #377 at 5f8bc1b4: the receipt amount must be a real finite
// positive number (server sends numeric `dollars`), never coerced.
describe('R377-1: malformed receipt amount stays unconfirmed', () => {
  const amounts = [['true', true], ['false', false], ['[25]', [25]], ['"25"', '25'], ['{}', {}], ['NaN', NaN], ['Infinity', Infinity], ['0', 0], ['-25', -25]]
  for (const locale of ['en', 'es']) {
    const S = STRINGS[locale]
    for (const [label, amount] of amounts) {
      it(`amount ${label} (${locale})`, async () => {
        const OPEN = { church: { name: 'St Test', slug: 'st-test', locale }, funds: [{ id: 1, name: 'General Fund' }], giving_enabled: true }
        vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
          if (opts?.method === 'POST') { posts += 1; return { ok: true, status: 201, json: async () => ({ ok: true, receipt: { amount, fund: 'General Fund', reference: 'synthetic' } }) } }
          return { ok: true, status: 200, json: async () => OPEN }
        }))
        const form = await fillAndGive(locale)
        expect(assign).not.toHaveBeenCalled()
        expect(openSystemBrowser).not.toHaveBeenCalled()
        expect(screen.queryByText(S['give.thanks'])).toBeNull()
        expect(screen.queryByText(S['give.receivedBefore'], { exact: false })).toBeNull()
        expect(screen.getByRole('alert')).toHaveTextContent(giftPageDidNotOpenNote(locale))
        await act(async () => { fireEvent.submit(form) })
        expect(posts).toBe(1)
      })
    }
  }
})
