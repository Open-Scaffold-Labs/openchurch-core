// V1.4 study #9: ticking a task draws a pen line through its words.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from './ToastProvider'
import { ConfirmProvider } from './ConfirmProvider'
import DailyChecklists from './DailyChecklists'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'staff', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token',
    loading: false,
  }),
}))

const ok = (b) => ({ ok: true, status: 200, json: async () => b })
beforeEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/checklists/today')) return ok({ runs: [{ id: 9, title: 'Sunday opening', items: [{ text: 'Unlock the doors', done: false }] }] })
    if (u.includes('/api/checklists/templates')) return ok({ templates: [] })
    return ok({})
  }))
})

describe('checklist pen line (V1.4)', () => {
  it('an open task is not struck; ticking it draws the line', async () => {
    render(<LocaleProvider><ToastProvider><ConfirmProvider><DailyChecklists /></ConfirmProvider></ToastProvider></LocaleProvider>)
    const box = await screen.findByRole('checkbox', { name: /unlock the doors/i })
    const words = screen.getByText('Unlock the doors')
    expect(words.className).toMatch(/pen-strike/)
    expect(words.className).not.toMatch(/is-struck/)
    fireEvent.click(box)
    await waitFor(() => expect(screen.getByText('Unlock the doors').className).toMatch(/is-struck/))
  })
})
