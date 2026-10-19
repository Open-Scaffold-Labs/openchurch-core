import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import Team from './Team'
import { STRINGS } from '../i18n/strings'
vi.mock('../components/ConfirmProvider', () => ({ useConfirm: () => async () => true }))
vi.mock('../utils/format', () => ({
  loadOne: async () => ({ ok: true, data: [
    { id: 1, name: 'Synthetic Admin', email: 'admin@example.invalid', role: 'admin', pastoral_lead: false },
    { id: 2, name: 'Synthetic Staff', email: 'staff@example.invalid', role: 'staff', pastoral_lead: false, deactivated: true },
    { id: 3, name: null, role: 'staff', closed: true, pastoral_lead: false },
  ] }), postJson: vi.fn(),
}))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })
describe('chancery closure controls', () => {
  it.each(['en', 'es'])('%s: thrown closure and receipt reads surface unknown outcomes', async locale => {
    localStorage.setItem('ochr_locale', locale)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    render(<Team />)
    fireEvent.click(await screen.findByRole('button', { name: STRINGS[locale]['team.closeName'].replace('{name}', 'Synthetic Staff') }))
    expect(await screen.findByRole('alert')).toHaveTextContent(STRINGS[locale]['team.closeFailed'])
    fireEvent.click(screen.getByRole('button', { name: STRINGS[locale]['team.closureStatus'] }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(STRINGS[locale]['team.receiptFailed']))
  })
  it('last administrator is refused without automatically promoting anyone', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 409 })
    vi.stubGlobal('fetch', fetch)
    render(<Team />)
    fireEvent.click(await screen.findByRole('button', { name: 'Close Synthetic Admin’s login' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(STRINGS.en['team.closeLastAdmin'])
    expect(fetch).toHaveBeenCalledTimes(1)
    const picker = screen.getByRole('combobox', { name: 'Role for Synthetic Staff' })
    expect(picker).toBeEnabled()
    fetch.mockResolvedValue({ status: 200, json: async () => ({ id: 2, role: 'admin' }) })
    fireEvent.change(picker, { target: { value: 'admin' } })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/users/2/role'), expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ role: 'admin' }),
    })))
  })
  it('does not accept malformed successful role responses as confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }))
    render(<Team />)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Role for Synthetic Staff' }), { target: { value: 'admin' } })
    expect(await screen.findByRole('alert')).toHaveTextContent(STRINGS.en['team.roleFailed'])
  })
  it.each(['en', 'es'])('%s: an unproven restore stays unknown and cannot restore a closed login', async locale => {
    localStorage.setItem('ochr_locale', locale)
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetch)
    render(<Team />)
    fireEvent.click(await screen.findByRole('button', { name: STRINGS[locale]['team.turnOnName'].replace('{name}', 'Synthetic Staff') }))
    expect(await screen.findByRole('alert')).toHaveTextContent(STRINGS[locale]['team.turnOnFailed'])
    expect(screen.getByText(STRINGS[locale]['team.loginUnknown'])).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: STRINGS[locale]['team.turnOnName'].replace('{name}', 'Synthetic Staff') })).toHaveLength(1)
    const closedRole = screen.getByRole('combobox', { name: STRINGS[locale]['team.roleFor'].replace('{name}', STRINGS[locale]['team.formerOperator']) })
    expect(closedRole).toBeDisabled()
  })
  it('only a confirmed restore removes its unknown marker', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ reactivated: true }) })
    vi.stubGlobal('fetch', fetch)
    render(<Team />)
    const name = STRINGS.en['team.turnOnName'].replace('{name}', 'Synthetic Staff')
    fireEvent.click(await screen.findByRole('button', { name }))
    await screen.findByText(STRINGS.en['team.loginUnknown'])
    fireEvent.click(screen.getByRole('button', { name }))
    await waitFor(() => expect(screen.queryByText(STRINGS.en['team.loginUnknown'])).not.toBeInTheDocument())
  })
})

