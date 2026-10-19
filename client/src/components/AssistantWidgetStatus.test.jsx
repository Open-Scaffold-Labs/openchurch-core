// A refused /api/assistant/status is not "the assistant is off".
//
// The probe used to do `r.ok ? r.json() : { available: false }` and the
// catch agreed, so a 401/500 hid the quill the same way an explicit
// available:false does. Public giving already splits this: unknown keeps
// the control, only an explicit no removes it. A later send that fails
// still surfaces ast.unavailable — the panel does not invent an answer.

import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import AssistantWidget from './AssistantWidget'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const OPEN = STRINGS.en['ast.open']

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body }
}

function mount() {
  return render(
    <LocaleProvider>
      <AssistantWidget />
    </LocaleProvider>,
  )
}

// Hold the status probe so the assertion runs after the body is applied,
// not on the first paint.
function holdStatus() {
  let release
  let rejectGate
  const gate = new Promise((resolve, reject) => {
    release = resolve
    rejectGate = reject
  })
  const fetchMock = vi.fn((url, opts = {}) => {
    const u = String(url)
    if (u.includes('/api/assistant/status')) return gate
    if (opts.method === 'POST') return Promise.resolve(response({}, { ok: false, status: 503 }))
    return Promise.reject(new Error(`unexpected fetch ${opts.method || 'GET'} ${u}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { release, rejectGate, gate, fetchMock }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  // jsdom does not implement Element.scrollTo; opening the panel scrolls the transcript.
  Element.prototype.scrollTo = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('assistant status is yes, no, or unknown', () => {
  it('a refused status keeps the quill', async () => {
    const { release, gate } = holdStatus()
    mount()
    await act(async () => {
      release(response({ error: 'unauthorized' }, { ok: false, status: 401 }))
      await gate
    })
    expect(screen.getByRole('button', { name: OPEN })).toBeInTheDocument()
  })

  it('an explicit available:false hides the quill', async () => {
    const { release, gate } = holdStatus()
    mount()
    await act(async () => {
      release(response({ available: false }))
      await gate
    })
    expect(screen.queryByRole('button', { name: OPEN })).not.toBeInTheDocument()
  })

  it('available:true shows the quill', async () => {
    const { release, gate } = holdStatus()
    mount()
    await act(async () => {
      release(response({ available: true }))
      await gate
    })
    expect(screen.getByRole('button', { name: OPEN })).toBeInTheDocument()
  })

  it('a thrown status probe keeps the quill', async () => {
    const { rejectGate, gate } = holdStatus()
    mount()
    await act(async () => {
      rejectGate(new TypeError('Failed to fetch'))
      await gate.catch(() => {})
    })
    expect(screen.getByRole('button', { name: OPEN })).toBeInTheDocument()
  })

  it('a malformed status body keeps the quill', async () => {
    const { release, gate } = holdStatus()
    mount()
    await act(async () => {
      // No boolean `available`. Boolean(undefined) used to hide the quill.
      release(response({}))
      await gate
    })
    expect(screen.getByRole('button', { name: OPEN })).toBeInTheDocument()
  })

  it('a status body that will not parse keeps the quill', async () => {
    const { release, gate } = holdStatus()
    mount()
    await act(async () => {
      release({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } })
      await gate
    })
    expect(screen.getByRole('button', { name: OPEN })).toBeInTheDocument()
  })

  it('a failed send while status is unknown still says the assistant is unavailable', async () => {
    const { release, gate } = holdStatus()
    mount()
    await act(async () => {
      release(response({ error: 'down' }, { ok: false, status: 503 }))
      await gate
    })
    fireEvent.click(screen.getByRole('button', { name: OPEN }))
    fireEvent.change(screen.getByPlaceholderText(STRINGS.en['ast.ph']), {
      target: { value: 'How do I record a baptism?' },
    })
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en['ast.send'] }))
    expect(await screen.findByRole('alert')).toHaveTextContent(STRINGS.en['ast.unavailable'])
  })
})
