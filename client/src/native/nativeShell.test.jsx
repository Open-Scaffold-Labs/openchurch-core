import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import InstallPrompt from '../components/InstallPrompt'
import PushSubscriptionToggle from '../components/PushSubscriptionToggle'
import { ToastProvider } from '../components/ToastProvider'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't',
    loading: false,
    canWrite: true,
    isAdmin: true,
  }),
}))

const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

function stubMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  })
}

describe('the native shell does not repeat the home-screen install instructions', () => {
  beforeEach(() => {
    localStorage.clear()
    stubMatchMedia()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete window.Capacitor
  })

  it('stays quiet when the bridge says this is the app', async () => {
    window.Capacitor = { isNativePlatform: () => true }
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: IOS_SAFARI })
    render(<LocaleProvider><InstallPrompt /></LocaleProvider>)
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['install.iosAdd'])).not.toBeInTheDocument()
  })

  it('hides the web-push home-screen card and does not read the server key', async () => {
    window.Capacitor = { isNativePlatform: () => true }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(
      <LocaleProvider>
        <ToastProvider>
          <PushSubscriptionToggle />
        </ToastProvider>
      </LocaleProvider>,
    )
    expect(screen.queryByText(/home screen/i)).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('bundled shell sign-in gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function renderGate(href) {
    vi.resetModules()
    const { LocaleProvider: FreshLocale } = await import('../i18n/index.jsx')
    const { default: NativeShellGate } = await import('./NativeShellGate.jsx')
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href },
    })
    return render(<FreshLocale><NativeShellGate /></FreshLocale>)
  }

  it('covers the page when the build is the bundled shell', async () => {
    vi.stubEnv('VITE_CAPACITOR', '1')
    vi.stubEnv('VITE_API_URL', '')
    await renderGate('capacitor://localhost/')
    expect(screen.getByRole('status')).toHaveTextContent(STRINGS.en['ios.shell.signInBody'])
  })

  it('stays off the hosted page', async () => {
    vi.stubEnv('VITE_CAPACITOR', '')
    const { container } = await renderGate('https://parish.example/schedule')
    expect(container).toBeEmptyDOMElement()
  })
})
