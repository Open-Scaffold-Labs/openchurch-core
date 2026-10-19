// A refused statements preview must stay a failure in the parish language.
// An empty tax year is a different sentence, and neither is the hard-coded
// English load-failure copy.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import GivingStatements from './GivingStatements'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      name: 'Admin',
      role: 'admin',
      organization: { id: 1, name: 'St Test', locale: 'en' },
    },
    token: 't',
    loading: false,
    isAdmin: true,
    canWrite: true,
  }),
}))

const dir = dirname(fileURLToPath(import.meta.url))
const es = STRINGS.es
const en = STRINGS.en

const ok = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
const refused = () => ok({ error: 'no' }, 500)

const EMPTY_YEAR = { year: 2026, donors: [], total_donors: 0, total_amount: 0 }
const ONE_DONOR = {
  year: 2026,
  total_donors: 1,
  total_amount: 500,
  donors: [{
    donor_key: 'rosa@example.com',
    by: 'email',
    donor_name: 'Rosa Vega',
    donor_email: 'rosa@example.com',
    gift_count: 1,
    total: 500,
  }],
}

function spanish() {
  localStorage.setItem('ochr_locale', 'es')
}

function stub({ preview, issued = () => ok({ statements: [] }) } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/giving-statements/issued')) return issued()
    if (u.includes('/api/giving-statements/preview')) return preview()
    return ok({})
  }))
}

function view() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <GivingStatements />
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

describe('giving statements load failures speak the parish language', () => {
  it('the page no longer hard-codes the English load-failure sentences', () => {
    const code = readFileSync(join(dir, 'GivingStatements.jsx'), 'utf8')
    expect(code).not.toMatch(/Couldn't load statements/)
    expect(code).not.toMatch(/Couldn't load issued statements/)
    expect(code).toMatch(/t\('load\.failedTitle'\)/)
    expect(code).toMatch(/t\('load\.failedBody'\)/)
  })

  it('a refused preview is the Spanish load failure, not an empty year', async () => {
    spanish()
    stub({ preview: refused })
    view()
    expect(await screen.findByRole('heading', { name: es['load.failedTitle'] })).toBeInTheDocument()
    expect(screen.getByText(es['load.failedBody'])).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedTitle'])).toBeNull()
    expect(screen.queryByText(en['load.failedBody'])).toBeNull()
    expect(screen.queryByText(/Couldn't load statements/)).toBeNull()
    expect(screen.queryByText(/No donations in/)).toBeNull()
  })

  it('an English session sees the English load failure', async () => {
    stub({ preview: refused })
    view()
    expect(await screen.findByRole('heading', { name: en['load.failedTitle'] })).toBeInTheDocument()
    expect(screen.getByText(en['load.failedBody'])).toBeInTheDocument()
    expect(screen.queryByText(es['load.failedTitle'])).toBeNull()
    expect(screen.queryByText(es['load.failedBody'])).toBeNull()
    expect(screen.queryByText(/Couldn't load statements/)).toBeNull()
    expect(screen.queryByText(/No donations in/)).toBeNull()
  })

  it('a real empty year is not a load failure', async () => {
    spanish()
    stub({ preview: () => ok(EMPTY_YEAR) })
    view()
    expect(await screen.findByRole('heading', { name: /No donations in/ })).toBeInTheDocument()
    expect(screen.queryByText(es['load.failedTitle'])).toBeNull()
    expect(screen.queryByText(es['load.failedBody'])).toBeNull()
    expect(screen.queryByText(en['load.failedTitle'])).toBeNull()
    expect(screen.queryByText(en['load.failedBody'])).toBeNull()
  })

  it('a refused issued list is the Spanish load failure, and the preview stays', async () => {
    spanish()
    stub({ preview: () => ok(ONE_DONOR), issued: refused })
    view()
    expect(await screen.findByRole('heading', { name: es['load.failedTitle'] })).toBeInTheDocument()
    expect(screen.getByText(es['load.failedBody'])).toBeInTheDocument()
    expect(screen.getByText('Rosa Vega')).toBeInTheDocument()
    expect(screen.queryByText(en['load.failedBody'])).toBeNull()
    expect(screen.queryByText(/Couldn't load issued statements/)).toBeNull()
    expect(screen.queryByText(/No donations in/)).toBeNull()
  })

  it('an ok preview without the donor list shape is a failure, not an empty year', async () => {
    spanish()
    stub({ preview: () => ok({ total_donors: 0 }) })
    view()
    expect(await screen.findByRole('heading', { name: es['load.failedTitle'] })).toBeInTheDocument()
    expect(screen.getByText(es['load.failedBody'])).toBeInTheDocument()
    expect(screen.queryByText(/No donations in/)).toBeNull()
    expect(screen.queryByText(en['load.failedTitle'])).toBeNull()
  })
})
