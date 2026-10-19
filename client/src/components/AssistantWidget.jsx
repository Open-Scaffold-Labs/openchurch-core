// AssistantWidget.jsx — floating in-app assistant (SUP.3 client).
//
// A quill button in the bottom-right opens a chat panel. Sends the current
// route as context, keeps session history, offers page-aware starter
// questions, and records thumbs feedback per answer.
//
// Mount once in App.jsx inside the protected layout: <AssistantWidget />
// (reads window.location.pathname itself; no props required).
//
// OPERATOR notes: quill (Feather) is the AI motif; hover shifts color,
// nothing scales; warm shadows; church/brass/parchment only. The help-guide
// card uses the book (BookOpen), never the quill, so a written guide entry
// can never be mistaken for an AI answer.
//
// Sage-style polish (S1–S3, borrowed from OpenLandscapeBusiness's Beacon,
// in OpenChurch's own theme):
//   S1  Below 640px the panel is a full-screen sheet (100dvh, safe-area
//       insets, fixed header). Ctrl+/ (⌘/ on Mac) toggles the panel —
//       NOT ⌘K: Cmd/Ctrl+K is already the global search palette (App.jsx
//       Header). Esc inside the panel closes it. Opening focuses the
//       composer; closing returns focus to where it was (else the quill).
//       Replies are announced through a polite live region. Smooth scroll
//       yields to prefers-reduced-motion.
//       The phone sheet is a real modal (R324-2): it is portaled to <body>
//       and the app root (#root) is made inert + aria-hidden while it is
//       open (HelpPanel's pattern), and Tab / Shift+Tab wrap inside it
//       (ConfirmProvider's pattern). The desktop panel stays non-modal.
//   S2  The request names the Help-panel guide for this page (help_key).
//       The server validates the key and builds the guide text itself;
//       the client never sends guide text.
//   S3  When a question already asked in an open panel is refused because
//       AI is paused (ai_disabled), unavailable (ai_unavailable) or capped
//       for the day (429), the panel shows this page's help-guide entry
//       under an explicit "From the help guide — …" label, next to the
//       refusal message. It is never shown as an AI answer, never gets
//       thumbs, never enters the history sent to the model.
//
// Visibility (José, Oct 18 2026): when the status probe reports AI off
// (available:false) the quill stays HIDDEN, as before S1–S3, and Ctrl+/
// does nothing. An unreadable status stays UNKNOWN: the quill and
// composer stay, with no "AI available" and no "AI is off" claim — the
// same as main before this change.
//
// NOT borrowed from Sage: write tools, question storage, the env-only kill
// switch, the lime theme, HTML rendering of answers.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Feather, X, Send, Loader2, ThumbsUp, ThumbsDown, BookOpen } from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { aiRefusalMessage } from '../utils/aiRefusal'
import { mutate } from '../utils/format'
import { helpKeyForPath, helpEntry } from '../assistant/helpGuide'

// ── Page-aware starter questions (bilingual via keys) ───────────────────────
const PAGE_STARTERS = [
  { match: /^\/register/,        keys: ['ast.s.reg1', 'ast.s.reg2', 'ast.s.reg3'] },
  { match: /^\/mass-intentions/, keys: ['ast.s.mi1', 'ast.s.mi2', 'ast.s.mi3'] },
  { match: /^\/donations/,       keys: ['ast.s.don1', 'ast.s.don2', 'ast.s.don3'] },
  { match: /^\/schedule|^\/events/, keys: ['ast.s.sch1', 'ast.s.sch2', 'ast.s.sch3'] },
  { match: /^\/clients/,         keys: ['ast.s.mem1', 'ast.s.mem2', 'ast.s.mem3'] },
  { match: /^\/finance/,         keys: ['ast.s.fin1', 'ast.s.fin2', 'ast.s.fin3'] },
]
const DEFAULT_STARTERS = ['ast.s.def1', 'ast.s.def2', 'ast.s.def3']

function starterKeysFor(path) {
  for (const p of PAGE_STARTERS) if (p.match.test(path)) return p.keys
  return DEFAULT_STARTERS
}

// Same breakpoint as Tailwind `sm`. No matchMedia (old browsers, jsdom
// without a stub) → the desktop panel.
export const SHEET_MQ = '(max-width: 639px)'
function media(q) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null
}
function useSheetLayout() {
  const [sheet, setSheet] = useState(() => !!media(SHEET_MQ)?.matches)
  useEffect(() => {
    const m = media(SHEET_MQ)
    if (!m) return
    const onChange = e => setSheet(!!e.matches)
    setSheet(!!m.matches)
    m.addEventListener?.('change', onChange)
    return () => m.removeEventListener?.('change', onChange)
  }, [])
  return sheet
}
function prefersReducedMotion() {
  return !!media('(prefers-reduced-motion: reduce)')?.matches
}

// Same selector as ConfirmProvider's focus trap.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Ctrl+/ or ⌘/. `code` covers layouts where '/' needs Shift.
export function isAssistantShortcut(e) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === '/' || e.code === 'Slash')
}

// A refusal that the written guide can stand in for. Anything else
// (input too large, forbidden, a provider failure) shows only its message.
export function fallbackReason(status, code) {
  if (code === 'ai_disabled') return 'paused'
  if (code === 'ai_unavailable') return 'off'
  if (status === 429) return 'limit'
  return null
}

function Bubble({ turn, onFeedback, t }) {
  const mine = turn.role === 'user'
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap
        ${mine
          ? 'bg-church-800 text-parchment-50 dark:bg-brass-700'
          : 'bg-white/80 text-ink-800 border border-parchment-300/70 dark:bg-ink-800 dark:text-parchment-100 dark:border-brass-900/30'}`}>
        {turn.content}
        {!mine && turn.id && (
          <div className="mt-1.5 flex gap-1.5">
            <button aria-label={t('ast.helpful')} onClick={() => onFeedback(turn, 'up')}
              className={`p-1 rounded ${turn.feedback === 'up' ? 'text-brass-700 dark:text-brass-300' : 'text-ink-300 hover:text-ink-500 dark:text-parchment-300/40 dark:hover:text-parchment-300/70'}`}>
              <ThumbsUp size={13} />
            </button>
            <button aria-label={t('ast.notHelpful')} onClick={() => onFeedback(turn, 'down')}
              className={`p-1 rounded ${turn.feedback === 'down' ? 'text-church-700 dark:text-brass-300' : 'text-ink-300 hover:text-ink-500 dark:text-parchment-300/40 dark:hover:text-parchment-300/70'}`}>
              <ThumbsDown size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// The written guide for this page — labelled as such, never as an answer.
function GuideCard({ helpKey, reason, t, locale }) {
  const labelId = useId()
  const entry = helpEntry(helpKey)
  return (
    <section data-source="help-guide" data-reason={reason} aria-labelledby={labelId}
      className="rounded-xl border border-dashed border-brass-400/70 bg-parchment-100/80 px-3.5 py-3 text-sm text-ink-700 dark:border-brass-700/50 dark:bg-ink-800/60 dark:text-parchment-200">
      <div id={labelId} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brass-800 dark:text-brass-300">
        <BookOpen size={13} aria-hidden="true" /> {t(`ast.guide.${reason}`)}
      </div>
      <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">{t('ast.guide.notAi')}</p>
      {entry ? (
        <div className="mt-2 space-y-2 whitespace-pre-wrap leading-relaxed">
          <h3 className="font-display text-sm font-semibold text-ink-800 dark:text-parchment-100">{entry.name}</h3>
          {locale !== 'en' && <p className="text-xs italic text-ink-500 dark:text-parchment-300/70">{t('ast.guide.lang')}</p>}
          <p>{entry.overview}</p>
          {entry.features?.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4">
              {entry.features.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
          {entry.tips?.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-ink-600 dark:text-parchment-300/80">{t('ast.guide.tips')}</div>
              <ul className="list-disc space-y-0.5 pl-4">
                {entry.tips.map((tip, i) => <li key={i}>{tip}</li>)}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-2">{t('ast.guide.none')}</p>
      )}
    </section>
  )
}

export default function AssistantWidget() {
  const { t, locale } = useLocale()
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // null, or 'paused' | 'off' | 'limit': why the written guide is showing.
  const [fallback, setFallback] = useState(null)
  // Text for the polite live region (screen readers hear new replies).
  const [announce, setAnnounce] = useState('')
  // 'yes' | 'no' | 'unknown'. A refused, thrown, or unreadable status is
  // unknown — the quill and composer stay, with no claim either way. Only
  // an explicit available:false hides the quill (and disables Ctrl+/).
  const [availability, setAvailability] = useState('unknown')
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const closeRef = useRef(null)
  const launcherRef = useRef(null)
  const panelRef = useRef(null)
  const returnFocusRef = useRef(null)
  const wasOpen = useRef(false)
  const sheet = useSheetLayout()
  const panelId = useId()
  const titleId = useId()

  useEffect(() => {
    let cancelled = false
    fetch(apiUrl('/api/assistant/status'))
      .then(r => {
        if (!r.ok) throw new Error(`status ${r.status}`)
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        if (!d || typeof d.available !== 'boolean') {
          setAvailability('unknown')
          return
        }
        setAvailability(d.available ? 'yes' : 'no')
      })
      .catch(() => { if (!cancelled) setAvailability('unknown') })
    return () => { cancelled = true }
  }, [])

  // What is actually on screen. An explicit off status hides the widget
  // even if the panel was opened while the probe was still pending
  // (R324-1), so every open-dependent effect keys off `shown`, not `open`:
  // the scroll lock, the inert root and the focus trap are released, and
  // focus comes back out, when an off status hides an open sheet.
  const hidden = availability === 'no'
  const shown = open && !hidden
  const modal = shown && sheet

  // Keep the state honest too: an off status closes the panel.
  useEffect(() => { if (hidden) setOpen(false) }, [hidden])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [turns, shown, fallback])

  const openPanel = useCallback(() => {
    const active = typeof document !== 'undefined' ? document.activeElement : null
    returnFocusRef.current = active && active !== document.body ? active : null
    setOpen(true)
  }, [])
  const closePanel = useCallback(() => setOpen(false), [])

  // Focus in on open, back out on close. If neither the earlier element
  // nor the quill is still in the document (an off status removed both),
  // focus falls back to <body> rather than a detached node.
  useEffect(() => {
    if (shown && !wasOpen.current) {
      ;(inputRef.current ?? closeRef.current)?.focus()
    } else if (!shown && wasOpen.current) {
      const back = returnFocusRef.current
      returnFocusRef.current = null
      const launcher = launcherRef.current
      if (back && back.isConnected && back !== launcher) back.focus()
      else if (launcher && launcher.isConnected) launcher.focus()
      else if (document.activeElement && !document.activeElement.isConnected) document.body.focus?.()
    }
    wasOpen.current = shown
  }, [shown])

  // The phone sheet covers the page; the page behind should not scroll.
  useEffect(() => {
    if (!modal) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [modal])

  // R324-2: the phone sheet is aria-modal, so the page behind is taken out
  // of the keyboard and accessibility trees (HelpPanel's inert-#root
  // pattern; the sheet itself is portaled outside #root). A root that was
  // already inert (another modal) is left as it was.
  useEffect(() => {
    if (!modal) return
    const root = document.getElementById('root')
    if (!root || root.contains(panelRef.current)) return
    const wasInert = root.hasAttribute('inert')
    const hadHidden = root.getAttribute('aria-hidden')
    root.inert = true
    root.setAttribute('inert', '')
    root.setAttribute('aria-hidden', 'true')
    return () => {
      if (!wasInert) { root.inert = false; root.removeAttribute('inert') }
      if (hadHidden === null) root.removeAttribute('aria-hidden')
      else root.setAttribute('aria-hidden', hadHidden)
    }
  }, [modal])

  // R324-2: Tab and Shift+Tab wrap inside the phone sheet, and pull focus
  // back in if it has escaped (ConfirmProvider's trap). Desktop: no trap.
  useEffect(() => {
    if (!modal) return
    const onKey = e => {
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      const nodes = [...(panel?.querySelectorAll(FOCUSABLE) || [])]
      if (!nodes.length) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (!panel.contains(active)) {
        e.preventDefault(); (e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [modal])

  // Ctrl+/ or ⌘/ toggles from anywhere. Cmd/Ctrl+K stays with search.
  useEffect(() => {
    function onKey(e) {
      if (!isAssistantShortcut(e)) return
      // AI reported off: the quill is hidden and the shortcut does nothing
      // (no preventDefault either — the keystroke is not ours).
      if (hidden) return
      e.preventDefault()
      if (shown) closePanel()
      else openPanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown, hidden, openPanel, closePanel])

  function onPanelKeyDown(e) {
    if (e.key === 'Escape') {
      // Only this panel closes; a Help panel or dialog underneath keeps its own Esc.
      e.stopPropagation()
      closePanel()
    }
  }

  const path = window.location.pathname
  const helpKey = helpKeyForPath(path)

  async function ask(question) {
    const q = question.trim()
    if (!q || busy) return
    setError('')
    setFallback(null)
    setInput('')
    const history = turns.map(turn => ({ role: turn.role, content: turn.content }))
    setTurns(prev => [...prev, { role: 'user', content: q }])
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/assistant'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, page_route: path, help_key: helpKey ?? undefined, history }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const reason = fallbackReason(res.status, data?.code)
        const msg = res.status === 429 && !data?.code ? t('ast.limit') : aiRefusalMessage(t, data, 'ast.unavailable')
        const err = new Error(msg)
        err.reason = reason
        throw err
      }
      setTurns(prev => [...prev, { role: 'assistant', content: data.answer, id: data.id }])
      setAnnounce(t('ast.repliedSr', { text: data.answer }))
    } catch (e) {
      setError(e.message)
      setFallback(e.reason ?? null)
      if (e.reason) setAnnounce(t(`ast.guide.${e.reason}`))
      setTurns(prev => prev.slice(0, -1)) // roll back the unanswered question
      setInput(q)
    } finally {
      setBusy(false)
    }
  }

  // The thumb lights up immediately, then stands down again if the write
  // did not land. A thumb that stays lit on a failed POST tells the person
  // their feedback reached us when it did not.
  async function sendFeedback(turn, feedback) {
    const prior = turn.feedback ?? null
    setTurns(prev => prev.map(x => (x === turn ? { ...x, feedback } : x)))
    const { ok } = await mutate(apiUrl(`/api/assistant/${turn.id}/feedback`), { body: { feedback } })
    if (!ok) {
      setTurns(prev => prev.map(x => (x.id === turn.id ? { ...x, feedback: prior } : x)))
    }
  }

  const starters = starterKeysFor(path).map(k => t(k))

  const panelCls = sheet
    ? 'safe-pt safe-pb fixed inset-0 z-50 flex print:hidden h-[100dvh] w-full flex-col overflow-hidden bg-parchment-50 dark:bg-ink-900'
    : 'mb-3 flex h-[520px] max-h-[calc(100dvh-7rem)] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-parchment-300/70 bg-parchment-50 shadow-warm-lg dark:border-brass-900/30 dark:bg-ink-900'

  // AI reported off: no quill, no panel (José, Oct 18 2026). After every
  // hook, so the hook order never changes.
  if (hidden) return null

  const panel = shown && (
    <div ref={panelRef} id={panelId} role="dialog" aria-modal={sheet ? 'true' : 'false'} aria-labelledby={titleId}
      data-layout={sheet ? 'sheet' : 'panel'} onKeyDown={onPanelKeyDown} className={panelCls}>
      {/* Header — fixed at the top of the sheet; the transcript scrolls under it. */}
      <div className="flex flex-none items-center justify-between border-b border-parchment-300/60 bg-parchment-100/80 px-4 py-3 dark:border-brass-900/30 dark:bg-ink-800/80">
        <div className="flex items-center gap-2">
          <Feather size={16} aria-hidden="true" className="text-church-700 dark:text-brass-400" />
          <h2 id={titleId} className="font-display text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('ast.title')}</h2>
        </div>
        <button ref={closeRef} type="button" onClick={closePanel} aria-label={t('ast.close')}
          className="tap rounded-lg p-1 text-ink-500 hover:bg-parchment-200/70 dark:text-parchment-300/70 dark:hover:bg-ink-700">
          <X size={sheet ? 20 : 16} aria-hidden="true" />
        </button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
        {turns.length === 0 && (
          <div>
            <p className="text-sm text-ink-600 dark:text-parchment-300/80">{t('ast.intro')}</p>
            <div className="mt-3 space-y-2">
              {starters.map((s, i) => (
                <button key={i} type="button" onClick={() => ask(s)}
                  className="block w-full rounded-xl border border-parchment-300/70 bg-white/70 px-3 py-2 text-left text-sm text-ink-700 hover:bg-parchment-100 dark:border-brass-900/30 dark:bg-ink-800/70 dark:text-parchment-200 dark:hover:bg-ink-800">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((turn, i) => <Bubble key={i} turn={turn} onFeedback={sendFeedback} t={t} />)}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-ink-500 dark:text-parchment-300/70">
            <Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" /> {t('ast.thinking')}
          </div>
        )}
        {error && <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p>}
        {fallback && <GuideCard helpKey={helpKey} reason={fallback} t={t} locale={locale} />}
      </div>

      {/* Composer */}
      <div className="flex-none border-t border-parchment-300/60 p-3 dark:border-brass-900/30">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input) } }}
            rows={1}
            aria-label={t('ast.ph')}
            placeholder={t('ast.ph')}
            className="max-h-28 flex-1 resize-none rounded-xl border border-parchment-300 bg-white px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-church-500/40 dark:border-brass-900/40 dark:bg-ink-800 dark:text-parchment-100"
          />
          <button type="button" onClick={() => ask(input)} disabled={busy || !input.trim()} aria-label={t('ast.send')}
            className="rounded-xl bg-church-800 p-2.5 text-parchment-50 hover:bg-church-900 disabled:opacity-50 dark:bg-brass-700 dark:hover:bg-brass-600">
            <Send size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="safe-mb fixed bottom-5 right-5 z-40 print:hidden">
      {/* Polite live region: new replies are read out without moving focus.
          Portaled to <body> so it is not under #root, which is aria-hidden
          while the phone sheet is open. */}
      {createPortal(
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="assistant-live">{announce}</div>,
        document.body,
      )}

      {shown && (modal ? createPortal(panel, document.body) : panel)}

      {/* On the phone sheet the panel's own close button replaces the quill. */}
      {!modal && (
        <button ref={launcherRef} type="button" onClick={() => (shown ? closePanel() : openPanel())}
          aria-label={shown ? t('ast.close') : t('ast.open')}
          aria-expanded={shown} aria-controls={shown ? panelId : undefined}
          aria-keyshortcuts="Control+/ Meta+/" title={t('ast.shortcut')}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-church-800 text-parchment-50 shadow-warm-lg transition-colors hover:bg-church-900 dark:bg-brass-700 dark:hover:bg-brass-600">
          <Feather size={20} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
