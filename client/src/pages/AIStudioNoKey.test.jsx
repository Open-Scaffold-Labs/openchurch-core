// SP-109 / D-01: AI Studio runs only on the parish's own key. With no key
// the page says so, links to Org details, disables Generate and hides the
// usage meter. A failed status read is UNKNOWN, never "no key".
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent } from '@testing-library/react'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import { MODULE_HELP } from '../data/helpContent'
import AI from './AI'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true,
  }),
}))

const ok = (b, status = 200) => ({ ok: status < 400, status, json: async () => b })
let statusRes
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    if (u.includes('/api/assistant/status')) return statusRes(init)
    if (u.includes('/api/ai/usage') || u.includes('quota')) return ok({ used: 0, limit: 20, plan: 'free', remaining: 20 })
    if (u.includes('/api/ai/generations')) return ok({ rows: [] })
    return ok({})
  }))
})

const view = () => render(
  <MemoryRouter><LocaleProvider><ToastProvider><ConfirmProvider>
    <AI />
  </ConfirmProvider></ToastProvider></LocaleProvider></MemoryRouter>
)
const typeSomething = () => fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Advent homily' } })
const generateBtn = () => screen.getByRole('button', { name: /Generate/ })

describe('AI Studio with no parish key', () => {
  it('says so, links to Org details, disables Generate, hides the meter', async () => {
    statusRes = () => ok({ available: false, code: 'ai_key_required' })
    view()
    const note = await screen.findByTestId('aist-nokey')
    expect(note).toHaveTextContent(/OpenChurch does not supply one/)
    expect(screen.getByRole('link', { name: 'Org details' })).toHaveAttribute('href', '/settings')
    typeSomething()
    expect(generateBtn()).toBeDisabled()
    expect(screen.queryByText(/AI this month/)).toBeNull()
  })

  it('a failed status read is unknown, not "no key"', async () => {
    statusRes = () => ok({ error: 'x' }, 500)
    view()
    expect(await screen.findByTestId('aist-unknown')).toHaveTextContent(/Couldn\u2019t check/)
    expect(screen.queryByTestId('aist-nokey')).toBeNull()
    expect(screen.queryByText(/AI this month/)).toBeNull()
  })

  it('with a key, no notice and Generate is usable', async () => {
    statusRes = () => ok({ available: true })
    view()
    typeSomething()
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByTestId('aist-nokey')).toBeNull()
    expect(screen.queryByTestId('aist-unknown')).toBeNull()
    expect(generateBtn()).not.toBeDisabled()
  })

  it('help overview names the parish-own-key rule', () => {
    expect(MODULE_HELP['ai-studio'].overview).toMatch(/own AI key/)
    expect(MODULE_HELP['ai-studio'].overview).not.toMatch(/^AI drafting[^.]*\. Metered monthly by plan/)
  })

  it('R367-2: re-entry after saving a key bypasses the cached no-key answer', async () => {
    // A cache-aware stub: anything not marked no-store gets the first
    // (cached) answer, as a browser would within max-age=60.
    let server = { available: false, code: 'ai_key_required' }
    let cached = null
    statusRes = (init) => {
      if (init?.cache !== 'no-store' && cached) return ok(cached)
      cached = server
      return ok(server)
    }
    const first = view()
    await screen.findByTestId('aist-nokey')
    first.unmount()
    server = { available: true } // key saved in Org details
    view()
    typeSomething()
    await waitFor(() => expect(generateBtn()).not.toBeDisabled())
    expect(screen.queryByTestId('aist-nokey')).toBeNull()
  })
})
