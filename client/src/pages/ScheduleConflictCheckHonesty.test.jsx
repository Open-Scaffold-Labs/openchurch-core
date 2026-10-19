// Schedule event modal: a failed or malformed conflict check
// (/api/calendar/conflicts) or availability check (/api/availability) used
// to become [] — no warning, identical to "nobody is double-booked" and
// "everyone is available". UNKNOWN is not EMPTY: the modal now says the
// check did not complete. Saving stays non-blocking, as before. Real
// conflicts and real unavailability still render; a clean check shows no
// note. jsdom only.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { EventModal } from './Schedule'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const MEMBERS = [{ id: 3, name: 'Synthetic Reader' }]
const EVENT = {
  id: 17, title: 'Vigil', date: '2026-11-04', start_time: '08:00', end_time: '09:00',
  type: 'meeting', assigned_to: [3],
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = (status = 500) => ({ ok: false, status, json: async () => ({ error: 'no' }) })
const CONFLICT = { id: 99, title: 'Choir rehearsal', start_time: '08:30', end_time: '09:30', conflicting_members: [{ id: 3, name: 'Synthetic Reader' }] }

function stub({ conflicts, availability }) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/calendar/conflicts')) return typeof conflicts === 'function' ? conflicts() : conflicts
    if (u.includes('/api/availability')) return typeof availability === 'function' ? availability() : availability
    if (u.includes('/api/liturgical')) return ok({ season: 'Ordinary Time', color: 'Green' })
    if (u.includes('/api/invoices')) return ok({ invoices: [] })
    if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
    return ok({})
  }))
}
const calls = (part) => fetch.mock.calls.filter(([u]) => String(u).includes(part)).length

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
// Per-endpoint queue: each call takes the next entry; the last one repeats.
function stubQueue({ conflicts, availability }) {
  const take = (q) => { const v = q.length > 1 ? q.shift() : q[0]; return typeof v === 'function' ? v() : v }
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/calendar/conflicts')) return take(conflicts)
    if (u.includes('/api/availability')) return take(availability)
    if (u.includes('/api/liturgical')) return ok({ season: 'Ordinary Time', color: 'Green' })
    if (u.includes('/api/invoices')) return ok({ invoices: [] })
    if (u.includes('/api/mass-intentions')) return ok({ intentions: [] })
    return ok({})
  }))
}

function mount({ locale } = {}) {
  if (locale) localStorage.setItem('ochr_locale', locale)
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <EventModal event={EVENT} onClose={() => {}} onSave={() => {}} onDelete={() => {}} members={MEMBERS} />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}
const en = STRINGS.en
const es = STRINGS.es
const CLEAN = { conflicts: ok({ conflicts: [] }), availability: ok({ unavailability: [] }) }

beforeEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

describe('conflict check that did not complete', () => {
  for (const [label, conflicts] of [
    ['a refused (500) check', refused(500)],
    ['a network failure', () => { throw new TypeError('Failed to fetch') }],
    ['a malformed 200 body', ok({ rows: [] })],
  ]) {
    it(`${label} says so instead of showing no conflicts; saving stays available`, async () => {
      stub({ ...CLEAN, conflicts })
      mount()
      expect(await screen.findByText(en['sched.conflictCheckFailed'], {}, { timeout: 2000 })).toBeInTheDocument()
      expect(calls('/api/calendar/conflicts')).toBeGreaterThanOrEqual(1)
      expect(screen.queryByText('Schedule conflict')).not.toBeInTheDocument()
      expect(screen.queryByText(en['sched.availabilityCheckFailed'])).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    })
  }

  it('follows the parish language (es)', async () => {
    stub({ ...CLEAN, conflicts: refused(503) })
    mount({ locale: 'es' })
    expect(await screen.findByText(es['sched.conflictCheckFailed'], {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.queryByText(en['sched.conflictCheckFailed'])).not.toBeInTheDocument()
  })
})

describe('availability check that did not complete', () => {
  for (const [label, availability] of [
    ['a refused (500) read', refused(500)],
    ['a network failure', () => { throw new TypeError('Failed to fetch') }],
    ['a malformed 200 body', ok({ items: [] })],
  ]) {
    it(`${label} says so instead of showing everyone available`, async () => {
      stub({ ...CLEAN, availability })
      mount()
      expect(await screen.findByText(en['sched.availabilityCheckFailed'], {}, { timeout: 2000 })).toBeInTheDocument()
      expect(screen.queryByText('Member unavailable')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    })
  }
})

describe('controls', () => {
  it('a clean check shows neither note nor warning', async () => {
    stub(CLEAN)
    mount()
    await waitFor(() => expect(calls('/api/calendar/conflicts')).toBeGreaterThanOrEqual(1), { timeout: 2000 })
    await waitFor(() => expect(calls('/api/availability')).toBeGreaterThanOrEqual(1))
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByText(en['sched.conflictCheckFailed'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['sched.availabilityCheckFailed'])).not.toBeInTheDocument()
    expect(screen.queryByText('Schedule conflict')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('a real conflict and real unavailability still render, with Save anyway', async () => {
    stub({ conflicts: ok({ conflicts: [CONFLICT] }), availability: ok({ unavailability: [{ client_id: 3 }] }) })
    mount()
    expect(await screen.findByText('Schedule conflict', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByText('Choir rehearsal')).toBeInTheDocument()
    expect(await screen.findByText('Member unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save anyway' })).toBeEnabled()
    expect(screen.queryByText(en['sched.conflictCheckFailed'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['sched.availabilityCheckFailed'])).not.toBeInTheDocument()
  })
})

// R321-1: every consumed entry is validated before a result is committed.
// One unusable entry makes the whole check UNKNOWN: the modal stays up and
// shows the amber note, never a crash or a shortened clean-looking result.
describe('malformed entries fail the whole check into the note', () => {
  const GOOD = CONFLICT
  for (const [label, list] of [
    ['an empty object entry', [{}]],
    ['a null entry', [null]],
    ['a non-object entry', ['x']],
    ['conflicting_members not an array', [{ ...GOOD, conflicting_members: 'Synthetic Reader' }]],
    ['a null member', [{ ...GOOD, conflicting_members: [null] }]],
    ['a member without a name', [{ ...GOOD, conflicting_members: [{ id: 3 }] }]],
    ['a non-string start_time', [{ ...GOOD, start_time: 830 }]],
    ['a missing id', [{ ...GOOD, id: undefined }]],
    ['one bad entry beside a valid one', [GOOD, {}]],
  ]) {
    it(`conflicts: ${label}`, async () => {
      stub({ ...CLEAN, conflicts: ok({ conflicts: list }) })
      mount()
      expect(await screen.findByText(en['sched.conflictCheckFailed'], {}, { timeout: 2000 })).toBeInTheDocument()
      expect(screen.queryByText('Schedule conflict')).not.toBeInTheDocument()
      expect(screen.queryByText('Choir rehearsal')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    })
  }

  for (const [label, list] of [
    ['an empty object entry', [{}]],
    ['a null entry', [null]],
    ['a non-object entry', [3]],
    ['a string client_id', [{ client_id: '3' }]],
    ['a zero client_id', [{ client_id: 0 }]],
    ['a fractional client_id', [{ client_id: 3.5 }]],
    ['one bad entry beside a valid one', [{ client_id: 3 }, {}]],
  ]) {
    it(`availability: ${label}`, async () => {
      stub({ ...CLEAN, availability: ok({ unavailability: list }) })
      mount()
      expect(await screen.findByText(en['sched.availabilityCheckFailed'], {}, { timeout: 2000 })).toBeInTheDocument()
      expect(screen.queryByText('Member unavailable')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    })
  }

  it('valid control: an unavailability entry for someone not assigned is a clean check', async () => {
    stub({ ...CLEAN, availability: ok({ unavailability: [{ client_id: 44 }] }) })
    mount()
    await waitFor(() => expect(calls('/api/availability')).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(calls('/api/calendar/conflicts')).toBeGreaterThanOrEqual(1), { timeout: 2000 })
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByText(en['sched.availabilityCheckFailed'])).not.toBeInTheDocument()
    expect(screen.queryByText('Member unavailable')).not.toBeInTheDocument()
  })
})

// A response from an obsolete check (the inputs changed after it was sent)
// must not overwrite the current result, whether it succeeds or fails.
describe('stale responses do not overwrite the current result', () => {
  const changeDate = (container) => {
    fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: '2026-11-05' } })
  }

  it('conflicts: a stale success after a newer failure leaves the failure note', async () => {
    const first = deferred()
    stubQueue({ conflicts: [() => first.promise, refused(500)], availability: [ok({ unavailability: [] })] })
    const { container } = mount()
    await waitFor(() => expect(calls('/api/calendar/conflicts')).toBe(1), { timeout: 2000 })
    changeDate(container)
    expect(await screen.findByText(en['sched.conflictCheckFailed'], {}, { timeout: 2000 })).toBeInTheDocument()
    await act(async () => { first.resolve(ok({ conflicts: [CONFLICT] })); await new Promise(r => setTimeout(r, 50)) })
    expect(screen.getByText(en['sched.conflictCheckFailed'])).toBeInTheDocument()
    expect(screen.queryByText('Schedule conflict')).not.toBeInTheDocument()
  })

  it('conflicts: a stale failure after a newer success leaves the real conflict', async () => {
    const first = deferred()
    stubQueue({ conflicts: [() => first.promise, ok({ conflicts: [CONFLICT] })], availability: [ok({ unavailability: [] })] })
    const { container } = mount()
    await waitFor(() => expect(calls('/api/calendar/conflicts')).toBe(1), { timeout: 2000 })
    changeDate(container)
    expect(await screen.findByText('Schedule conflict', {}, { timeout: 2000 })).toBeInTheDocument()
    await act(async () => { first.resolve(refused(500)); await new Promise(r => setTimeout(r, 50)) })
    expect(screen.getByText('Schedule conflict')).toBeInTheDocument()
    expect(screen.queryByText(en['sched.conflictCheckFailed'])).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save anyway' })).toBeEnabled()
  })

  it('availability: a stale success after a newer failure leaves the failure note', async () => {
    const first = deferred()
    stubQueue({ conflicts: [ok({ conflicts: [] })], availability: [() => first.promise, refused(500)] })
    const { container } = mount()
    await waitFor(() => expect(calls('/api/availability')).toBe(1))
    changeDate(container)
    expect(await screen.findByText(en['sched.availabilityCheckFailed'], {}, { timeout: 2000 })).toBeInTheDocument()
    await act(async () => { first.resolve(ok({ unavailability: [{ client_id: 3 }] })); await new Promise(r => setTimeout(r, 50)) })
    expect(screen.getByText(en['sched.availabilityCheckFailed'])).toBeInTheDocument()
    expect(screen.queryByText('Member unavailable')).not.toBeInTheDocument()
  })

  it('availability: a stale failure after a newer success leaves the real unavailability', async () => {
    const first = deferred()
    stubQueue({ conflicts: [ok({ conflicts: [] })], availability: [() => first.promise, ok({ unavailability: [{ client_id: 3 }] })] })
    const { container } = mount()
    await waitFor(() => expect(calls('/api/availability')).toBe(1))
    changeDate(container)
    expect(await screen.findByText('Member unavailable', {}, { timeout: 2000 })).toBeInTheDocument()
    await act(async () => { first.resolve(refused(500)); await new Promise(r => setTimeout(r, 50)) })
    expect(screen.getByText('Member unavailable')).toBeInTheDocument()
    expect(screen.queryByText(en['sched.availabilityCheckFailed'])).not.toBeInTheDocument()
  })
})
