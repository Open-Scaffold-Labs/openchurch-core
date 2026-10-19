// SP-031: Edit Staff for a member whose stored role is not in the
// built-in list (e.g. "Office Manager") showed Role = Pastor, the first
// option. The record's own role must be shown, offered and saved as-is.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Payroll from './Payroll'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Treasurer', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true,
  }),
}))

const SUMMARY = { total_payroll: 0, total_hours: 0, shift_count: 0, staff_count: 1 }
const ok = (b) => ({ ok: true, status: 200, json: async () => b })

function stub(staff) {
  const writes = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    if (opts.method && opts.method !== 'GET') { writes.push({ u, method: opts.method, body: JSON.parse(opts.body || '{}') }); return ok({ ...staff[0], ...JSON.parse(opts.body || '{}') }) }
    if (u.includes('/payroll/summary')) return ok(SUMMARY)
    if (u.includes('/payroll/staff')) return ok(staff)
    if (u.includes('/payroll/shifts')) return ok([])
    return ok({})
  }))
  return writes
}

const mount = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <Payroll />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)

async function openEdit(name) {
  await screen.findAllByText(name)
  fireEvent.click(screen.getAllByRole('button', { name: 'Row actions' })[0])
  fireEvent.click(await screen.findByRole('button', { name: /Edit Staff/ }))
  await screen.findByText('Edit Staff Member')
  return screen.getByDisplayValue(name).closest('div.p-5').querySelector('select')
}

beforeEach(() => vi.unstubAllGlobals())

describe('Edit Staff keeps a role that is not in the built-in list (SP-031)', () => {
  it('shows "Office Manager", not "Pastor", and an untouched save sends Office Manager', async () => {
    const writes = stub([{ id: 7, name: 'Linda Synthetic', role: 'Office Manager', pay_rate: 0, status: 'active' }])
    mount()
    const role = await openEdit('Linda Synthetic')
    expect(role.value).toBe('Office Manager')
    expect(role.selectedOptions[0].textContent).toBe('Office Manager')
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
    await waitFor(() => expect(writes.length).toBeGreaterThan(0))
    expect(writes[0].body.role).toBe('Office Manager')
  })

  it('CONTROL: a built-in role is shown once, with no extra option', async () => {
    stub([{ id: 8, name: 'Paul Synthetic', role: 'Pastor', pay_rate: 0, status: 'active' }])
    mount()
    const role = await openEdit('Paul Synthetic')
    expect(role.value).toBe('Pastor')
    expect([...role.options].filter(o => o.value === 'Pastor')).toHaveLength(1)
    expect(role.options).toHaveLength(9)
  })
})
