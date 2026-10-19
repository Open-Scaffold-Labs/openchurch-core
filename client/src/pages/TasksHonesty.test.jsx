// Daily Tasks already refuses to call a failed read an empty parish.
// The sentences that say so were still hard-coded English, so a Spanish
// office heard the failure in the wrong language. These keys already
// exist in both locales. A failed read must not render the first-run card.

import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Tasks, { LinkedEvents } from './Tasks'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const es = STRINGS.es
const en = STRINGS.en
const STATS = { total: 1, completed: 0, in_progress: 0, high_pending: 0 }
const MARIA = { id: 7, name: 'Maria Ruiz', role: 'Member' }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const fail = () => ({ ok: false, status: 503, json: async () => ({ error: 'down' }) })

function task(id) {
  return {
    id, title: `Open the church ${id}`, category: 'OPENING', status: 'PENDING',
    priority: 'LOW', checklist: [],
  }
}

function mount(ui) {
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

// A macrotask runs after the fetch microtasks and the setState they queue,
// so a negative assertion is looking at the settled screen.
async function settled() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

afterEach(() => {
  localStorage.removeItem('ochr_locale')
  vi.unstubAllGlobals()
})

function spanish() {
  localStorage.setItem('ochr_locale', 'es')
}

describe('Tasks list honesty in Spanish', () => {
  it('a refused list says the load failed, not that the parish has no tasks', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/tasks/stats')) return fail()
      if (u.includes('/api/tasks')) return fail()
      return ok({})
    }))
    mount(<Tasks />)
    expect(await screen.findByText(es['load.failedTitle'])).toBeInTheDocument()
    expect(screen.getByText(es['load.failedBody'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es['error.tryAgain'] })).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en['error.tryAgain'] })).not.toBeInTheDocument()
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument()
    expect(screen.queryByText("Some tasks didn't load.")).not.toBeInTheDocument()
  })

  it('CONTROL: a real empty list does not say the load failed', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/tasks/stats')) return ok({ total: 0, completed: 0, in_progress: 0, high_pending: 0 })
      if (u.includes('/api/tasks')) return ok([])
      return ok({})
    }))
    mount(<Tasks />)
    expect(await screen.findByText('No tasks yet')).toBeInTheDocument()
    expect(screen.queryByText(es['load.failedTitle'])).not.toBeInTheDocument()
    expect(screen.queryByText(es['load.failedBody'])).not.toBeInTheDocument()
  })
})

describe('Tasks member picker honesty in Spanish', () => {
  function stub(clients) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/tasks/stats')) return ok(STATS)
      if (u.includes('/api/tasks')) return ok([task(1)])
      if (u.includes('/api/clients')) return clients
      return ok({})
    }))
  }

  async function openNew() {
    mount(<Tasks />)
    fireEvent.click(await screen.findByRole('button', { name: 'New Task' }))
    expect(await screen.findByRole('heading', { name: 'New Task' })).toBeInTheDocument()
  }

  it('a refused roster says the member list failed', async () => {
    spanish()
    stub(fail())
    await openNew()
    expect(await screen.findByText(es['mem.listFailed'])).toBeInTheDocument()
    expect(screen.queryByText(en['mem.listFailed'])).not.toBeInTheDocument()
    expect(screen.queryByText(/it is not a sign that your parish has no members/i)).not.toBeInTheDocument()
  })

  it('CONTROL: an empty roster does not say the member list failed', async () => {
    spanish()
    stub(ok([]))
    await openNew()
    await settled()
    expect(screen.queryByText(es['mem.listFailed'])).not.toBeInTheDocument()
    expect(screen.queryByText(en['mem.listFailed'])).not.toBeInTheDocument()
  })

  it('CONTROL: a real roster names the person', async () => {
    spanish()
    stub(ok([MARIA]))
    await openNew()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search members…' }), { target: { value: 'Maria' } })
    expect(await screen.findByText('Maria Ruiz')).toBeInTheDocument()
    expect(screen.queryByText(es['mem.listFailed'])).not.toBeInTheDocument()
  })
})

describe('Linked events honesty in Spanish', () => {
  it('a refused lookup is not an empty calendar', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async () => fail()))
    mount(<LinkedEvents taskId="task-1" assignedMemberId={4} />)
    expect(await screen.findByText(es['dash.upcomingUnread'])).toBeInTheDocument()
    expect(screen.queryByText(en['dash.upcomingUnread'])).not.toBeInTheDocument()
    expect(screen.queryByText(/isn't on any events yet/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/not an empty calendar/i)).not.toBeInTheDocument()
  })

  it('CONTROL: a real empty calendar does not say the lookup failed', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async () => ok([])))
    mount(<LinkedEvents taskId="task-1" assignedMemberId={4} />)
    expect(await screen.findByText(/isn't on any events yet/i)).toBeInTheDocument()
    expect(screen.queryByText(es['dash.upcomingUnread'])).not.toBeInTheDocument()
  })
})

describe('Tasks load-more honesty in Spanish', () => {
  it('a refused next page says nothing was lost', async () => {
    spanish()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/tasks/stats')) return ok({ total: 51, completed: 0, in_progress: 0, high_pending: 0 })
      if (u.includes('/api/tasks') && u.includes('offset=50')) return fail()
      if (u.includes('/api/tasks')) return ok(Array.from({ length: 50 }, (_, i) => task(i + 1)))
      return ok({})
    }))
    mount(<Tasks />)
    // The pager itself speaks the parish language (it was hard-coded
    // English while Members already used these keys).
    fireEvent.click(await screen.findByRole('button', { name: es['mem.loadMore'] }))
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(es['np.loadFailed'])
    expect(screen.queryByText(en['np.loadFailed'])).not.toBeInTheDocument()
    expect(screen.queryByText(/Couldn't load more tasks/i)).not.toBeInTheDocument()
  })
})
