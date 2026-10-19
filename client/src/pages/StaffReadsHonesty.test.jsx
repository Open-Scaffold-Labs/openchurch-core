// Honest-failure sweep (after #321): four staff reads that turned a
// refused, dropped or malformed answer into an empty one.
//
//   Kiosk roster search   a 200 without a usable members list said "No
//                         members match — try the guest button" (duplicate path)
//   Event attendance      a 200 without a usable roster hid the section, as for
//                         an event with nobody assigned
//   Register drafts       a 200 without a usable drafts list said "No pending
//                         drafts" while staged entries waited
//   Schedule groups       any failed groups read hid the group filter and left
//                         the event picker at "No group", as for a parish
//                         without groups
//
// Real empty answers and real data are the controls. jsdom only.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Kiosk from './Kiosk'
import RegisterDrafts from './RegisterDrafts'
import Schedule from './Schedule'
import AttendanceSection from '../components/AttendanceSection'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const en = STRINGS.en
const es = STRINGS.es
const ok = (b) => ({ ok: true, status: 200, json: async () => b })
const notJson = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })
const err = (s) => ({ ok: false, status: s, json: async () => ({ error: 'boom' }) })
const drop = () => { throw new TypeError('Failed to fetch') }

function stub(routes, fallback = () => ok({})) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    for (const [frag, h] of routes) if (u.includes(frag)) return h()
    return fallback(u)
  }))
}

beforeEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

// ── Kiosk roster search ──────────────────────────────────────────────
const KIOSK = { org: { name: 'St Test', locale: 'en' }, services: [{ id: 1, title: 'Sunday Mass', time: '10:00' }], rooms: [] }
const NO_MATCH = /no members match/i
const SEARCH_BAD = /couldn'?t search the roster/i
function mountKiosk(members) {
  stub([['/members', members]], () => ok(KIOSK))
  render(
    <MemoryRouter initialEntries={['/kiosk/tok123']}>
      <LocaleProvider><Routes><Route path="/kiosk/:token" element={<Kiosk />} /></Routes></LocaleProvider>
    </MemoryRouter>
  )
}
async function search(q = 'Mar') {
  await screen.findByText(/Sunday Mass/i)
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: q } })
  await act(async () => { await new Promise(r => setTimeout(r, 400)) })
}

describe('kiosk roster search', () => {
  for (const [label, h] of [
    ['a 200 with no members list', () => ok({})],
    ['a null members list', () => ok({ members: null })],
    ['a non-JSON 200', notJson],
    ['an empty-object entry', () => ok({ members: [{}] })],
    ['an entry with a string id', () => ok({ members: [{ id: '7', name: 'Maria Ruiz' }] })],
    ['an entry without a name', () => ok({ members: [{ id: 7 }] })],
  ]) {
    it(`${label} is a failed search, not "no members match"`, async () => {
      mountKiosk(h)
      await search()
      expect(await screen.findByText(SEARCH_BAD)).toBeInTheDocument()
      expect(screen.queryByText(NO_MATCH)).not.toBeInTheDocument()
    })
  }
  it('CONTROL: a real match is offered', async () => {
    mountKiosk(() => ok({ members: [{ id: 7, name: 'Maria Ruiz' }] }))
    await search()
    expect(await screen.findByText('Maria Ruiz')).toBeInTheDocument()
    expect(screen.queryByText(SEARCH_BAD)).not.toBeInTheDocument()
  })
  it('CONTROL: a real empty answer still points at the guest button', async () => {
    mountKiosk(() => ok({ members: [] }))
    await search('Zzz')
    expect(await screen.findByText(NO_MATCH)).toBeInTheDocument()
    expect(screen.queryByText(SEARCH_BAD)).not.toBeInTheDocument()
  })
})

// ── Event attendance ─────────────────────────────────────────────────
function mountAttendance(h) {
  stub([['/api/events/5/attendance', h]])
  return render(<LocaleProvider><ToastProvider><AttendanceSection eventId={5} /></ToastProvider></LocaleProvider>)
}
const ROW = { member_id: 3, member_name: 'Synthetic Reader', member_email: null, status: null }

describe('event attendance roster', () => {
  for (const [label, h] of [
    ['a 200 with no roster', () => ok({ event_id: 5 })],
    ['a null roster', () => ok({ roster: null })],
    ['an empty-object entry', () => ok({ roster: [{}] })],
    ['a string member_id', () => ok({ roster: [{ ...ROW, member_id: '3' }] })],
    ['a missing member_name', () => ok({ roster: [{ ...ROW, member_name: undefined }] })],
    ['an unknown status', () => ok({ roster: [{ ...ROW, status: 'late' }] })],
    ['one bad entry beside a valid one', () => ok({ roster: [ROW, null] })],
  ]) {
    it(`${label} says it did not load instead of hiding the section`, async () => {
      mountAttendance(h)
      expect(await screen.findByText('Failed (malformed)')).toBeInTheDocument()
      expect(screen.queryByText('Synthetic Reader')).not.toBeInTheDocument()
    })
  }
  it('CONTROL: a refused read still reports its status', async () => {
    mountAttendance(() => err(500))
    expect(await screen.findByText('Failed (500)')).toBeInTheDocument()
  })
  it('CONTROL: a real roster renders, marks seeded', async () => {
    mountAttendance(() => ok({ roster: [ROW, { ...ROW, member_id: 4, member_name: 'Second Server', status: 'present' }] }))
    expect(await screen.findByText('Synthetic Reader')).toBeInTheDocument()
    expect(screen.getByText('Second Server')).toBeInTheDocument()
    expect(screen.queryByText(/Failed \(/)).not.toBeInTheDocument()
  })
  it('CONTROL: a real empty roster still hides the section', async () => {
    const { container } = mountAttendance(() => ok({ roster: [] }))
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).toBe(''))
  })
})

// ── Register drafts ──────────────────────────────────────────────────
const DRAFT = { id: 41, source: 'csv', status: 'pending', raw_payload: { type: 'baptism' }, draft: { type: 'baptism', member_name: 'Maria Test' } }
function mountDrafts(h) {
  stub([['/api/sacraments/drafts?', h], ['/api/clients', () => ok([])]])
  render(<MemoryRouter><LocaleProvider><ToastProvider><RegisterDrafts /></ToastProvider></LocaleProvider></MemoryRouter>)
}

describe('register drafts queue', () => {
  for (const [label, h] of [
    ['a 200 with no drafts list', () => ok({})],
    ['a null drafts list', () => ok({ drafts: null })],
    ['an empty-object entry', () => ok({ drafts: [{}] })],
    ['an entry with a string id', () => ok({ drafts: [{ ...DRAFT, id: '41' }] })],
    ['a non-JSON 200', notJson],
  ]) {
    it(`${label} is unread, not "No pending drafts"`, async () => {
      mountDrafts(h)
      expect(await screen.findByText(en['err.load'])).toBeInTheDocument()
      expect(screen.queryByText(en['drafts.emptyTitle'])).not.toBeInTheDocument()
    })
  }
  // R322-1: the editor reads d.draft and joins meta_attributes lists. A row it
  // cannot read fails the whole read into err.load: no crash, no invented
  // empty editable draft, no silently dropped row.
  const META = (m) => ({ ...DRAFT, draft: { ...DRAFT.draft, meta_attributes: m } })
  for (const [label, rows] of [
    ['a missing draft', [{ id: 41, source: 'csv' }]],
    ['a null draft', [{ ...DRAFT, draft: null }]],
    ['a string draft', [{ ...DRAFT, draft: 'baptism' }]],
    ['an array draft', [{ ...DRAFT, draft: [] }]],
    ['string godparents', [META({ godparents: 'Maria' })]],
    ['string sponsors', [META({ sponsors: 'Jose' })]],
    ['a non-string godparent name', [META({ godparents: ['Ana', { name: 'Luis' }] })]],
    ['meta_attributes not an object', [META('godparents: Ana')]],
    ['an object-valued field', [{ ...DRAFT, draft: { ...DRAFT.draft, date: { y: 1953 } } }]],
    ['an object source', [{ ...DRAFT, source: { kind: 'csv' } }]],
    ['a valid row beside a missing draft', [DRAFT, { id: 42, source: 'csv' }]],
    ['a valid row beside bad sponsors', [DRAFT, { ...META({ sponsors: 'Jose' }), id: 43 }]],
  ]) {
    it(`${label} is a read error, not a crash or a dropped row`, async () => {
      mountDrafts(() => ok({ drafts: rows }))
      expect(await screen.findByText(en['err.load'])).toBeInTheDocument()
      expect(screen.queryByText(new RegExp(`${en['drafts.original']} \\(`))).not.toBeInTheDocument()
      expect(screen.queryByText(en['drafts.emptyTitle'])).not.toBeInTheDocument()
    })
  }
  for (const [label, row, check] of [
    ['an empty draft {}', { id: 44, source: 'csv', raw_payload: {}, draft: {} }, () => {}],
    ['a draft with only a type', { id: 45, source: 'ocr', raw_payload: { t: 'b' }, draft: { type: 'baptism' } }, () => {}],
    ['null meta_attributes and null fields', { id: 46, source: 'csv', raw_payload: {}, draft: { meta_attributes: null, date: null, client_id: null } }, () => {}],
    ['godparents and sponsors lists', { id: 47, source: 'csv', raw_payload: {}, draft: { type: 'confirmation', meta_attributes: { godparents: ['Ana', 'Luis'], sponsors: ['Jose'] } } },
      () => { expect(screen.getByDisplayValue('Ana; Luis')).toBeInTheDocument(); expect(screen.getByDisplayValue('Jose')).toBeInTheDocument() }],
  ]) {
    it(`CONTROL: ${label} stays editable`, async () => {
      mountDrafts(() => ok({ drafts: [row] }))
      expect(await screen.findByText(new RegExp(`${en['drafts.original']} \\(${row.source}\\)`))).toBeInTheDocument()
      expect(screen.queryByText(en['err.load'])).not.toBeInTheDocument()
      check()
    })
  }

  it('CONTROL: a real empty queue says so', async () => {
    mountDrafts(() => ok({ drafts: [] }))
    expect(await screen.findByText(en['drafts.emptyTitle'])).toBeInTheDocument()
    expect(screen.queryByText(en['err.load'])).not.toBeInTheDocument()
  })
  it('CONTROL: a real draft renders', async () => {
    mountDrafts(() => ok({ drafts: [DRAFT] }))
    expect(await screen.findByText(new RegExp(`${en['drafts.original']} \\(csv\\)`))).toBeInTheDocument()
    expect(screen.queryByText(en['err.load'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['drafts.emptyTitle'])).not.toBeInTheDocument()
  })
})

// ── Schedule groups ──────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const EVENT = { id: 40, title: 'Group Sweep Mass', date: TODAY, start_time: '09:00', end_time: '10:00', type: 'service', assigned_to: [], group_id: null }
function mountSchedule(groups, { locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  stub([
    ['/api/groups', groups],
    ['/api/calendar/conflicts', () => ok({ conflicts: [] })],
    ['/api/calendar', () => ok([EVENT])],
    ['/api/liturgical/range', () => ok({})],
    ['/api/liturgical', () => ok({ season: 'ordinary', color: 'green' })],
    ['/api/mass-intentions', () => ok({ intentions: [] })],
    ['/api/clients', () => ok([])],
    ['/api/invoices', () => ok([])],
    ['/api/availability', () => ok({ unavailability: [] })],
  ])
  render(<MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider><Schedule /></ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>)
}
const groupsCalled = () => fetch.mock.calls.some(([u]) => String(u).includes('/api/groups'))

describe('schedule groups', () => {
  for (const [label, h] of [
    ['a 500', () => err(500)],
    ['a dropped connection', drop],
    ['a 200 with no groups list', () => ok({})],
    ['an entry with a string id', () => ok({ groups: [{ id: '1', name: 'Choir' }] })],
    ['an entry without a name', () => ok({ groups: [{ id: 1 }] })],
  ]) {
    it(`${label} says the groups did not load (toolbar)`, async () => {
      mountSchedule(h)
      expect(await screen.findByText(en['sched.groupsLoadFailed'])).toBeInTheDocument()
      expect(screen.queryByTitle(en['sched.filterGroup'])).not.toBeInTheDocument()
    })
  }
  it('the event drawer says so beside the group picker', async () => {
    mountSchedule(() => err(503))
    await screen.findByText(en['sched.groupsLoadFailed'])
    const tiles = await screen.findAllByRole('button', { name: /Group Sweep Mass/ })
    tiles[0].click()
    await waitFor(() => expect(screen.getAllByText(en['sched.groupsLoadFailed'])).toHaveLength(2))
  })
  it('follows the parish language (es)', async () => {
    mountSchedule(() => err(500), { locale: 'es' })
    expect(await screen.findByText(es['sched.groupsLoadFailed'])).toBeInTheDocument()
  })
  it('CONTROL: real groups show the filter and no note', async () => {
    mountSchedule(() => ok({ groups: [{ id: 1, name: 'Choir' }] }))
    expect(await screen.findByTitle(en['sched.filterGroup'])).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Choir' })).toBeInTheDocument()
    expect(screen.queryByText(en['sched.groupsLoadFailed'])).not.toBeInTheDocument()
  })
  it('CONTROL: a parish with no groups shows neither filter nor note', async () => {
    mountSchedule(() => ok({ groups: [] }))
    await waitFor(() => expect(groupsCalled()).toBe(true))
    await screen.findAllByRole('button', { name: /Group Sweep Mass/ })
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByTitle(en['sched.filterGroup'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['sched.groupsLoadFailed'])).not.toBeInTheDocument()
  })
})
