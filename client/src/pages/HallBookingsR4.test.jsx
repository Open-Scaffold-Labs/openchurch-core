// OC-CAT-1 r4: Saint SP-240 (the counsel note no longer says "No link was
// issued" beside an issued or signed agreement) and SP-241 (an expired link
// renewed by Approve is reported as new, not "it still works").
//
// Red at 4bd41010: the issued and signed cases show hall.counselPending,
// which says no link was issued; a renewed Approve shows hall.sentCopied.
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import HallBookings from './HallBookings'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { role: 'admin', organization: { locale: 'en', tradition: 'general' } },
    loading: false,
  }),
}))

const EN = STRINGS.en
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function mount(ui, path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocaleProvider>
        <Routes>
          <Route path="/hall" element={ui} />
          <Route path="/sign/hall/:token" element={ui} />
        </Routes>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

const BOOKING = {
  id: 9, host_name: 'Ada and Ben', event_kind: 'wedding', space_name: 'Fellowship Hall',
  starts_at: '2026-11-08T00:00:00.000Z', ends_at: '2026-11-08T06:00:00.000Z', status: 'held',
  time_zone: 'America/Los_Angeles', parish_name: 'Synthetic Hall Parish',
}
function detailWith(agreements) {
  return {
    ...BOOKING, payments: 'on_hold',
    milestones: [{ id: 1, kind: 'hall_rental', amount: '25.00', due_on: '2026-10-01', deposit_held: null }],
    beo: null, agreements, warnings: [], liturgical_status: 'known', liturgical: [], unplaced: [],
  }
}

function hallFetch(routes) {
  return vi.fn(async (url, init) => {
    const path = String(url)
    for (const [match, reply] of routes) {
      if (match(path, init)) return typeof reply === 'function' ? reply(path, init) : reply
    }
    if (path.includes('/api/sacraments')) return json(200, { records: [] })
    if (path.includes('/api/catering/spaces')) return json(200, { payments: 'on_hold', spaces: [{ id: 1, name: 'Fellowship Hall', space_kind: 'fellowship_hall' }] })
    if (path.endsWith('/api/catering/bookings')) return json(200, { payments: 'on_hold', bookings: [BOOKING] })
    return json(500, {})
  })
}

let writeText
beforeEach(() => {
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

const ES = STRINGS.es

describe('SP-240: the counsel note matches what was issued', () => {
  it('a sent agreement under the counsel gate does not say no link was issued', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{ id: 3, status: 'sent', counsel_pending: true, copy_path: '/sign/hall/org000001.sample' }]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    const note = await screen.findByTestId('counsel-pending')
    expect(note.textContent).not.toMatch(/No link was issued/)
    expect(note.textContent).toBe(EN['hall.counselPendingSent'])
    expect(screen.getByRole('button', { name: EN['hall.copyLink'] })).toBeTruthy()
  })

  it('a signed agreement under the counsel gate does not say no link was issued', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{ id: 3, status: 'signed', signed_at: '2026-10-20T10:00:00Z', counsel_pending: true, copy_path: '/sign/hall/org000001.sample' }]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    const note = await screen.findByTestId('counsel-pending')
    expect(note.textContent).not.toMatch(/No link was issued/)
    expect(note.textContent).toBe(EN['hall.counselPendingSigned'])
  })

  it('a draft under the counsel gate still says no link was issued', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{ id: 3, status: 'draft', counsel_pending: true, copy_path: null }]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    expect((await screen.findByTestId('counsel-pending')).textContent).toBe(EN['hall.counselPending'])
  })

  it('the issued and signed notes, EN and ES, never claim no link', () => {
    for (const key of ['hall.counselPendingSent', 'hall.counselPendingSigned']) {
      expect(EN[key]).toBeTruthy()
      expect(ES[key]).toBeTruthy()
      expect(EN[key]).not.toMatch(/No link was issued/)
      expect(ES[key]).not.toMatch(/No se emitió/)
    }
  })
})

describe('SP-241: a renewed link is reported as new', () => {
  it('Approve that renews an expired link says the old one expired', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/agreement'), json(200, { payments: 'on_hold', id: 3, status: 'draft', contract_sha256: 'abc', contract_en: 'Ready', contract_es: 'Listo', counsel_pending: false })],
      [(p) => p.endsWith('/agreement/send'), json(200, { payments: 'on_hold', agreement_id: 3, copy_path: '/sign/hall/org000001.fresh', already_issued: false, renewed: true, deposit_link: null })],
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{ id: 3, status: 'draft', counsel_pending: false, copy_path: null }]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.prepare'] }))
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.send'] }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/sign/hall/org000001.fresh`))
    expect(await screen.findByText(EN['hall.renewedCopied'])).toBeTruthy()
    expect(screen.queryByText(EN['hall.alreadyIssued'])).toBeNull()
  })
})
