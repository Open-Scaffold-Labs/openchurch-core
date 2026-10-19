// SP-054 at the page: adding a member to a parish that already has 12
// must not say "Your first member is on the roster", even in a browser
// that has never shown it. A parish with none still gets it.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { ToastProvider } from '../components/ToastProvider'
import { ConfirmProvider } from '../components/ConfirmProvider'
import Clients from './Clients'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Ada Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const FIRST = 'Welcome aboard. Your first member is on the roster.'
const ok = (body, status = 200) => ({ ok: true, status, json: async () => body })
const member = i => ({ id: 100 + i, name: `Synthetic Member ${i}`, status: 'active', role: 'Member', tags: '' })

function stub(total) {
  const roster = Array.from({ length: total }, (_, i) => member(i))
  const posts = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('/api/clients/stats')) return ok({ total, newWeek: 0, active: total, growth: 0 })
    if (u.includes('/api/clients') && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return ok({ id: 999, name: 'New Person' }, 201) }
    if (u.includes('/api/clients')) return ok(roster)
    return ok([])
  }))
  return posts
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/clients']}>
      <LocaleProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Clients />
          </ConfirmProvider>
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  )
}

async function addMember() {
  const en = STRINGS.en
  fireEvent.click((await screen.findAllByRole('button', { name: new RegExp(en['mem.addMember']) }))[0])
  fireEvent.change(await screen.findByPlaceholderText(en['mem.namePh']), { target: { value: 'New Person' } })
  fireEvent.submit(document.querySelector('form'))
}

beforeEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

describe('first-member toast follows the parish count (SP-054)', () => {
  it('a parish with 12 members: adding one does not say "your first member"', async () => {
    const posts = stub(12)
    mount()
    await screen.findByText('Synthetic Member 0')
    await addMember()
    await waitFor(() => expect(posts).toHaveLength(1))
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByText(FIRST)).not.toBeInTheDocument()
  })

  it('CONTROL: a parish with none still gets the first-member toast', async () => {
    const posts = stub(0)
    mount()
    await addMember()
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(await screen.findByText(FIRST)).toBeInTheDocument()
  })
})
