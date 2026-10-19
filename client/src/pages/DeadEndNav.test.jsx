// Dead-end cleanup: Sunday Packet return homes + Member Outreach honesty.
//
// Defects these catch (mutate any one back and the matching test goes red):
//   1. Packet back always labelled "Worship planner" / always /service-planner
//      — including direct entry, Dashboard, and Schedule.
//   2. Dashboard Member Outreach summarised as an empty inbox
//      ("No messages pending") and/or linked at a blank /messages.
//   3. Week chrome dropping `from` so a Schedule hop becomes a Worship return.

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import SundayPacket, { packetReturnHome, packetWeekParams } from './SundayPacket'
import { DailyBriefing, MemberOutreachUnbuilt } from './Dashboard'
import ServicePlanner from './ServicePlanner'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

const PACKET = {
  parish: 'St Test',
  date: '2026-09-13',
  plan: { title: 'Sunday Mass', elements: [] },
  serving: [],
  intentions: [],
  bulletin: null,
  lectionary: null,
  liturgical: null,
}

const stubPacketFetch = () => vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url)
  if (u.includes('/api/packet')) return ok(PACKET)
  return ok({})
}))

const wrapAt = (path, node) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Routes>
            <Route path="/packet" element={node} />
            <Route path="/messages" element={node} />
            <Route path="*" element={node} />
          </Routes>
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>
  </MemoryRouter>
)

beforeEach(() => vi.unstubAllGlobals())

describe('packetReturnHome', () => {
  it('Schedule / planner keep their parents; unknown and missing go to Dashboard — never Worship', () => {
    expect(packetReturnHome('schedule')).toEqual({ to: '/schedule', labelKey: 'pkt.backSchedule' })
    expect(packetReturnHome('planner')).toEqual({ to: '/service-planner', labelKey: 'pkt.back' })
    expect(packetReturnHome('dashboard')).toEqual({ to: '/', labelKey: 'pkt.backDashboard' })
    expect(packetReturnHome(null)).toEqual({ to: '/', labelKey: 'pkt.backDashboard' })
    expect(packetReturnHome('worship')).toEqual({ to: '/', labelKey: 'pkt.backDashboard' })
  })

  it('week nav keeps a known from and drops an unknown one', () => {
    expect(packetWeekParams('2026-09-20', 'schedule')).toEqual({ date: '2026-09-20', from: 'schedule' })
    expect(packetWeekParams('2026-09-20', 'nope')).toEqual({ date: '2026-09-20' })
    expect(packetWeekParams('2026-09-20', null)).toEqual({ date: '2026-09-20' })
  })
})

describe('Sunday Packet return link', () => {
  it('direct entry and unknown from go to Dashboard, not the Worship planner', async () => {
    stubPacketFetch()
    wrapAt('/packet', <SundayPacket />)
    const link = await screen.findByRole('link', { name: /dashboard/i })
    expect(link.getAttribute('href')).toBe('/')
    expect(screen.queryByRole('link', { name: /worship planner/i })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('St Test')).toBeInTheDocument())
  })

  it('from=schedule returns to Schedule and keeps from across the next-week hop', async () => {
    stubPacketFetch()
    wrapAt('/packet?date=2026-09-13&from=schedule', <SundayPacket />)
    const back = await screen.findByRole('link', { name: /^schedule$/i })
    expect(back.getAttribute('href')).toBe('/schedule')
    expect(screen.queryByRole('link', { name: /worship planner/i })).not.toBeInTheDocument()
    screen.getByRole('button', { name: /next sunday/i }).click()
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /^schedule$/i }).getAttribute('href')).toBe('/schedule')
    })
  })

  it('from=planner is the only path that says Worship planner', async () => {
    stubPacketFetch()
    wrapAt('/packet?date=2026-09-13&from=planner', <SundayPacket />)
    const back = await screen.findByRole('link', { name: /worship planner/i })
    expect(back.getAttribute('href')).toBe('/service-planner')
  })

  it('from=dashboard returns to the dashboard', async () => {
    stubPacketFetch()
    wrapAt('/packet?from=dashboard', <SundayPacket />)
    const back = await screen.findByRole('link', { name: /dashboard/i })
    expect(back.getAttribute('href')).toBe('/')
  })
})

describe('Dashboard Member Outreach', () => {
  it('does not claim an empty inbox and does not link /messages', () => {
    render(
      <MemoryRouter>
        <LocaleProvider>
          <DailyBriefing data={{ calEvents: [], schedule: [], tasks: [], members: [] }} />
        </LocaleProvider>
      </MemoryRouter>
    )
    expect(screen.getByText('Member Outreach')).toBeInTheDocument()
    expect(screen.getByText(/not built yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/no messages pending/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /member outreach/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /open member outreach/i })).not.toBeInTheDocument()
    const hrefs = [...document.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).not.toContain('/messages')
  })

  it('the /messages route looks unfinished, not empty or successful', () => {
    wrapAt('/messages', <MemberOutreachUnbuilt />)
    expect(screen.getByText('Member outreach is not built')).toBeInTheDocument()
    expect(screen.getByText(/does not have a messages inbox/i)).toBeInTheDocument()
    expect(screen.getByText(/nothing was lost/i)).toBeInTheDocument()
    expect(screen.queryByText(/no messages pending/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dashboard/i })).toBeInTheDocument()
  })
})

describe('Worship planner Packet hop', () => {
  it('carries from=planner on the Sunday Packet link', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.endsWith('/api/service-plans')) return ok({
        plans: [{ id: 9, date: '2026-09-13', title: 'Sunday Mass', element_count: 1 }],
      })
      if (u.includes('/api/service-plans/9')) return ok({
        id: 9, date: '2026-09-13', title: 'Sunday Mass', elements: [],
      })
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/organization')) return ok({ name: 'St Test' })
      if (u.includes('/api/liturgical')) return ok({ season: null, feast_name: null, color: null })
      return ok({})
    }))
    render(
      <MemoryRouter>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <ServicePlanner />
            </ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>
    )
    const link = await screen.findByRole('link', { name: /sunday packet/i })
    expect(link.getAttribute('href')).toBe('/packet?date=2026-09-13&from=planner')
  })
})
