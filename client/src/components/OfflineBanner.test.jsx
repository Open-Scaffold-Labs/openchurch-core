// The banner and the service worker must say the same *offline* fact.
//
// sw.js serves a cached /api/* answer only while it believes the browser is
// offline. Its own navigator.onLine is one signal; this banner's is the
// other, sent as ONLINE_STATE whenever it changes. Without that message a
// SLOW connection let the worker's 3-second timeout hand the page
// yesterday's number as today's — online, no banner, and the real answer,
// arriving later, went only to the cache. (Mini boss fight, the wrong-truth
// problem: a false $0.00 on the Finance ledger from the transport layer.)
//
// Offline ≠ "showing cached data". onlyWhenOffline can miss; the page then
// shows FAILED. The bar must stay offline-honest. Reintroducing the
// unconditional cached-data claim (in chrome or in the i18n strings) goes
// red. (OC-READY-01-024)

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import OfflineBanner from './OfflineBanner'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const CACHED_DATA_CLAIM = /cached data|from your last visit|datos en cach|de su [uú]ltima visita/i

function view() {
  return render(
    <LocaleProvider>
      <OfflineBanner />
    </LocaleProvider>,
  )
}

let posted
beforeEach(() => {
  posted = []
  localStorage.removeItem('ochr_locale')
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: { postMessage: m => posted.push(m) } } })
})
afterEach(() => { delete navigator.serviceWorker })

describe('OfflineBanner tells the service worker what it is about to say', () => {
  it('reports the initial state on mount, then every change', async () => {
    view()
    expect(posted).toEqual([{ type: 'ONLINE_STATE', online: true }])

    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await act(async () => { window.dispatchEvent(new Event('offline')) })
    expect(screen.getByText(/you're offline/i)).toBeInTheDocument()
    expect(posted.at(-1)).toEqual({ type: 'ONLINE_STATE', online: false })

    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(posted.at(-1)).toEqual({ type: 'ONLINE_STATE', online: true })
  })

  it('is harmless with no worker controlling the page', () => {
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined })
    expect(() => view()).not.toThrow()
  })

  it('the visible bar carries the top safe-area utility (OC-READY-01-016)', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    view()
    const bar = screen.getByRole('status')
    expect(bar.className.split(/\s+/)).toContain('safe-pt')
    expect(bar.className.split(/\s+/)).toContain('top-0')
  })
})

describe('OfflineBanner chrome is offline-honest (OC-READY-01-024)', () => {
  function goOffline() {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
  }

  it('THE BAR NAMES OFFLINE AND DOES NOT CLAIM CACHED DATA', () => {
    goOffline()
    view()
    const bar = screen.getByRole('status')
    expect(bar.textContent).toMatch(/you're offline/i)
    expect(bar.textContent).not.toMatch(CACHED_DATA_CLAIM)
    expect(posted.at(-1)).toEqual({ type: 'ONLINE_STATE', online: false })
  })

  it('SPANISH CHROME STAYS OFFLINE-HONEST — NO CACHED-DATA CLAIM', () => {
    localStorage.setItem('ochr_locale', 'es')
    goOffline()
    view()
    const bar = screen.getByRole('status')
    expect(bar.textContent).toMatch(/sin conexi[oó]n/i)
    expect(bar.textContent).not.toMatch(CACHED_DATA_CLAIM)
    expect(posted.at(-1)).toEqual({ type: 'ONLINE_STATE', online: false })
  })

  it('i18n strings and the component wiring cannot reintroduce the claim', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'OfflineBanner.jsx'), 'utf8')
    expect(src).toMatch(/t\('offline\.banner'\)/)
    expect(src).not.toMatch(/showing cached data from your last visit/)
    expect(STRINGS.en['offline.banner']).toMatch(/you're offline/i)
    expect(STRINGS.en['offline.banner']).not.toMatch(CACHED_DATA_CLAIM)
    expect(STRINGS.es['offline.banner']).toMatch(/sin conexi[oó]n/i)
    expect(STRINGS.es['offline.banner']).not.toMatch(CACHED_DATA_CLAIM)
  })
})
