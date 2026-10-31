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
  // The editor chrome is translated now (App Review 2026-10-26), so match either locale.
  const button = await screen.findByRole('button', { name: /pull readings from service plan|traer las lecturas del plan de servicio/i })
  fireEvent.change(screen.getByLabelText(/bulletin date|fecha del boletín/i), { target: { value: DATE } })
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

describe('SP-308 multi-plan day prefers a plan that has readings', () => {
  // Saint VERIFIED: API lists Nov 1 as [56, 55] (id DESC). Plan 56 is
  // hymns-only; plan 55 has readings. Old plans.find took 56 → false
  // "no readings yet" toast (SP-301). Ascending candidates + skip empty.
  const DATE_MULTI = '2026-11-01'
  const pullMulti = async () => {
    const button = await screen.findByRole('button', { name: /pull readings from service plan|traer las lecturas del plan de servicio/i })
    fireEvent.change(screen.getByLabelText(/bulletin date|fecha del boletín/i), { target: { value: DATE_MULTI } })
    await act(async () => { fireEvent.click(button) })
  }

  it('skips a newer hymns-only plan and pulls readings from the older plan', async () => {
    const fetched = []
    routes({
      '/api/service-plans/56': () => {
        fetched.push(56)
        return ok({ elements: [{ kind: 'hymn', title: 'Entrance', reference: '#100' }] })
      },
      '/api/service-plans/55': () => {
        fetched.push(55)
        return ok({ elements: [
          { kind: 'reading', title: 'First Reading', reference: 'Rev 7:2-4, 9-14' },
          { kind: 'psalm', title: 'Responsorial Psalm', reference: 'Ps 24:1bc-2, 3-4ab, 5-6' },
        ] })
      },
      // List order matches production: id DESC for the same date.
      '/api/service-plans': () => ok({ plans: [
        { id: 56, date: DATE_MULTI },
        { id: 55, date: DATE_MULTI },
      ] }),
    })
    mount()
    await pullMulti()
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/first reading/i)).toHaveValue(
        'First Reading — Rev 7:2-4, 9-14\nResponsorial Psalm — Ps 24:1bc-2, 3-4ab, 5-6',
      )
    })
    expect(screen.queryByText(NO_READINGS)).not.toBeInTheDocument()
    // Deterministic order: try lower id first; never need 56 once 55 wins.
    expect(fetched).toEqual([55])
  })

  it('still says no readings when every same-date plan is hymns-only', async () => {
    routes({
      '/api/service-plans/56': () => ok({ elements: [{ kind: 'hymn', title: 'Entrance' }] }),
      '/api/service-plans/55': () => ok({ elements: [{ kind: 'hymn', title: 'Recessional' }] }),
      '/api/service-plans': () => ok({ plans: [
        { id: 56, date: DATE_MULTI },
        { id: 55, date: DATE_MULTI },
      ] }),
    })
    mount()
    await pullMulti()
    expect(await screen.findByRole('status')).toHaveTextContent(NO_READINGS)
  })
})
