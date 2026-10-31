// D-01 (José, 2026-10-19): each parish brings its own AI key; there is no
// platform-managed key. With no key, /api/assistant/status says
// { available:false, code:'ai_key_required' }. The quill stays and the
// panel says "add your parish's key" — not hidden, not an outage, no
// composer (nothing could answer). A plain available:false still hides.
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import AssistantWidget from './AssistantWidget'
import { aiRefusalMessage } from '../utils/aiRefusal'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
function stubStatus(body) {
  const f = vi.fn(async (url) => {
    if (String(url).includes('/api/assistant/status')) return ok(body)
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', f)
  return f
}
const mount = () => render(<LocaleProvider><AssistantWidget /></LocaleProvider>)

beforeEach(() => { localStorage.removeItem('ochr_locale'); Element.prototype.scrollTo = vi.fn() })
afterEach(() => { vi.unstubAllGlobals(); localStorage.removeItem('ochr_locale') })

describe.each([['en'], ['es']])('assistant with no parish key (%s)', (loc) => {
  const S = STRINGS[loc]
  beforeEach(() => { localStorage.setItem('ochr_locale', loc) })

  it('keeps the quill and says to add the parish key, with no composer', async () => {
    const f = stubStatus({ available: false, code: 'ai_key_required' })
    mount()
    await waitFor(() => expect(f).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: S['ast.open'] }))
    const note = await screen.findByTestId('assistant-key-required')
    expect(note).toHaveTextContent(S['ast.keyRequired'])
    expect(screen.queryByLabelText(S['ast.ph'])).not.toBeInTheDocument()
    expect(screen.queryByText(S['ast.unavailable'])).not.toBeInTheDocument()
  })

  it('copy names the parish key and both providers, and claims no platform key', () => {
    for (const k of ['ast.keyRequired', 'ai.refusal.ai_key_required']) {
      expect(S[k]).toMatch(/Anthropic/)
      expect(S[k]).toMatch(/OpenAI/)
      expect(S[k]).not.toMatch(/built-in|integrad|no disponible ahora|unavailable right now/i)
    }
    expect(S['ast.keyRequired']).not.toBe(STRINGS[loc === 'en' ? 'es' : 'en']['ast.keyRequired'])
  })

  it('mapper: a POST refusal with ai_key_required gets the key copy, not the outage copy', () => {
    const t = (k) => S[k]
    expect(aiRefusalMessage(t, { code: 'ai_key_required' }, 'ast.unavailable')).toBe(S['ai.refusal.ai_key_required'])
  })
})

it('control: a plain available:false still hides the quill', async () => {
  const f = stubStatus({ available: false })
  mount()
  await waitFor(() => expect(f).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByRole('button', { name: STRINGS.en['ast.open'] })).not.toBeInTheDocument())
})

// R334-2: the no-key state is entered from a real widget submission, and
// left again by a read-only status recheck. Status/POST bodies are scripted.
function script() {
  const s = { status: [], post: [], calls: [] }
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url)
    s.calls.push({ u, opts })
    if (u.includes('/api/assistant/status')) {
      const next = s.status.length > 1 ? s.status.shift() : s.status[0]
      if (next === 'throw') throw new Error('offline')
      return ok(next)
    }
    if (u.endsWith('/api/assistant') && opts.method === 'POST') {
      const { status, body } = s.post.shift()
      return { ok: status < 400, status, json: async () => body }
    }
    throw new Error(`unexpected fetch ${u}`)
  }))
  return s
}
async function openAndAsk(S, q) {
  fireEvent.click(await screen.findByRole('button', { name: S['ast.open'] }))
  const box = await screen.findByLabelText(S['ast.ph'])
  fireEvent.change(box, { target: { value: q } })
  fireEvent.click(screen.getByRole('button', { name: S['ast.send'] }))
}

describe.each([['en'], ['es']])('R334-2 transitions (%s)', (loc) => {
  const S = STRINGS[loc]
  beforeEach(() => { localStorage.setItem('ochr_locale', loc) })

  it('available, then a POST refused with ai_key_required: switches to the no-key panel, no composer, no outage error', async () => {
    const s = script()
    s.status = [{ available: true }]
    s.post = [{ status: 409, body: { code: 'ai_key_required', error: 'server english' } }]
    mount()
    await openAndAsk(S, 'How do I print?')
    expect(await screen.findByTestId('assistant-key-required')).toHaveTextContent(S['ast.keyRequired'])
    expect(screen.queryByLabelText(S['ast.ph'])).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('server english')).not.toBeInTheDocument()
    expect(screen.queryByText('How do I print?')).not.toBeInTheDocument() // unanswered question rolled back
  })

  it('unknown first probe, then the POST establishes no key: same no-key panel', async () => {
    const s = script()
    s.status = ['throw']
    s.post = [{ status: 409, body: { code: 'ai_key_required' } }]
    mount()
    await openAndAsk(S, 'Synthetic?')
    expect(await screen.findByTestId('assistant-key-required')).toBeInTheDocument()
  })

  it('recovery: "Check again" rechecks status read-only (no-store) and brings the composer back once a key is added', async () => {
    const s = script()
    s.status = [{ available: false, code: 'ai_key_required' }, { available: true }]
    mount()
    fireEvent.click(await screen.findByRole('button', { name: S['ast.open'] }))
    fireEvent.click(await screen.findByTestId('assistant-key-recheck'))
    expect(await screen.findByLabelText(S['ast.ph'])).toBeInTheDocument()
    expect(screen.queryByTestId('assistant-key-required')).not.toBeInTheDocument()
    const rechecks = s.calls.filter(c => c.u.includes('/status') && c.opts?.cache === 'no-store')
    expect(rechecks.length).toBeGreaterThan(0)
    expect(s.calls.some(c => c.opts?.method === 'POST')).toBe(false)
  })

  it('a key saved or removed in Org details (ochr:ai-provider-changed) rechecks: removed → no-key panel', async () => {
    const s = script()
    s.status = [{ available: true }, { available: false, code: 'ai_key_required' }]
    mount()
    fireEvent.click(await screen.findByRole('button', { name: S['ast.open'] }))
    expect(await screen.findByLabelText(S['ast.ph'])).toBeInTheDocument()
    act(() => { window.dispatchEvent(new Event('ochr:ai-provider-changed')) })
    expect(await screen.findByTestId('assistant-key-required')).toBeInTheDocument()
  })

  it('a recheck that cannot be read keeps the no-key panel (no invented state)', async () => {
    const s = script()
    s.status = [{ available: false, code: 'ai_key_required' }, 'throw']
    mount()
    fireEvent.click(await screen.findByRole('button', { name: S['ast.open'] }))
    fireEvent.click(await screen.findByTestId('assistant-key-recheck'))
    await waitFor(() => expect(s.calls.filter(c => c.u.includes('/status')).length).toBeGreaterThanOrEqual(2))
    expect(screen.getByTestId('assistant-key-required')).toBeInTheDocument()
  })

  it('control: a paused refusal still shows the error and the guide fallback, not the no-key panel', async () => {
    const s = script()
    s.status = [{ available: true }]
    s.post = [{ status: 403, body: { code: 'ai_disabled' } }]
    mount()
    await openAndAsk(S, 'Synthetic?')
    expect(await screen.findByRole('alert')).toHaveTextContent(S['ai.refusal.ai_disabled'])
    expect(screen.getAllByText(S['ast.guide.paused'], { exact: false }).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('assistant-key-required')).not.toBeInTheDocument()
    expect(screen.getByLabelText(S['ast.ph'])).toBeInTheDocument()
  })
})

// R334-3: one owner for availability — the latest request. Deferred
// promises let an older response arrive AFTER a newer one.
function deferredFetch() {
  const pending = { status: [], post: [] }
  vi.stubGlobal('fetch', vi.fn((url, opts = {}) => {
    const u = String(url)
    let resolve
    const p = new Promise(r => { resolve = r })
    if (u.includes('/api/assistant/status')) pending.status.push({ resolve: body => resolve(ok(body)), opts })
    else if (u.endsWith('/api/assistant') && opts.method === 'POST') pending.post.push({ resolve: (status, body) => resolve({ ok: status < 400, status, json: async () => body }) })
    else return Promise.reject(new Error(`unexpected ${u}`))
    return p
  }))
  return pending
}
const settle = async (fn) => { await act(async () => { fn(); await Promise.resolve(); await Promise.resolve() }) }

describe.each([['en'], ['es']])('R334-3 stale responses are ignored (%s)', (loc) => {
  const S = STRINGS[loc]
  beforeEach(() => { localStorage.setItem('ochr_locale', loc) })

  it('(a) recheck A then B; B says no key; A says available late → stays no-key', async () => {
    const f = deferredFetch()
    mount()
    await waitFor(() => expect(f.status).toHaveLength(1))
    await settle(() => f.status[0].resolve({ available: false, code: 'ai_key_required' }))
    fireEvent.click(await screen.findByRole('button', { name: S['ast.open'] })) // opening in no-key rechecks (A)
    await waitFor(() => expect(f.status).toHaveLength(2))
    fireEvent.click(screen.getByTestId('assistant-key-recheck')) // B
    await waitFor(() => expect(f.status).toHaveLength(3))
    await settle(() => f.status[2].resolve({ available: false, code: 'ai_key_required' }))
    await settle(() => f.status[1].resolve({ available: true }))
    expect(screen.getByTestId('assistant-key-required')).toBeInTheDocument()
    expect(screen.queryByLabelText(S['ast.ph'])).not.toBeInTheDocument()
  })

  it('(b) initial GET pending, POST 409, old GET says available late → stays no-key', async () => {
    const f = deferredFetch()
    mount()
    await waitFor(() => expect(f.status).toHaveLength(1))
    await openAndAsk(S, 'Synthetic?')
    await waitFor(() => expect(f.post).toHaveLength(1))
    await settle(() => f.post[0].resolve(409, { code: 'ai_key_required' }))
    expect(await screen.findByTestId('assistant-key-required')).toBeInTheDocument()
    await settle(() => f.status[0].resolve({ available: true }))
    expect(screen.getByTestId('assistant-key-required')).toBeInTheDocument()
    expect(screen.queryByLabelText(S['ast.ph'])).not.toBeInTheDocument()
  })

  it('(c) reverse: newer recheck says available, older says off late → stays available', async () => {
    const f = deferredFetch()
    mount()
    await waitFor(() => expect(f.status).toHaveLength(1))
    await settle(() => f.status[0].resolve({ available: false, code: 'ai_key_required' }))
    fireEvent.click(await screen.findByRole('button', { name: S['ast.open'] })) // A
    await waitFor(() => expect(f.status).toHaveLength(2))
    fireEvent.click(screen.getByTestId('assistant-key-recheck')) // B
    await waitFor(() => expect(f.status).toHaveLength(3))
    await settle(() => f.status[2].resolve({ available: true }))
    expect(await screen.findByLabelText(S['ast.ph'])).toBeInTheDocument()
    await settle(() => f.status[1].resolve({ available: false }))
    expect(screen.getByLabelText(S['ast.ph'])).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: S['ast.close'] }).length).toBeGreaterThan(0) // quill not hidden by the stale off
  })

  it('(d) old POST refusal arrives after a newer successful key recheck → stays available', async () => {
    const f = deferredFetch()
    mount()
    await waitFor(() => expect(f.status).toHaveLength(1))
    await settle(() => f.status[0].resolve({ available: true }))
    await openAndAsk(S, 'Synthetic?')
    await waitFor(() => expect(f.post).toHaveLength(1))
    act(() => { window.dispatchEvent(new Event('ochr:ai-provider-changed')) }) // admin saved a key
    await waitFor(() => expect(f.status).toHaveLength(2))
    await settle(() => f.status[1].resolve({ available: true }))
    await settle(() => f.post[0].resolve(409, { code: 'ai_key_required' }))
    expect(screen.queryByTestId('assistant-key-required')).not.toBeInTheDocument()
    expect(screen.getByLabelText(S['ast.ph'])).toBeInTheDocument()
  })

  it('unmount retires ownership: a late response after unmount changes nothing and logs no error', async () => {
    const f = deferredFetch()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = mount()
    await waitFor(() => expect(f.status).toHaveLength(1))
    expect(f.status[0].opts.signal?.aborted).toBe(false)
    unmount()
    expect(f.status[0].opts.signal?.aborted).toBe(true)
    await settle(() => f.status[0].resolve({ available: true }))
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
