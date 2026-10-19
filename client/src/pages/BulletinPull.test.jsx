// A refused service-plan read used to toast "No service plan for this date
// yet," and a refused plan used to toast "That service plan has no readings
// yet." Both are true-empty sentences. A failure is neither.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Bulletin from './Bulletin'

const localeRef = { current: 'en' }

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: localeRef.current } },
    token: 't', loading: false,
  }),
}))

const DATE = '2026-10-04'
const PLAN = { id: 7, date: DATE }
const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

const routes = (over = {}) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
  if (u.includes('/api/bulletins')) return ok({ bulletins: [] })
  if (u.includes('/api/organization')) return ok({ name: 'St Test', slug: 'st-test' })
  if (u.includes('/api/service-plans')) return ok({ plans: [] })
  return ok({})
}))

const mount = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Bulletin />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

const pull = async () => {
  const button = await screen.findByRole('button', { name: /pull readings from service plan/i })
  fireEvent.change(screen.getByLabelText(/bulletin date/i), { target: { value: DATE } })
  await act(async () => { fireEvent.click(button) })
}

const UNREAD = /service plans did not load/i
const NONE = /no service plan for this date yet/i
const PLAN_UNREAD = /that service plan did not load/i
const NO_READINGS = /has no readings yet/i
const ES_UNREAD = /no se pudieron cargar los planes de servicio/i
const ES_NONE = /aún no hay un plan de servicio/i

beforeEach(() => {
  localeRef.current = 'en'
  try { localStorage.removeItem('ochr_locale') } catch { /* jsdom */ }
  vi.unstubAllGlobals()
})

describe('a refused pull is not an empty date', () => {
  it('a 500 on the plan list does not claim this date has no plan', async () => {
    routes({ '/api/service-plans': () => err(500) })
    mount()
    await pull()
    expect(await screen.findByRole('alert')).toHaveTextContent(UNREAD)
    expect(screen.queryByText(NONE)).not.toBeInTheDocument()
  })

  it('a non-list body is unread, not an empty date', async () => {
    routes({ '/api/service-plans': () => ok({ plans: null }) })
    mount()
    await pull()
    expect(await screen.findByRole('alert')).toHaveTextContent(UNREAD)
    expect(screen.queryByText(NONE)).not.toBeInTheDocument()
  })

  it('a date with no plan still says so', async () => {
    routes({ '/api/service-plans': () => ok({ plans: [] }) })
    mount()
    await pull()
    expect(await screen.findByRole('status')).toHaveTextContent(NONE)
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('a 500 on the matched plan does not claim it has no readings', async () => {
    routes({
      '/api/service-plans/7': () => err(500),
      '/api/service-plans': () => ok({ plans: [PLAN] }),
    })
    mount()
    await pull()
    expect(await screen.findByRole('alert')).toHaveTextContent(PLAN_UNREAD)
    expect(screen.queryByText(NO_READINGS)).not.toBeInTheDocument()
  })

  it('a plan with no readings still says so', async () => {
    routes({
      '/api/service-plans/7': () => ok({ elements: [] }),
      '/api/service-plans': () => ok({ plans: [PLAN] }),
    })
    mount()
    await pull()
    expect(await screen.findByRole('status')).toHaveTextContent(NO_READINGS)
    expect(screen.queryByText(PLAN_UNREAD)).not.toBeInTheDocument()
  })

  it('a reading fills the Readings field', async () => {
    routes({
      '/api/service-plans/7': () => ok({ elements: [{ kind: 'reading', title: 'Isaiah 50', reference: 'Isa 50:4-7' }] }),
      '/api/service-plans': () => ok({ plans: [PLAN] }),
    })
    mount()
    await pull()
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/first reading/i)).toHaveValue('Isaiah 50 — Isa 50:4-7')
    })
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
    expect(screen.queryByText(NONE)).not.toBeInTheDocument()
  })

  it('Spanish names a refused list, not a date without a plan', async () => {
    localeRef.current = 'es'
    routes({ '/api/service-plans': () => err(500) })
    mount()
    await pull()
    expect(await screen.findByRole('alert')).toHaveTextContent(ES_UNREAD)
    expect(screen.queryByText(ES_NONE)).not.toBeInTheDocument()
  })
})
