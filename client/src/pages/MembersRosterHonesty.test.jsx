// Members roster reads that still coerced a non-array 200 into an empty
// roll: Groups, the service planner assignee list, and the dashboard
// Members tab. A real [] may say empty. `{}`, null, and a wrapped
// object may not.

import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Groups from './Groups'
import ServicePlanner from './ServicePlanner'
import Dashboard from './Dashboard'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const MARIA = { id: 7, name: 'Maria Ruiz', role: 'Member' }
const PLAN = { id: 3, title: 'Sunday', date: '2026-09-20', elements: [] }
const STATS = { total: 2, newWeek: 0, active: 2, growth: 0 }
const FAILED = STRINGS.en['mem.listFailed']

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

function shell(ui) {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.unstubAllGlobals()
})

describe('Groups member roster', () => {
  function stub(body) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/groups')) return ok({ groups: [] })
      if (u.includes('/api/clients')) return ok(body)
      if (u.includes('/api/connect')) return ok({ interests: [] })
      return ok({})
    }))
  }

  async function openNewGroup() {
    shell(<Groups />)
    expect(await screen.findByText('No groups yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /new group/i }))
  }

  for (const [label, body] of [
    ['a 200 object', {}],
    ['a 200 null', null],
    ['a 200 wrapped list', { clients: [MARIA] }],
  ]) {
    it(`${label} says the member list failed`, async () => {
      stub(body)
      await openNewGroup()
      expect(await screen.findByText(FAILED)).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /Maria Ruiz/ })).not.toBeInTheDocument()
    })
  }

  it('CONTROL: an empty array does not say the list failed', async () => {
    stub([])
    await openNewGroup()
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
  })

  it('CONTROL: a real roster names the person', async () => {
    stub([MARIA])
    await openNewGroup()
    expect(await screen.findByRole('option', { name: /Maria Ruiz/ })).toBeInTheDocument()
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
  })
})

describe('Service planner assignee roster', () => {
  function stub(body) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (/\/api\/service-plans\/\d+/.test(u)) return ok(PLAN)
      if (u.includes('/api/service-plans')) return ok({ plans: [{ id: PLAN.id, title: PLAN.title, date: PLAN.date }] })
      if (u.includes('/api/clients')) return ok(body)
      if (u.includes('/api/organization')) return ok({ name: 'St Test' })
      if (u.includes('/api/liturgical')) return ok({ season: null, feast_name: null, color: null })
      return { ok: false, status: 404, json: async () => ({}) }
    }))
  }

  async function openAdd() {
    shell(<ServicePlanner />)
    fireEvent.click(await screen.findByRole('button', { name: /add element/i }))
  }

  for (const [label, body] of [
    ['a 200 object', {}],
    ['a 200 null', null],
    ['a 200 wrapped list', { clients: [MARIA] }],
  ]) {
    it(`${label} says the member list failed`, async () => {
      stub(body)
      await openAdd()
      expect(await screen.findByText(FAILED)).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /Maria Ruiz/ })).not.toBeInTheDocument()
    })
  }

  it('CONTROL: an empty array does not say the list failed', async () => {
    stub([])
    await openAdd()
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
  })

  it('CONTROL: a real roster names the person', async () => {
    stub([MARIA])
    await openAdd()
    expect(await screen.findByRole('option', { name: /Maria Ruiz/ })).toBeInTheDocument()
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
  })
})

describe('Dashboard member roster load', () => {
  function stub(body) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/clients/stats')) return ok(STATS)
      if (u.includes('/api/clients')) return ok(body)
      if (u.includes('/api/setup')) return ok({ dismissed_at: '2020-01-01T00:00:00.000Z' })
      if (u.includes('/api/checklists/today')) return ok({ runs: [] })
      if (u.includes('/api/checklists')) return ok([])
      if (u.includes('/api/sacraments/anniversaries')) return ok({ anniversaries: [] })
      if (u.includes('/api/onboarding')) return ok({ hasSamples: false })
      return ok([])
    }))
  }

  for (const [label, body] of [
    ['a 200 object', {}],
    ['a 200 null', null],
    ['a 200 scalar', 4],
  ]) {
    it(`${label} is not "no members" and not "no new members"`, async () => {
      stub(body)
      shell(<Dashboard />)
      expect(await screen.findByText(FAILED)).toBeInTheDocument()
      expect(screen.queryByText(STRINGS.en['dash.sum.noNew'])).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Members' }))
      expect(screen.queryByText('No members yet.')).not.toBeInTheDocument()
      expect(screen.getAllByText(FAILED).length).toBeGreaterThan(0)
    })
  }

  it('CONTROL: an empty array may say there are no members', async () => {
    stub([])
    shell(<Dashboard />)
    expect(await screen.findByText(STRINGS.en['dash.sum.noNew'])).toBeInTheDocument()
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Members' }))
    expect(await screen.findByText('No members yet.')).toBeInTheDocument()
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
  })
})
