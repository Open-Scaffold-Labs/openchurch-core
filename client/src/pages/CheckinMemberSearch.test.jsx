// Staff Check-in used to dump the remaining roll into a native <select>.
// On a Sunday tablet that is a long wheel, not a name search — and a failed
// roster read looked like an empty parish. The kiosk already types to find
// people; the staff desk now does the same against the loaded roll.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Checkin from './Checkin'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Usher', role: 'staff', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: false,
  }),
}))

const EVENT = { id: 11, title: 'Sunday Mass', date: '2026-09-13', start_time: '10:00:00' }
const MEMBERS = [
  { id: 7, name: 'Maria Ruiz' },
  { id: 8, name: 'Jose Ruiz' },
  { id: 9, name: 'Anna Chen' },
]

const ok  = (b) => ({ ok: true,  status: 200, json: async () => b })
const err = (s, b = { error: 'boom' }) => ({ ok: false, status: s, json: async () => b })

let calls
const routes = (over = {}) => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, method, body })
    for (const [frag, h] of Object.entries(over)) if (u.includes(frag) && (typeof h === 'function')) {
      const res = h({ url: u, method, body })
      if (res) return res
    }
    if (u.includes('/api/calendar')) return ok([EVENT])
    if (u.includes('/api/clients')) return ok(MEMBERS)
    if (u.includes('/api/rooms')) return ok({ rooms: [] })
    if (u.includes('/api/checkins/recent')) return ok({ services: [] })
    if (u.includes('/api/checkins') && method === 'GET') {
      return ok({
        checkins: [{ id: 1, client_id: 8, person_name: 'Jose Ruiz', kind: 'member', checked_out_at: null }],
        present: 1,
      })
    }
    if (u.includes('/api/checkins') && method === 'POST') {
      return ok({ id: 99, person_name: 'Maria Ruiz', kind: 'member' })
    }
    return ok({})
  }))
}

const mount = () => render(
  <MemoryRouter initialEntries={['/checkin']}>
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Routes><Route path="/checkin" element={<Checkin />} /></Routes>
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  </MemoryRouter>
)

const searchBox = () => screen.getByRole('searchbox', { name: /search a member to check in/i })

const typeName = async (q) => {
  const box = await waitFor(() => searchBox())
  fireEvent.change(box, { target: { value: q } })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

describe('staff check-in member search', () => {
  it('CONTROL: a working desk shows a name search, not the full roll', async () => {
    routes(); mount()
    expect(await screen.findByRole('searchbox', { name: /search a member to check in/i })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /choose a member to check in/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Select a member…')).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Maria Ruiz' })).not.toBeInTheDocument()
  })

  it('two letters find Maria and hide Jose who is already present', async () => {
    routes(); mount()
    await typeName('Ru')
    expect(await screen.findByRole('button', { name: /Maria Ruiz/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Jose Ruiz/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Anna Chen/ })).not.toBeInTheDocument()
  })

  it('one letter does not dump the roll', async () => {
    routes(); mount()
    await typeName('M')
    expect(screen.queryByRole('button', { name: /Maria Ruiz/ })).not.toBeInTheDocument()
    expect(screen.queryByText('No matching members')).not.toBeInTheDocument()
  })

  it('Check in posts the picked member, not a typed guest', async () => {
    routes(); mount()
    await typeName('Mar')
    fireEvent.click(await screen.findByRole('button', { name: /Maria Ruiz/ }))
    expect(screen.getByText('Maria Ruiz')).toBeInTheDocument()
    const checkIn = screen.getAllByRole('button', { name: /check in/i })[0]
    expect(checkIn).not.toBeDisabled()
    await act(async () => { fireEvent.click(checkIn) })
    await waitFor(() => {
      const post = calls.find(c => c.method === 'POST' && c.url.includes('/api/checkins'))
      expect(post).toBeTruthy()
      expect(post.body).toEqual({
        calendar_event_id: 11,
        client_id: 7,
        kind: 'member',
      })
    })
  })

  for (const [label, body] of [
    ['a 200 object', {}],
    ['a 200 null', null],
    ['a 200 scalar', 4],
    ['a 200 wrapped list', { clients: MEMBERS }],
  ]) {
    it(`${label} is a failed roster, not an empty parish`, async () => {
      routes({
        '/api/clients': () => ok(body),
      })
      mount()
      expect(await screen.findByText(STRINGS.en['mem.listFailed'])).toBeInTheDocument()
      await typeName('Mar')
      expect(screen.getByText(STRINGS.en['mem.listFailed'])).toBeInTheDocument()
      expect(screen.queryByText('No matching members')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Maria Ruiz/ })).not.toBeInTheDocument()
    })
  }

  it('a failed roster is not an empty parish', async () => {
    routes({
      '/api/clients': () => err(500),
    })
    mount()
    expect(await screen.findByText(STRINGS.en['mem.listFailed'])).toBeInTheDocument()
    await typeName('Mar')
    expect(screen.getByText(STRINGS.en['mem.listFailed'])).toBeInTheDocument()
    expect(screen.queryByText('No matching members')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Maria Ruiz/ })).not.toBeInTheDocument()
  })

  it('a Spanish desk hears the Spanish failure, not an empty roll', async () => {
    localStorage.setItem('ochr_locale', 'es')
    routes({ '/api/clients': () => ok(null) })
    mount()
    expect(await screen.findByText(STRINGS.es['mem.listFailed'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['mem.listFailed'])).not.toBeInTheDocument()
    expect(screen.queryByText('No matching members')).not.toBeInTheDocument()
  })
})
