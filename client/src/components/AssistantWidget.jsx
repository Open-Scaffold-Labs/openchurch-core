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
// nothing scales; warm shadows; church/brass/parchment only.

import { useEffect, useRef, useState } from 'react'
import { Feather, X, Send, Loader2, ThumbsUp, ThumbsDown } from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { mutate } from '../utils/format'

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

export default function AssistantWidget() {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [available, setAvailable] = useState(false)
  const scrollRef = useRef(null)

  // Render the quill only when the assistant can actually answer — a
  // support button that always apologizes is worse than no button.
  useEffect(() => {
    let cancelled = false
    fetch(apiUrl('/api/assistant/status'))
      .then(r => r.ok ? r.json() : { available: false })
      .then(d => { if (!cancelled) setAvailable(Boolean(d.available)) })
      .catch(() => { if (!cancelled) setAvailable(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, open])

  async function ask(question) {
    const q = question.trim()
    if (!q || busy) return
    setError('')
    setInput('')
    const history = turns.map(turn => ({ role: turn.role, content: turn.content }))
    setTurns(prev => [...prev, { role: 'user', content: q }])
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/assistant'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, page_route: window.location.pathname, history }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('ast.unavailable'))
      setTurns(prev => [...prev, { role: 'assistant', content: data.answer, id: data.id }])
    } catch (e) {
      setError(e.message)
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

  const starters = starterKeysFor(window.location.pathname).map(k => t(k))

  if (!available) return null

  return (
    <div className="fixed bottom-5 right-5 z-40 print:hidden">
      {open && (
        <div className="mb-3 flex h-[520px] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-parchment-300/70 bg-parchment-50 shadow-warm-lg dark:border-brass-900/30 dark:bg-ink-900">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-parchment-300/60 bg-parchment-100/80 px-4 py-3 dark:border-brass-900/30 dark:bg-ink-800/80">
            <div className="flex items-center gap-2">
              <Feather size={16} className="text-church-700 dark:text-brass-400" />
              <span className="font-display text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('ast.title')}</span>
            </div>
            <button onClick={() => setOpen(false)} aria-label={t('ast.close')}
              className="p-1 rounded-lg text-ink-500 hover:bg-parchment-200/70 dark:text-parchment-300/70 dark:hover:bg-ink-700">
              <X size={16} />
            </button>
          </div>

          {/* Transcript */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {turns.length === 0 && (
              <div>
                <p className="text-sm text-ink-600 dark:text-parchment-300/80">{t('ast.intro')}</p>
                <div className="mt-3 space-y-2">
                  {starters.map((s, i) => (
                    <button key={i} onClick={() => ask(s)}
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
                <Loader2 size={14} className="animate-spin" /> {t('ast.thinking')}
              </div>
            )}
            {error && <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p>}
          </div>

          {/* Composer */}
          <div className="border-t border-parchment-300/60 p-3 dark:border-brass-900/30">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input) } }}
                rows={1}
                placeholder={t('ast.ph')}
                className="max-h-28 flex-1 resize-none rounded-xl border border-parchment-300 bg-white px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-church-500/40 dark:border-brass-900/40 dark:bg-ink-800 dark:text-parchment-100"
              />
              <button onClick={() => ask(input)} disabled={busy || !input.trim()} aria-label={t('ast.send')}
                className="rounded-xl bg-church-800 p-2.5 text-parchment-50 hover:bg-church-900 disabled:opacity-50 dark:bg-brass-700 dark:hover:bg-brass-600">
                <Send size={15} />
              </button>
            </div>
          </div>
        </div>
      )}

      <button onClick={() => setOpen(!open)} aria-label={open ? t('ast.close') : t('ast.open')}
        className="flex h-12 w-12 items-center justify-center rounded-full bg-church-800 text-parchment-50 shadow-warm-lg transition-colors hover:bg-church-900 dark:bg-brass-700 dark:hover:bg-brass-600">
        <Feather size={20} />
      </button>
    </div>
  )
}
