import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Feather, Send, Copy, Check, Loader2, Trash2, History,
  BookOpen, MessageCircle, Sun, Megaphone,
} from 'lucide-react'
import PageWrapper, { itemVariants } from '../components/PageWrapper'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { useToast } from '../components/ToastProvider'
import AiQuotaMeter from '../components/AiQuotaMeter'
import LiturgicalSuggestion from '../components/LiturgicalSuggestion'
import { useConfirm } from '../components/ConfirmProvider'

// Type definitions — the label shown to the user, the icon, and the
// hint text for the prompt textarea. The `key` must match the server's
// SYSTEM_PROMPTS keys in routes/ai.js.
const TYPES = [
  { key: 'sermon',       icon: BookOpen,      accent: 'from-church-600 to-church-800' },
  { key: 'message',      icon: MessageCircle, accent: 'from-ink-600 to-ink-800' },
  { key: 'devotional',   icon: Sun,           accent: 'from-amber-700 to-amber-900' },
  { key: 'announcement', icon: Megaphone,     accent: 'from-brass-600 to-brass-800' },
]
// Labels and textarea hints live in the dictionary: aist.type.<key> /
// aist.hint.<key> — the studio speaks the parish's language.

const typeMeta = (key) => TYPES.find(t => t.key === key) ?? TYPES[0]

function timeAgo(dateStr, t) {
  const s = Math.floor((Date.now() - new Date(dateStr)) / 1000)
  if (s < 60) return t('aist.justNow')
  if (s < 3600) return t('aist.ago', { n: `${Math.floor(s / 60)}m` })
  if (s < 86400) return t('aist.ago', { n: `${Math.floor(s / 3600)}h` })
  return t('aist.ago', { n: `${Math.floor(s / 86400)}d` })
}

// Copy-to-clipboard button that briefly swaps the icon to a check.
function CopyButton({ text, className = '' }) {
  const { t } = useLocale()
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <button
      onClick={copy}
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors ${className}`}
    >
      {copied ? <Check size={12} className="text-brass-500" /> : <Copy size={12} />}
      {copied ? t('aist.copied') : t('aist.copy')}
    </button>
  )
}

export default function AI() {
  const [type, setType]       = useState('sermon')
  const [prompt, setPrompt]   = useState('')
  // Sermon assistant — the preaching date. When set, the server injects
  // that day's liturgical season/feast/color into the model context, so
  // an Advent 2 sermon actually sounds like Advent 2. The chip below
  // the input previews what the server will resolve.
  const [preachDate, setPreachDate] = useState('')
  const [preachLit, setPreachLit]   = useState(null)
  const [output, setOutput]   = useState('')
  const [meta, setMeta]       = useState(null)       // { provider, model, created_at }
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [history, setHistory] = useState([])
  // Bumped after each successful generate so the AiQuotaMeter
  // re-fetches and ticks up.
  const [quotaKey, setQuotaKey] = useState(0)
  const { canWrite } = useAuth()
  const toast = useToast()
  const ask = useConfirm()
  const { t } = useLocale()

  const current = typeMeta(type)

  async function loadHistory() {
    try {
      const res = await fetch(apiUrl('/api/ai/generations?limit=20'))
      const data = res.ok ? await res.json() : { rows: [] }
      setHistory(Array.isArray(data?.rows) ? data.rows : [])
    } catch {
      setHistory([])
    }
  }

  useEffect(() => { loadHistory() }, [])

  // Resolve the liturgical day for the chosen preach date (sermon only).
  // Server response is private-cached 1h, so this is cheap.
  useEffect(() => {
    if (type !== 'sermon' || !/^\d{4}-\d{2}-\d{2}$/.test(preachDate)) {
      setPreachLit(null)
      return
    }
    let cancelled = false
    fetch(apiUrl(`/api/liturgical?date=${preachDate}`))
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setPreachLit(d) })
      .catch(() => { if (!cancelled) setPreachLit(null) })
    return () => { cancelled = true }
  }, [type, preachDate])

  async function generate() {
    if (!prompt.trim() || loading) return
    setLoading(true)
    setError('')
    setOutput('')
    setMeta(null)
    try {
      const res = await fetch(apiUrl('/api/ai/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          prompt,
          ...(type === 'sermon' && /^\d{4}-\d{2}-\d{2}$/.test(preachDate) ? { preach_date: preachDate } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 429 && data.code === 'quota_exceeded') {
        // Surface the structured quota message via toast so the
        // banner inside the composer doesn't double up. Refresh the
        // meter so the rose-colored "limit reached" state lands.
        toast.error(data.error || t('aist.limit'))
        setError(data.error || t('aist.limit'))
        setQuotaKey(k => k + 1)
      } else if (!res.ok) {
        setError(data.error || t('aist.failed'))
      } else {
        setOutput(data.output || '')
        setMeta({ provider: data.provider, model: data.model, created_at: data.created_at })
        loadHistory()
        setQuotaKey(k => k + 1)
      }
    } catch (err) {
      setError(err.message || t('aist.network'))
    } finally {
      setLoading(false)
    }
  }

  async function removeEntry(id) {
    if (!(await ask({ title: t('aist.deleteConfirm'), confirmLabel: 'Delete' }))) return
    let res
    try {
      res = await fetch(apiUrl(`/api/ai/generations/${id}`), { method: 'DELETE' })
    } catch (err) {
      toast.error(t('err.save'))
      return
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || t('aist.deleteFailed'))
      return
    }
    setHistory(h => h.filter(e => e.id !== id))
  }

  function loadFromHistory(entry) {
    setType(entry.type)
    setPrompt(entry.prompt)
    setOutput(entry.output)
    setMeta({ provider: entry.provider, model: entry.model, created_at: entry.created_at })
    setError('')
  }

  function onPromptKeyDown(e) {
    // Cmd/Ctrl + Enter submits.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      generate()
    }
  }

  return (
    <PageWrapper>
      <motion.div variants={itemVariants} className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">{t('aist.title')}</h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            {t('aist.sub')}
          </p>
        </div>
        {/* Quota meter — admins/staff only, since viewers can't generate.
            Self-hides while loading or on fetch error so the layout
            doesn't shift around. */}
        {canWrite && <AiQuotaMeter refreshKey={quotaKey} />}
      </motion.div>

      {/* Read-only notice for viewers — they can browse history but
          cannot generate. Server enforces; this just explains what's
          missing from the page. */}
      {!canWrite && (
        <motion.div variants={itemVariants} className="mb-6 px-4 py-3 rounded-xl bg-brass-50 dark:bg-brass-900/20 border border-brass-200/70 dark:border-brass-800/40 text-sm text-ink-700 dark:text-parchment-200">
          {t('aist.readOnly')}
        </motion.div>
      )}

      {/* Type picker — hidden for viewers since they can't generate */}
      {canWrite && (
      <motion.div variants={itemVariants} className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {TYPES.map(ty => {
          const Icon = ty.icon
          const active = ty.key === type
          return (
            <button
              key={ty.key}
              onClick={() => setType(ty.key)}
              className={`relative overflow-hidden flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-left ${
                active
                  ? 'border-church-500 dark:border-white/30 bg-parchment-50 dark:bg-ink-900 shadow-md'
                  : 'border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50/70 dark:bg-ink-900/60 hover:bg-parchment-50 dark:hover:bg-ink-900 hover:border-parchment-300 dark:hover:border-brass-900/60'
              }`}
            >
              <div className={`w-9 h-9 shrink-0 rounded-lg bg-gradient-to-br ${ty.accent} flex items-center justify-center text-parchment-50 shadow-sm`}>
                <Icon size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">{t(`aist.type.${ty.key}`)}</p>
                <p className="text-[10px] text-ink-500 dark:text-parchment-300/70">
                  {active ? t('aist.selected') : t('aist.pick')}
                </p>
              </div>
              {active && (
                <motion.div
                  layoutId="type-underline"
                  className={`absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r ${ty.accent}`}
                />
              )}
            </button>
          )
        })}
      </motion.div>
      )}

      <div className={`grid gap-6 ${canWrite ? 'lg:grid-cols-3' : 'lg:grid-cols-1'}`}>
        {/* Composer + output — admin/staff only */}
        {canWrite && (
        <motion.div variants={itemVariants} className="lg:col-span-2 space-y-4">
          <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-card overflow-hidden">
            <div className="px-5 py-3 border-b border-parchment-300/60 dark:border-brass-900/30 flex items-center gap-2">
              <Feather size={14} className="text-church-700 dark:text-brass-300" />
              <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
                {t(`aist.type.${current.key}`)}
              </h2>
              <span className="ml-auto text-[10px] text-ink-500 dark:text-parchment-300/70">
                {t('aist.kbd')}
              </span>
            </div>
            <div className="p-5 space-y-3">
              {/* Liturgical context chip — only renders for sermon /
                  devotional types where the season actually shapes
                  the content. Clicking seeds the empty prompt with
                  a sentence-starter tailored to the upcoming
                  Sunday. /api/liturgical is server-cached 1h so the
                  fetch is effectively free after first hit. */}
              <LiturgicalSuggestion
                type={type}
                prompt={prompt}
                onUse={(seed) => setPrompt(seed)}
              />
              {/* Preaching date — sermon only. Optional; when set, the
                  server grounds the outline in that day's liturgical
                  context and we preview the resolved day here. */}
              {type === 'sermon' && (
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="preach-date" className="text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70">
                    {t('aist.preachDate')}
                  </label>
                  <input
                    id="preach-date"
                    type="date"
                    value={preachDate}
                    onChange={e => setPreachDate(e.target.value)}
                    className="px-2 py-1 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
                  />
                  {preachDate && (
                    <button
                      type="button"
                      onClick={() => setPreachDate('')}
                      className="text-[11px] text-ink-400 hover:text-church-700 dark:hover:text-brass-300"
                    >
                      {t('aist.clear')}
                    </button>
                  )}
                  {preachLit && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-brass-50 dark:bg-brass-900/20 border border-brass-200/70 dark:border-brass-800/40 text-ink-700 dark:text-parchment-200">
                      <BookOpen size={11} className="text-brass-700 dark:text-brass-300" />
                      {preachLit.feast_name ? `${preachLit.feast_name} · ` : ''}{preachLit.season}
                      {preachLit.color ? ` · ${preachLit.color}` : ''}
                    </span>
                  )}
                </div>
              )}
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={onPromptKeyDown}
                rows={4}
                placeholder={t(`aist.hint.${current.key}`)}
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-church-500 resize-none"
              />
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">
                  {t('aist.chars', { n: prompt.length })}
                </span>
                <button
                  onClick={generate}
                  disabled={!prompt.trim() || loading}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-church-900 dark:bg-white text-parchment-50 dark:text-church-900 text-sm font-semibold shadow hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {loading ? t('aist.generating') : t('aist.generate')}
                </button>
              </div>
              {error && (
                <div className="text-xs text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}
            </div>
          </div>

          {/* Output */}
          <AnimatePresence>
            {(output || loading) && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-card overflow-hidden"
              >
                <div className="px-5 py-3 border-b border-parchment-300/60 dark:border-brass-900/30 flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('aist.output')}</h3>
                  {meta?.provider && (
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-parchment-200 dark:bg-ink-800 text-ink-500 dark:text-parchment-300/70">
                      {meta.provider}{meta.model ? ` · ${meta.model}` : ''}
                    </span>
                  )}
                  {output && <CopyButton text={output} className="ml-auto" />}
                </div>
                <div className="p-5">
                  {loading && !output ? (
                    <div className="flex items-center gap-2 text-sm text-ink-500 dark:text-parchment-300/70">
                      <Loader2 size={14} className="animate-spin" /> {t('aist.thinking')}
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-800 dark:text-parchment-100">
                      {output}
                    </pre>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
        )}

        {/* History */}
        <motion.div variants={itemVariants} className={canWrite ? 'lg:col-span-1' : ''}>
          <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-card overflow-hidden">
            <div className="px-5 py-3 border-b border-parchment-300/60 dark:border-brass-900/30 flex items-center gap-2">
              <History size={14} className="text-church-700 dark:text-brass-300" />
              <h3 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('aist.history')}</h3>
              <span className="ml-auto text-[10px] text-ink-500 dark:text-parchment-300/70">
                {history.length}
              </span>
            </div>
            {history.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <div className="inline-flex w-10 h-10 rounded-xl bg-church-50 dark:bg-church-900/40 items-center justify-center text-church-800 dark:text-brass-300 mb-3">
                  <Feather size={16} />
                </div>
                <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
                  {t('aist.emptyTitle')}
                </p>
                <p className="mt-1.5 text-xs text-ink-500 dark:text-parchment-300/70 leading-relaxed max-w-[18rem] mx-auto">
                  {t('aist.emptyBody')}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-parchment-200/60 dark:divide-brass-900/30 max-h-[32rem] overflow-y-auto">
                {history.map(e => {
                  const meta = typeMeta(e.type)
                  const Icon = meta.icon
                  return (
                    <li key={e.id} className="group">
                      <div className="flex items-start gap-2 px-4 py-3 hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors">
                        <button
                          onClick={() => loadFromHistory(e)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <div className="flex items-center gap-2">
                            <div className={`w-5 h-5 shrink-0 rounded-md bg-gradient-to-br ${meta.accent} flex items-center justify-center text-parchment-50`}>
                              <Icon size={10} />
                            </div>
                            <span className="text-xs font-semibold text-ink-800 dark:text-parchment-100 truncate">
                              {t(`aist.type.${e.type}`)}
                            </span>
                            <span className="text-[10px] text-ink-500 dark:text-parchment-300/70 shrink-0">
                              {timeAgo(e.created_at, t)}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] text-ink-500 dark:text-parchment-300/70 line-clamp-2">
                            {e.prompt}
                          </p>
                        </button>
                        {canWrite && (
                          <button
                            onClick={() => removeEntry(e.id)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-parchment-300 hover:text-rose-500"
                            title={t('aist.delete')}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </motion.div>
      </div>
    </PageWrapper>
  )
}
