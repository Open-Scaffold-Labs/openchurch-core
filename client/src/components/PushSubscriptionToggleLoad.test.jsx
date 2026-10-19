// A refused vapid-key read used to be stored as an empty public key, so
// the card said server-side push isn't configured. That sentence is only
// true when the server actually answered with a null or empty key.
// A body with no publicKey of its own is unread. A failed read of this
// device's subscription is unknown, not off, and a later failure keeps
// a subscription that was already read.

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from './ToastProvider'
import PushSubscriptionToggle from './PushSubscriptionToggle'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, organization: { id: 1, locale: 'en', name: 'St Test' } },
    token: 't',
    loading: false,
  }),
}))

const UNSET = /isn't configured/
const KEY = 'BEl0123456789abcdef'

function installPushBrowser(pushManager) {
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: vi.fn(async () => 'granted'),
  })
  vi.stubGlobal('PushManager', function PushManager() {})
  const manager = pushManager ?? {
    getSubscription: vi.fn(async () => null),
    subscribe: vi.fn(),
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: manager }) },
  })
  return manager
}

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function mount(props = {}) {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <PushSubscriptionToggle {...props} />
      </ToastProvider>
    </LocaleProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  installPushBrowser()
})

afterEach(() => {
  delete navigator.serviceWorker
})

describe('the vapid key probe', () => {
  it('a refused key is a failed read, not "isn\'t configured"', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ publicKey: null }, 503))
    vi.stubGlobal('fetch', fetchMock)
    mount()
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(STRINGS.en['load.failedTitle'])
    expect(status).toHaveTextContent(STRINGS.en['load.failedBody'])
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/push/vapid-key')
  })

  it.each([
    ['null', { publicKey: null }],
    ['empty string', { publicKey: '' }],
    ['blank', { publicKey: '   ' }],
  ])('an ok response with a %s key is the unset copy, not a failed read', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(body)))
    mount()
    expect(await screen.findByText(UNSET)).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeDisabled()
  })

  it('an ok response with a key reaches the toggle, not the failure or unset copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ publicKey: KEY })))
    mount()
    const toggle = await screen.findByRole('switch')
    expect(toggle).toBeEnabled()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['load.failedBody'])).not.toBeInTheDocument()
  })

  it('a thrown probe is a failed read, not "isn\'t configured"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    mount()
    expect(await screen.findByText(STRINGS.en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['load.failedBody'])).toBeInTheDocument()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('an ok response whose body will not parse is a failed read, not "isn\'t configured"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token') },
    })))
    mount()
    expect(await screen.findByText(STRINGS.en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it.each([
    ['an empty object', {}],
    ['no publicKey of its own', { configured: true }],
  ])('an ok body that is %s is a failed read, not "isn\'t configured"', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(body)))
    mount()
    expect(await screen.findByText(STRINGS.en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['load.failedBody'])).toBeInTheDocument()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('an ok body that is not a key object is a failed read, not "isn\'t configured"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(['nope'])))
    mount()
    expect(await screen.findByText(STRINGS.en['load.failedTitle'])).toBeInTheDocument()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('retry runs the probe again and can reach the toggle', async () => {
    let mode = 'refuse'
    const fetchMock = vi.fn(async () => (
      mode === 'refuse'
        ? jsonRes({ publicKey: null }, 500)
        : jsonRes({ publicKey: KEY })
    ))
    vi.stubGlobal('fetch', fetchMock)
    mount()
    expect(await screen.findByText(STRINGS.en['load.failedTitle'])).toBeInTheDocument()
    const before = fetchMock.mock.calls.length
    mode = 'key'
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['load.retry'] }))
    expect(await screen.findByRole('switch')).toBeEnabled()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['load.failedTitle'])).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before)
  })

  it('a rejected device subscription lookup is not an off toggle', async () => {
    const getSubscription = vi.fn(async () => { throw new Error('lookup failed') })
    installPushBrowser({ getSubscription, subscribe: vi.fn() })
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ publicKey: KEY })))
    mount()
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(STRINGS.en['push.deviceUnknownTitle'])
    expect(status).toHaveTextContent(STRINGS.en['push.deviceUnknownBody'])
    expect(screen.queryByText(STRINGS.en['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['load.retry'] }))
    await waitFor(() => expect(getSubscription.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(await screen.findByRole('status')).toHaveTextContent(STRINGS.en['push.deviceUnknownTitle'])
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
  })

  it('Spanish names an unread device, not an off toggle', async () => {
    localStorage.setItem('ochr_locale', 'es')
    installPushBrowser({
      getSubscription: vi.fn(async () => { throw new Error('lookup failed') }),
      subscribe: vi.fn(),
    })
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ publicKey: KEY })))
    mount()
    expect(await screen.findByText(STRINGS.es['push.deviceUnknownTitle'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['push.deviceUnknownBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.es['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('a later rejected device lookup keeps a subscription already known', async () => {
    let rejectLater = () => {}
    const getSubscription = vi.fn(() => {
      if (getSubscription.mock.calls.length === 1) {
        return Promise.resolve({ endpoint: 'https://push.example/device' })
      }
      return new Promise((_, reject) => {
        rejectLater = () => reject(new Error('lookup failed'))
      })
    })
    installPushBrowser({ getSubscription, subscribe: vi.fn() })
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ publicKey: KEY })))
    const view = mount({ probeNonce: 0 })
    expect(await screen.findByRole('switch')).toHaveAttribute('aria-checked', 'true')

    view.rerender(
      <LocaleProvider>
        <ToastProvider>
          <PushSubscriptionToggle probeNonce={1} />
        </ToastProvider>
      </LocaleProvider>,
    )
    await waitFor(() => expect(getSubscription).toHaveBeenCalledTimes(2))
    await act(async () => { rejectLater() })

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch')).toBeEnabled()
    expect(screen.queryByText(STRINGS.en['push.deviceUnknownTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
  })

  it('a later rejected device lookup keeps a device already read as off', async () => {
    let rejectLater = () => {}
    const getSubscription = vi.fn(() => {
      if (getSubscription.mock.calls.length === 1) return Promise.resolve(null)
      return new Promise((_, reject) => {
        rejectLater = () => reject(new Error('lookup failed'))
      })
    })
    installPushBrowser({ getSubscription, subscribe: vi.fn() })
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ publicKey: KEY })))
    const view = mount({ probeNonce: 0 })
    const first = await screen.findByRole('switch')
    expect(first).toHaveAttribute('aria-checked', 'false')
    expect(first).toBeEnabled()

    view.rerender(
      <LocaleProvider>
        <ToastProvider>
          <PushSubscriptionToggle probeNonce={1} />
        </ToastProvider>
      </LocaleProvider>,
    )
    await waitFor(() => expect(getSubscription).toHaveBeenCalledTimes(2))
    await act(async () => { rejectLater() })

    const again = screen.getByRole('switch')
    expect(again).toHaveAttribute('aria-checked', 'false')
    expect(again).toBeEnabled()
    expect(screen.queryByText(STRINGS.en['push.deviceUnknownTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
  })

  it('Spanish names the failed read', async () => {
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ publicKey: KEY }, 401)))
    mount()
    expect(await screen.findByText(STRINGS.es['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['load.failedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['load.retry'] })).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(UNSET)).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})
