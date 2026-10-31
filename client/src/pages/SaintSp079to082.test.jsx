// Saint SP-079..082, role Staff, main 36a761b.
//
// SP-079: Service Planner print asked GET /api/organization, which is
//   admin-only, so Staff saw "the parish name did not load" and a reload
//   could not fix it. The page now asks for the display name only.
// SP-080: at phone width the packet Print control was clipped. The week
//   chrome wraps and Print does not shrink. jsdom does not layout; this
//   pins the same contract as the weekly sheet.
// SP-081: ⌘K "sacristy" and Help "packet" found nothing.
// SP-082: no service plan for the date omitted the order of worship
//   with no word said. A plan that exists with no parts is not "no plan".

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import SundayPacket from './SundayPacket'
import ServicePlanner, { planDateFromSearch } from './ServicePlanner'
import HelpPanel from '../components/HelpPanel'
import GlobalSearchPalette, { pageCommandsForQuery } from '../components/GlobalSearchPalette'

const { auth } = vi.hoisted(() => ({ auth: { role: 'staff' } }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Sacristan', role: auth.role, organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't',
    loading: false,
    canWrite: auth.role !== 'viewer',
    isAdmin: auth.role === 'admin',
  }),
}))

const { en, es } = STRINGS
const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const refused = (status = 403) => ({ ok: false, status, json: async () => ({ error: 'Forbidden' }) })

const PLAN = { id: 7, date: '2026-10-04', title: 'Sunday Mass', element_count: 1 }
const DETAIL = { ...PLAN, elements: [{ id: 1, kind: 'reading', title: 'Gospel', reference: 'John 1' }] }

function packetBody(plan) {
  return {
    parish: 'St Test',
    date: '2026-09-13',
    plan,
    serving: [{ title: 'Sunday Mass', start_time: '09:00:00', assigned: [] }],
    intentions: [],
    bulletin: null,
    lectionary: null,
    liturgical: null,
  }
}

function mountPacketResponse(body, { httpStatus = 200 } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/api/packet')) {
      if (httpStatus !== 200) return refused(httpStatus)
      return ok(body)
    }
    return ok({})
  }))
  return render(
    <MemoryRouter initialEntries={['/packet?date=2026-09-13&from=dashboard']}>
      <LocaleProvider>
        <Routes>
          <Route path="/packet" element={<SundayPacket />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

function mountPacket(plan) {
  return mountPacketResponse(packetBody(plan))
}

function packetWithoutPlan() {
  const body = packetBody(null)
  delete body.plan
  return body
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

beforeEach(() => {
  auth.role = 'staff'
  vi.unstubAllGlobals()
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('SP-079 service planner asks for the display name', () => {
  function stubPlanner(display = ok({ name: 'St Test' })) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (/\/api\/service-plans\/\d+/.test(u)) return ok(DETAIL)
      if (u.includes('/api/service-plans')) return ok({ plans: [PLAN] })
      if (u.includes('/api/clients')) return ok([])
      if (u.includes('/api/organization/display-name')) return display
      if (u.includes('/api/organization')) return ok({ name: 'LEAKED SETTINGS', tax_id: 'EIN-LEAK' })
      if (u.includes('/api/liturgical')) return ok({ season: null, feast_name: null, color: null })
      return ok(null)
    }))
  }

  function mountPlanner(entry = '/service-planner') {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <ServicePlanner />
            </ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>,
    )
  }

  it('loads the parish name from the display-name read, not the admin settings', async () => {
    stubPlanner()
    mountPlanner()
    expect(await screen.findByText('Sunday Mass')).toBeInTheDocument()
    expect(screen.queryByText(en['plan.orgUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText('EIN-LEAK')).not.toBeInTheDocument()
    expect(screen.queryByText('LEAKED SETTINGS')).not.toBeInTheDocument()
    const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('/api/organization/display-name'))).toBe(true)
    expect(urls.some(u => /\/api\/organization\/?(?:\?|$)/.test(u))).toBe(false)
  })

  it('a refused display name is a real failure, and reload copy stays for that case', async () => {
    stubPlanner(refused(500))
    mountPlanner()
    expect(await screen.findByText(en['plan.orgUnread'])).toBeInTheDocument()
  })

  it('opens the new-plan date on the Sunday the packet was showing', async () => {
    stubPlanner(ok({ name: 'St Test' }))
    mountPlanner('/service-planner?date=2026-09-13')
    expect(await screen.findByLabelText(en['plan.newDate'])).toHaveValue('2026-09-13')
  })
})

describe('planDateFromSearch', () => {
  it('keeps a civil day and ignores anything else', () => {
    expect(planDateFromSearch('?date=2026-09-13', '2026-10-04')).toBe('2026-09-13')
    expect(planDateFromSearch('?date=nope', '2026-10-04')).toBe('2026-10-04')
    expect(planDateFromSearch('', '2026-10-04')).toBe('2026-10-04')
  })
})

describe('SP-080 packet Print stays whole at phone width', () => {
  it('lets the week cluster wrap so Print does not shrink', async () => {
    mountPacket({ title: 'Sunday Mass', elements: [{ kind: 'hymn', title: 'Gather' }] })
    const print = await screen.findByRole('button', { name: /^print$/i })
    expect(print.textContent).toMatch(/^\s*Print\s*$/)
    expect(print.className).toMatch(/shrink-0/)
    expect(print.className).not.toMatch(/truncate|ellipsis/)
    const chrome = screen.getByTestId('packet-week-chrome')
    expect(chrome.contains(print)).toBe(true)
    expect(chrome.className).toMatch(/flex-wrap/)
    expect(chrome.className).toMatch(/min-w-0/)
    expect(chrome.className).toMatch(/max-w-full/)
    const range = screen.getByTestId('packet-week-range')
    expect(chrome.contains(range)).toBe(true)
    expect(range.className).toMatch(/min-w-0/)
    expect(range.className).toMatch(/sm:min-w-\[11rem\]/)
    expect(range.className).not.toMatch(/(^|\s)min-w-\[11rem\]/)
  })

  it('keeps the Spanish Print label whole in the same wrapping chrome', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mountPacket({ title: 'Sunday Mass', elements: [{ kind: 'hymn', title: 'Gather' }] })
    const print = await screen.findByRole('button', { name: /^imprimir$/i })
    expect(print.textContent).toMatch(/^\s*Imprimir\s*$/)
    expect(print.className).toMatch(/shrink-0/)
    expect(screen.getByTestId('packet-week-chrome').contains(print)).toBe(true)
  })
})

describe('SP-082 no order of worship for this date', () => {
  it('says there is no plan and links to Worship on that date', async () => {
    mountPacket(null)
    const section = await screen.findByTestId('pkt-no-plan')
    expect(section).toHaveTextContent(en['pkt.noPlan'])
    expect(section).toHaveTextContent(en['pkt.order'])
    const link = screen.getByTestId('pkt-create-plan')
    expect(link).toHaveTextContent(en['pkt.createPlan'])
    expect(link.getAttribute('href')).toBe('/service-planner?date=2026-09-13')
    expect(link.className).toMatch(/print:hidden/)
    expect(screen.getByText('Sunday Mass')).toBeInTheDocument()
    expect(screen.queryByText(en['pkt.empty'])).not.toBeInTheDocument()
  })

  it('says the same in Spanish', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mountPacket(null)
    const section = await screen.findByTestId('pkt-no-plan')
    expect(section).toHaveTextContent(es['pkt.noPlan'])
    expect(screen.getByTestId('pkt-create-plan')).toHaveTextContent(es['pkt.createPlan'])
    expect(section).not.toHaveTextContent(en['pkt.noPlan'])
  })

  it('does not call a plan with no parts a missing plan', async () => {
    mountPacket({ title: 'Sunday Mass', elements: [] })
    expect(await screen.findByText('Sunday Mass')).toBeInTheDocument()
    expect(screen.queryByTestId('pkt-no-plan')).not.toBeInTheDocument()
    expect(screen.queryByText(en['pkt.noPlan'])).not.toBeInTheDocument()
  })

  it('lists the order when the plan has parts', async () => {
    mountPacket({ title: 'Sunday Mass', elements: [{ kind: 'hymn', title: 'Gather', reference: null }] })
    expect(await screen.findByText('Gather')).toBeInTheDocument()
    expect(screen.queryByTestId('pkt-no-plan')).not.toBeInTheDocument()
  })
})

// R346-2. !packet.plan treated omitted, false, 0, and '' as a confirmed
// missing plan. Only explicit null is that fact. A plan object with an
// elements array is a plan, including an empty array. Anything else is
// the existing unread error, and a failed HTTP response stays that path.
describe('R346-2 an unreadable plan is not a confirmed missing plan', () => {
  const unreadShapes = [
    ['plan omitted', packetWithoutPlan()],
    ['plan false', packetBody(false)],
    ['plan zero', packetBody(0)],
    ['plan empty string', packetBody('')],
    ['plan object without elements', packetBody({ title: 'Sunday Mass' })],
    ['plan elements not an array', packetBody({ title: 'Sunday Mass', elements: 'Gather' })],
    ['plan elements null', packetBody({ elements: null })],
    ['plan is an array', packetBody([{ kind: 'hymn', title: 'Gather' }])],
  ]

  for (const [locale, strings, other] of [['en', en, es], ['es', es, en]]) {
    for (const [label, body] of unreadShapes) {
      it(`${locale}: ${label} shows the load error and no create prompt`, async () => {
        if (locale === 'es') localStorage.setItem('ochr_locale', 'es')
        mountPacketResponse(body)
        expect(await screen.findByText(strings['pkt.loadError'])).toBeInTheDocument()
        expect(screen.queryByText(strings['pkt.noPlan'])).not.toBeInTheDocument()
        expect(screen.queryByText(other['pkt.noPlan'])).not.toBeInTheDocument()
        expect(screen.queryByTestId('pkt-no-plan')).not.toBeInTheDocument()
        expect(screen.queryByTestId('pkt-create-plan')).not.toBeInTheDocument()
        expect(screen.queryByText('St Test')).not.toBeInTheDocument()
      })
    }

    it(`${locale}: explicit null is no plan for this date`, async () => {
      if (locale === 'es') localStorage.setItem('ochr_locale', 'es')
      mountPacket(null)
      const section = await screen.findByTestId('pkt-no-plan')
      expect(section).toHaveTextContent(strings['pkt.noPlan'])
      expect(screen.getByTestId('pkt-create-plan')).toHaveTextContent(strings['pkt.createPlan'])
      expect(screen.queryByText(strings['pkt.loadError'])).not.toBeInTheDocument()
      expect(screen.queryByText(other['pkt.noPlan'])).not.toBeInTheDocument()
    })

    it(`${locale}: a plan with an empty elements array is a plan`, async () => {
      if (locale === 'es') localStorage.setItem('ochr_locale', 'es')
      mountPacket({ title: 'Sunday Mass', elements: [] })
      expect(await screen.findByText('Sunday Mass')).toBeInTheDocument()
      expect(screen.queryByTestId('pkt-no-plan')).not.toBeInTheDocument()
      expect(screen.queryByText(strings['pkt.noPlan'])).not.toBeInTheDocument()
      expect(screen.queryByText(strings['pkt.loadError'])).not.toBeInTheDocument()
    })

    it(`${locale}: a failed packet request stays the load error`, async () => {
      if (locale === 'es') localStorage.setItem('ochr_locale', 'es')
      mountPacketResponse(packetBody(null), { httpStatus: 500 })
      expect(await screen.findByText(strings['pkt.loadError'])).toBeInTheDocument()
      expect(screen.queryByTestId('pkt-no-plan')).not.toBeInTheDocument()
      expect(screen.queryByText(strings['pkt.noPlan'])).not.toBeInTheDocument()
      expect(screen.queryByTestId('pkt-create-plan')).not.toBeInTheDocument()
    })
  }
})

describe('SP-081 the packet can be found', () => {
  it('Help search for packet finds the entry in English and Spanish', async () => {
    const { unmount } = render(
      <LocaleProvider>
        <HelpPanel open onClose={() => {}} />
      </LocaleProvider>,
    )
    fireEvent.change(screen.getByPlaceholderText(en['help.searchPh']), { target: { value: 'packet' } })
    expect(screen.getByText(en['help.packetTitle'])).toBeInTheDocument()
    expect(screen.getByText(en['help.packetBody'])).toBeInTheDocument()
    unmount()

    localStorage.setItem('ochr_locale', 'es')
    render(
      <LocaleProvider>
        <HelpPanel open onClose={() => {}} />
      </LocaleProvider>,
    )
    fireEvent.change(screen.getByPlaceholderText(es['help.searchPh']), { target: { value: 'paquete' } })
    expect(screen.getByText(es['help.packetTitle'])).toBeInTheDocument()
    expect(screen.getByText(es['help.packetBody'])).toBeInTheDocument()
    expect(screen.queryByText(en['help.packetBody'])).not.toBeInTheDocument()
  })

  it('the Worship guide and the FAQ carry the entry', () => {
    render(
      <LocaleProvider>
        <HelpPanel open onClose={() => {}} />
      </LocaleProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Worship' }))
    const guide = screen.getByTestId('help-packet-entry')
    expect(guide).toHaveTextContent(en['help.packetTitle'])
    expect(guide).toHaveTextContent('sacristy')
    fireEvent.click(screen.getByRole('button', { name: en['help.tabFaq'] }))
    fireEvent.click(screen.getByRole('button', { name: en['help.packetTitle'] }))
    expect(screen.getByText(en['help.packetBody'])).toBeInTheDocument()
  })

  it('Staff ⌘K sacristy opens the Sunday Packet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok([])))
    render(
      <LocaleProvider>
        <MemoryRouter initialEntries={['/']}>
          <LocationProbe />
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>,
    )
    fireEvent.change(screen.getByLabelText(en['shell.search.query']), { target: { value: 'sacristy' } })
    const row = await screen.findByRole('button', { name: /Sunday Packet/i })
    expect(row).toHaveTextContent(en['shell.cmd.packetHint'])
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(c => String(c[0]).includes('/api/search'))).toBe(true))
    await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull())
    expect(screen.queryByText(new RegExp(en['shell.search.noneBefore']))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Sunday Packet/i }))
    expect(screen.getByTestId('loc').textContent).toBe('/packet')
  })

  it('a Spanish session finds it as paquete', async () => {
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn(async () => ok([])))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>,
    )
    fireEvent.change(screen.getByLabelText(es['shell.search.query']), { target: { value: 'paquete' } })
    expect(await screen.findByRole('button', { name: /Paquete dominical/i })).toBeInTheDocument()
  })

  it('a Viewer searching sacristy is not offered the packet', async () => {
    auth.role = 'viewer'
    vi.stubGlobal('fetch', vi.fn(async () => ok([])))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>,
    )
    fireEvent.change(screen.getByLabelText(en['shell.search.query']), { target: { value: 'sacristy' } })
    await waitFor(() => {
      expect(screen.getByText(new RegExp(en['shell.search.noneBefore']))).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /Sunday Packet/i })).toBeNull()
  })

  it('pageCommandsForQuery is staff and admin only, and matches both languages', () => {
    expect(pageCommandsForQuery('sacristy', 'staff').map(c => c.to)).toEqual(['/packet'])
    expect(pageCommandsForQuery('sacristía', 'admin').map(c => c.to)).toEqual(['/packet'])
    expect(pageCommandsForQuery('paquete', 'staff').map(c => c.to)).toEqual(['/packet'])
    expect(pageCommandsForQuery('sacristy', 'viewer')).toEqual([])
    expect(pageCommandsForQuery('sa', 'staff')).toEqual([])
    expect(pageCommandsForQuery('john', 'staff')).toEqual([])
  })
})
