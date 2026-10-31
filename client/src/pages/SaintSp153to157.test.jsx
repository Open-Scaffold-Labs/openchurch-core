// Saint SP-153..157 (Daily Tasks). Each block is red on 0231b06f.
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Tasks from './Tasks'
import { UrgentTasks } from './Dashboard'
import DailyChecklists from '../components/DailyChecklists'
import { MODULE_HELP } from '../data/helpContent'
import { STRINGS } from '../i18n/strings'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const iso = (offsetDays) => {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const TASKS = [
  { id: 'a', title: 'Order candles', category: 'OPENING', status: 'PENDING', priority: 'LOW', checklist: [], due_date: iso(-3) },
  { id: 'b', title: 'Book the hall', category: 'CLOSING', status: 'PENDING', priority: 'MEDIUM', checklist: [], due_date: iso(5) },
  { id: 'c', title: 'No date task', category: 'OPENING', status: 'PENDING', priority: 'LOW', checklist: [] },
]

function wrap(ui) {
  return render(
    <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>,
  )
}
async function settled() { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }

let posted
beforeEach(() => {
  posted = null
  localStorage.removeItem('ochr_locale')
  localStorage.removeItem('ochr_urgent_collapsed')
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    if (init?.method === 'POST' && u.endsWith('/api/tasks')) { posted = JSON.parse(init.body); return ok({ id: 'n' }) }
    if (u.includes('/api/tasks/stats')) return ok({ total: 3, completed: 0, in_progress: 0, high_pending: 0 })
    if (u.includes('/api/tasks')) return ok(TASKS)
    if (u.includes('/api/clients')) return ok([])
    if (u.includes('/api/checklists/today')) return ok({ runs: [] })
    if (u.includes('/api/checklists/templates')) return ok({ templates: [] })
    return ok({})
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('SP-153 TaskCard shows due_date', () => {
  it('renders the due date with overdue styling in Category and All views', async () => {
    wrap(<Tasks />)
    await screen.findByText('Order candles')
    const check = () => {
      const dues = screen.getAllByTestId('task-due')
      expect(dues).toHaveLength(2)
      const overdue = dues.find(d => /3d overdue/.test(d.textContent))
      expect(overdue).toBeTruthy()
      expect(overdue.dataset.overdue).toBe('true')
      expect(overdue.className).toMatch(/text-rose-500/)
      const future = dues.find(d => /Due in 5d/.test(d.textContent))
      expect(future.dataset.overdue).toBe('false')
    }
    check()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await settled()
    check()
  })
})

describe('R380-1 completed tasks show no obligation wording', () => {
  it('completed overdue and completed due-today read as a plain date', async () => {
    const done = [
      { id: 'x', title: 'Done late', category: 'OPENING', status: 'COMPLETED', priority: 'LOW', checklist: [], due_date: iso(-3) },
      { id: 'y', title: 'Done today', category: 'OPENING', status: 'COMPLETED', priority: 'LOW', checklist: [], due_date: iso(0) },
    ]
    fetch.mockImplementation(async (url) => {
      const u = String(url)
      if (u.includes('/api/tasks/stats')) return ok({ total: 2, completed: 2, in_progress: 0, high_pending: 0 })
      if (u.includes('/api/tasks')) return ok(done)
      return ok([])
    })
    wrap(<Tasks />)
    await screen.findByText('Done late')
    const dues = screen.getAllByTestId('task-due')
    expect(dues).toHaveLength(2)
    for (const d of dues) {
      expect(d.textContent).toMatch(/^Due [A-Z][a-z]{2} \d{1,2}$/)
      expect(d.textContent).not.toMatch(/overdue|today|tomorrow|Due in/i)
      expect(d.dataset.overdue).toBe('false')
    }
  })
})

describe('SP-154 New Task is one-off by default', () => {
  it('Recurring starts at None and saves null', async () => {
    wrap(<Tasks />)
    await screen.findByText('Order candles')
    fireEvent.click(screen.getAllByRole('button', { name: /new task|add task/i })[0])
    const dialog = await screen.findByRole('dialog', { name: 'New Task' })
    const selects = within(dialog).getAllByRole('combobox')
    const recurring = selects.find(s => [...s.options].some(o => o.textContent === 'Sunday Only'))
    expect(recurring.value).toBe('')
    fireEvent.change(within(dialog).getByLabelText('Task title'), { target: { value: 'One-off' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /save|create|add task/i }))
    await settled()
    expect(posted).toBeTruthy()
    expect(posted.recurring_freq).toBeNull()
  })
})

describe('SP-155 Esc closes the Edit Task modal', () => {
  it('Escape closes it', async () => {
    wrap(<Tasks />)
    await screen.findByText('Order candles')
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'Edit Task' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await settled()
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    expect(screen.queryByRole('dialog', { name: 'Edit Task' })).toBeNull()
  })
})

describe('SP-156 Dashboard Urgent includes overdue non-HIGH tasks', () => {
  it('lists an overdue LOW task and omits a future MEDIUM one', async () => {
    wrap(<UrgentTasks tasks={TASKS} />)
    expect(await screen.findByText('Order candles')).toBeTruthy()
    expect(screen.queryByText('Book the hall')).toBeNull()
    expect(screen.getByText('1 high priority or overdue')).toBeTruthy()
  })
})

describe('SP-157 checklist templates are findable', () => {
  it('Manage checklists button has a visible text label', async () => {
    wrap(<DailyChecklists />)
    const btn = await screen.findByRole('button', { name: 'Manage checklists' })
    expect(btn.textContent).toContain('Manage checklists')
  })
  it('Help no longer says templates live under Daily Tasks', () => {
    const text = JSON.stringify(MODULE_HELP.tasks)
    expect(text).toMatch(/Dashboard/)
    expect(text).toMatch(/Manage checklists/)
    expect(MODULE_HELP.tasks.sections[0].content).not.toMatch(/^Repeatable routines[^.]*live as templates/)
    expect(STRINGS.es['chk.manage']).toBeTruthy()
    expect(STRINGS.es['dash.urgentOpen']).toBeTruthy()
  })
})
