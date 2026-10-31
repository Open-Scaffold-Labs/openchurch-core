// OC-CAT-1 r3: copy says what happened and why (Vesper copy review,
// Saint SP-227/234/235/236/237, counsel gate).
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import HallBookings from './HallBookings'
import SignHallAgreement from './SignHallAgreement'

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

describe('signing page tells the signer the real reason (SP-235)', () => {
  it('an expired link says it expired, not "did not open"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(410, { code: 'expired', payments: 'on_hold' })))
    mount(<SignHallAgreement />, '/sign/hall/org000001.sample')
    expect(await screen.findByText(EN['sign.expired'])).toBeTruthy()
    expect(screen.queryByText(EN['sign.loadFailed'])).toBeNull()
  })

  it('a rate-limited link says to wait', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { code: 'rate_limited', payments: 'on_hold' })))
    mount(<SignHallAgreement />, '/sign/hall/org000001.sample')
    expect((await screen.findAllByText(EN['sign.rateLimited'])).length).toBeGreaterThan(0)
    expect(screen.queryByText(EN['sign.loadFailed'])).toBeNull()
  })

  it('while counsel terms are missing the page can be read and declined, not signed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {
      payments: 'on_hold', status: 'sent', email_verified: false, contract: 'Draft text.',
      consent: [{ id: 'money', text: 'Nothing is charged from this page.' }], counsel_pending: true,
    })))
    mount(<SignHallAgreement />, '/sign/hall/org000001.sample')
    expect(await screen.findByText(EN['sign.counselPending'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: EN['sign.sign'] })).toBeNull()
    expect(screen.getByRole('button', { name: EN['sign.decline'] })).toBeTruthy()
  })

  it('a refused signature names the missing consent instead of "try again"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') return json(400, { code: 'consent', payments: 'on_hold' })
      return json(200, {
        payments: 'on_hold', status: 'sent', email_verified: false, contract: 'Text.',
        consent: [{ id: 'money', text: 'Nothing is charged from this page.' }], counsel_pending: false,
      })
    }))
    mount(<SignHallAgreement />, '/sign/hall/org000001.sample')
    fireEvent.change(await screen.findByLabelText(EN['sign.name']), { target: { value: 'Ada Lovelace' } })
    fireEvent.click(screen.getByRole('button', { name: EN['sign.sign'] }))
    expect(await screen.findByText(EN['sign.consentMissing'])).toBeTruthy()
    expect(screen.queryByText(EN['sign.nothingLost'])).toBeNull()
  })
})

describe('hall page copy (r3)', () => {
  it('names the parish zone on the card', async () => {
    vi.stubGlobal('fetch', hallFetch([]))
    mount(<HallBookings />, '/hall')
    expect(await screen.findByText(/Nov 7, 2026, 4:00\sPM–10:00\sPM \(America\/Los_Angeles time\)/)).toBeTruthy()
  })

  it('SP-234: a staff release of a signed booking says only an admin can', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/cancel'), json(403, { code: 'admin', payments: 'on_hold' })],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.cancelHold'] }))
    expect(await screen.findByText(EN['hall.cancelAdminOnly'])).toBeTruthy()
    expect(screen.queryByText(EN['hall.saveFailed'])).toBeNull()
  })

  it('SP-227/237: conflicts are spelled out, and the Sunday warning stays on its own booking', async () => {
    const both = [BOOKING, { ...BOOKING, id: 21, host_name: 'Dinner during Mass', event_kind: 'fellowship_dinner' }]
    let creates = 0
    vi.stubGlobal('fetch', hallFetch([
      [(p, i) => p.endsWith('/api/catering/bookings') && i?.method === 'POST', () => {
        creates += 1
        if (creates === 1) {
          return json(409, {
            code: 'conflict', payments: 'on_hold', time_zone: 'America/Los_Angeles',
            conflicts: [{ source: 'sacrament', title: 'marriage', date: '2026-11-07', hour: 'unknown' }],
          })
        }
        return json(201, { ...both[1], payments: 'on_hold', warnings: [{ source: 'calendar', title: 'Sunday Mass', date: '2026-11-15', during: 'sunday_mass' }] })
      }],
      [(p) => p.endsWith('/api/catering/bookings'), () => json(200, { payments: 'on_hold', bookings: creates >= 2 ? both : [BOOKING] })],
    ]))
    mount(<HallBookings />, '/hall')
    await screen.findByText('Ada and Ben')
    fireEvent.change(screen.getByLabelText(EN['hall.host']), { target: { value: 'Dinner during Mass' } })
    fireEvent.change(screen.getByLabelText(EN['hall.starts']), { target: { value: '2026-11-15T10:00' } })
    fireEvent.change(screen.getByLabelText(EN['hall.ends']), { target: { value: '2026-11-15T12:00' } })
    fireEvent.click(screen.getByRole('button', { name: EN['hall.book'] }))
    expect(await screen.findByText('Sacramental register · Marriage · November 7, 2026')).toBeTruthy()
    expect(screen.getByText(EN['hall.conflictMarriageHint'])).toBeTruthy()
    expect(screen.queryByText(/marriage · 2026-11-07/)).toBeNull()

    fireEvent.change(screen.getByLabelText(EN['hall.host']), { target: { value: 'Dinner during Mass' } })
    fireEvent.change(screen.getByLabelText(EN['hall.starts']), { target: { value: '2026-11-15T10:00' } })
    fireEvent.change(screen.getByLabelText(EN['hall.ends']), { target: { value: '2026-11-15T12:00' } })
    fireEvent.click(screen.getByRole('button', { name: EN['hall.book'] }))
    const banners = await screen.findAllByTestId('sunday-warning')
    expect(banners).toHaveLength(1)
    const card = screen.getByText('Dinner during Mass').closest('article')
    expect(within(card).getByTestId('sunday-warning').textContent).toMatch(/Sunday Mass · November 15, 2026/)
    const other = screen.getByText('Ada and Ben').closest('article')
    expect(within(other).queryByTestId('sunday-warning')).toBeNull()
  })

  it('Approve is disabled and says why while counsel terms are missing', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/agreement'), json(201, { payments: 'on_hold', id: 3, status: 'draft', contract_sha256: 'abc', contract_en: 'Draft', contract_es: 'Borrador', counsel_pending: true })],
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{ id: 3, status: 'draft', counsel_pending: true, copy_path: null }]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.prepare'] }))
    const approve = await screen.findByRole('button', { name: EN['hall.send'] })
    expect(approve.disabled).toBe(true)
    expect(screen.getByTestId('counsel-pending').textContent).toBe(EN['hall.counselPending'])
  })

  it('"Approve and copy" copies the link, and is gone once the link is issued', async () => {
    let sent = false
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/agreement'), json(201, { payments: 'on_hold', id: 3, status: 'draft', contract_sha256: 'abc', contract_en: 'Ready', contract_es: 'Listo', counsel_pending: false })],
      [(p) => p.endsWith('/agreement/send'), () => { sent = true; return json(200, { payments: 'on_hold', agreement_id: 3, copy_path: '/sign/hall/org000001.sample', already_issued: false, deposit_link: null }) }],
      [(p) => p.endsWith('/bookings/9'), () => json(200, detailWith([sent
        ? { id: 3, status: 'sent', counsel_pending: false, copy_path: '/sign/hall/org000001.sample' }
        : { id: 3, status: 'draft', counsel_pending: false, copy_path: null }]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.prepare'] }))
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.send'] }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/sign/hall/org000001.sample`))
    expect(await screen.findByText(EN['hall.sentCopied'])).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: EN['hall.send'] })).toBeNull())
    expect(screen.queryByRole('button', { name: EN['hall.prepare'] })).toBeNull()
  })

  it('replacing the link warns first, then sends confirm_replace', async () => {
    const calls = []
    const fetchMock = hallFetch([
      [(p) => p.endsWith('/agreement/rotate'), (p, init) => { calls.push(JSON.parse(init.body)); return json(200, { payments: 'on_hold', copy_path: '/sign/hall/org000001.next' }) }],
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([{ id: 3, status: 'sent', counsel_pending: false, copy_path: '/sign/hall/org000001.sample' }]))],
    ])
    vi.stubGlobal('fetch', fetchMock)
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.replaceLink'] }))
    expect(await screen.findByText(EN['hall.replaceWarn'])).toBeTruthy()
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: EN['hall.replaceConfirm'] }))
    await waitFor(() => expect(calls).toEqual([{ confirm_replace: true }]))
    expect(await screen.findByText(EN['hall.replaced'])).toBeTruthy()
  })

  it('an unsigned void does not claim a signature record', async () => {
    vi.stubGlobal('fetch', hallFetch([
      [(p) => p.endsWith('/bookings/9'), json(200, detailWith([
        { id: 2, status: 'voided', signed_at: null, copy_path: null },
        { id: 3, status: 'voided', signed_at: '2026-10-20T10:00:00Z', copy_path: null },
      ]))],
    ]))
    mount(<HallBookings />, '/hall')
    fireEvent.click(await screen.findByRole('button', { name: EN['hall.beoTitle'] }))
    expect(await screen.findByText(EN['hall.status.voidedUnsigned'])).toBeTruthy()
    expect(screen.getAllByText(EN['hall.status.voided'])).toHaveLength(1)
  })

  it('copy strings: frozen does not claim a send; one "Nothing is charged" per sentence set', () => {
    expect(EN['hall.frozen']).not.toMatch(/has been sent/)
    expect(STRINGS.es['hall.frozen']).not.toMatch(/se envió/)
    expect(EN['hall.status.voidedUnsigned']).not.toMatch(/signature record/)
  })
})
