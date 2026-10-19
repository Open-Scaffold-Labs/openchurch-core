// HelpPanel.jsx — in-app help: searchable module reference, FAQ, role table,
// and the Report a Problem flow (SUP.5 + SUP.2 client).
//
// Open from the header's ? icon. Four tabs:
//   Guide   — per-module reference from data/helpContent.js, grouped
//   FAQ     — expandable questions
//   Roles   — who can do what
//   Report  — submit a problem report (posts to /api/support-tickets)
//             + the reporter's own past reports with their status
//
// Search spans everything via buildSearchIndex(). Chrome strings are
// bilingual (t()); the guide corpus itself is English-first — the Spanish
// content pass is tracked as SUP follow-up work.
//
// Adapted from the Support extension proposal with the OPERATOR bans
// applied: church/brass/parchment palette (no emerald/red/burgundy-*),
// shadow-warm-lg; the scrim is the sanctioned MobileSheet treatment.

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X, Search, BookOpen, HelpCircle, Shield, Bug,
  ChevronDown, ChevronRight, Check, Minus, Send, Loader2,
} from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
import { scrimCls } from './MobileSheet'
import { MODULE_HELP, ROLE_TABLE, TIPS, FAQ, buildSearchIndex } from '../data/helpContent'

const GROUP_ORDER = ['General', 'Pastoral', 'Stewardship', 'Studio', 'Admin', 'You']

const STATUS_TONE = {
  new:               'bg-church-50 text-church-800 dark:bg-church-900/40 dark:text-brass-200',
  diagnosing:        'bg-brass-50 text-brass-700 dark:bg-brass-900/25 dark:text-brass-300',
  waiting_on_parish: 'bg-amber-50 text-amber-800 dark:bg-amber-900/25 dark:text-amber-300',
  in_progress:       'bg-brass-50 text-brass-700 dark:bg-brass-900/25 dark:text-brass-300',
  resolved:          'bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-300/80',
  closed:            'bg-parchment-200 text-ink-500 dark:bg-ink-800 dark:text-parchment-300/70',
}

function Pill({ active, onClick, icon: Icon, children }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors
        ${active
          ? 'bg-church-800 text-parchment-50 dark:bg-brass-700'
          : 'bg-parchment-200/70 text-ink-700 hover:bg-parchment-300/70 dark:bg-ink-800 dark:text-parchment-200 dark:hover:bg-ink-700'}`}>
      <Icon size={14} /> {children}
    </button>
  )
}

function YesNo({ yes }) {
  const { t } = useLocale()
  return yes
    ? <Check size={15} className="text-brass-700 dark:text-brass-300 mx-auto" aria-label={t('help.yes')} />
    : <Minus size={15} className="text-ink-300 dark:text-parchment-300/40 mx-auto" aria-label={t('help.no')} />
}

function SectionBlock({ section }) {
  if (section.type === 'indicators' || section.type === 'fields') {
    return (
      <div className="mt-2">
        <div className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{section.title}</div>
        <ul className="mt-1 space-y-1">
          {(section.items || []).map((it, i) => (
            <li key={i} className="text-sm text-ink-600 dark:text-parchment-300/80">
              <span className="font-medium text-ink-800 dark:text-parchment-100">{it.label}</span>
              <span> — {it.desc}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div className="mt-2">
      <div className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{section.title}</div>
      <p className="mt-1 text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">{section.content}</p>
    </div>
  )
}

function ModuleCard({ id, mod, openId, setOpenId }) {
  const { t } = useLocale()
  const open = openId === id
  return (
    <div className="rounded-xl border border-parchment-300/70 dark:border-brass-900/30 bg-white/60 dark:bg-ink-800/60">
      <button onClick={() => setOpenId(open ? null : id)}
        className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="font-medium text-ink-800 dark:text-parchment-100">{mod.name}</span>
        {open ? <ChevronDown size={16} className="text-ink-400" /> : <ChevronRight size={16} className="text-ink-400" />}
      </button>
      {open && (
        <div className="px-4 pb-4">
          <p className="text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">{mod.overview}</p>
          {mod.features?.length > 0 && (
            <ul className="mt-2 list-disc pl-5 space-y-0.5">
              {mod.features.map((f, i) => (
                <li key={i} className="text-sm text-ink-600 dark:text-parchment-300/80">{f}</li>
              ))}
            </ul>
          )}
          {(mod.sections || []).map((s, i) => <SectionBlock key={i} section={s} />)}
          {id === 'intentions' && (
            <div data-testid="help-fulfill-howto">
              <SectionBlock section={{
                type: 'text',
                title: t('help.miFulfillHowTitle'),
                content: t('help.miFulfillHowBody'),
              }} />
            </div>
          )}
          {mod.tips?.length > 0 && (
            <div className="mt-3 rounded-lg bg-parchment-100 dark:bg-ink-900/60 px-3 py-2">
              {mod.tips.map((tip, i) => (
                <p key={i} className="text-xs text-ink-500 dark:text-parchment-300/70">✦ {tip}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-parchment-300/70 dark:border-brass-900/30 bg-white/60 dark:bg-ink-800/60">
      <button onClick={() => setOpen(!open)} className="w-full flex items-start justify-between gap-3 px-4 py-3 text-left">
        <span className="text-sm font-medium text-ink-800 dark:text-parchment-100">{q}</span>
        {open ? <ChevronDown size={16} className="shrink-0 mt-0.5 text-ink-400" /> : <ChevronRight size={16} className="shrink-0 mt-0.5 text-ink-400" />}
      </button>
      {open && <p className="px-4 pb-4 text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">{a}</p>}
    </div>
  )
}

function ReportTab() {
  const { t, dateLocale } = useLocale()
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const [error, setError] = useState('')
  const [mine, setMine] = useState(null)
  const [mineFailed, setMineFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setMineFailed(false)
    fetch(apiUrl('/api/support-tickets/mine?limit=10'))
      .then(r => {
        if (!r.ok) throw new Error('unread')
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        if (!d || !Array.isArray(d.tickets)) throw new Error('shape')
        setMine(d.tickets)
      })
      .catch(() => { if (!cancelled) { setMineFailed(true); setMine(null) } })
    return () => { cancelled = true }
  }, [done])

  async function submit() {
    if (description.trim().length < 10) { setError(t('sup.tooShort')); return }
    setBusy(true); setError('')
    try {
      const res = await fetch(apiUrl('/api/support-tickets'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          page_route: window.location.pathname,
          context_bundle: {
            userAgent: navigator.userAgent,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            language: navigator.language,
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('sup.failed'))
      setDone(data)
      setDescription('')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {done ? (
        <div className="rounded-xl border border-brass-300/60 bg-brass-50 dark:bg-brass-900/20 dark:border-brass-800/50 p-4">
          <p className="text-sm text-ink-800 dark:text-parchment-100">
            {t('sup.thanks', { id: done.id })}
          </p>
          <button onClick={() => setDone(null)} className="mt-3 text-sm underline text-church-800 dark:text-brass-300">
            {t('sup.another')}
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm text-ink-600 dark:text-parchment-300/80">{t('sup.reportIntro')}</p>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={5}
            placeholder={t('sup.reportPh')}
            className="mt-3 w-full rounded-xl border border-parchment-300 dark:border-brass-900/40 bg-white dark:bg-ink-900 px-3 py-2 text-sm text-ink-800 dark:text-parchment-100 focus:outline-none focus:ring-2 focus:ring-church-500/40"
          />
          {error && <p className="mt-2 text-sm text-rose-700 dark:text-rose-300" role="alert">{error}</p>}
          <button onClick={submit} disabled={busy}
            className="mt-3 inline-flex items-center gap-2 rounded-xl bg-church-800 px-4 py-2 text-sm font-medium text-parchment-50 hover:bg-church-900 disabled:opacity-60 dark:bg-brass-700 dark:hover:bg-brass-600">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            {busy ? t('sup.submitting') : t('sup.submit')}
          </button>
        </>
      )}

      {mineFailed && (
        <p role="status" className="mt-6 text-sm text-amber-800 dark:text-amber-300">
          {t('sup.reportsUnread')}
        </p>
      )}

      {/* The reporter's own reports — closes the "what happened to it?" loop. */}
      {mine?.length > 0 && (
        <div className="mt-6">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">
            {t('sup.myReports')}
          </div>
          <ul className="mt-2 space-y-2">
            {mine.map(r => (
              <li key={r.id} className="rounded-xl border border-parchment-300/70 dark:border-brass-900/30 bg-white/60 dark:bg-ink-800/60 px-3.5 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${STATUS_TONE[r.status] || STATUS_TONE.new}`}>
                    {t(`sup.status.${r.status}`)}
                  </span>
                  <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">
                    {new Date(r.created_at).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-600 dark:text-parchment-300/80 line-clamp-2">{r.description}</p>
                {r.resolution_notes && (
                  <p className="mt-1 text-xs italic text-ink-500 dark:text-parchment-300/70">{r.resolution_notes}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function HelpPanel({ open, onClose }) {
  const { t } = useLocale()
  const [tab, setTab] = useState('guide')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState(null)
  const index = useMemo(() => {
    const rows = buildSearchIndex()
    rows.push({
      kind: 'section',
      id: 'intentions',
      title: t('help.miFulfillHowTitle'),
      text: t('help.miFulfillHowBody'),
    })
    return rows
  }, [t])

  // Portaled to <body> (the FeedbackModal pattern), with the app shell
  // made inert while open: the page behind the scrim is genuinely
  // deactivated — for keyboards and screen readers, not just visually.
  useEffect(() => {
    if (!open) return
    const root = document.getElementById('root')
    if (root) { root.inert = true; root.setAttribute('aria-hidden', 'true') }
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => {
      if (root) { root.inert = false; root.removeAttribute('aria-hidden') }
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return null
    return index
      .map(r => ({ r, score: (r.title.toLowerCase().includes(q) ? 2 : 0) + (r.text.toLowerCase().includes(q) ? 1 : 0) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(x => x.r)
  }, [query, index])

  if (!open) return null

  const groups = GROUP_ORDER.map(g => ({
    group: g,
    items: Object.entries(MODULE_HELP).filter(([, m]) => m.group === g),
  })).filter(g => g.items.length)

  return createPortal(
    // The sanctioned scrim (MobileSheet's exported treatment): the page
    // recedes behind the panel instead of competing with it.
    <div className={`${scrimCls} z-40 flex justify-end print:hidden`} onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t('help.title')}
        onClick={e => e.stopPropagation()}
        className="h-full w-full max-w-lg overflow-y-auto bg-parchment-50 dark:bg-ink-900 border-l border-parchment-300/70 dark:border-brass-900/30 shadow-warm-lg">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-parchment-50 dark:bg-ink-900 px-5 pt-4 pb-3 border-b border-parchment-300/60 dark:border-brass-900/30">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold text-church-800 dark:text-brass-400">{t('help.title')}</h2>
            <button onClick={onClose} aria-label={t('help.close')} className="p-1.5 rounded-lg text-ink-500 hover:bg-parchment-200/70 dark:text-parchment-300/70 dark:hover:bg-ink-800">
              <X size={18} />
            </button>
          </div>
          <div className="mt-3 relative">
            <Search size={15} className="absolute left-3 top-2.5 text-ink-400" />
            <input
              value={query} onChange={e => setQuery(e.target.value)}
              placeholder={t('help.searchPh')}
              className="w-full rounded-xl border border-parchment-300 dark:border-brass-900/40 bg-white dark:bg-ink-800 pl-9 pr-3 py-2 text-sm text-ink-800 dark:text-parchment-100 focus:outline-none focus:ring-2 focus:ring-church-500/40"
            />
          </div>
          {!results && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Pill active={tab === 'guide'} onClick={() => setTab('guide')} icon={BookOpen}>{t('help.tabGuide')}</Pill>
              <Pill active={tab === 'faq'} onClick={() => setTab('faq')} icon={HelpCircle}>{t('help.tabFaq')}</Pill>
              <Pill active={tab === 'roles'} onClick={() => setTab('roles')} icon={Shield}>{t('help.tabRoles')}</Pill>
              <Pill active={tab === 'report'} onClick={() => setTab('report')} icon={Bug}>{t('help.tabReport')}</Pill>
            </div>
          )}
        </div>

        <div className="px-5 py-4">
          {/* Search results override tabs */}
          {results && (
            <div className="space-y-2">
              {results.length === 0 && (
                <p className="text-sm text-ink-500 dark:text-parchment-300/70">{t('help.nothingFound')}</p>
              )}
              {results.map((r, i) => (
                <button key={i}
                  onClick={() => { setQuery(''); if (r.kind === 'faq') setTab('faq'); else { setTab('guide'); setOpenId(r.id) } }}
                  className="w-full text-left rounded-xl border border-parchment-300/70 dark:border-brass-900/30 bg-white/60 dark:bg-ink-800/60 px-4 py-3 hover:bg-parchment-100 dark:hover:bg-ink-800">
                  <div className="text-sm font-medium text-ink-800 dark:text-parchment-100">{r.title}</div>
                  <div className="mt-0.5 text-xs text-ink-500 dark:text-parchment-300/70 line-clamp-2">{r.text}</div>
                </button>
              ))}
            </div>
          )}

          {!results && tab === 'guide' && (
            <div className="space-y-5">
              {groups.map(({ group, items }) => (
                <div key={group}>
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">
                    {t(`navsec.${group}`) === `navsec.${group}` ? group : t(`navsec.${group}`)}
                  </div>
                  <div className="mt-2 space-y-2">
                    {items.map(([id, mod]) => (
                      <ModuleCard key={id} id={id} mod={mod} openId={openId} setOpenId={setOpenId} />
                    ))}
                  </div>
                </div>
              ))}
              <div className="rounded-xl bg-parchment-100 dark:bg-ink-800/60 px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-ink-500 dark:text-parchment-300/70">
                  {t('help.goodToKnow')}
                </div>
                <ul className="mt-1.5 space-y-1">
                  {TIPS.map((tip, i) => <li key={i} className="text-xs text-ink-600 dark:text-parchment-300/80">✦ {tip}</li>)}
                </ul>
              </div>
            </div>
          )}

          {!results && tab === 'faq' && (
            <div className="space-y-2">
              <FaqItem q={t('help.miFulfillHowTitle')} a={t('help.miFulfillHowBody')} />
              {FAQ.map((f, i) => <FaqItem key={i} q={f.q} a={f.a} />)}
            </div>
          )}

          {!results && tab === 'roles' && (
            <div className="overflow-x-auto rounded-xl border border-parchment-300/70 dark:border-brass-900/30">
              <table className="w-full text-sm">
                <thead className="bg-parchment-100 dark:bg-ink-800">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-ink-700 dark:text-parchment-200">{t('help.capability')}</th>
                    <th className="px-2 py-2 font-medium text-ink-700 dark:text-parchment-200">{t('help.roleAdmin')}</th>
                    <th className="px-2 py-2 font-medium text-ink-700 dark:text-parchment-200">{t('help.roleStaff')}</th>
                    <th className="px-2 py-2 font-medium text-ink-700 dark:text-parchment-200">{t('help.roleViewer')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ROLE_TABLE.map((r, i) => (
                    <tr key={i} className={i % 2 ? 'bg-white/50 dark:bg-ink-800/40' : ''}>
                      <td className="px-3 py-2 text-ink-600 dark:text-parchment-300/80">{r.area}</td>
                      <td className="px-2 py-2"><YesNo yes={r.admin} /></td>
                      <td className="px-2 py-2"><YesNo yes={r.staff} /></td>
                      <td className="px-2 py-2"><YesNo yes={r.viewer} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!results && tab === 'report' && <ReportTab />}
        </div>
      </aside>
    </div>
  ,
    document.body
  )
}
