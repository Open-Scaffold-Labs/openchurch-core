/** @vitest-environment jsdom */
// SP-316: typing † in the intention field ticks Departed.
// SP-317: phone mark-said checkboxes have a ≥44px hit target.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import MassIntentions from './MassIntentions'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MassIntentions.jsx'), 'utf8')

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

describe('SP-317 mark-said checkbox hit target', () => {
  it('wraps phone and table mark-said checks in a ≥44px label', () => {
    const hits = SRC.match(/min-h-\[44px\] min-w-\[44px\]/g) || []
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(SRC).toMatch(/data-testid="mi-mark-said-check"/)
  })
})

describe('SP-316 typing † ticks Departed', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/mass-intentions?')) return ok({ intentions: [] })
      return ok([])
    }))
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: '', addEventListener() {}, removeEventListener() {},
    })))
  })

  it('checking starts false; typing † ticks the Departed box', async () => {
    render(
      <MemoryRouter initialEntries={['/mass-intentions']}>
        <LocaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <Routes><Route path="/mass-intentions" element={<MassIntentions />} /></Routes>
            </ConfirmProvider>
          </ToastProvider>
        </LocaleProvider>
      </MemoryRouter>,
    )

    const add = await screen.findByRole('button', { name: /add intention|nueva intención/i })
    fireEvent.click(add)

    // Exact name — other copy on the page also says "intention".
    const intention = await screen.findByRole('textbox', { name: /^Intention$/i })
    const departed = screen.getByRole('checkbox', { name: /Departed/i })
    expect(departed).not.toBeChecked()

    fireEvent.change(intention, { target: { value: '† Testenvelope family' } })
    await waitFor(() => expect(departed).toBeChecked())
  })
})
