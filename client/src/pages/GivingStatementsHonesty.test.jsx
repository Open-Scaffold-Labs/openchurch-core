// STMT-01 / GIV-09 residual — the statements list must not read as if
// issued claims were emailed. Issued list chrome names "not sent to donor".
// Removing that honesty string from the list page goes red.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from '../i18n'
import GivingStatements from './GivingStatements'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Admin', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, isAdmin: true, canWrite: true,
  }),
}))

const ok = b => ({ ok: true, status: 200, json: async () => b })

function stubList({ statements = [] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/giving-statements/issued')) {
      return ok({ statements })
    }
    if (u.includes('/api/giving-statements/preview')) {
      return ok({ year: 2026, total_donors: 1, total_amount: 500, donors: [{
        donor_key: 'rosa@example.com', by: 'email', donor_name: 'Rosa Vega',
        donor_email: 'rosa@example.com', gift_count: 1, total: 500,
      }] })
    }
    return ok({})
  }))
}

function view() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <GivingStatements />
      </LocaleProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

describe('giving-statement list chrome separates issued from sent (STMT-01)', () => {
  it('THE LIST SAYS ISSUING DOES NOT EMAIL THE DONOR', async () => {
    stubList()
    view()
    const honesty = await screen.findByTestId('statement-list-not-sent', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/does not email the donor/i)
    expect(honesty.textContent).not.toMatch(/sent successfully|delivered|email sent/i)
  })

  it('ISSUED ROWS READ ISSUED — NOT SENT TO DONOR', async () => {
    stubList({ statements: [{
      id: 107, tax_year: 2026, donor_key: 'rosa@example.com', donor_key_kind: 'email',
      statement_no: '2026-1', status: 'issued', issued_at: '2026-01-15T12:00:00Z',
      issued_by_name: 'Admin', superseded_at: null, superseded_by_id: null, total: '500.00',
    }] })
    view()
    const list = await screen.findByTestId('statement-issued-list', {}, { timeout: 4000 })
    expect(list.textContent).toMatch(/Issued — not sent to donor/i)
    expect(list.textContent).toMatch(/2026-1/)
    expect(screen.getByRole('link', { name: /2026-1/i }).getAttribute('href')).toMatch(/issued=107/)
  })

  it('SPANISH LIST CHROME SAYS NO ENVIADO AL DONANTE', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubList({ statements: [{
      id: 107, tax_year: 2026, donor_key: 'rosa@example.com', donor_key_kind: 'email',
      statement_no: '2026-1', status: 'issued', issued_at: '2026-01-15T12:00:00Z',
      issued_by_name: 'Admin', superseded_at: null, superseded_by_id: null, total: '500.00',
    }] })
    view()
    const list = await screen.findByTestId('statement-issued-list', {}, { timeout: 4000 })
    expect(list.textContent).toMatch(/Emitido — no enviado al donante/i)
    expect(screen.getByTestId('statement-list-not-sent').textContent).toMatch(/no envía el estado de cuenta/i)
    localStorage.removeItem('ochr_locale')
  })
})
