// The self-serve kiosk card on Check-in. A refused or dropped read of
// GET /api/kiosk-admin used to fold into `kiosk_token: null`, which the
// card renders as "Enable kiosk". That button POSTs /rotate, which mints a
// NEW token: on a parish whose kiosk was live, it would silently break the
// link already open on the entrance tablet. Unknown is not off.

import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Checkin from './Checkin'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false, isAdmin: true, canWrite: true,
  }),
}))

const today = new Date().toISOString().slice(0, 10)
const MASS = { id: 18, title: 'Mass TODAY', date: today, start_time: '10:30', end_time: '11:45', type: 'service' }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = (status = 500) => ({ ok: false, status, json: async () => ({ error: 'no' }) })

function stub(kiosk, { locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    calls.push(`${opts.method || 'GET'} ${u}`)
    if (u.includes('/api/kiosk-admin')) return typeof kiosk === 'function' ? kiosk() : kiosk
    if (u.includes('/api/calendar?')) return ok([MASS])
    if (u.includes('/api/rooms')) return ok({ rooms: [] })
    if (u.includes('/api/checkins/recent')) return ok({ services: [] })
    if (u.includes('/api/checkins')) return ok({ checkins: [], present: 0 })
    if (u.includes('/api/clients')) return ok([])
    return ok({})
  }))
  return calls
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/checkin']}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Checkin />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

const ENABLE = /enable kiosk/i

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('kiosk card when the kiosk setting did not load', () => {
  for (const [label, kiosk] of [
    ['a 500', refused(500)],
    ['a 403', refused(403)],
    ['a 200 body without kiosk_token', ok({ error: 'odd' })],
  ]) {
    it(`${label} is not "the kiosk is off" and offers no Enable button`, async () => {
      const en = STRINGS.en
      stub(kiosk)
      mount()
      expect(await screen.findByText(en['load.failedTitle'])).toBeInTheDocument()
      expect(screen.getByText(en['load.failedBody'])).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: ENABLE })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /new link/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /turn off/i })).not.toBeInTheDocument()
    })
  }

  it('a dropped connection is not "the kiosk is off"', async () => {
    stub(() => { throw new TypeError('Failed to fetch') })
    mount()
    expect(await screen.findByText(STRINGS.en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: ENABLE })).not.toBeInTheDocument()
  })

  it('says it in Spanish too', async () => {
    const { en, es } = STRINGS
    stub(refused(500), { locale: 'es' })
    mount()
    expect(await screen.findByText(es['load.failedTitle'])).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: ENABLE })).not.toBeInTheDocument()
  })

  it('retry reads the setting again and shows the live link without re-keying it', async () => {
    let n = 0
    const calls = stub(() => (++n === 1 ? refused(500) : ok({ kiosk_token: 'live-token-abc' })))
    mount()
    await screen.findByText(STRINGS.en['load.failedTitle'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.en['load.retry'] })) })
    expect(await screen.findByDisplayValue(/\/kiosk\/live-token-abc$/)).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['load.failedTitle'])).not.toBeInTheDocument()
    expect(calls.some(c => c.startsWith('POST') && c.includes('/rotate'))).toBe(false)
  })

  it('CONTROL: a kiosk that really is off still offers Enable kiosk', async () => {
    stub(ok({ kiosk_token: null }))
    mount()
    expect(await screen.findByRole('button', { name: ENABLE })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['load.failedTitle'])).not.toBeInTheDocument()
  })

  it('CONTROL: a live kiosk shows its link', async () => {
    stub(ok({ kiosk_token: 'live-token-abc' }))
    mount()
    expect(await screen.findByDisplayValue(/\/kiosk\/live-token-abc$/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: ENABLE })).not.toBeInTheDocument()
  })
})

// R310-1 (TARS on #310 at c0fbec95): a 200 whose kiosk_token is neither the
// documented off sentinel (null) nor a nonblank string is a malformed read.
// It must not offer Enable (mint), nor a live link built from garbage.
describe('R310-1 kiosk card on a malformed kiosk_token', () => {
  for (const [label, value] of [
    ['false', false],
    ['0', 0],
    ['empty text', ''],
    ['whitespace text', '   '],
    ['an object', { token: 'x' }],
    ['an array', ['x']],
  ]) {
    it(`kiosk_token ${label} is a load failure with no enable/rotate/disable/link controls`, async () => {
      const en = STRINGS.en
      const calls = stub(ok({ kiosk_token: value }))
      mount()
      expect(await screen.findByText(en['load.failedTitle'])).toBeInTheDocument()
      expect(screen.getByRole('button', { name: en['load.retry'] })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: ENABLE })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /new link/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /turn off/i })).not.toBeInTheDocument()
      expect(screen.queryByDisplayValue(/\/kiosk\//)).not.toBeInTheDocument()
      expect(screen.queryByTitle('Copy link')).not.toBeInTheDocument()
      expect(calls.some(c => c.startsWith('POST') || c.startsWith('DELETE'))).toBe(false)
    })
  }

  it('retry after a malformed read is read-only and recovers to the live link with zero rotate requests', async () => {
    let n = 0
    const calls = stub(() => (++n === 1 ? ok({ kiosk_token: false }) : ok({ kiosk_token: 'live-token-abc' })))
    mount()
    await screen.findByText(STRINGS.en['load.failedTitle'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.en['load.retry'] })) })
    expect(await screen.findByDisplayValue(/\/kiosk\/live-token-abc$/)).toBeInTheDocument()
    expect(calls.filter(c => c.includes('/rotate'))).toHaveLength(0)
    expect(calls.filter(c => c.startsWith('GET') && c.includes('/api/kiosk-admin'))).toHaveLength(2)
  })
})
