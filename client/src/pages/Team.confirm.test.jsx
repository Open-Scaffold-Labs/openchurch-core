// Parish Team remove confirm titles/messages go through strings.js + t().
// ConfirmProvider defaults are already i18n (#107). This is the call-site
// only: `Remove {name} from the team?` / body / `Remove from team`.
// Interpolated name stays roster data. Restoring those hard-EN literals
// in Team.jsx goes red.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Team from './Team'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', email: 's@sttest.org', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const HERE = dirname(fileURLToPath(import.meta.url))
const TEAM_SRC = readFileSync(join(HERE, 'Team.jsx'), 'utf8')

const TEAM_KEYS = ['team.closeTitle', 'team.closeBody', 'team.closeConfirm']
const HARD_EN = [
  'Remove ${u.name} from the team?',
  'They lose access to this parish immediately.',
  'Remove from team',
  'Close {name}\'s login?',
]

const JANE = { id: 2, name: 'Jane Probe', email: 'jane@sttest.org', role: 'staff', created_at: '2026-01-02' }
const ME = { id: 1, name: 'Secretary', email: 's@sttest.org', role: 'admin', created_at: '2026-01-01' }

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function ok(body, status = 200) {
  return { ok: true, status, json: async () => body }
}

function stubFetch() {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    calls.push({ u, method })
    if (u.includes('/api/users') && method === 'GET') return ok([ME, JANE])
    if (u.includes('/api/users/') && u.endsWith('/close') && method === 'POST') {
      return ok({
        closed: true,
        access_revoked: true,
        live_profile_processed: true,
        review_remaining: true,
        all_copies_erased: false,
      })
    }
    if (u.includes('/api/calendar-sync/my-link')) {
      return { ok: false, status: 404, json: async () => ({ code: 'no_member_match' }) }
    }
    return ok({})
  }))
  return calls
}

function mount() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Team />
        </ConfirmProvider>
      </ToastProvider>
    </LocaleProvider>,
  )
}

function closeLabel(dict = STRINGS.en) {
  return dict['team.closeName'].replace('{name}', JANE.name)
}

async function openCloseJane(dict = STRINGS.en) {
  mount()
  const btn = await screen.findByRole('button', { name: closeLabel(dict) })
  await act(async () => { fireEvent.click(btn) })
  return screen.getByRole('alertdialog')
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

describe('Team close confirm is translated (call-site titles/messages)', () => {
  it('ENGLISH CONFIRM USES t() COPY AND KEEPS THE NAME AS DATA', async () => {
    stubFetch()
    const dialog = await openCloseJane()
    const title = STRINGS.en['team.closeTitle'].replace('{name}', JANE.name)
    expect(dialog).toHaveAccessibleName(title)
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    expect(within(dialog).getByText(STRINGS.en['team.closeBody'])).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: STRINGS.en['team.closeConfirm'] })).toBeInTheDocument()
    expect(title).toContain(JANE.name)
    expect(STRINGS.en['team.closeBody']).toMatch(/permanent/i)
    expect(STRINGS.en['team.closeBody']).toMatch(/does not close the parish/i)
    expect(STRINGS.en['team.closeBody']).toMatch(/every copy is gone/i)
  })

  it('SPANISH CONFIRM IS SPANISH — NOT THE ENGLISH TITLE', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch()
    const dialog = await openCloseJane(STRINGS.es)
    const esTitle = STRINGS.es['team.closeTitle'].replace('{name}', JANE.name)
    const enTitle = STRINGS.en['team.closeTitle'].replace('{name}', JANE.name)
    expect(dialog).toHaveAccessibleName(esTitle)
    expect(screen.getByRole('heading', { name: esTitle })).toBeInTheDocument()
    expect(within(dialog).getByText(STRINGS.es['team.closeBody'])).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: STRINGS.es['team.closeConfirm'] })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: enTitle })).toBeNull()
    expect(within(dialog).queryByText(STRINGS.en['team.closeBody'])).toBeNull()
    expect(esTitle).toContain(JANE.name)
    expect(STRINGS.es['team.closeBody']).toMatch(/permanente/i)
    expect(STRINGS.es['team.closeBody']).toMatch(/parroquia/i)
  })

  it('cancel does not close; confirm posts the closure and does not delete', async () => {
    const calls = stubFetch()
    const dialog = await openCloseJane()
    fireEvent.click(within(dialog).getByRole('button', { name: STRINGS.en['confirm.cancel'] }))
    expect(calls.some(c => c.method === 'POST' && c.u.includes('/close'))).toBe(false)
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: closeLabel() }))
    })
    const again = screen.getByRole('alertdialog')
    fireEvent.click(within(again).getByRole('button', { name: STRINGS.en['team.closeConfirm'] }))
    await waitFor(() => {
      expect(calls.some(c => c.method === 'POST' && c.u.includes(`/api/users/${JANE.id}/close`))).toBe(true)
    })
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
    expect(await screen.findByText(STRINGS.en['team.closureAccess'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['team.closureRemaining'])).toBeInTheDocument()
  })

  it('i18n strings and the component wiring cannot reintroduce hard-EN titles', () => {
    const jsx = stripComments(TEAM_SRC)
    for (const key of TEAM_KEYS) {
      expect(TEAM_SRC, key).toMatch(new RegExp(`t\\('${key.replace('.', '\\.')}'`))
      expect(STRINGS.en[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).toBeTruthy()
      expect(STRINGS.es[key], key).not.toBe(STRINGS.en[key])
    }
    expect(TEAM_SRC).toMatch(/t\('team\.closeTitle',\s*\{\s*name:\s*u\.name\s*\}\)/)
    expect(TEAM_SRC).toMatch(/\/api\/users\/\$\{u\.id\}\/close/)
    expect(TEAM_SRC).not.toMatch(/method:\s*'DELETE'/)
    expect(TEAM_SRC).toMatch(/useLocale\(/)
    for (const phrase of HARD_EN) {
      expect(jsx, `JSX must not hard-code ${JSON.stringify(phrase)}`).not.toContain(phrase)
    }
    expect(STRINGS.en['team.closeTitle']).toMatch(/\{name\}/)
    expect(STRINGS.es['team.closeTitle']).toMatch(/\{name\}/)
    expect(STRINGS.es['team.closeConfirm']).toMatch(/acceso/i)
  })
})
