// PublicSwap remaining + residual chrome (Mercury after #120) goes
// through strings.js + t() en+es. Restoring those literals in the
// component goes red. Member names, event titles, and swap notes stay
// API data.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import PublicSwap from './PublicSwap'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const SWAP_SRC = readFileSync(join(HERE, 'PublicSwap.jsx'), 'utf8')

// Copied from server/src/routes/swap.js via PublicSwapLoad.test.jsx —
// not guessed. Title is the parish-supplied datum the page must keep.
const SWAP = {
  me:  { id: 1, name: 'Ana Probe', organization_id: 1, reminders_opt_out: false },
  org: { locale: 'en' },
  upcoming_assignments: [{ id: 11, calendar_event_id: 5, title: 'Sunday Mass', date: '2026-09-06', time: '10:00', role: 'Reader' }],
  swap_requests: [],
  roster: [],
}

const ok = (b) => ({ ok: true, status: 200, json: async () => b })

const HARD_EN = [
  'Hello,',
  'Serving reminders',
  "Off — you won't get reminders before events you're serving.",
  "On — we'll remind you about a day before events you're serving.",
  'Toggle serving reminders',
  'Request swap',
  'Request a swap',
  'Start typing a name…',
  'A short note — work conflict, family thing, etc.',
]

const SWAP_KEYS = [
  'swap.hello',
  'swap.reminders',
  'swap.remindersOff',
  'swap.remindersOn',
  'swap.toggleReminders',
  'swap.request',
  'swap.requestTitle',
  'swap.close',
  'swap.namePh',
  'swap.notePh',
]

const hello = (lang, name = 'Ana Probe') => STRINGS[lang]['swap.hello'].replaceAll('{name}', name)

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const routes = (over = {}, body = SWAP) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
  if (u.includes('/members')) return ok({ members: [{ id: 2, name: 'Luis Probe' }] })
  return ok(body)
}))

const mount = () => render(
  <MemoryRouter initialEntries={['/swap/tok-abc']}>
    <LocaleProvider>
      <Routes><Route path="/swap/:token" element={<PublicSwap />} /></Routes>
    </LocaleProvider>
  </MemoryRouter>,
)

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
})

describe('PublicSwap remaining chrome is translated', () => {
  it('ENGLISH PAGE CHROME USES t() COPY; API CONTENT STAYS DATA', async () => {
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: hello('en') })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['swap.reminders'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['swap.remindersOn'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['swap.remindersOff'])).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.en['swap.toggleReminders'] })).toBeInTheDocument()
    expect(screen.getByText(/Ana Probe/)).toBeInTheDocument()
    expect(screen.getByText('Sunday Mass')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.en['swap.request'] })) })
    expect(await screen.findByRole('heading', { name: STRINGS.en['swap.requestTitle'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['swap.close'] })).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.en['swap.namePh'])).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.en['swap.notePh'])).toBeInTheDocument()
    expect(screen.getAllByText('Sunday Mass').length).toBeGreaterThanOrEqual(1)
  })

  it('SPANISH PAGE CHROME IS SPANISH — NOT THE ENGLISH LABELS', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes()
    mount()
    expect(await screen.findByRole('heading', { name: hello('es') })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: hello('en') })).toBeNull()
    expect(screen.getByText(STRINGS.es['swap.reminders'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['swap.reminders'])).toBeNull()
    expect(screen.getByText(STRINGS.es['swap.remindersOn'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['swap.remindersOn'])).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.es['swap.toggleReminders'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['swap.toggleReminders'] })).toBeNull()
    expect(screen.getByText(/Ana Probe/)).toBeInTheDocument()
    expect(screen.getByText('Sunday Mass')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.es['swap.request'] })) })
    expect(await screen.findByRole('heading', { name: STRINGS.es['swap.requestTitle'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['swap.requestTitle'] })).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.es['swap.close'] })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: STRINGS.en['swap.close'] })).toBeNull()
    expect(screen.getByPlaceholderText(STRINGS.es['swap.namePh'])).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(STRINGS.en['swap.namePh'])).toBeNull()
    expect(screen.getByPlaceholderText(STRINGS.es['swap.notePh'])).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(STRINGS.en['swap.notePh'])).toBeNull()
    expect(screen.getAllByText('Sunday Mass').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Ana Probe/)).toBeInTheDocument()
  })

  it('publicLocale from the swap payload is Spanish chrome', async () => {
    routes({}, { ...SWAP, org: { locale: 'es' } })
    mount()
    expect(await screen.findByRole('heading', { name: hello('es') })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: hello('en') })).toBeNull()
    expect(screen.getByText(STRINGS.es['swap.reminders'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['swap.reminders'])).toBeNull()
    expect(screen.getByText(STRINGS.es['swap.remindersOn'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['swap.remindersOn'])).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.es['swap.toggleReminders'] })).toBeInTheDocument()
    expect(screen.getByText('Sunday Mass')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.es['swap.request'] })) })
    expect(await screen.findByRole('heading', { name: STRINGS.es['swap.requestTitle'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: STRINGS.en['swap.requestTitle'] })).toBeNull()
    expect(screen.getByRole('button', { name: STRINGS.es['swap.close'] })).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.es['swap.namePh'])).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.es['swap.notePh'])).toBeInTheDocument()
    expect(screen.getAllByText('Sunday Mass').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Ana Probe/)).toBeInTheDocument()
  })

  it('opted-out reminder chrome uses Off copy; names stay API data', async () => {
    routes({}, { ...SWAP, me: { ...SWAP.me, reminders_opt_out: true } })
    mount()
    expect(await screen.findByText(STRINGS.en['swap.remindersOff'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['swap.remindersOn'])).toBeNull()
    expect(screen.getByRole('heading', { name: hello('en') })).toBeInTheDocument()
    expect(screen.getByText(/Ana Probe/)).toBeInTheDocument()
    expect(screen.getByText('Sunday Mass')).toBeInTheDocument()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN chrome', () => {
    const jsx = stripComments(SWAP_SRC)
    for (const key of SWAP_KEYS) {
      expect(SWAP_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(SWAP_SRC).toMatch(/useLocale\(/)
    expect(SWAP_SRC).toMatch(/setPublicLocale/)
    expect(SWAP_SRC).toMatch(/data\.me\.name/)
    expect(SWAP_SRC).toMatch(/e\.title/)
    expect(jsx).not.toMatch(/aria-label=["']Close["']/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['swap.hello']).toBe('Hello, {name}')
    expect(STRINGS.en['swap.reminders']).toBe('Serving reminders')
    expect(STRINGS.en['swap.remindersOff']).toBe("Off — you won't get reminders before events you're serving.")
    expect(STRINGS.en['swap.remindersOn']).toBe("On — we'll remind you about a day before events you're serving.")
    expect(STRINGS.en['swap.toggleReminders']).toBe('Toggle serving reminders')
    expect(STRINGS.en['swap.request']).toBe('Request swap')
    expect(STRINGS.en['swap.requestTitle']).toBe('Request a swap')
    expect(STRINGS.en['swap.close']).toBe('Close')
    expect(STRINGS.en['swap.namePh']).toBe('Start typing a name…')
    expect(STRINGS.en['swap.notePh']).toBe('A short note — work conflict, family thing, etc.')
    expect(STRINGS.es['swap.hello']).toMatch(/hola/i)
    expect(STRINGS.es['swap.hello']).toContain('{name}')
    expect(STRINGS.es['swap.reminders']).toMatch(/recordatorio/i)
    expect(STRINGS.es['swap.remindersOff']).toMatch(/desactiv/i)
    expect(STRINGS.es['swap.remindersOn']).toMatch(/activad/i)
    expect(STRINGS.es['swap.toggleReminders']).toMatch(/recordatorio/i)
    expect(STRINGS.es['swap.request']).toMatch(/pedir|cambio|reemplazo/i)
    expect(STRINGS.es['swap.requestTitle']).toMatch(/cambio|reemplazo/i)
    expect(STRINGS.es['swap.close']).toMatch(/cerrar/i)
    expect(STRINGS.es['swap.namePh']).toMatch(/nombre/i)
    expect(STRINGS.es['swap.notePh']).toMatch(/nota/i)
  })
})
