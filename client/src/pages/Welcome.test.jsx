// Welcome user-visible chrome goes through strings.js + t() en+es.
// Hard-coded English headings, module card titles/bodies, and CTAs are
// the remaining Welcome defect after Login/Signup/Forgot localization.
// Restoring those literals in the component goes red. Dashboard `/`
// and add-member `/clients?new=1` stay the first-run targets; the four
// orientation modules do not grow.
// (OC-READY-01-033)

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import Welcome from './Welcome'

const authState = vi.hoisted(() => ({
  user: {
    id: 1,
    name: 'Jane Doe',
    role: 'admin',
    organization: { id: 1, name: 'St Test', locale: 'en' },
  },
}))

const navigate = vi.hoisted(() => vi.fn())

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: authState.user,
    token: 'test-token',
    loading: false,
  }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

const HERE = dirname(fileURLToPath(import.meta.url))
const WELCOME_SRC = readFileSync(join(HERE, 'Welcome.jsx'), 'utf8')
const APP_SRC = readFileSync(join(HERE, '..', 'App.jsx'), 'utf8')

const HARD_EN = [
  'Welcome, {firstName',
  'Welcome, {name}',
  'your church',
  'Your workspace for',
  'sample rows',
  'Here’s what’s inside',
  "Here's what's inside",
  'Your directory of parishioners',
  'feast days',
  'rolling checklist',
  'Generate bulletins',
  'Go to my dashboard',
  'jump straight to adding a member',
  "title: 'Members'",
  "title: 'Events'",
  "title: 'Tasks'",
  "title: 'AI Studio'",
]

const WELCOME_KEYS = [
  'welcome.hello',
  'welcome.helloAnon',
  'welcome.orgFallback',
  'welcome.bodyBefore',
  'welcome.bodyAfter',
  'welcome.bodyHelp',
  'welcome.inside',
  'welcome.members',
  'welcome.membersBody',
  'welcome.events',
  'welcome.eventsBody',
  'welcome.tasks',
  'welcome.tasksBody',
  'welcome.studio',
  'welcome.studioBody',
  'welcome.cta',
  'welcome.addMember',
]

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const mount = () => render(
  <MemoryRouter>
    <LocaleProvider>
      <Welcome />
    </LocaleProvider>
  </MemoryRouter>,
)

beforeEach(() => {
  navigate.mockReset()
  authState.user = {
    id: 1,
    name: 'Jane Doe',
    role: 'admin',
    organization: { id: 1, name: 'St Test', locale: 'en' },
  }
  localStorage.removeItem('ochr_locale')
})

describe('Welcome chrome is translated (OC-READY-01-033)', () => {
  it('ENGLISH HEADING, MODULE CARDS, AND CTAS USE t() COPY', () => {
    mount()
    expect(screen.getByRole('heading', {
      name: STRINGS.en['welcome.hello'].replace('{name}', 'Jane'),
    })).toBeInTheDocument()
    expect(screen.getByText((_, node) => (
      node.tagName === 'P'
      && (node.textContent || '').includes('St Test')
      && (node.textContent || '').includes('sample rows')
    ))).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['welcome.inside'])).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['welcome.members'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['welcome.membersBody'])).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['welcome.events'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['welcome.eventsBody'])).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['welcome.tasks'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['welcome.tasksBody'])).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: STRINGS.en['welcome.studio'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['welcome.studioBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['welcome.cta'] })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.en['welcome.addMember'] })).toHaveAttribute(
      'href',
      '/clients?new=1',
    )
  })

  it('SPANISH WELCOME CHROME IS SPANISH — NOT THE ENGLISH LABELS', () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(screen.getByRole('heading', {
      name: STRINGS.es['welcome.hello'].replace('{name}', 'Jane'),
    })).toBeInTheDocument()
    expect(screen.queryByRole('heading', {
      name: STRINGS.en['welcome.hello'].replace('{name}', 'Jane'),
    })).toBeNull()
    expect(screen.getByText(STRINGS.es['welcome.inside'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['welcome.inside'])).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['welcome.members'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['welcome.members'] })).toBeNull()
    expect(screen.getByText(STRINGS.es['welcome.membersBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['welcome.membersBody'])).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['welcome.events'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['welcome.eventsBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['welcome.eventsBody'])).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['welcome.tasks'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['welcome.tasksBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['welcome.tasksBody'])).toBeNull()
    expect(screen.getByRole('heading', { name: STRINGS.es['welcome.studio'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['welcome.studioBody'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['welcome.studioBody'])).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.es['welcome.cta'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['welcome.cta'] })).toBeNull()
    expect(screen.getByRole('link', { name: STRINGS.es['welcome.addMember'] })).toHaveAttribute(
      'href',
      '/clients?new=1',
    )
    expect(screen.queryByText(/Go to my dashboard/)).toBeNull()
    expect(screen.queryByText(/jump straight to adding a member/)).toBeNull()
  })

  it('nameless greeting uses the locale anon string, not hard-EN “there”', () => {
    authState.user = {
      id: 1,
      name: '',
      role: 'admin',
      organization: { id: 1, name: 'St Test', locale: 'en' },
    }
    const { unmount } = mount()
    expect(screen.getByRole('heading', { name: STRINGS.en['welcome.helloAnon'] })).toBeInTheDocument()
    expect(screen.queryByText(/Welcome, there/)).toBeNull()
    unmount()

    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(screen.getByRole('heading', { name: STRINGS.es['welcome.helloAnon'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['welcome.helloAnon'] })).toBeNull()
  })

  it('missing org name uses the locale fallback, not a hard-EN “your church”', () => {
    authState.user = {
      id: 1,
      name: 'Jane Doe',
      role: 'admin',
      organization: { id: 1, locale: 'en' },
    }
    localStorage.setItem('ochr_locale', 'es')
    mount()
    expect(screen.getByText((_, node) => (
      node.tagName === 'SPAN'
      && node.textContent === STRINGS.es['welcome.orgFallback']
    ))).toBeInTheDocument()
    expect(screen.queryByText('your church')).toBeNull()
  })

  it('dashboard CTA and add-member link keep the same first-run targets', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['welcome.cta'] }))
    expect(navigate).toHaveBeenCalledWith('/', { replace: true })
    expect(screen.getByRole('link', { name: STRINGS.en['welcome.addMember'] })).toHaveAttribute(
      'href',
      '/clients?new=1',
    )
  })

  it('the four orientation modules do not grow or change destinations', () => {
    expect(WELCOME_SRC).toMatch(/id: 'members'/)
    expect(WELCOME_SRC).toMatch(/id: 'events'/)
    expect(WELCOME_SRC).toMatch(/id: 'tasks'/)
    expect(WELCOME_SRC).toMatch(/id: 'studio'/)
    expect(WELCOME_SRC).toMatch(/navigate\('\/', \{ replace: true \}\)/)
    expect(WELCOME_SRC).toMatch(/to="\/clients\?new=1"/)
    expect(APP_SRC).toMatch(/path="\/welcome"/)
    const ids = [...WELCOME_SRC.matchAll(/id: '(\w+)'/g)].map(m => m[1])
    expect(ids).toEqual(['members', 'events', 'tasks', 'studio'])
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(WELCOME_SRC)
    for (const key of WELCOME_KEYS) {
      expect(WELCOME_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(WELCOME_SRC).toMatch(/useLocale\(/)
    expect(WELCOME_SRC).toMatch(/t\('welcome\.hello', \{ name \}\)/)
    expect(WELCOME_SRC).toMatch(/t\('welcome\.helloAnon'\)/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['welcome.members']).toBe('Members')
    expect(STRINGS.en['welcome.events']).toBe('Events')
    expect(STRINGS.en['welcome.tasks']).toBe('Tasks')
    expect(STRINGS.en['welcome.studio']).toBe('AI Studio')
    expect(STRINGS.en['welcome.cta']).toBe('Go to my dashboard & checklist')
    expect(STRINGS.es['welcome.members']).toMatch(/miembros/i)
    expect(STRINGS.es['welcome.events']).toMatch(/eventos/i)
    expect(STRINGS.es['welcome.tasks']).toMatch(/tareas/i)
    expect(STRINGS.es['welcome.studio']).toMatch(/estudio/i)
    expect(STRINGS.es['welcome.cta']).toMatch(/panel/i)
    expect(STRINGS.es['welcome.addMember']).toMatch(/miembro/i)
  })
})
