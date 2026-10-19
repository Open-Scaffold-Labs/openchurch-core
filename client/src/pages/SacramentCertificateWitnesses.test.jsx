// SCORE residual (FAILURE-L2-15 HOLD): a certificate whose godparents or
// sponsors arrived as [{ name }] must print the name. Joining the object
// paints "[object Object]" on the extract. Synthetic names only.

import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import SacramentCertificate from './SacramentCertificate'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 'test-token', loading: false,
  }),
}))

const BASE = {
  id: 1,
  member_name: 'Maria Ruiz',
  client_id: 44,
  date: '2019-05-10',
  place: 'San Miguel Chapel',
  minister: 'Fr. Alvarez',
  certificate_no: 'L3-MR-001',
  voided_at: null,
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

function renderCert(record) {
  localStorage.setItem('ochr_locale', 'en')
  vi.stubGlobal('fetch', vi.fn(async () => ok(record)))
  return render(
    <MemoryRouter initialEntries={['/register/1/certificate']}>
      <LocaleProvider>
        <Routes>
          <Route path="/register/:id/certificate" element={<SacramentCertificate />} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>
  )
}

async function articleText(record) {
  const view = renderCert(record)
  expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy()
  return view.container.querySelector('article').textContent
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('certificate chrome does not stringify witness objects', () => {
  it('prints godparent names from [{ name }] and never [object Object]', async () => {
    const text = await articleText({
      ...BASE,
      type: 'baptism',
      meta_attributes: { godparents: [{ name: 'Ana Ruiz' }, { name: 'Jose Ruiz' }] },
    })
    expect(text).toContain(STRINGS.en['cert.title.baptism'])
    expect(text).toContain(STRINGS.en['cert.phrase.baptism'])
    expect(screen.getByText(STRINGS.en['cert.godparents'])).toBeTruthy()
    expect(text).toContain('Ana Ruiz')
    expect(text).toContain('Jose Ruiz')
    expect(text).not.toContain('[object Object]')
  })

  it('prints a single sponsor name from [{ name }] under the singular label', async () => {
    const text = await articleText({
      ...BASE,
      type: 'confirmation',
      meta_attributes: { sponsors: [{ name: 'Lucia M.' }] },
    })
    expect(text).toContain(STRINGS.en['cert.title.confirmation'])
    expect(text).toContain(STRINGS.en['cert.phrase.confirmation'])
    expect(screen.getByText(STRINGS.en['cert.sponsor'])).toBeTruthy()
    expect(screen.queryByText(STRINGS.en['cert.sponsors'])).toBeNull()
    expect(text).toContain('Lucia M.')
    expect(text).not.toContain('[object Object]')
  })

  it('omits a witness object that has no name instead of stringifying it', async () => {
    const text = await articleText({
      ...BASE,
      type: 'baptism',
      meta_attributes: { godparents: [{ name: 'Ana Ruiz' }, { role: 'witness' }] },
    })
    expect(text).toContain('Ana Ruiz')
    expect(screen.getByText(STRINGS.en['cert.godparent'])).toBeTruthy()
    expect(screen.queryByText(STRINGS.en['cert.godparents'])).toBeNull()
    expect(text).not.toContain('[object Object]')
    expect(text).not.toContain('witness')
  })
})
