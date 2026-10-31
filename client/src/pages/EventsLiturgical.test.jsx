// Events: the liturgical day saved with an event, and the words it shows in.
//
// 1. Changing an event's date looked up the new date's season. A failed
//    lookup was taken for an answer: an error response came back as blank
//    season, color and feast, which the form then saved as "no season"; a
//    network error left the OLD date's season in the form, which was then
//    saved against the new date. The form now drops the old date's values at
//    once and, when the lookup fails, leaves them out of the request so the
//    server stamps them from the date.
// 2. The Events list and the form chip printed the canonical English token,
//    so a Spanish parish read "Christmas" for Navidad. They now go through
//    seasonLabel, like the Sacristy List and Schedule. jsdom only.

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Events from './Events'

let ORG = { id: 1, name: 'St Test', locale: 'en' }
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: ORG },
    token: 't', loading: false, canWrite: true, isAdmin: true, isViewer: false,
  }),
}))

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const EVENT = {
  id: 5, title: 'Midnight Mass', service_division: '', date: '2026-12-25', time: '23:00', location: '',
  liturgical_season: 'Christmas', liturgical_color: 'White', feast_name: '', assigned_members: [], is_public: false,
}
const EVENT_B = {
  ...EVENT, id: 6, title: 'Patronal Mass', date: '2026-07-12', time: '10:00',
  liturgical_season: 'Parish Jubilee', liturgical_color: 'Gold', feast_name: 'Our Patron',
}
let EVENTS = [EVENT]
let litReply
let patches
function stub() {
  patches = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('/api/liturgical')) return litReply()
    if (opts.method === 'PATCH') { patches.push(JSON.parse(opts.body)); return res(200, { ...EVENT }) }
    if (/\/api\/events\?/.test(u)) return res(200, EVENTS)
    if (u.includes('/api/clients')) return res(200, [])
    return res(200, [])
  }))
}

const wrap = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Events />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

beforeEach(() => {
  vi.unstubAllGlobals()
  try { localStorage.clear() } catch { /* jsdom */ }
  ORG = { id: 1, name: 'St Test', locale: 'en' }
  EVENTS = [EVENT]
  litReply = () => res(200, { season: 'Ordinary Time', color: 'Green', feast_name: null })
  stub()
})

async function moveEventTo(date) {
  const { container } = wrap()
  fireEvent.click(await screen.findByRole('button', { name: 'Edit event: Midnight Mass' }))
  const input = await waitFor(() => {
    const el = container.querySelector('form input[type="date"]')
    if (!el) throw new Error('no date input yet')
    return el
  })
  await act(async () => { fireEvent.change(input, { target: { value: date } }) })
  // Let the lookup settle before saving.
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })) })
  await waitFor(() => expect(patches).toHaveLength(1))
  return patches[0]
}

describe('Events form: a failed liturgical lookup is not saved as an answer', () => {
  it('an error response does not save a blank season', async () => {
    litReply = () => res(500, { error: 'boom' })
    const body = await moveEventTo('2026-07-12')
    expect(body.date).toBe('2026-07-12')
    expect('liturgical_season' in body).toBe(false)
    expect('liturgical_color' in body).toBe(false)
    expect('feast_name' in body).toBe(false)
  })
  it("a network error does not save the old date's season against the new date", async () => {
    litReply = () => { throw new TypeError('Failed to fetch') }
    const body = await moveEventTo('2026-07-12')
    expect(body.liturgical_season).not.toBe('Christmas')
    expect(body.liturgical_color).not.toBe('White')
  })
  it('CONTROL: a good lookup is saved with the new date', async () => {
    const body = await moveEventTo('2026-07-12')
    expect(body.liturgical_season).toBe('Ordinary Time')
    expect(body.liturgical_color).toBe('Green')
  })
})

// R340-1: a 200 whose body is not a liturgical answer is a failed lookup.
describe('Events form: a malformed 200 lookup is not saved as an answer', () => {
  for (const [name, body] of [
    ['{}', {}],
    ['an array', [{ season: 'Ordinary Time', color: 'Green' }]],
    ['an object season', { season: { name: 'Ordinary Time' }, color: 'Green', feast_name: null }],
    ['a numeric color', { season: 'Ordinary Time', color: 5, feast_name: null }],
    ['an object feast', { season: 'Ordinary Time', color: 'Green', feast_name: { x: 1 } }],
    ['null body', null],
    ['a partial answer with no feast_name', { season: 'Ordinary Time', color: 'Green' }],
  ]) {
    it(`200 ${name} leaves season, color and feast out of the PATCH`, async () => {
      litReply = () => res(200, body)
      const sent = await moveEventTo('2026-07-12')
      expect(sent.date).toBe('2026-07-12')
      for (const k of ['liturgical_season', 'liturgical_color', 'feast_name']) expect(k in sent).toBe(false)
    })
  }
  it('CONTROL: a valid answer with a null feast saves the season and a known "no feast"', async () => {
    const sent = await moveEventTo('2026-07-12')
    expect(sent.liturgical_season).toBe('Ordinary Time')
    expect(sent.liturgical_color).toBe('Green')
    expect(sent.feast_name).toBe('')
  })
  it('CONTROL: parish-defined wording is accepted as text', async () => {
    litReply = () => res(200, { season: 'Tiempo de la Parroquia', color: 'Rose', feast_name: 'Fiesta Patronal' })
    const sent = await moveEventTo('2026-07-12')
    expect(sent).toMatchObject({ liturgical_season: 'Tiempo de la Parroquia', liturgical_color: 'Rose', feast_name: 'Fiesta Patronal' })
  })
})

// R340-3: a lookup belongs to the form session that asked for it.
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
async function dateInput(container) {
  return waitFor(() => {
    const el = container.querySelector('form input[type="date"]')
    if (!el) throw new Error('no date input yet')
    return el
  })
}
describe('Events form: a dismissed form\'s late lookup cannot reach the next form', () => {
  it('A moved to July, cancelled, then B (already July, custom context) keeps its own context', async () => {
    EVENTS = [EVENT, EVENT_B]
    const late = deferred()
    litReply = () => late.promise
    const { container } = wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit event: Midnight Mass' }))
    await act(async () => { fireEvent.change(await dateInput(container), { target: { value: '2026-07-12' } }) })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit event: Patronal Mass' }))
    await dateInput(container)
    await act(async () => { late.resolve(res(200, { season: 'Ordinary Time', color: 'Green', feast_name: null })) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })) })
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toMatchObject({ date: '2026-07-12', liturgical_season: 'Parish Jubilee', liturgical_color: 'Gold', feast_name: 'Our Patron' })
  })
  it('CONTROL: the latest lookup in the same form still applies when it arrives late', async () => {
    const first = deferred(), second = deferred()
    const queue = [first, second]
    litReply = () => queue.shift().promise
    const { container } = wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit event: Midnight Mass' }))
    const input = await dateInput(container)
    await act(async () => { fireEvent.change(input, { target: { value: '2026-03-08' } }) })
    await act(async () => { fireEvent.change(input, { target: { value: '2026-07-12' } }) })
    await act(async () => { second.resolve(res(200, { season: 'Ordinary Time', color: 'Green', feast_name: null })) })
    await act(async () => { first.resolve(res(200, { season: 'Lent', color: 'Violet', feast_name: null })) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })) })
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toMatchObject({ date: '2026-07-12', liturgical_season: 'Ordinary Time', liturgical_color: 'Green' })
  })
})

describe('Events list season chip', () => {
  it('CONTROL: an English parish reads Christmas', async () => {
    wrap()
    expect(await screen.findByText('Christmas')).toBeInTheDocument()
  })
  it('a Spanish parish reads Navidad, not the English token', async () => {
    ORG = { ...ORG, locale: 'es' }
    wrap()
    expect(await screen.findByText('Navidad')).toBeInTheDocument()
    expect(screen.queryByText('Christmas')).not.toBeInTheDocument()
  })
  it('the form chip reads Tiempo Ordinario for a Spanish parish', async () => {
    ORG = { ...ORG, locale: 'es' }
    const { container } = wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit event: Midnight Mass' }))
    const input = await waitFor(() => {
      const el = container.querySelector('form input[type="date"]')
      if (!el) throw new Error('no date input yet')
      return el
    })
    await act(async () => { fireEvent.change(input, { target: { value: '2026-07-12' } }) })
    expect(await screen.findByText('Tiempo Ordinario')).toBeInTheDocument()
    expect(screen.queryByText('Ordinary Time')).not.toBeInTheDocument()
  })
})
