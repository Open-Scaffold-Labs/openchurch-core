import { useEffect, useState, useCallback, useRef } from 'react'
import { ClipboardCheck, Plus, X, Loader2, Settings2 } from 'lucide-react'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { useLocale } from '../i18n'
import { useConfirm } from './ConfirmProvider'
import { SkeletonBlock } from './Skeleton'
import { loadList } from '../utils/format'

// In flight is not an empty day and not a parish with no routines.
function ChecklistPending() {
  return (
    <div role="status" aria-label="Loading" className="space-y-2">
      <SkeletonBlock className="h-3 w-1/3" />
      <SkeletonBlock className="h-3 w-2/3" />
    </div>
  )
}

// Daily operational checklists (OPS.1) — the dashboard widget. Renders
// nothing at all when the org has no active templates and the viewer
// can't create one; otherwise: today's runs with tickable items, and a
// quiet manage mode for staff to shape the routines.

export default function DailyChecklists() {
  const { user } = useAuth()
  const { t } = useLocale()
  const toast = useToast()
  const ask = useConfirm()
  const canWrite = user?.role === 'admin' || user?.role === 'staff'

  const [runs, setRuns] = useState(null)
  // A dropped request must not look like a day with nothing to do.
  const [runsFailed, setRunsFailed] = useState(false)
  const [templates, setTemplates] = useState([])
  // A failed routines read must not look like a parish with no checklists.
  const [templatesFailed, setTemplatesFailed] = useState(false)
  // While the routines read is in flight, Manage must not look settled-empty.
  const [templatesLoading, setTemplatesLoading] = useState(false)
  // Only the latest templates claim may paint. An older {templates:[]}
  // must not wipe a newer list into a quiet empty parish.
  const templatesLoadGen = useRef(0)
  const [managing, setManaging] = useState(false)
  const [form, setForm] = useState({ title: '', items: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    // A failed load used to become an empty run list, and this card hides
    // itself when the list is empty and you cannot write — so the checklist
    // did not merely look empty, it VANISHED. A closing checklist that is
    // not on screen is one nobody does.
    // `d.runs ?? []` treated a missing, null, or wrong-shaped `runs` as a
    // successful empty day. A body whose runs is not an array is a failed
    // load. A genuine { runs: [] } stays the real empty day.
    loadList(apiUrl('/api/checklists/today'), d => d?.runs).then(({ ok, data }) => {
      setRuns(data)
      setRunsFailed(!ok)
    })
    if (canWrite) {
      const gen = ++templatesLoadGen.current
      setTemplatesLoading(true)
      fetch(apiUrl('/api/checklists/templates'))
        .then(async r => {
          if (!r.ok) throw new Error('templates')
          return r.json()
        })
        .then(d => {
          if (gen !== templatesLoadGen.current) return
          const list = d?.templates
          if (!Array.isArray(list)) {
            setTemplates([])
            setTemplatesFailed(true)
            setTemplatesLoading(false)
            return
          }
          setTemplates(list)
          setTemplatesFailed(false)
          setTemplatesLoading(false)
        })
        .catch(() => {
          if (gen !== templatesLoadGen.current) return
          setTemplates([])
          setTemplatesFailed(true)
          setTemplatesLoading(false)
        })
    }
  }, [canWrite])
  useEffect(() => { load() }, [load])

  const toggle = async (run, index, done) => {
    // A viewer must not get an optimistic tick the server will refuse.
    if (!canWrite) return
    // Optimistic tick — the whole point of a checklist is that it
    // responds like paper.
    setRuns(rs => rs.map(r => r.id === run.id
      ? { ...r, items: r.items.map((it, i) => (i === index ? { ...it, done } : it)) }
      : r))
    try {
      const res = await fetch(apiUrl(`/api/checklists/runs/${run.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, done }),
      })
      if (!res.ok) throw new Error()
    } catch {
      toast.error(t('chk.saveError'))
      load()
    }
  }

  const addTemplate = async (e) => {
    e.preventDefault()
    const items = form.items.split('\n').map(s => s.trim()).filter(Boolean)
    if (!form.title.trim() || !items.length) return
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/checklists/templates'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: form.title.trim(), items }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || t('chk.saveError'))
      }
      setForm({ title: '', items: '' })
      toast.success(t('chk.created'))
      load()
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  const removeTemplate = async (id) => {
    if (!(await ask({ title: t('chk.deleteConfirm'), confirmLabel: t('chk.deleteAction') }))) return
    try {
      const res = await fetch(apiUrl(`/api/checklists/templates/${id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error()
      load()
    } catch { toast.error(t('chk.saveError')) }
  }

  // Still reading today. A viewer must not look the same as a real empty
  // day, which is the only case that returns null.
  if (runs === null) {
    return (
      <div className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 shadow-warm p-4">
        <div className="flex items-center gap-2 mb-3">
          <ClipboardCheck size={16} className="text-church-700 dark:text-brass-300" />
          <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">{t('chk.title')}</p>
        </div>
        <ChecklistPending />
      </div>
    )
  }
  // Only disappear when the list is genuinely empty. If it failed to load,
  // stay on screen and say so — silence is the one answer that is never true.
  if (runs.length === 0 && !canWrite && !runsFailed) return null

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500'

  return (
    <div className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 shadow-warm p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ClipboardCheck size={16} className="text-church-700 dark:text-brass-300" />
          <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">{t('chk.title')}</p>
        </div>
        {canWrite && (
          <button type="button" onClick={() => setManaging(m => !m)} aria-label={t('chk.manage')}
            className="p-1.5 rounded-lg text-ink-400 hover:text-church-700 dark:hover:text-brass-300">
            <Settings2 size={14} />
          </button>
        )}
      </div>

      {runsFailed && (
        <p className="text-[12px] text-amber-700 dark:text-amber-400 leading-snug">
          Today’s checklists didn’t load — this isn’t a day with nothing on it.
        </p>
      )}
      {runs.length === 0 && !runsFailed && (
        <p className="text-sm text-ink-500 dark:text-parchment-300/70">{t('chk.empty')}</p>
      )}

      <div className="space-y-4">
        {runs.map(run => {
          const done = run.items.filter(i => i.done).length
          return (
            <div key={run.id}>
              <p className="text-sm font-semibold text-ink-800 dark:text-parchment-100 mb-1.5">
                {run.title}
                <span className={`ml-2 text-[11px] font-normal ${done === run.items.length ? 'text-brass-700 dark:text-brass-300' : 'text-ink-400 dark:text-parchment-400/60'}`}>
                  {done}/{run.items.length}
                </span>
              </p>
              <ul className="space-y-1">
                {run.items.map((item, i) => (
                  <li key={i}>
                    <label className={`flex items-start gap-2 text-sm cursor-pointer ${item.done ? 'text-ink-400 dark:text-parchment-400/50 line-through' : 'text-ink-700 dark:text-parchment-200'}`}>
                      <input type="checkbox" checked={item.done} disabled={!canWrite}
                        onChange={e => toggle(run, i, e.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-church-700" />
                      <span>{item.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>

      {canWrite && managing && (
        <div className="mt-4 pt-4 border-t border-parchment-300/60 dark:border-brass-900/25 space-y-3">
          {templatesFailed && (
            <p role="status" className="text-[12px] text-amber-700 dark:text-amber-400 leading-snug">
              {t('chk.templatesUnread')}
            </p>
          )}
          {templatesLoading && templates.length === 0 && !templatesFailed && (
            <ChecklistPending />
          )}
          {templates.length > 0 && (
            <ul className="space-y-1">
              {templates.map(tp => (
                <li key={tp.id} className="flex items-center justify-between text-sm text-ink-700 dark:text-parchment-200">
                  <span>{tp.title} <span className="text-[11px] text-ink-400">({tp.items.length})</span></span>
                  <button type="button" onClick={() => removeTemplate(tp.id)} aria-label={`${t('chk.delete')} ${tp.title}`}
                    className="p-1 text-ink-400 hover:text-rose-700 dark:hover:text-rose-300"><X size={13} /></button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={addTemplate} className="space-y-2">
            <input type="text" value={form.title} placeholder={t('chk.newTitle')}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className={inputCls} />
            <textarea rows={3} value={form.items} placeholder={t('chk.newItems')}
              onChange={e => setForm(f => ({ ...f, items: e.target.value }))} className={inputCls} />
            <button type="submit" disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} {t('chk.add')}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
