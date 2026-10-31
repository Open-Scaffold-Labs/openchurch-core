// SP-299 — confirm before Published false→true; Cancel makes no request.
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Bulletin from './Bulletin'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1, name: 'Secretary', role: 'admin',
      organization: { id: 1, name: 'St Test', slug: 'st-test', locale: 'en' },
    },
    token: 't', loading: false,
  }),
}))

const en = STRINGS.en
const ok = (b) => ({ ok: true, status: 200, json: async () => b })
let posts

beforeEach(() => {
  posts = []
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    const method = init?.method || 'GET'
    if (method === 'POST' && u.includes('/api/bulletins')) {
      const body = init?.body ? JSON.parse(init.body) : null
      posts.push(body)
      return ok({ id: 99, date: body.date, ...body })
    }
    if (u.includes('/api/bulletins')) return ok({ bulletins: [] })
    if (u.includes('/api/organization')) return ok({ name: 'St Test', slug: 'st-test' })
    if (u.includes('/api/liturgical')) return ok({ season: 'Ordinary Time', color: 'Green', feast_name: null })
    if (u.includes('/api/calendar')) return ok([])
    if (u.includes('/api/service-plans')) return ok({ plans: [] })
    return ok({})
  }))
})

function mount() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Bulletin />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>,
  )
}

describe('SP-299 publish confirm', () => {
  it('confirm copy names announcements, readings, intentions (deceased/requesters), pastor note; no consent claim', () => {
    expect(en['bul.publishConfirmBody']).toMatch(/announcements/i)
    expect(en['bul.publishConfirmBody']).toMatch(/readings/i)
    expect(en['bul.publishConfirmBody']).toMatch(/Mass intentions/i)
    expect(en['bul.publishConfirmBody']).toMatch(/deceased|dead/i)
    expect(en['bul.publishConfirmBody']).toMatch(/requesters/i)
    expect(en['bul.publishConfirmBody']).toMatch(/pastor/i)
    expect(en['bul.publishConfirmBody']).toMatch(/does not mean those people consented/i)
    expect(STRINGS.es['bul.publishConfirmBody']).toMatch(/difuntos/i)
    expect(STRINGS.es['bul.publishConfirmBody']).not.toBe(en['bul.publishConfirmBody'])
  })

  it('Cancel on Published checkbox makes no request and leaves Published off', async () => {
    mount()
    await screen.findByText(en['bul.published'])
    const box = screen.getByRole('checkbox')
    expect(box).not.toBeChecked()
    await act(async () => { fireEvent.click(box) })
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(en['bul.publishConfirmTitle'])).toBeInTheDocument()
    expect(within(dialog).getByText(en['bul.publishConfirmBody'])).toBeInTheDocument()
    // Cancel
    const cancel = within(dialog).getByRole('button', { name: /cancel|cancelar/i })
    await act(async () => { fireEvent.click(cancel) })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(posts).toHaveLength(0)
  })

  it('confirmed Publish then Save posts published:true', async () => {
    mount()
    await screen.findByText(en['bul.published'])
    const box = screen.getByRole('checkbox')
    await act(async () => { fireEvent.click(box) })
    const dialog = await screen.findByRole('alertdialog')
    const confirm = within(dialog).getByRole('button', { name: en['bul.publishConfirmAction'] })
    await act(async () => { fireEvent.click(confirm) })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('checkbox')).toBeChecked()

    // Dirty the form so Save enables
    const ann = screen.getByLabelText(en['bul.field.announcements'] || /announcements/i)
    await act(async () => { fireEvent.change(ann, { target: { value: 'Parish picnic' } }) })
    const saveBtn = screen.getByRole('button', { name: en['bul.create'] })
    await act(async () => { fireEvent.click(saveBtn) })
    // Save re-confirms when prior on server was unpublished.
    const dialog2 = await screen.findByRole('alertdialog')
    await act(async () => {
      fireEvent.click(within(dialog2).getByRole('button', { name: en['bul.publishConfirmAction'] }))
    })
    await waitFor(() => expect(posts.length).toBeGreaterThan(0))
    expect(posts[0].published).toBe(true)
    expect(posts[0].announcements).toBe('Parish picnic')
  })
})
