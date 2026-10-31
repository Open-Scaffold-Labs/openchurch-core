// TARS #372 finding 2: after the iOS shell opens an external checkout,
// the same gift must not be submittable again until the user
// deliberately starts a new gift.
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import PublicGive from './PublicGive'
import { giftOpenedOutsideNote, giftStartOverLabel } from '../native/planPurchase'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))
const openSystemBrowser = vi.fn(async () => true)
vi.mock('../native/systemBrowser.js', () => ({ openSystemBrowser: (...a) => openSystemBrowser(...a) }))

const OPEN = { church: { name: 'St Test', slug: 'st-test', locale: 'en' }, funds: [{ id: 1, name: 'General Fund' }], giving_enabled: true }
const ok = (b) => ({ ok: true, status: 200, json: async () => b })

let posts
beforeEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.stubEnv('VITE_CAPACITOR', '1')
  posts = 0
  openSystemBrowser.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    if (opts?.method === 'POST') { posts += 1; return ok({ checkout_url: 'https://checkout.example.com/s/abc' }) }
    return ok(OPEN)
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('external checkout in the iOS shell', () => {
  it('keeps the gift unresolved and blocks resubmission until the user starts over', async () => {
    render(
      <MemoryRouter initialEntries={['/p/st-test/give']}>
        <LocaleProvider>
          <Routes><Route path="/p/:slug/give" element={<PublicGive />} /></Routes>
        </LocaleProvider>
      </MemoryRouter>,
    )
    await screen.findByPlaceholderText(STRINGS.en['give.amountPh'])
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['give.namePh']), { target: { value: 'Test Donor' } })
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['give.amountPh']), { target: { value: '25' } })
    const submit = screen.getByRole('button', { name: /give \$/i })
    await act(async () => { fireEvent.click(submit) })

    expect(openSystemBrowser).toHaveBeenCalledTimes(1)
    expect(posts).toBe(1)
    expect(screen.getByText(giftOpenedOutsideNote('en'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /give \$/i })).toBeDisabled()
    await act(async () => { fireEvent.submit(submit.closest('form')) })
    expect(posts).toBe(1)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: giftStartOverLabel('en') })) })
    expect(screen.queryByText(giftOpenedOutsideNote('en'))).toBeNull()
    expect(screen.getByRole('button', { name: /give \$/i })).toBeEnabled()
  })
})
