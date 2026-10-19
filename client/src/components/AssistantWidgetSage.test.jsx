// Sage-style polish (S1–S3) for the in-app assistant.
//
// jsdom limits, stated so green is not over-read: jsdom has no layout,
// no media queries, no env(safe-area-inset-*), no screen reader and no
// Safari. The phone sheet is asserted through a stubbed matchMedia and the
// classes it selects; the live region through its DOM contents; focus
// through document.activeElement. None of this is device evidence.

import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { STRINGS } from '../i18n/strings'
import { MODULE_HELP } from '../data/helpContent'
import AssistantWidget, { SHEET_MQ, fallbackReason, isAssistantShortcut } from './AssistantWidget'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false }),
}))

const EN = STRINGS.en
const OPEN = EN['ast.open']
const CLOSE = EN['ast.close']

function res(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

// status: a response, or an Error to reject with. post: a queue of responses.
function stubFetch({ status = res({ available: true }), post = [] } = {}) {
  const queue = [...post]
  const calls = []
  const fetchMock = vi.fn((url, opts = {}) => {
    const u = String(url)
    if (u.includes('/api/assistant/status')) return status instanceof Error ? Promise.reject(status) : Promise.resolve(status)
    if (opts.method === 'POST' && u.endsWith('/api/assistant')) {
      calls.push(JSON.parse(opts.body))
      return Promise.resolve(queue.shift() ?? res({}, { status: 503 }))
    }
    return Promise.reject(new Error(`unexpected fetch ${opts.method || 'GET'} ${u}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

function stubMedia(matching = []) {
  window.matchMedia = vi.fn(q => ({
    matches: matching.includes(q), media: q,
    addEventListener() {}, removeEventListener() {},
  }))
}

async function mount() {
  let r
  await act(async () => {
    r = render(<LocaleProvider><AssistantWidget /></LocaleProvider>)
  })
  return r
}

const launcher = () => screen.getByRole('button', { name: OPEN })
const composer = () => screen.getByPlaceholderText(EN['ast.ph'])

async function askQuestion(q = 'How do I record a baptism?') {
  fireEvent.change(composer(), { target: { value: q } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: EN['ast.send'] }))
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('ochr_locale')
  delete window.matchMedia
  Element.prototype.scrollTo = vi.fn()
  window.history.pushState({}, '', '/register')
  document.body.style.overflow = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.matchMedia
  window.history.pushState({}, '', '/')
})

describe('S1 keyboard: Ctrl+/ or ⌘/ toggles, ⌘K stays with search, Esc closes', () => {
  it('Ctrl+/ opens the dialog and focuses the composer; Ctrl+/ again closes it', async () => {
    stubFetch()
    await mount()
    fireEvent.keyDown(window, { key: '/', code: 'Slash', ctrlKey: true })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(document.activeElement).toBe(composer())
    fireEvent.keyDown(window, { key: '/', code: 'Slash', ctrlKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('⌘/ (Meta) opens it too', async () => {
    stubFetch()
    await mount()
    fireEvent.keyDown(window, { key: '/', code: 'Slash', metaKey: true })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('⌘K and Ctrl+K do NOT open the assistant (the global search palette owns them)', async () => {
    stubFetch()
    await mount()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.keyDown(window, { key: '/' }) // a bare slash is typing, not a shortcut
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(isAssistantShortcut({ key: 'k', metaKey: true })).toBe(false)
    expect(isAssistantShortcut({ key: '/', ctrlKey: true, altKey: true })).toBe(false)
  })

  it('Esc inside the panel closes it, returns focus to the quill, and does not reach document listeners', async () => {
    stubFetch()
    await mount()
    launcher().focus()
    fireEvent.click(launcher())
    expect(document.activeElement).toBe(composer())
    const docEsc = vi.fn()
    document.addEventListener('keydown', docEsc)
    fireEvent.keyDown(composer(), { key: 'Escape' })
    document.removeEventListener('keydown', docEsc)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(launcher())
    expect(docEsc).not.toHaveBeenCalled()
  })

  it('closing after a shortcut open returns focus to what had it before', async () => {
    stubFetch()
    await mount()
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()
    fireEvent.keyDown(window, { key: '/', ctrlKey: true })
    expect(document.activeElement).toBe(composer())
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: CLOSE }))
    expect(document.activeElement).toBe(field)
    field.remove()
  })
})

describe('S1 dialog semantics and labels', () => {
  it('is a labelled dialog with a labelled close button; the quill reports expanded state and its shortcut', async () => {
    stubFetch()
    await mount()
    expect(launcher()).toHaveAttribute('aria-expanded', 'false')
    expect(launcher()).toHaveAttribute('aria-keyshortcuts', 'Control+/ Meta+/')
    fireEvent.click(launcher())
    const dialog = screen.getByRole('dialog', { name: EN['ast.title'] })
    expect(within(dialog).getByRole('button', { name: CLOSE })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: CLOSE }).find(b => b.getAttribute('aria-expanded') === 'true')).toBeTruthy()
  })
})

describe('S1 phone sheet (stubbed matchMedia — no real viewport in jsdom)', () => {
  it('below 640px the panel is a full-screen sheet with safe-area padding, modal, and the page stops scrolling', async () => {
    stubMedia([SHEET_MQ])
    stubFetch()
    await mount()
    fireEvent.click(launcher())
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-layout', 'sheet')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    for (const c of ['fixed', 'inset-0', 'h-[100dvh]', 'w-full', 'safe-pt', 'safe-pb']) expect(dialog.className).toContain(c)
    expect(dialog.className).not.toContain('w-[360px]')
    // The sheet's own close button replaces the quill while open.
    expect(screen.queryByRole('button', { name: OPEN })).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.click(screen.getByRole('button', { name: CLOSE }))
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(launcher())
  })

  it('at desktop width it stays the 360px floating panel, non-modal', async () => {
    stubMedia([])
    stubFetch()
    await mount()
    fireEvent.click(launcher())
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-layout', 'panel')
    expect(dialog).toHaveAttribute('aria-modal', 'false')
    expect(dialog.className).toContain('w-[360px]')
    expect(dialog.className).not.toContain('inset-0')
  })

  it('prefers-reduced-motion turns the transcript scroll into an instant jump', async () => {
    stubMedia(['(prefers-reduced-motion: reduce)'])
    stubFetch()
    await mount()
    fireEvent.click(launcher())
    const calls = Element.prototype.scrollTo.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.at(-1)[0].behavior).toBe('auto')
  })
})

describe('S1 live region', () => {
  it('a new reply is announced politely', async () => {
    stubFetch({ post: [res({ id: 7, answer: 'Open Register, then Digitize.' })] })
    await mount()
    fireEvent.click(launcher())
    await askQuestion()
    const live = screen.getByTestId('assistant-live')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('Open Register, then Digitize.')
  })
})

describe('S2 help-guide context in the request', () => {
  it('sends the page help KEY with the route — never guide text', async () => {
    const { calls } = stubFetch({ post: [res({ id: 1, answer: 'ok' })] })
    await mount()
    fireEvent.click(launcher())
    await askQuestion('How do certificate numbers work?')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ question: 'How do certificate numbers work?', page_route: '/register', help_key: 'register' })
    const raw = JSON.stringify(calls[0])
    expect(raw).not.toContain(MODULE_HELP.register.overview.slice(0, 40))
  })

  it('a page with no guide entry sends no help_key', async () => {
    window.history.pushState({}, '', '/support')
    const { calls } = stubFetch({ post: [res({ id: 1, answer: 'ok' })] })
    await mount()
    fireEvent.click(launcher())
    await askQuestion()
    expect('help_key' in calls[0]).toBe(false)
  })
})

describe('S3 labelled help-guide fallback', () => {
  const cases = [
    { name: 'ai_disabled (stop switch)', resp: res({ code: 'ai_disabled', error: 'x' }, { status: 403 }), reason: 'paused', message: EN['ai.refusal.ai_disabled'] },
    { name: 'ai_unavailable 503', resp: res({ code: 'ai_unavailable', error: 'x' }, { status: 503 }), reason: 'off', message: EN['ai.refusal.ai_unavailable'] },
    { name: 'daily cap 429', resp: res({ error: 'The assistant has reached today\u2019s limit' }, { status: 429 }), reason: 'limit', message: EN['ast.limit'] },
  ]
  for (const c of cases) {
    it(`${c.name}: the refusal stays visible and the guide shows under "${EN[`ast.guide.${c.reason}`]}"`, async () => {
      stubFetch({ post: [c.resp] })
      await mount()
      fireEvent.click(launcher())
      await askQuestion()
      expect(screen.getByRole('alert')).toHaveTextContent(c.message)
      const card = document.querySelector('[data-source="help-guide"]')
      expect(card).not.toBeNull()
      expect(card).toHaveAttribute('data-reason', c.reason)
      expect(within(card).getByText(EN[`ast.guide.${c.reason}`])).toBeInTheDocument()
      expect(within(card).getByText(EN['ast.guide.notAi'])).toBeInTheDocument()
      expect(within(card).getByText(MODULE_HELP.register.overview)).toBeInTheDocument()
      // Not an AI answer: no thumbs, and labelled by the guide heading.
      expect(within(card).queryByRole('button', { name: EN['ast.helpful'] })).toBeNull()
      expect(screen.getByRole('region', { name: EN[`ast.guide.${c.reason}`] })).toBe(card)
      expect(screen.getByTestId('assistant-live')).toHaveTextContent(EN[`ast.guide.${c.reason}`])
    })
  }

  for (const [name, resp] of [
    ['ai_failed 500', res({ code: 'ai_failed', error: 'x' }, { status: 500 })],
    ['ai_input_too_large 413', res({ code: 'ai_input_too_large', error: 'x' }, { status: 413 })],
  ]) {
    it(`${name}: only the refusal, no guide card (the guide is not a stand-in for every failure)`, async () => {
      stubFetch({ post: [resp] })
      await mount()
      fireEvent.click(launcher())
      await askQuestion()
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(document.querySelector('[data-source="help-guide"]')).toBeNull()
    })
  }

  it('the guide never enters the history sent on the next question', async () => {
    const { calls } = stubFetch({ post: [res({ code: 'ai_disabled' }, { status: 403 }), res({ id: 2, answer: 'ok' })] })
    await mount()
    fireEvent.click(launcher())
    await askQuestion('first')
    await askQuestion('second')
    expect(calls[1].history).toEqual([])
    expect(document.querySelector('[data-source="help-guide"]')).toBeNull()
  })

  it('a page with no guide entry says so instead of borrowing another page', async () => {
    window.history.pushState({}, '', '/support')
    stubFetch({ post: [res({ code: 'ai_disabled' }, { status: 403 })] })
    await mount()
    fireEvent.click(launcher())
    await askQuestion()
    const card = document.querySelector('[data-source="help-guide"]')
    expect(within(card).getByText(EN['ast.guide.none'])).toBeInTheDocument()
  })

  for (const [name, status] of [
    ['a thrown status fetch', new TypeError('Failed to fetch')],
    ['a 500 status', res({ error: 'down' }, { status: 500 })],
  ]) {
    it(`${name} is UNKNOWN: the quill and composer stay, no "AI is off" claim, no availability claim`, async () => {
      stubFetch({ status })
      await mount()
      fireEvent.click(launcher())
      expect(composer()).toBeInTheDocument()
      expect(document.querySelector('[data-source="help-guide"]')).toBeNull()
      expect(screen.getByRole('dialog').textContent).not.toMatch(/\bavailable\b|AI is off/i)
    })
  }

  it('UNKNOWN status, then a mid-session 429: the labelled guide still appears', async () => {
    stubFetch({ status: new TypeError('Failed to fetch'), post: [res({ error: 'cap' }, { status: 429 })] })
    await mount()
    fireEvent.click(launcher())
    await askQuestion()
    expect(document.querySelector('[data-source="help-guide"]')).toHaveAttribute('data-reason', 'limit')
  })

  it('Spanish: labels are localized and the English guide says it is in English', async () => {
    localStorage.setItem('ochr_locale', 'es')
    stubFetch({ post: [res({ code: 'ai_disabled' }, { status: 403 })] })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: STRINGS.es['ast.open'] }))
    fireEvent.change(screen.getByPlaceholderText(STRINGS.es['ast.ph']), { target: { value: 'hola' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: STRINGS.es['ast.send'] })) })
    const card = document.querySelector('[data-source="help-guide"]')
    expect(within(card).getByText(STRINGS.es['ast.guide.paused'])).toBeInTheDocument()
    expect(within(card).getByText(STRINGS.es['ast.guide.lang'])).toBeInTheDocument()
  })
})

// José, Oct 18 2026: AI reported off keeps the quill HIDDEN (as on main
// before S1–S3). The labelled guide is only for refusals inside a panel
// that was already open.
describe('quill visibility follows the status probe', () => {
  it('status available:false: no quill, no panel, and Ctrl+/ / ⌘/ do nothing', async () => {
    stubFetch({ status: res({ available: false }) })
    await mount()
    expect(screen.queryByRole('button', { name: OPEN })).toBeNull()
    const ctrl = new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(ctrl) })
    fireEvent.keyDown(window, { key: '/', code: 'Slash', metaKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(ctrl.defaultPrevented).toBe(false)
    expect(document.querySelector('[data-source="help-guide"]')).toBeNull()
  })

  it('status available:true: the quill shows and opens the composer', async () => {
    stubFetch({ status: res({ available: true }) })
    await mount()
    fireEvent.click(launcher())
    expect(composer()).toBeInTheDocument()
    expect(document.querySelector('[data-source="help-guide"]')).toBeNull()
  })

  for (const [name, resp, reason] of [
    ['AI paused mid-session (ai_disabled)', res({ code: 'ai_disabled' }, { status: 403 }), 'paused'],
    ['provider unavailable mid-session (ai_unavailable)', res({ code: 'ai_unavailable' }, { status: 503 }), 'off'],
    ['daily cap mid-session (429)', res({ error: 'cap' }, { status: 429 }), 'limit'],
  ]) {
    it(`status on, then ${name}: the quill stays and the labelled guide appears`, async () => {
      stubFetch({ status: res({ available: true }), post: [resp] })
      await mount()
      fireEvent.click(launcher())
      await askQuestion()
      const card = document.querySelector('[data-source="help-guide"]')
      expect(card).toHaveAttribute('data-reason', reason)
      expect(within(card).getByText(EN['ast.guide.notAi'])).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: CLOSE }).length).toBeGreaterThan(0)
      expect(composer()).toBeInTheDocument()
    })
  }
})

// TARS R324-1 / R324-2 (Oct 18 2026). The app is mounted inside a real
// #root with a background control, as in index.html, so the inert root,
// the portal and the focus trap are exercised the way the app uses them.
// jsdom does not enforce `inert` (it still lets script focus or click an
// inert node), so background isolation is asserted through the attributes
// and the trap pulling escaped focus back in. No browser evidence.
const SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function deferred() {
  let resolve, reject
  const promise = new Promise((res_, rej_) => { resolve = res_; reject = rej_ })
  return { promise, resolve, reject }
}

let appRoot
async function mountInRoot() {
  appRoot = document.createElement('div')
  appRoot.id = 'root'
  const bg = document.createElement('button')
  bg.textContent = 'Background control'
  const onBg = vi.fn()
  bg.addEventListener('click', onBg)
  appRoot.appendChild(bg)
  const host = document.createElement('div')
  appRoot.appendChild(host)
  document.body.appendChild(appRoot)
  await act(async () => {
    render(<LocaleProvider><AssistantWidget /></LocaleProvider>, { container: host })
  })
  return { bg, onBg }
}

describe('R324-1: an off status that arrives after the phone sheet opened', () => {
  afterEach(() => { appRoot?.remove(); appRoot = null })

  it('closes the sheet: no dialog, no quill, original body overflow restored, root released, focus on a connected element', async () => {
    stubMedia([SHEET_MQ])
    document.body.style.overflow = 'clip'
    const status = deferred()
    stubFetch({ status: status.promise })
    await mountInRoot()
    fireEvent.click(launcher())
    expect(screen.getByRole('dialog')).toHaveAttribute('data-layout', 'sheet')
    expect(document.body.style.overflow).toBe('hidden')
    expect(appRoot).toHaveAttribute('inert')
    await act(async () => { status.resolve(res({ available: false })) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: OPEN })).toBeNull()
    expect(document.body.style.overflow).toBe('clip')
    expect(appRoot).not.toHaveAttribute('inert')
    expect(appRoot).not.toHaveAttribute('aria-hidden')
    expect(document.activeElement).not.toBeNull()
    expect(document.activeElement.isConnected).toBe(true)
    fireEvent.keyDown(window, { key: '/', code: 'Slash', ctrlKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  for (const [name, settle] of [
    ['available:true', d => d.resolve(res({ available: true }))],
    ['a 500 status (UNKNOWN)', d => d.resolve(res({ error: 'down' }, { status: 500 }))],
    ['a thrown status (UNKNOWN)', d => d.reject(new TypeError('Failed to fetch'))],
  ]) {
    it(`control — ${name} after opening: the sheet stays open and modal`, async () => {
      stubMedia([SHEET_MQ])
      document.body.style.overflow = 'clip'
      const status = deferred()
      stubFetch({ status: status.promise })
      await mountInRoot()
      fireEvent.click(launcher())
      await act(async () => { settle(status) })
      expect(screen.getByRole('dialog')).toHaveAttribute('data-layout', 'sheet')
      expect(document.activeElement).toBe(composer())
      expect(document.body.style.overflow).toBe('hidden')
      expect(appRoot).toHaveAttribute('inert')
      fireEvent.click(screen.getByRole('button', { name: CLOSE }))
      expect(document.body.style.overflow).toBe('clip')
      expect(document.activeElement).toBe(launcher())
    })
  }
})

describe('R324-2: the phone sheet contains focus; the desktop panel does not', () => {
  afterEach(() => { appRoot?.remove(); appRoot = null })

  async function openSheet() {
    stubMedia([SHEET_MQ])
    stubFetch()
    const bg = await mountInRoot()
    fireEvent.click(launcher())
    fireEvent.change(composer(), { target: { value: 'hello' } }) // enables Send, the last control
    const dialog = screen.getByRole('dialog')
    const nodes = [...dialog.querySelectorAll(SEL)]
    return { ...bg, dialog, first: nodes[0], last: nodes[nodes.length - 1] }
  }

  it('Tab on the last control wraps to the first', async () => {
    const { first, last } = await openSheet()
    expect(last).toBe(screen.getByRole('button', { name: EN['ast.send'] }))
    last.focus()
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => { last.dispatchEvent(e) })
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  it('Shift+Tab on the first control wraps to the last', async () => {
    const { first, last } = await openSheet()
    expect(first).toBe(within(screen.getByRole('dialog')).getByRole('button', { name: CLOSE }))
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('the background is isolated: the sheet is outside #root, #root is inert + aria-hidden, and escaped focus is pulled back in', async () => {
    const { dialog, bg, first } = await openSheet()
    expect(appRoot.contains(dialog)).toBe(false)
    expect(appRoot).toHaveAttribute('inert')
    expect(appRoot).toHaveAttribute('aria-hidden', 'true')
    // jsdom lets script focus an inert node; a browser would not. The trap
    // still refuses to let Tab continue from there.
    bg.focus()
    fireEvent.keyDown(bg, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    // The live region is not under the aria-hidden root.
    expect(appRoot.contains(screen.getByTestId('assistant-live'))).toBe(false)
  })

  it('Escape closes the sheet, restores the root, and returns focus to the quill', async () => {
    await openSheet()
    const docEsc = vi.fn()
    document.addEventListener('keydown', docEsc)
    fireEvent.keyDown(composer(), { key: 'Escape' })
    document.removeEventListener('keydown', docEsc)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(docEsc).not.toHaveBeenCalled()
    expect(appRoot).not.toHaveAttribute('inert')
    expect(appRoot).not.toHaveAttribute('aria-hidden')
    expect(document.activeElement).toBe(launcher())
  })

  it('desktop: non-modal — inside #root, no inert, Tab is not trapped', async () => {
    stubMedia([])
    stubFetch()
    await mountInRoot()
    fireEvent.click(launcher())
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'false')
    expect(appRoot.contains(dialog)).toBe(true)
    expect(appRoot).not.toHaveAttribute('inert')
    const close = within(dialog).getByRole('button', { name: CLOSE })
    close.focus()
    const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    act(() => { close.dispatchEvent(e) })
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('fallbackReason is the only gate to the guide card', () => {
  it('maps exactly the three refusals', () => {
    expect(fallbackReason(403, 'ai_disabled')).toBe('paused')
    expect(fallbackReason(503, 'ai_unavailable')).toBe('off')
    expect(fallbackReason(429, undefined)).toBe('limit')
    for (const [s, c] of [[403, 'ai_forbidden'], [403, 'ai_unsupported_provider'], [413, 'ai_input_too_large'], [500, 'ai_failed'], [500, undefined], [400, undefined]]) {
      expect(fallbackReason(s, c)).toBeNull()
    }
  })
})
