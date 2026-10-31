// App Review 2026-10-26 (Beacon) — rendered contracts for the ES + a11y
// findings fixed in this pass. jsdom + the accessible-name algorithm:
// not VoiceOver, not a phone, not Dynamic Type, not a pixel measurement.
//
// Revert any one fix and the matching test goes red:
//   - Schedule event dialog: close X has no name / heading stays English
//   - Register: every row says just "Open" / "Certificate"
//   - Mobile nav drawer: no dialog role, no Esc, no close button, or the
//     off-screen drawer stays in the Tab order (no inert)
//   - Account menu: focus stays on the trigger, Esc does not close/return
//   - Login: empty submit is silent / wrong password is English in ES
//   - Notification + profile-picture sections stay English in ES
//   - /bulletin editor chrome stays English in ES

import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ThemeProvider } from '../context/ThemeContext'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { Sidebar, Header, SIDEBAR_ID } from '../App'
import Schedule from '../pages/Schedule'
import SacramentalRegister from '../pages/SacramentalRegister'
import Login from '../pages/Login'
import Bulletin from '../pages/Bulletin'
import NotificationPrefs from '../components/NotificationPrefs'
import AvatarUploader from '../components/AvatarUploader'

const { login } = vi.hoisted(() => ({ login: vi.fn() }))
const authState = vi.hoisted(() => ({ signedIn: true }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => (authState.signedIn ? {
    user: {
      id: 1, name: 'Secretary', email: 'sec@example.org', role: 'admin',
      organization: { id: 1, name: 'St Test', slug: 'st-test', locale: 'en', tradition: 'catholic', timezone: 'America/Los_Angeles' },
    },
    token: 't', loading: false, canWrite: true, isAdmin: true, login, logout: vi.fn(),
  } : { user: null, token: null, loading: false, login }),
}))

const es = (k) => STRINGS.es[k]
const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function stubFetch(over = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h(u)
    if (u.includes('/api/bulletins')) return ok({ bulletins: [] })
    if (u.includes('/api/organization')) return ok({ name: 'St Test', slug: 'st-test' })
    if (u.includes('/api/service-plans')) return ok({ plans: [] })
    if (u.includes('/api/affiliation')) return ok({ affiliation: null })
    return ok([])
  }))
}

function stubMatchMedia(mobile) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: mobile && /max-width:\s*767px/.test(query),
      media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(),
    })),
  })
}

const shell = (ui, path = '/') => render(
  <MemoryRouter initialEntries={[path]}>
    <ThemeProvider>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </ThemeProvider>
  </MemoryRouter>,
)

beforeEach(() => {
  authState.signedIn = true
  login.mockReset()
  localStorage.removeItem('ochr_locale')
  stubMatchMedia(false)
})
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

describe('Schedule event dialog', () => {
  const open = () => shell(
    <Routes><Route path="/schedule" element={<Schedule />} /></Routes>,
    '/schedule?new=1',
  )

  it('the close X has an accessible name, in Spanish too', async () => {
    stubFetch()
    open()
    expect(await screen.findByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('Spanish: heading, field labels, and the close X are Spanish', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    open()
    expect(await screen.findByText(es('sched.dlg.new'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es('sched.dlg.close') })).toBeInTheDocument()
    expect(screen.getByText(es('sched.dlg.assigned'))).toBeInTheDocument()
    expect(screen.getByText(es('sched.dlg.repeat'))).toBeInTheDocument()
    expect(screen.getByLabelText(new RegExp(`^${es('sched.dlg.group')}`))).toBeInTheDocument()
    for (const en of ['New Event', 'Assigned Members', 'Repeat', 'No group', 'Search members to assign…']) {
      expect(screen.queryByText(en), en).toBeNull()
    }
    expect(screen.getByPlaceholderText(es('sched.dlg.searchMembers'))).toBeInTheDocument()
  })
})

describe('Sacramental Register row actions', () => {
  const RECORDS = [
    { id: 11, type: 'baptism', member_name: 'Ana Ruiz', date: '2026-01-04' },
    { id: 12, type: 'baptism', member_name: 'Luis Ortega', date: '2026-02-08' },
    { id: 13, type: 'confirmation', member_name: 'Ana Ruiz', date: '2026-05-17' },
  ]
  const mount = () => {
    stubFetch({ '/api/sacraments': () => ok({ records: RECORDS }) })
    return shell(<SacramentalRegister />)
  }

  it('every Open and Certificate link has a unique name that starts with the visible word', async () => {
    mount()
    await screen.findByText('Luis Ortega')
    const opens = screen.getAllByRole('link', { name: /^Open:/ })
    const certs = screen.getAllByRole('link', { name: /^Certificate:/ })
    expect(opens).toHaveLength(3)
    expect(certs).toHaveLength(3)
    const names = [...opens, ...certs].map(a => a.getAttribute('aria-label'))
    expect(new Set(names).size).toBe(6)
    expect(names.some(n => n.includes('Luis Ortega'))).toBe(true)
  })

  it('Spanish names keep the Spanish visible word first', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    await screen.findByText('Luis Ortega')
    const opens = screen.getAllByRole('link', { name: new RegExp(`^${es('register.open')}:`) })
    expect(opens).toHaveLength(3)
    expect(opens[0].getAttribute('aria-label')).toContain(es('sac.baptism'))
    expect(screen.getByRole('columnheader', { name: es('register.actions') })).toBeInTheDocument()
  })
})

describe('mobile navigation drawer', () => {
  const mount = (props) => {
    stubFetch()
    return shell(<Sidebar collapsed={false} onToggle={() => {}} {...props} />)
  }

  it('open on a phone: a named modal dialog with a named close button, Escape closes it', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubMatchMedia(true)
    const onClose = vi.fn()
    mount({ mobileOpen: true, onClose })
    const drawer = await screen.findByRole('dialog', { name: es('shell.navDrawer') })
    expect(drawer).toHaveAttribute('aria-modal', 'true')
    expect(drawer.id).toBe(SIDEBAR_ID)
    // focus moved into the drawer
    expect(drawer.contains(document.activeElement)).toBe(true)
    fireEvent.click(within(drawer).getByRole('button', { name: es('shell.closeNav') }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('Tab wraps inside the open drawer', async () => {
    stubMatchMedia(true)
    mount({ mobileOpen: true, onClose: vi.fn() })
    const drawer = await screen.findByRole('dialog')
    const focusables = [...drawer.querySelectorAll('a[href], button:not([disabled])')]
    focusables[focusables.length - 1].focus()
    fireEvent.keyDown(document.activeElement, { key: 'Tab' })
    expect(document.activeElement).toBe(focusables[0])
  })

  it('closed on a phone: off-screen drawer is inert, not a dialog', () => {
    stubMatchMedia(true)
    const { container } = mount({ mobileOpen: false, onClose: vi.fn() })
    const aside = container.querySelector(`#${SIDEBAR_ID}`)
    expect(aside.hasAttribute('inert')).toBe(true)
    expect(aside.getAttribute('role')).toBeNull()
  })

  it('desktop: the docked sidebar is never inert and never a modal', () => {
    stubMatchMedia(false)
    const { container } = mount({ mobileOpen: false, onClose: vi.fn() })
    const aside = container.querySelector(`#${SIDEBAR_ID}`)
    expect(aside.hasAttribute('inert')).toBe(false)
    expect(aside.getAttribute('role')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close navigation menu' })).toBeNull()
  })
})

describe('header: hamburger state and account menu focus', () => {
  it('the hamburger reports expanded state and controls the sidebar', async () => {
    stubFetch()
    const { rerender } = shell(<Header onMenuClick={() => {}} menuOpen={false} />)
    const burger = document.querySelector(`[aria-controls="${SIDEBAR_ID}"]`)
    expect(burger).toBeTruthy()
    expect(burger).toHaveAttribute('aria-expanded', 'false')
    rerender(
      <MemoryRouter><ThemeProvider><LocaleProvider><ToastProvider><ConfirmProvider>
        <Header onMenuClick={() => {}} menuOpen />
      </ConfirmProvider></ToastProvider></LocaleProvider></ThemeProvider></MemoryRouter>,
    )
    expect(document.querySelector(`[aria-controls="${SIDEBAR_ID}"]`)).toHaveAttribute('aria-expanded', 'true')
  })

  it('opening the account menu moves focus in; Escape closes it and returns focus', async () => {
    stubFetch()
    shell(<Header onMenuClick={() => {}} />)
    const name = STRINGS.en['shell.account.menu'].replace('{name}', 'Secretary')
    const trigger = await screen.findByRole('button', { name })
    trigger.focus()
    await act(async () => { fireEvent.click(trigger) })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const panel = document.getElementById(trigger.getAttribute('aria-controls'))
    expect(panel).toBeTruthy()
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
  })
})

describe('Login errors in Spanish', () => {
  const mount = () => shell(<Login />, '/login')

  it('an empty submit says what is missing and focuses the empty field', async () => {
    authState.signedIn = false
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    const { container } = mount()
    const form = container.querySelector('form')
    await act(async () => { fireEvent.submit(form) })
    expect(await screen.findByRole('alert')).toHaveTextContent(es('login.emptyFields'))
    expect(login).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(container.querySelector('input[type="email"]'))
  })

  it('a wrong password reads in Spanish, not the English server sentence', async () => {
    authState.signedIn = false
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    login.mockRejectedValueOnce(new Error('Invalid email or password'))
    const { container } = mount()
    fireEvent.change(container.querySelector('input[type="email"]'), { target: { value: 'a@b.org' } })
    fireEvent.change(container.querySelector('input[autocomplete="current-password"]'), { target: { value: 'nope' } })
    await act(async () => { fireEvent.submit(container.querySelector('form')) })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(es('login.invalid'))
    expect(alert).not.toHaveTextContent(/Invalid email or password/)
  })
})

describe('/preferences sections in Spanish', () => {
  it('notification switches are named in Spanish; unknown types keep the server label', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch({
      '/api/notification-prefs': () => ok({ prefs: [
        { notification_type: 'assignment_reminder', label: 'Event reminders', description: 'A reminder before events you are assigned to.', enabled: true },
        { notification_type: 'brand_new_type', label: 'Server label', description: 'Server description', enabled: false },
      ] }),
    })
    shell(<NotificationPrefs />)
    expect(await screen.findByText(es('notif.title'))).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: es('notif.type.assignment_reminder.label') })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: 'Server label' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(es('notif.emailPending'))).toBeInTheDocument()
    expect(screen.queryByText('Event reminders')).toBeNull()
  })

  it('the profile-picture controls are Spanish', () => {
    localStorage.setItem('ochr_locale', 'es')
    shell(<AvatarUploader value={null} name="Secretary" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: new RegExp(es('avatar.upload')) })).toBeInTheDocument()
    expect(screen.getByText(es('avatar.help'))).toBeInTheDocument()
    expect(screen.queryByText(/Upload photo/)).toBeNull()
  })
})

describe('/bulletin editor in Spanish', () => {
  it('labels, actions, and the empty list are Spanish and the fields are labelled', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    shell(<Bulletin />)
    expect(await screen.findByText(es('bul.empty'))).toBeInTheDocument()
    expect(screen.getByLabelText(es('bul.date'))).toBeInTheDocument()
    for (const f of ['announcements', 'readings', 'intentions', 'pastor_note']) {
      expect(screen.getByLabelText(es(`bul.field.${f}`)), f).toHaveAttribute('placeholder', es(`bul.field.${f}.ph`))
    }
    expect(screen.getByRole('button', { name: new RegExp(es('bul.pull')) })).toBeInTheDocument()
    for (const en of ['No bulletins yet.', 'Bulletin date', 'Announcements', "Pastor's note", 'Create bulletin', 'Print / PDF']) {
      expect(screen.queryByText(en), en).toBeNull()
    }
  })
})
