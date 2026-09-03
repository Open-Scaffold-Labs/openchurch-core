// Batch 2, the list page. (Pass 8 §14–§15)
//
// `r.ok ? r.json() : { bulletins: [] }` with an empty .catch, so a 500 told
// an admin the parish had never published a bulletin, and said nothing else.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Bulletin from './Bulletin'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false,
  }),
}))

const BULLETINS = [{ id: 1, date: '2026-08-23', title: 'Sunday 23 August' }]
const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })

const routes = (over = {}) => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  for (const [frag, h] of Object.entries(over)) if (u.includes(frag)) return h()
  if (u.includes('/api/bulletins'))    return ok({ bulletins: BULLETINS })
  if (u.includes('/api/organization')) return ok({ name: 'St Test', slug: 'st-test' })
  return ok({})
}))

const mount = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Bulletin />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

const EMPTY_CLAIM = /no bulletins yet/i
const UNREAD      = /couldn'?t be read/i

beforeEach(() => vi.unstubAllGlobals())

describe('CONTROL', () => {
  it('lists what the parish has published', async () => {
    routes(); mount()
    await waitFor(() => expect(screen.queryByText(EMPTY_CLAIM)).not.toBeInTheDocument())
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })

  it('a parish with no bulletins still gets the welcoming copy', async () => {
    routes({ '/api/bulletins': () => ok({ bulletins: [] }) }); mount()
    expect(await screen.findByText(EMPTY_CLAIM)).toBeInTheDocument()
    expect(screen.queryByText(UNREAD)).not.toBeInTheDocument()
  })
})

describe('FAILED must never become EMPTY', () => {
  for (const status of [500, 403]) {
    it(`a ${status} does not claim the parish has published none`, async () => {
      routes({ '/api/bulletins': () => err(status) }); mount()
      expect(await screen.findByText(UNREAD)).toBeInTheDocument()
      expect(screen.queryByText(EMPTY_CLAIM)).not.toBeInTheDocument()
    })
  }

  it('PARTIAL: the parish name failing does not take the list down', async () => {
    routes({ '/api/organization': () => err(500) }); mount()
    await waitFor(() => expect(screen.queryByText(EMPTY_CLAIM)).not.toBeInTheDocument())
  })

  it('retry fills the list in place', async () => {
    let call = 0
    routes({ '/api/bulletins': () => (++call === 1 ? err(500) : ok({ bulletins: BULLETINS })) })
    mount()
    expect(await screen.findByText(UNREAD)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again/i })) })
    await waitFor(() => expect(screen.queryByText(UNREAD)).not.toBeInTheDocument())
  })
})
