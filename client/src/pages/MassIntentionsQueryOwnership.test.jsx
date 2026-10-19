// R313-1 (TARS on #313 @0790563d): every list-result writer — first page,
// Load more, save reload — is owned by the query (status/search/view) and
// list generation it started under. Deterministic deferred responses: an
// older read's success, failure or completion must not append to, replace,
// set an error on, or finish ("done") the current query's list.
// R313-2: the past-scheduled empty state narrowed by search/status says only
// that nothing MATCHES; it never claims no past scheduled intention exists.
import { ToastProvider } from '../components/ToastProvider'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import MassIntentions from './MassIntentions'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Secretary', role: 'admin', organization: { id: 1, name: 'St Test', locale: 'en', tradition: 'catholic' } },
    token: 't', loading: false, canWrite: true, isAdmin: true,
  }),
}))

const { en, es } = STRINGS
const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const mk = (id, txt, past, extra = {}) => ({ id, intention: txt, requested_by: 'Synthetic', mass_date: past ? '2026-10-04' : '2027-01-03', mass_title: 'Sunday Mass', status: 'scheduled', stipend: null, past_scheduled: past, ...extra })
const PLAIN_PAGE = Array.from({ length: 50 }, (_, i) => mk(1000 + i, `Plain ${i}`, false))
const PAST_PAGE = Array.from({ length: 50 }, (_, i) => mk(2000 + i, `Past ${i}`, true))
const OLD_TAIL = [mk(3000, 'Old tail A', false), mk(3001, 'Old tail B', false)]

// Each list GET waits for the test to settle it, in any order.
let reqs, writes, deferWrites = false
function stubDeferred() {
  reqs = []; writes = []
  vi.stubGlobal('matchMedia', vi.fn(q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })))
  vi.stubGlobal('fetch', vi.fn((url, init = {}) => {
    const u = String(url)
    if (u.includes('/api/mass-intentions?')) {
      return new Promise(resolve => {
        const p = new URL(u, 'http://x').searchParams
        reqs.push({ p: Object.fromEntries(p), settle: (body, status = 200) => resolve(ok(body, status)) })
      })
    }
    if (/\/api\/mass-intentions(\/\d+)?$/.test(u) && init.method) {
      if (!deferWrites) return Promise.resolve(ok({ id: 99 }, 201))
      return new Promise(resolve => { writes.push({ method: init.method, settle: (body, status) => resolve(ok(body, status)) }) })
    }
    return Promise.resolve(ok([]))
  }))
}
const req = match => waitFor(() => {
  const r = reqs.find(x => !x.used && Object.entries(match).every(([k, v]) => (v === undefined ? !(k in x.p) : x.p[k] === v)))
  if (!r) throw new Error(`no pending request ${JSON.stringify(match)}`)
  r.used = true; return r
}, { timeout: 2000 })
const settle = async (r, body, status) => { await act(async () => { r.settle(body, status); await Promise.resolve() }); await act(async () => {}) }
const book = () => render(<MemoryRouter initialEntries={['/mass-intentions']}><LocaleProvider><ToastProvider><Routes><Route path="/mass-intentions" element={<MassIntentions />} /></Routes></ToastProvider></LocaleProvider></MemoryRouter>)
const loadMoreBtn = () => screen.queryByRole('button', { name: en['mi.loadMore'] })
async function firstUnfilteredPage() {
  book()
  await settle(await req({ offset: '0', view: undefined }), { intentions: PLAIN_PAGE })
  await screen.findByText('Plain 0')
}
async function turnOnPastFilter(body = { intentions: PAST_PAGE }, status) {
  fireEvent.click(screen.getByTestId('mi-past-filter'))
  const r = await req({ offset: '0', view: 'past_scheduled' })
  await settle(r, body, status)
}

beforeEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale'); deferWrites = false; stubDeferred() })
afterEach(() => vi.unstubAllGlobals())

describe('R313-1 list-result ownership', () => {
  it('TARS repro: old unfiltered Load more resolving after the filtered first page does not append or set done', async () => {
    await firstUnfilteredPage()
    fireEvent.click(loadMoreBtn())
    const oldMore = await req({ offset: '50', view: undefined })
    await turnOnPastFilter()
    await screen.findByText('Past 0')
    await settle(oldMore, { intentions: OLD_TAIL })
    expect(screen.queryByText('Old tail A')).toBeNull()
    expect(screen.queryByText(/^Plain /)).toBeNull()
    expect(screen.getAllByTestId('mi-past-scheduled')).toHaveLength(50)
    expect(loadMoreBtn()).toBeInTheDocument() // short stale page did not mark the new list done
    expect(loadMoreBtn()).not.toBeDisabled()
  })

  it('old Load more FAILURE after a newer success sets no error', async () => {
    await firstUnfilteredPage()
    fireEvent.click(loadMoreBtn())
    const oldMore = await req({ offset: '50', view: undefined })
    await turnOnPastFilter()
    await screen.findByText('Past 0')
    await settle(oldMore, { error: 'x' }, 500)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Past 49')).toBeInTheDocument()
  })

  it('old save reload resolving after a query change does not replace the filtered list; the save toast stays truthful', async () => {
    await firstUnfilteredPage()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['mi.add'], 'i') }))
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en['mi.intention']}$`, 'i')), { target: { value: 'For the parish' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en['mi.save']}`, 'i') }))
    expect(await screen.findByText(en['mi.addedToast'])).toBeInTheDocument()
    const oldReload = await req({ offset: '0', view: undefined })
    await turnOnPastFilter()
    await screen.findByText('Past 0')
    await settle(oldReload, { intentions: [mk(4000, 'Reloaded unfiltered', false), ...PLAIN_PAGE.slice(0, 3)] })
    expect(screen.queryByText('Reloaded unfiltered')).toBeNull()
    expect(screen.getAllByTestId('mi-past-scheduled')).toHaveLength(50)
  })

  it('old save reload SUCCESS after a newer filtered FAILURE neither repaints rows nor clears the error', async () => {
    await firstUnfilteredPage()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['mi.add'], 'i') }))
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en['mi.intention']}$`, 'i')), { target: { value: 'For the parish' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en['mi.save']}`, 'i') }))
    const oldReload = await req({ offset: '0', view: undefined })
    await turnOnPastFilter({ error: 'x' }, 500)
    expect(await screen.findByRole('alert')).toHaveTextContent(en['mi.loadFailed'])
    await settle(oldReload, { intentions: [mk(4000, 'Reloaded unfiltered', false)] })
    expect(screen.queryByText('Reloaded unfiltered')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent(en['mi.loadFailed'])
  })

  it('CONTROL: current-query Load more appends; current save reload replaces; a current reload failure keeps rows + shows the error', async () => {
    await firstUnfilteredPage()
    fireEvent.click(loadMoreBtn())
    await settle(await req({ offset: '50', view: undefined }), { intentions: OLD_TAIL })
    expect(screen.getByText('Old tail A')).toBeInTheDocument()
    expect(screen.getByText('Plain 0')).toBeInTheDocument()
    expect(loadMoreBtn()).toBeNull() // short current page → done
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['mi.add'], 'i') }))
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en['mi.intention']}$`, 'i')), { target: { value: 'For the parish' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en['mi.save']}`, 'i') }))
    await settle(await req({ offset: '0', view: undefined }), { intentions: [mk(4000, 'Reloaded current', false)] })
    expect(await screen.findByText('Reloaded current')).toBeInTheDocument()
    expect(screen.queryByText('Plain 0')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /edit intention/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
    expect(await screen.findByText(en['mi.updatedToast'])).toBeInTheDocument()
    await settle(await req({ offset: '0', view: undefined }), { error: 'x' }, 500)
    expect(await screen.findByRole('alert')).toHaveTextContent(en['mi.loadFailed'])
    expect(screen.getByText('Reloaded current')).toBeInTheDocument()
  })

  it('CONTROL: a newer Load more on the current filtered query still appends', async () => {
    await firstUnfilteredPage()
    await turnOnPastFilter()
    fireEvent.click(loadMoreBtn())
    await settle(await req({ offset: '50', view: 'past_scheduled' }), { intentions: [mk(2050, 'Past 50', true)] })
    expect(screen.getByText('Past 50')).toBeInTheDocument()
    expect(screen.getAllByTestId('mi-past-scheduled')).toHaveLength(51)
  })
})

describe('R313-2 past-scheduled empty copy is scoped to the active filters', () => {
  for (const [loc, L] of [['en', en], ['es', es]]) {
    it(`${loc}: a real past scheduled row excluded only by status (or search) gets "no matching", never "none exist"`, async () => {
      if (loc === 'es') localStorage.setItem('ochr_locale', 'es')
      book()
      await settle(await req({ offset: '0', view: undefined }), { intentions: [mk(1, 'Real past row', true)] })
      await screen.findByText('Real past row')
      await turnOnPastFilter({ intentions: [mk(1, 'Real past row', true)] })
      await screen.findByText('Real past row')
      // status=fulfilled AND past_scheduled → [] from the server
      fireEvent.change(screen.getByLabelText(L['mi.allStatuses']), { target: { value: 'fulfilled' } })
      await settle(await req({ offset: '0', view: 'past_scheduled', status: 'fulfilled' }), { intentions: [] })
      expect(await screen.findByText(L['mi.pastScheduledNoMatchTitle'])).toBeInTheDocument()
      expect(screen.getByText(L['mi.pastScheduledNoMatchBody'])).toBeInTheDocument()
      expect(screen.queryByText(L['mi.pastScheduledEmptyTitle'])).toBeNull()
      expect(screen.queryByText(L['mi.pastScheduledEmptyBody'])).toBeNull()
      // back to all statuses, nonmatching search → same scoped copy
      fireEvent.change(screen.getByLabelText(L['mi.allStatuses']), { target: { value: '' } })
      fireEvent.change(screen.getByLabelText(L['mi.search']), { target: { value: 'zzz-nomatch' } })
      await settle(await req({ offset: '0', view: 'past_scheduled', q: 'zzz-nomatch' }), { intentions: [] })
      expect(await screen.findByText(L['mi.pastScheduledNoMatchTitle'])).toBeInTheDocument()
      expect(screen.queryByText(L['mi.pastScheduledEmptyBody'])).toBeNull()
      for (const k of ['mi.pastScheduledNoMatchTitle', 'mi.pastScheduledNoMatchBody']) {
        expect(en[k]).not.toMatch(/missed|said|celebrated|discharged|overdue/i)
        expect(es[k]).not.toMatch(/perdid|omitid|celebrad|cumplid[ao]s?\b|vencid/i)
      }
    })
  }

  it('CONTROL: with no search and all statuses, the unconstrained empty copy is used', async () => {
    book()
    await settle(await req({ offset: '0', view: undefined }), { intentions: [mk(1, 'Future row', false)] })
    await screen.findByText('Future row')
    await turnOnPastFilter({ intentions: [] })
    expect(await screen.findByText(en['mi.pastScheduledEmptyTitle'])).toBeInTheDocument()
    expect(screen.queryByText(en['mi.pastScheduledNoMatchTitle'])).toBeNull()
  })
})

// R313-1 delta (TARS @3e1c1b93, comment 6254553936): the query changes while
// the WRITE itself is still pending. The save continuation must not borrow
// the new query's generation, retire its reads, or reload with the old
// closure's status/search/view. The confirmed-save toast stays.
describe('R313-1 delta: save continuation owned from before the write await', () => {
  const pendingWrite = () => waitFor(() => { const w = writes.find(x => !x.used); if (!w) throw new Error('no write'); w.used = true; return w }, { timeout: 2000 })
  const flush = () => act(async () => { await new Promise(r => setTimeout(r, 400)) }) // > the 250ms first-page debounce
  const oldQueryReloads = since => reqs.slice(since).filter(r => r.p.offset === '0' && !('view' in r.p))
  async function startAdd() {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['mi.add'], 'i') }))
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en['mi.intention']}$`, 'i')), { target: { value: 'For the parish' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en['mi.save']}`, 'i') }))
    return pendingWrite()
  }
  async function startEdit() {
    fireEvent.click(screen.getAllByRole('button', { name: /edit intention/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
    return pendingWrite()
  }

  it('POST pending → filter on → filtered page SUCCEEDS → POST resolves: no old-query reload; filtered rows, done and Load more stay current; toast "added"', async () => {
    deferWrites = true
    await firstUnfilteredPage()
    const post = await startAdd()
    expect(post.method).toBe('POST')
    await turnOnPastFilter()
    await screen.findByText('Past 0')
    const mark = reqs.length
    await settle(post, { id: 99 }, 201)
    expect(await screen.findByText(en['mi.addedToast'])).toBeInTheDocument()
    await flush()
    for (const r of oldQueryReloads(mark)) await settle(r, { intentions: [mk(4000, 'Old-query reload', false)] })
    expect(screen.queryByText('Old-query reload')).toBeNull()
    expect(screen.getAllByTestId('mi-past-scheduled')).toHaveLength(50)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status', { name: en['mi.loading'] })).toBeNull()
    expect(loadMoreBtn()).toBeInTheDocument()
    expect(loadMoreBtn()).not.toBeDisabled()
    expect(oldQueryReloads(mark)).toHaveLength(0)
  })

  it('PATCH pending → filter on → filtered page FAILS → PATCH resolves: the newer error stays, no stale rows; toast "updated"', async () => {
    deferWrites = true
    await firstUnfilteredPage()
    const patch = await startEdit()
    expect(patch.method).toBe('PATCH')
    await turnOnPastFilter({ error: 'x' }, 500)
    expect(await screen.findByRole('alert')).toHaveTextContent(en['mi.loadFailed'])
    const mark = reqs.length
    await settle(patch, { id: 1000 }, 200)
    expect(await screen.findByText(en['mi.updatedToast'])).toBeInTheDocument()
    await flush()
    for (const r of oldQueryReloads(mark)) await settle(r, { intentions: PLAIN_PAGE })
    expect(screen.queryByRole('alert')).toHaveTextContent(en['mi.loadFailed'])
    expect(screen.queryByText(/^Plain /)).toBeNull()
    expect(oldQueryReloads(mark)).toHaveLength(0)
  })

  it('POST resolving while the NEW query\'s Load more is pending does not retire it', async () => {
    deferWrites = true
    await firstUnfilteredPage()
    const post = await startAdd()
    await turnOnPastFilter()
    await screen.findByText('Past 0')
    fireEvent.click(loadMoreBtn())
    const currentMore = await req({ offset: '50', view: 'past_scheduled' })
    await settle(post, { id: 99 }, 201)
    await flush()
    for (const r of oldQueryReloads(0).filter(r => !r.used)) await settle(r, { intentions: PLAIN_PAGE })
    await settle(currentMore, { intentions: [mk(2050, 'Past 50', true)] })
    expect(screen.getByText('Past 50')).toBeInTheDocument()
    expect(screen.getAllByTestId('mi-past-scheduled')).toHaveLength(51)
    expect(screen.queryByText(/^Plain /)).toBeNull()
  })

  it('unmount while POST is pending: the delayed continuation issues no reload after retirement', async () => {
    deferWrites = true
    await firstUnfilteredPage()
    const post = await startAdd()
    const mark = reqs.length
    // RTL cleanup-equivalent unmount of the rendered tree
    const { cleanup } = await import('@testing-library/react')
    cleanup()
    await act(async () => { post.settle({ id: 99 }, 201); await new Promise(r => setTimeout(r, 400)) })
    expect(reqs.slice(mark).filter(r => r.p.offset === '0')).toHaveLength(0)
  })

  it('CONTROL: a save with NO query change still reloads the current list (replaces rows)', async () => {
    deferWrites = true
    await firstUnfilteredPage()
    const post = await startAdd()
    await settle(post, { id: 99 }, 201)
    await settle(await req({ offset: '0', view: undefined }), { intentions: [mk(4000, 'Reloaded current', false)] })
    expect(await screen.findByText('Reloaded current')).toBeInTheDocument()
    expect(screen.queryByText('Plain 0')).toBeNull()
    expect(screen.getByText(en['mi.addedToast'])).toBeInTheDocument()
  })
})
