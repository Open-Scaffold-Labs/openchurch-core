// ⌘K used to find a member and then lose them: selectItem always
// navigated to the type's list page. The search payload already carries
// `id`. These tests pin the two deep-links from product archaeology
// 2026-09-09 — member → /clients/:id, donation → /donations?id=.

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import GlobalSearchPalette, { pathForSearchItem } from './GlobalSearchPalette'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false }),
}))

const MEMBER = {
  id: 20013, type: 'member', name: 'John Parishioner',
  email: 'john@parish.test', role: 'member', status: 'active',
}
const GIFT = {
  id: 501, type: 'donation', donor_name: 'John Donor',
  amount: '40.00', category: 'tithe', date: '2031-06-15',
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

function mount(hits) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/search')) return ok(hits)
    return ok([])
  }))
  const onClose = vi.fn()
  render(
    <LocaleProvider>
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <GlobalSearchPalette open onClose={onClose} typeFilter={null} setTypeFilter={() => {}} />
      </MemoryRouter>
    </LocaleProvider>
  )
  return { onClose }
}

async function searchAndPick(query, title) {
  fireEvent.change(screen.getByLabelText('Search query'), { target: { value: query } })
  const row = await screen.findByRole('button', { name: new RegExp(title, 'i') }, { timeout: 4000 })
  fireEvent.click(row)
}

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('pathForSearchItem', () => {
  it('opens the member profile, not the members list', () => {
    expect(pathForSearchItem(MEMBER)).toBe('/clients/20013')
  })

  it('opens the donations log focused on that gift', () => {
    expect(pathForSearchItem(GIFT)).toBe('/donations?id=501')
  })

  it('falls back to the list when the hit has no id', () => {
    expect(pathForSearchItem({ type: 'member', name: 'John Parishioner' })).toBe('/clients')
    expect(pathForSearchItem({ type: 'donation', donor_name: 'John Donor' })).toBe('/donations')
  })

  it('leaves other types on their list pages', () => {
    expect(pathForSearchItem({ type: 'event', id: 9, title: 'Mass' })).toBe('/events')
    expect(pathForSearchItem({ type: 'task', id: 3, title: 'Call' })).toBe('/tasks')
    expect(pathForSearchItem({ type: 'staff', id: 2, name: 'Sacristan' })).toBe('/payroll')
  })
})

describe('picking a search hit', () => {
  it('a member row lands on /clients/:id', async () => {
    const { onClose } = mount([MEMBER, GIFT])
    await searchAndPick('john', 'John Parishioner')
    expect(screen.getByTestId('loc').textContent).toBe('/clients/20013')
    expect(onClose).toHaveBeenCalled()
  })

  it('a donation row lands on /donations?id= for that gift', async () => {
    const { onClose } = mount([MEMBER, GIFT])
    await searchAndPick('john', 'John Donor')
    expect(screen.getByTestId('loc').textContent).toBe('/donations?id=501')
    expect(onClose).toHaveBeenCalled()
  })

  it('English session still names the query field and the empty hint', () => {
    mount([])
    expect(screen.getByRole('dialog', { name: STRINGS.en['shell.searchShort'] })).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['shell.search.query'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.en['shell.search.close'])).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.en['shell.search.placeholder'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['shell.search.all'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.en['nav.Members'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['shell.search.hint'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['shell.search.footer'])).toBeInTheDocument()
  })

  it('Spanish session replaces the search chrome, including an empty result', async () => {
    localStorage.setItem('ochr_locale', 'es')
    localStorage.setItem('ochr_search_recents', JSON.stringify(['misa dominical']))
    mount([])
    expect(screen.getByRole('dialog', { name: STRINGS.es['shell.searchShort'] })).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.es['shell.search.query'])).toBeInTheDocument()
    expect(screen.getByLabelText(STRINGS.es['shell.search.close'])).toBeInTheDocument()
    expect(screen.getByPlaceholderText(STRINGS.es['shell.search.placeholder'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['shell.search.all'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['nav.Members'] })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['nav.Donations'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['shell.search.recent'])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: STRINGS.es['shell.search.clear'] })).toBeInTheDocument()
    expect(screen.getByText(STRINGS.es['shell.search.footer'])).toBeInTheDocument()
    expect(screen.queryByLabelText(STRINGS.en['shell.search.query'])).toBeNull()
    expect(screen.queryByText(STRINGS.en['shell.search.hint'])).toBeNull()
    expect(screen.queryByText('Recent')).toBeNull()

    fireEvent.change(screen.getByLabelText(STRINGS.es['shell.search.query']), { target: { value: 'xyz' } })
    const empty = await screen.findByText(/Sin resultados para/)
    expect(empty.textContent).toContain('"xyz"')
    expect(screen.queryByText(/No results for/)).toBeNull()
  })

  it('a refused search is not an empty parish', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    fireEvent.change(screen.getByLabelText(STRINGS.en['shell.search.query']), { target: { value: 'john' } })
    expect(await screen.findByRole('status')).toHaveTextContent(STRINGS.en['shell.search.unread'])
    // 'did not load' rule: say only that search did not load, no inverse claim.
    expect(STRINGS.en['shell.search.unread']).toMatch(/^Search did not load\./)
    expect(STRINGS.es['shell.search.unread']).toMatch(/^No se pudo cargar la búsqueda\./)
    expect(STRINGS.en['shell.search.unread']).not.toMatch(/nothing matches|isn't a sign/)
    expect(screen.queryByText(/No results for/)).toBeNull()
  })

  it('a search body that is not a list is not an empty parish', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) })))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    fireEvent.change(screen.getByLabelText(STRINGS.en['shell.search.query']), { target: { value: 'john' } })
    expect(await screen.findByRole('status')).toHaveTextContent(STRINGS.en['shell.search.unread'])
    expect(screen.queryByText(/No results for/)).toBeNull()
  })

  it('an empty list is still no results', async () => {
    mount([])
    fireEvent.change(screen.getByLabelText(STRINGS.en['shell.search.query']), { target: { value: 'john' } })
    expect(await screen.findByText(/No results for/)).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a refused search in Spanish does not say there were no results', async () => {
    localStorage.setItem('ochr_locale', 'es')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    fireEvent.change(screen.getByLabelText(STRINGS.es['shell.search.query']), { target: { value: 'juan' } })
    const note = await screen.findByRole('status')
    expect(note).toHaveTextContent(STRINGS.es['shell.search.unread'])
    expect(screen.queryByText(/Sin resultados para/)).toBeNull()
  })

  it('an abort the palette did not start is a failed search', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError')
    expect(abortErr.name).toBe('AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => { throw abortErr }))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    fireEvent.change(screen.getByLabelText(STRINGS.en['shell.search.query']), { target: { value: 'pedro' } })
    expect(await screen.findByRole('status', {}, { timeout: 4000 })).toHaveTextContent(STRINGS.en['shell.search.unread'])
    expect(screen.queryByText(/No results for/)).toBeNull()
  })

  it('a dropped connection is not an empty parish', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    fireEvent.change(screen.getByLabelText(STRINGS.en['shell.search.query']), { target: { value: 'john' } })
    expect(await screen.findByRole('status', {}, { timeout: 4000 })).toHaveTextContent(STRINGS.en['shell.search.unread'])
    expect(screen.queryByText(/No results for/)).toBeNull()
  })

  it('a later success clears the failure note', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const q = new URL(String(url), 'http://local.test').searchParams.get('q')
      if (q === 'maria') return { ok: false, status: 500, json: async () => ({}) }
      if (q === 'pedro') return ok([MEMBER])
      return ok([])
    }))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    const input = screen.getByLabelText(STRINGS.en['shell.search.query'])
    fireEvent.change(input, { target: { value: 'maria' } })
    expect(await screen.findByRole('status', {}, { timeout: 4000 })).toHaveTextContent(STRINGS.en['shell.search.unread'])
    fireEvent.change(input, { target: { value: 'pedro' } })
    expect(await screen.findByRole('button', { name: /John Parishioner/i }, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/No results for/)).toBeNull()
  })

  it('a short query clears a failure, the spinner, and the previous hits', async () => {
    let releaseZz
    const zzPending = new Promise((resolve) => { releaseZz = resolve })
    let zzStarted = false
    vi.stubGlobal('fetch', vi.fn((url) => {
      const q = new URL(String(url), 'http://local.test').searchParams.get('q')
      if (q === 'zz') {
        zzStarted = true
        return zzPending.then(() => ok([]))
      }
      if (q === 'ma') return Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
      return Promise.resolve(ok([MEMBER]))
    }))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    const input = screen.getByLabelText(STRINGS.en['shell.search.query'])

    fireEvent.change(input, { target: { value: 'ma' } })
    expect(await screen.findByRole('status', {}, { timeout: 4000 })).toHaveTextContent(STRINGS.en['shell.search.unread'])
    fireEvent.change(input, { target: { value: 'm' } })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/No results for/)).toBeNull()
    expect(screen.getByText(STRINGS.en['shell.search.hint'])).toBeInTheDocument()
    expect(document.querySelector('.animate-spin')).toBeNull()

    fireEvent.change(input, { target: { value: 'jo' } })
    expect(await screen.findByRole('button', { name: /John Parishioner/i }, { timeout: 4000 })).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'j' } })
    expect(screen.queryByRole('button', { name: /John Parishioner/i })).toBeNull()
    expect(screen.getByText(STRINGS.en['shell.search.hint'])).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'zz' } })
    await waitFor(() => expect(zzStarted).toBe(true), { timeout: 4000 })
    expect(document.querySelector('.animate-spin')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /John Parishioner/i })).toBeNull()
    fireEvent.change(input, { target: { value: 'z' } })
    expect(document.querySelector('.animate-spin')).toBeNull()
    expect(screen.getByText(STRINGS.en['shell.search.hint'])).toBeInTheDocument()
    await act(async () => {
      releaseZz()
      await zzPending
    })
    expect(screen.queryByText(/No results for/)).toBeNull()
    expect(screen.queryByRole('button', { name: /John Parishioner/i })).toBeNull()
  })

  it('a late earlier failure does not replace a newer success', async () => {
    let releaseMaria
    const mariaPending = new Promise((resolve) => { releaseMaria = resolve })
    const mariaFetch = mariaPending.then(() => ({ ok: false, status: 500, json: async () => ({}) }))
    let mariaStarted = false
    vi.stubGlobal('fetch', vi.fn((url) => {
      const q = new URL(String(url), 'http://local.test').searchParams.get('q')
      if (q === 'maria') {
        mariaStarted = true
        return mariaFetch
      }
      return Promise.resolve(ok([MEMBER]))
    }))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    const input = screen.getByLabelText(STRINGS.en['shell.search.query'])
    fireEvent.change(input, { target: { value: 'maria' } })
    await waitFor(() => expect(mariaStarted).toBe(true), { timeout: 4000 })
    fireEvent.change(input, { target: { value: 'pedro' } })
    expect(await screen.findByRole('button', { name: /John Parishioner/i }, { timeout: 4000 })).toBeInTheDocument()
    await act(async () => {
      releaseMaria()
      await mariaFetch
    })
    expect(screen.getByRole('button', { name: /John Parishioner/i })).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/No results for/)).toBeNull()
  })

  it('a stale reply does not flash no results while the next search loads', async () => {
    let releaseMaria
    const mariaPending = new Promise((resolve) => { releaseMaria = resolve })
    const mariaFetch = mariaPending.then(() => ok([]))
    let releasePedro
    const pedroPending = new Promise((resolve) => { releasePedro = resolve })
    const pedroFetch = pedroPending.then(() => ok([MEMBER]))
    let mariaStarted = false
    vi.stubGlobal('fetch', vi.fn((url) => {
      const q = new URL(String(url), 'http://local.test').searchParams.get('q')
      if (q === 'maria') {
        mariaStarted = true
        return mariaFetch
      }
      return pedroFetch
    }))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    const input = screen.getByLabelText(STRINGS.en['shell.search.query'])
    fireEvent.change(input, { target: { value: 'maria' } })
    await waitFor(() => expect(mariaStarted).toBe(true), { timeout: 4000 })
    fireEvent.change(input, { target: { value: 'pedro' } })
    await act(async () => {
      releaseMaria()
      await mariaFetch
    })
    expect(screen.queryByText(/No results for/)).toBeNull()
    expect(document.querySelector('.animate-spin')).toBeTruthy()
    await act(async () => {
      releasePedro()
      await pedroFetch
    })
    expect(await screen.findByRole('button', { name: /John Parishioner/i }, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.queryByText(/No results for/)).toBeNull()
  })

  it('a late earlier response does not render under the newer query', async () => {
    let releaseMaria
    const mariaPending = new Promise((resolve) => { releaseMaria = resolve })
    const mariaFetch = mariaPending.then(() => ok([]))
    let mariaSignal = null
    vi.stubGlobal('fetch', vi.fn((url, opts) => {
      const q = new URL(String(url), 'http://local.test').searchParams.get('q')
      if (q === 'maria') {
        mariaSignal = opts?.signal ?? null
        return mariaFetch
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Search failed' }) })
    }))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    const input = screen.getByLabelText(STRINGS.en['shell.search.query'])
    fireEvent.change(input, { target: { value: 'maria' } })
    await waitFor(() => expect(mariaSignal).toBeInstanceOf(AbortSignal), { timeout: 4000 })
    fireEvent.change(input, { target: { value: 'pedro' } })
    expect(mariaSignal.aborted).toBe(true)
    expect(await screen.findByRole('status', {}, { timeout: 4000 })).toHaveTextContent(STRINGS.en['shell.search.unread'])
    await act(async () => {
      releaseMaria()
      await mariaFetch
    })
    expect(screen.getByRole('status')).toHaveTextContent(STRINGS.en['shell.search.unread'])
    expect(screen.queryByText(/No results for/)).toBeNull()
    expect(input).toHaveValue('pedro')
  })

  it('retyping the same query after an error searches again', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) return { ok: false, status: 500, json: async () => ({}) }
      return ok([MEMBER])
    }))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    const input = screen.getByLabelText(STRINGS.en['shell.search.query'])
    fireEvent.change(input, { target: { value: 'maria' } })
    expect(await screen.findByRole('status', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(calls).toBe(1)
    fireEvent.input(input, { target: { value: 'maria' } })
    expect(await screen.findByRole('button', { name: /John Parishioner/i }, { timeout: 4000 })).toBeInTheDocument()
    expect(calls).toBe(2)
    expect(screen.queryByRole('status')).toBeNull()
  })

  // Flake fix (leo/test-isolation-flakes): the retype above raced the
  // passive effect that re-armed the native input listener. This pins the
  // worst-case schedule: the retype fires synchronously in the mutation
  // that paints the failure note, before any passive effect can run.
  it('a retype in the same tick the failure note paints still searches again', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) return { ok: false, status: 500, json: async () => ({}) }
      return ok([MEMBER])
    }))
    render(
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    const input = screen.getByLabelText(STRINGS.en['shell.search.query'])
    let fired = false
    const mo = new MutationObserver(() => {
      if (!fired && document.querySelector('[role="status"]')) {
        fired = true
        fireEvent.input(input, { target: { value: 'maria' } })
      }
    })
    mo.observe(document.body, { childList: true, subtree: true })
    fireEvent.change(input, { target: { value: 'maria' } })
    try {
      expect(await screen.findByRole('button', { name: /John Parishioner/i }, { timeout: 4000 })).toBeInTheDocument()
    } finally { mo.disconnect() }
    expect(fired).toBe(true)
    expect(calls).toBe(2)
    expect(screen.queryByRole('status')).toBeNull()
  })

  // TARS #294: the app mounts the palette CLOSED. The retry listener must
  // attach whenever the input exists (every open), detach on close, and
  // never stack.
  describe('retry listener across open / close', () => {
    const failingThenOk = () => {
      const state = { calls: 0 }
      vi.stubGlobal('fetch', vi.fn(async () => {
        state.calls += 1
        if (state.calls === 1) return { ok: false, status: 500, json: async () => ({}) }
        return ok([MEMBER])
      }))
      return state
    }
    const tree = (open) => (
      <LocaleProvider>
        <MemoryRouter>
          <GlobalSearchPalette open={open} onClose={() => {}} typeFilter={null} setTypeFilter={() => {}} />
        </MemoryRouter>
      </LocaleProvider>
    )
    const label = () => STRINGS.en['shell.search.query']
    const closeAndWait = async (rerender) => {
      rerender(tree(false))
      await waitFor(() => expect(screen.queryByLabelText(label())).toBeNull(), { timeout: 4000 })
    }
    // Live 'input' listeners per element, via the prototype.
    const trackInputListeners = () => {
      const live = new Map()
      const add = EventTarget.prototype.addEventListener
      const rem = EventTarget.prototype.removeEventListener
      vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (type, fn, o) {
        if (type === 'input' && this instanceof HTMLInputElement) live.set(this, (live.get(this) || 0) + 1)
        return add.call(this, type, fn, o)
      })
      vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (type, fn, o) {
        if (type === 'input' && this instanceof HTMLInputElement) live.set(this, (live.get(this) || 0) - 1)
        return rem.call(this, type, fn, o)
      })
      return live
    }

    it('mounted closed, then opened: a same-tick retype after an error searches again', async () => {
      const st = failingThenOk()
      const { rerender } = render(tree(false))
      rerender(tree(true))
      const input = await screen.findByLabelText(label(), {}, { timeout: 4000 })
      let fired = false
      const mo = new MutationObserver(() => {
        if (!fired && document.querySelector('[role="status"]')) { fired = true; fireEvent.input(input, { target: { value: 'maria' } }) }
      })
      mo.observe(document.body, { childList: true, subtree: true })
      fireEvent.change(input, { target: { value: 'maria' } })
      try {
        expect(await screen.findByRole('button', { name: /John Parishioner/i }, { timeout: 4000 })).toBeInTheDocument()
      } finally { mo.disconnect() }
      expect(fired).toBe(true)
      expect(st.calls).toBe(2)
    })

    it('open, close, reopen: a retype after an error searches again', async () => {
      const { rerender } = render(tree(true))
      await closeAndWait(rerender)
      const st = failingThenOk()
      rerender(tree(true))
      const input = await screen.findByLabelText(label(), {}, { timeout: 4000 })
      fireEvent.change(input, { target: { value: 'maria' } })
      expect(await screen.findByRole('status', {}, { timeout: 4000 })).toBeInTheDocument()
      expect(st.calls).toBe(1)
      fireEvent.input(input, { target: { value: 'maria' } })
      expect(await screen.findByRole('button', { name: /John Parishioner/i }, { timeout: 4000 })).toBeInTheDocument()
      expect(st.calls).toBe(2)
    })

    it('several reopens: exactly one live listener, closed inputs keep none, one search per retype', async () => {
      const live = trackInputListeners()
      const { rerender } = render(tree(false))
      for (let i = 0; i < 4; i++) {
        rerender(tree(true))
        await screen.findByLabelText(label(), {}, { timeout: 4000 })
        await closeAndWait(rerender)
      }
      const st = failingThenOk()
      rerender(tree(true))
      const input = await screen.findByLabelText(label(), {}, { timeout: 4000 })
      expect(live.get(input)).toBe(1)
      for (const [el, n] of live) if (el !== input) expect(n).toBe(0)
      fireEvent.change(input, { target: { value: 'maria' } })
      expect(await screen.findByRole('status', {}, { timeout: 4000 })).toBeInTheDocument()
      fireEvent.input(input, { target: { value: 'maria' } })
      expect(await screen.findByRole('button', { name: /John Parishioner/i }, { timeout: 4000 })).toBeInTheDocument()
      await new Promise(r => setTimeout(r, 700)) // past the 300ms debounce: no second retry search
      expect(st.calls).toBe(2)
    })
  })

  it('does not dump a member onto /clients', async () => {
    mount([MEMBER])
    await searchAndPick('john', 'John Parishioner')
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).not.toBe('/clients')
    })
  })
})
