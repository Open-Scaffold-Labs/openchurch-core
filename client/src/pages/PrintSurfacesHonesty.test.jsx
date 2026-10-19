// OC-READY-01-023 / STMT-01 residual — remaining print surfaces
// (import receipt, offerings sheet, sacramental certificate, first
// parish setup record) must not read as if OpenChurch emailed them.
// Reality is window.print() / "Save as PDF" only. Removing the honesty
// string goes red. Honesty is print:hidden; paper footers stay live
// print markers.

import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import ImportReceipt from './ImportReceipt'
import InvoicePrint from './InvoicePrint'
import SacramentCertificate from './SacramentCertificate'
import SetupRecord from './SetupRecord'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

const RECEIPT_BATCH = {
  can_undo: false,
  rows_available: true,
  rows_available_until: '2026-10-17',
  receipt: {
    parish: 'St Test',
    committed_at: '2026-09-17T12:00:00Z',
    source_name: 'members.csv',
    kind: 'members',
    row_count: 10,
    prepared_by: { name: 'Secretary', email: 'sec@example.com' },
    approved_by: { name: 'Admin', email: 'admin@example.com' },
    imported: 8,
    held_for_follow_up: 1,
    duplicates_left_for_review: 1,
    duplicates_imported_anyway: 0,
    skipped: 0,
    follow_up_reasons: [],
    ignored_columns: [],
    protection: {
      records: 'Imported records live in the parish workspace.',
      source_file: 'The original file was not stored.',
    },
  },
}

const INVOICE = {
  id: 1,
  invoice_no: '2026-1',
  title: 'Wedding — church use',
  payer_member_name: 'Rosa Vega',
  payer_name: 'Rosa Vega',
  event_title: null,
  event_date: null,
  issued_at: '2026-09-01T12:00:00Z',
  created_at: '2026-09-01T12:00:00Z',
  status: 'issued',
  subtotal: '250.00',
  waived_amount: '0',
  amount_paid: '0',
  total: '250.00',
  lines: [{ id: 1, description: 'Church use', qty: 1, amount: '250.00' }],
  payments: [],
}

const CERT_RECORD = {
  id: 1,
  type: 'baptism',
  member_name: 'Maria Test',
  date: '2026-05-10',
  place: 'St Test',
  minister: 'Fr. Corrected',
  certificate_no: 'P6-001',
  meta_attributes: {},
  voided_at: null,
}

const SETUP_RECORD = {
  parish: 'St Test',
  established: '2026-01-01',
  prepared_on: '2026-09-17',
  prepared_by: 'Secretary',
  in_place: [{ key: 'setup.inPlace.workspace', on: '2026-01-01' }],
  left_for_later: [],
  access: [{ name: 'Secretary', role: 'admin' }],
  latest_import: null,
}

function stubFetch(handler) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    const override = handler(u)
    if (override) return override
    return ok({})
  }))
}

function wrap(node, path, routePath) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Routes>
              <Route path={routePath} element={node} />
            </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
})

function expectHonesty(honesty) {
  expect(honesty.textContent).toMatch(/does not email/i)
  expect(honesty.textContent).toMatch(/print or save as PDF/i)
  expect(honesty.textContent).not.toMatch(/sent successfully|email sent|delivered/i)
  expect(honesty.className).toMatch(/print:hidden/)
}

function expectLivePrintMarker(node) {
  expect(node).toBeTruthy()
  expect(node.textContent).not.toMatch(/sent|emailed|delivered/i)
  expect(node.className).not.toMatch(/print:hidden/)
}

describe('Import receipt print≠emailed honesty (OC-READY-01-023)', () => {
  function mount() {
    stubFetch(u => u.match(/\/api\/imports\/1$/) ? ok(RECEIPT_BATCH) : null)
    wrap(<ImportReceipt />, '/migration/1/receipt', '/migration/:id/receipt')
  }

  it('THE RECEIPT SAYS PRINT/PDF ONLY — OPENCHURCH DOES NOT EMAIL', async () => {
    mount()
    const honesty = await screen.findByTestId('receipt-print-not-emailed', {}, { timeout: 4000 })
    expectHonesty(honesty)
  })

  it('PAPER FOOTER STAYS A LIVE PRINT MARKER — NOT A SENT CLAIM', async () => {
    mount()
    const honesty = await screen.findByTestId('receipt-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.className).toMatch(/print:hidden/)
    await screen.findByText(/Kept with the parish records/, {}, { timeout: 4000 })
    const footer = document.querySelector('footer')
    expectLivePrintMarker(footer)
    expect(footer.textContent).toMatch(/Kept with the parish records/)
  })

  it('SPANISH RECEIPT CHROME SAYS NO LO ENVÍA POR CORREO', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    const honesty = await screen.findByTestId('receipt-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/no lo envía por correo/i)
    expect(honesty.className).toMatch(/print:hidden/)
    localStorage.removeItem('ochr_locale')
  })
})

describe('Offerings sheet print≠emailed honesty (OC-READY-01-023)', () => {
  function mount() {
    stubFetch(u => u.match(/\/api\/invoices\/1$/) ? ok(INVOICE) : null)
    wrap(<InvoicePrint />, '/offerings/1/print', '/offerings/:id/print')
  }

  it('THE SHEET SAYS PRINT/PDF ONLY — OPENCHURCH DOES NOT EMAIL', async () => {
    mount()
    const honesty = await screen.findByTestId('invoice-print-not-emailed', {}, { timeout: 4000 })
    expectHonesty(honesty)
  })

  it('PAPER FOOTER STAYS A LIVE PRINT MARKER — NOT A SENT CLAIM', async () => {
    mount()
    const honesty = await screen.findByTestId('invoice-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.className).toMatch(/print:hidden/)
    await screen.findByText(/kept by the parish office/i, {}, { timeout: 4000 })
    const footer = document.querySelector('footer')
    expectLivePrintMarker(footer)
    expect(footer.textContent).toMatch(/kept by the parish office/i)
  })

  it('SPANISH SHEET CHROME SAYS NO LA ENVÍA POR CORREO', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    const honesty = await screen.findByTestId('invoice-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/no la envía por correo/i)
    expect(honesty.className).toMatch(/print:hidden/)
    localStorage.removeItem('ochr_locale')
  })
})

describe('Sacrament certificate print≠emailed honesty (OC-READY-01-023)', () => {
  function mount() {
    stubFetch(u => u.match(/\/api\/sacraments\/1$/) ? ok(CERT_RECORD) : null)
    wrap(<SacramentCertificate />, '/register/1/certificate', '/register/:id/certificate')
  }

  it('THE CERTIFICATE SAYS PRINT/PDF ONLY — OPENCHURCH DOES NOT EMAIL', async () => {
    mount()
    const honesty = await screen.findByTestId('certificate-print-not-emailed', {}, { timeout: 4000 })
    expectHonesty(honesty)
  })

  it('PAPER ISSUE LINE STAYS A LIVE PRINT MARKER — NOT A SENT CLAIM', async () => {
    mount()
    const honesty = await screen.findByTestId('certificate-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.className).toMatch(/print:hidden/)
    const paper = document.querySelector('article')
    expectLivePrintMarker(paper)
    expect(paper.textContent).toMatch(/Issued /)
  })

  it('SPANISH CERTIFICATE CHROME SAYS NO LO ENVÍA POR CORREO', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    const honesty = await screen.findByTestId('certificate-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/no lo envía por correo/i)
    expect(honesty.className).toMatch(/print:hidden/)
    localStorage.removeItem('ochr_locale')
  })
})

describe('Setup record print≠emailed honesty (OC-READY-01-023)', () => {
  function mount() {
    stubFetch(u => u.includes('/api/setup/record') ? ok(SETUP_RECORD) : null)
    wrap(<SetupRecord />, '/getting-settled/record', '/getting-settled/record')
  }

  it('THE RECORD SAYS PRINT/PDF ONLY — OPENCHURCH DOES NOT EMAIL', async () => {
    mount()
    const honesty = await screen.findByTestId('setup-record-print-not-emailed', {}, { timeout: 4000 })
    expectHonesty(honesty)
  })

  it('PAPER FOOTER STAYS A LIVE PRINT MARKER — NOT A SENT CLAIM', async () => {
    mount()
    const honesty = await screen.findByTestId('setup-record-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.className).toMatch(/print:hidden/)
    const footer = document.querySelector('footer')
    expectLivePrintMarker(footer)
    expect(footer.textContent).toMatch(/not yet part of the record/i)
  })

  it('SPANISH RECORD CHROME SAYS NO LO ENVÍA POR CORREO', async () => {
    localStorage.setItem('ochr_locale', 'es')
    mount()
    const honesty = await screen.findByTestId('setup-record-print-not-emailed', {}, { timeout: 4000 })
    expect(honesty.textContent).toMatch(/no lo envía por correo/i)
    expect(honesty.className).toMatch(/print:hidden/)
    localStorage.removeItem('ochr_locale')
  })
})
