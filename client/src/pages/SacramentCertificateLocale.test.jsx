// REGISTER-L3-01 — English and Spanish certificates are two phrasings of
// the same register extract. Labels change. The name, date, place,
// minister, certificate number, and witnesses do not. A fact the record
// does not hold is not filled in.

import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import SacramentCertificate from './SacramentCertificate'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const FULL = {
  id: 1,
  type: 'baptism',
  member_name: 'Maria Ruiz',
  client_id: 44,
  date: '2019-05-10',
  place: 'San Miguel Chapel',
  minister: 'Fr. Alvarez',
  certificate_no: 'L3-MR-001',
  meta_attributes: { godparents: ['Ana Ruiz', 'Jose Ruiz'] },
  voided_at: null,
}

const SPARSE = {
  id: 1,
  type: 'baptism',
  member_name: 'Ana Delgado',
  client_id: null,
  date: null,
  place: null,
  minister: null,
  certificate_no: null,
  meta_attributes: {},
  voided_at: null,
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

function renderCert(record, locale) {
  localStorage.setItem('ochr_locale', locale)
  vi.stubGlobal('fetch', vi.fn(async () => ok(record)))
  const view = render(
    <MemoryRouter initialEntries={['/register/1/certificate']}>
      <LocaleProvider>
        <Routes>
          <Route path="/register/:id/certificate" element={<SacramentCertificate />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>
  )
  return view
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('EN and ES certificates carry the same historical facts', () => {
  it('prints the recorded name, day, place, minister, number, and witnesses in both languages', async () => {
    const en = renderCert(FULL, 'en')
    expect(await screen.findByRole('heading', { name: 'Certificate of Baptism' })).toBeTruthy()
    const enText = en.container.querySelector('article').textContent
    en.unmount()

    const es = renderCert(FULL, 'es')
    expect(await screen.findByRole('heading', { name: 'Certificado de Bautismo' })).toBeTruthy()
    const esText = es.container.querySelector('article').textContent
    es.unmount()

    for (const fact of ['Maria Ruiz', 'San Miguel Chapel', 'Fr. Alvarez', 'L3-MR-001', 'Ana Ruiz', 'Jose Ruiz', '2019', '10']) {
      expect(enText).toContain(fact)
      expect(esText).toContain(fact)
    }
    expect(enText).toContain('May')
    expect(esText).toContain('mayo')
    expect(enText).not.toContain('Certificado de Bautismo')
    expect(esText).not.toContain('Certificate of Baptism')
    // The roster name after a later marriage is not on this extract.
    expect(enText).not.toContain('Maria Ruiz Garcia')
    expect(esText).not.toContain('Maria Ruiz Garcia')
  })

  it('does not invent a date, place, minister, or number the record does not hold', async () => {
    for (const locale of ['en', 'es']) {
      const view = renderCert(SPARSE, locale)
      expect(await screen.findByText('Ana Delgado')).toBeTruthy()
      const text = view.container.querySelector('article').textContent
      expect(text).not.toContain('2019')
      expect(text).not.toMatch(/\bmay\b|mayo/i)
      expect(text).not.toContain('San Miguel Chapel')
      expect(text).not.toContain('Fr. Alvarez')
      expect(text).not.toContain('L3-MR-001')
      expect(text).not.toContain('Ana Ruiz')
      view.unmount()
    }
  })
})
