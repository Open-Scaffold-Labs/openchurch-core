// SP-078 (Saint, 20 Oct): assigning a Mass silently moved an intention
// from Open to Scheduled, and releasing it silently moved it back. The
// confirmation now names the new status — only when the server's
// confirmed row actually changed status.
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from './ToastProvider'
import MassIntentionAssign from './MassIntentionAssign'
import { MODULE_HELP } from '../data/helpContent'

const authState = vi.hoisted(() => ({ locale: 'en' }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: authState.locale } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const { en, es } = STRINGS
const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const event = { id: 40, date: '2027-06-08', title: '9am Mass', type: 'service' }
const wrap = (node) => render(<MemoryRouter><LocaleProvider><ToastProvider>{node}</ToastProvider></LocaleProvider></MemoryRouter>)
const OPEN = { id: 7, intention: '† Rivera', requested_by: 'The family', calendar_event_id: null, status: 'open' }
const SCHED = { id: 3, intention: '† Ana', requested_by: 'Ana', calendar_event_id: 40, status: 'scheduled' }

function stub({ assigned, released }) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    const u = String(url)
    if (u.includes('/awaiting')) return ok({ intentions: [OPEN] })
    if (u.includes('/unassign') && opts?.method === 'POST') return ok(released)
    if (u.includes('/assign') && opts?.method === 'POST') return ok(assigned)
    return ok({})
  }))
}

beforeEach(() => { authState.locale = 'en'; vi.unstubAllGlobals() })

describe('SP-078 assign/release say when the status changed', () => {
  it('assigning an Open intention says it is now Scheduled', async () => {
    stub({ assigned: { ...OPEN, calendar_event_id: 40, status: 'scheduled' } })
    wrap(<MassIntentionAssign event={event} assigned={[]} />)
    { const b = await screen.findByRole('button', { name: /offer at this mass/i }); await act(async () => { fireEvent.click(b) }) }
    expect(await screen.findByText(`${en['sched.assignedToast']} ${en['mi.status']}: ${en['mi.scheduled']}.`)).toBeInTheDocument()
  })

  it('releasing a Scheduled intention says it is back to Open', async () => {
    stub({ released: { ...SCHED, calendar_event_id: null, status: 'open' } })
    wrap(<MassIntentionAssign event={event} assigned={[SCHED]} />)
    { const b = await screen.findByRole('button', { name: /release: † ana/i }); await act(async () => { fireEvent.click(b) }) }
    { const c = await screen.findByTestId('mi-release-confirm'); await act(async () => { fireEvent.click(c) }) }
    expect(await screen.findByText(`${en['sched.releasedToast']} ${en['mi.status']}: ${en['mi.open']}.`)).toBeInTheDocument()
  })

  it('Spanish session uses the Spanish status words', async () => {
    authState.locale = 'es'
    stub({ assigned: { ...OPEN, calendar_event_id: 40, status: 'scheduled' } })
    wrap(<MassIntentionAssign event={event} assigned={[]} />)
    { const b = await screen.findByRole('button', { name: /ofrecer en esta misa/i }); await act(async () => { fireEvent.click(b) }) }
    expect(await screen.findByText(`${es['sched.assignedToast']} ${es['mi.status']}: ${es['mi.scheduled']}.`)).toBeInTheDocument()
  })

  it('control: no status change confirmed, no status sentence', async () => {
    stub({ assigned: { ...OPEN, status: 'open' } })
    wrap(<MassIntentionAssign event={event} assigned={[]} />)
    { const b = await screen.findByRole('button', { name: /offer at this mass/i }); await act(async () => { fireEvent.click(b) }) }
    expect(await screen.findByText(en['sched.assignedToast'])).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(`${en['mi.status']}:`))).toBeNull()
  })

  it('Help "Status meanings" says assigning schedules and releasing reopens', () => {
    const s = MODULE_HELP.massIntentions?.sections?.find(x => x.title === 'Status meanings')
      || Object.values(MODULE_HELP).flatMap(m => m.sections || []).find(x => x.title === 'Status meanings')
    const sched = s.items.find(i => i.label === 'Scheduled').desc
    expect(sched).toMatch(/Scheduled automatically/)
    expect(sched).toMatch(/back to Open/)
  })
})
