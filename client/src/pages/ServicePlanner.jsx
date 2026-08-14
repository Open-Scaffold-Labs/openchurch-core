import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ListMusic, Loader2, Plus, Trash2, X, ChevronUp, ChevronDown, Pencil, Calendar as CalendarIcon, Printer, Play,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { LIT_COLOR_TEXT, LIT_COLOR_DOT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { seasonLabel } from '../i18n/liturgical'
import { useConfirm } from '../components/ConfirmProvider'

// Service Planner (SVC.2) — build a service's order of worship: a list of
// elements (hymns, readings, prayers, the homily…), each with a kind, a
// reference, an assigned person, and notes. Reorder with the up/down
// handles. Backed by /api/service-plans (SVC.1). Worship staff + admins
// edit; viewers read.

function pad(n) { return String(n).padStart(2, '0') }
function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function upcomingSundayISO() {
  const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return toISO(d)
}
function fmtLong(iso, dateLocale) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}
function fmtShort(iso, dateLocale) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })
}

// Element kinds — labels resolve through the kind.* dictionary keys so
// the planner (and the printed order) speak the parish's language.
const KIND_KEYS = ['hymn', 'psalm', 'reading', 'prayer', 'rite', 'sermon', 'music', 'announcement', 'other']
const kindLabel = (t, k) => t(`kind.${k}`)
// Nine kinds, five palette families — so some kinds must share a voice.
// The sung items (hymn, psalm, music) share brass with `rite`: between
// them they are the parts of the service that are performed rather than
// read, spoken, or announced. That grouping tells a worship leader
// scanning an order of service more than nine arbitrary hues did, and
// the kind label is written in the badge either way.
const KIND_BADGE = {
  hymn: 'bg-brass-100 text-brass-700 dark:bg-brass-900/30 dark:text-brass-200',
  psalm: 'bg-brass-100 text-brass-700 dark:bg-brass-900/30 dark:text-brass-200',
  reading: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200',
  prayer: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-200',
  rite: 'bg-brass-100 text-brass-700 dark:bg-brass-900/30 dark:text-brass-200',
  sermon: 'bg-church-100 text-church-800 dark:bg-church-900/40 dark:text-brass-200',
  music: 'bg-brass-100 text-brass-700 dark:bg-brass-900/30 dark:text-brass-200',
  announcement: 'bg-parchment-100 text-ink-600 dark:bg-ink-800 dark:text-parchment-300',
  other: 'bg-parchment-100 text-ink-600 dark:bg-ink-800 dark:text-parchment-300',
}

const inputCls = 'w-full px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400'

const LIT_HEX = { Purple: '#6b21a8', White: '#b08d57', Green: '#15803d', Red: '#b91c1c', Gold: '#b8860b' }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

// Open a print window with the order of worship — a numbered run-sheet.
// Same print-window pattern as the bulletin / name tags (no PDF library).
function printOrderOfWorship({ orgName, plan, lit, t, dateLocale }) {
  const w = window.open('', '_blank', 'width=800,height=1000')
  if (!w) return
  const accent = LIT_HEX[lit?.color] ?? '#7B2D26'
  const litLine = lit?.feast_name || (lit?.season ? seasonLabel(t, lit.season) : '')
  const longDate = (() => {
    const [y, m, d] = plan.date.slice(0, 10).split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  })()
  const rows = (plan.elements || []).map((e, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td class="body">
        <span class="kind">${escapeHtml(kindLabel(t, e.kind))}</span>
        <span class="title">${escapeHtml(e.title)}</span>
        ${e.reference ? `<span class="ref">${escapeHtml(e.reference)}</span>` : ''}
        ${e.notes ? `<div class="notes">${escapeHtml(e.notes)}</div>` : ''}
      </td>
      <td class="who">${e.assigned_name ? escapeHtml(e.assigned_name) : ''}</td>
    </tr>`).join('')

  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(t('plan.order'))} — ${escapeHtml(longDate)}</title><style>
    @page { margin: 18mm }
    body { font-family: Georgia, 'Times New Roman', serif; color: #2b2622; margin: 0; line-height: 1.45 }
    .band { height: 8px; background: ${accent} }
    header { text-align: center; padding: 20px 0 12px; border-bottom: 1px solid #e6ddcf }
    header .org { font-size: 22px; font-weight: 700; color: #2b2622 }
    header .ttl { font-size: 15px; margin-top: 4px; color: #4a4036 }
    header .sub { font-size: 12px; text-transform: uppercase; letter-spacing: 3px; color: #8a7d6a; margin-top: 6px }
    header .lit { font-size: 12px; font-weight: 700; color: ${accent}; margin-top: 4px }
    table { width: 100%; border-collapse: collapse; margin-top: 14px }
    td { padding: 7px 6px; vertical-align: top; border-bottom: 1px solid #efe7d8; font-size: 14px }
    td.num { width: 26px; color: #b3a692; font-weight: 700 }
    td.who { width: 26%; text-align: right; color: #6a5f50; white-space: nowrap }
    .kind { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8a7d6a; margin-right: 8px }
    .title { font-weight: 600 }
    .ref { color: #6a5f50; margin-left: 8px }
    .notes { font-size: 12px; color: #7a6f5e; margin-top: 2px; font-style: italic }
    footer { margin-top: 22px; text-align: center; font-size: 11px; color: #a89c88 }
  </style></head><body>
    <div class="band"></div>
    <header>
      <div class="org">${escapeHtml(orgName || '')}</div>
      <div class="ttl">${escapeHtml(plan.title || t('plan.service'))}</div>
      <div class="sub">${escapeHtml(t('plan.order'))} · ${escapeHtml(longDate)}</div>
      ${litLine ? `<div class="lit">${escapeHtml(litLine)}</div>` : ''}
    </header>
    ${rows ? `<table>${rows}</table>` : `<p style="text-align:center;color:#8a7d6a;margin-top:24px">${escapeHtml(t('plan.noElements'))}</p>`}
    <footer>${escapeHtml(orgName || '')}</footer>
    <script>window.onload = function () { window.print() }<\/script>
  </body></html>`)
  w.document.close()
}

// Add / edit element modal.
function ElementModal({ element, members, onClose, onSave }) {
  const { t } = useLocale()
  const isEdit = !!element?.id
  const [form, setForm] = useState(() => ({
    kind: element?.kind ?? 'hymn',
    title: element?.title ?? '',
    reference: element?.reference ?? '',
    assigned_client_id: element?.assigned_client_id ?? '',
    notes: element?.notes ?? '',
  }))
  const [saving, setSaving] = useState(false)
  const field = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit() {
    if (!form.title.trim()) return
    setSaving(true)
    await onSave({
      kind: form.kind,
      title: form.title.trim(),
      reference: form.reference.trim() || null,
      assigned_client_id: form.assigned_client_id ? Number(form.assigned_client_id) : null,
      notes: form.notes.trim() || null,
    })
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center p-0 md:p-6">
      <motion.div
        initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 30 }} transition={{ duration: 0.18 }}
        className="w-full md:max-w-md bg-parchment-50 dark:bg-ink-900 rounded-t-2xl md:rounded-2xl shadow-warm border border-parchment-300/60 dark:border-brass-900/30 p-5 space-y-3"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900 dark:text-parchment-50">{isEdit ? t('plan.editElement') : t('plan.addElement')}</h2>
          <button onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50" aria-label={t('plan.close')}><X size={18} /></button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('plan.kind')}</label>
            <select value={form.kind} onChange={field('kind')} className={inputCls}>
              {KIND_KEYS.map(v => <option key={v} value={v}>{kindLabel(t, v)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('plan.reference')}</label>
            <input type="text" value={form.reference} onChange={field('reference')} placeholder="#312 · Is 11:1-10" aria-label={t('plan.reference')} className={inputCls} />
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('plan.titleField')}</label>
          <input type="text" value={form.title} onChange={field('title')} placeholder={t('plan.titlePh')} aria-label={t('plan.titleField')} autoFocus className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('plan.assignedTo')}</label>
          <select value={form.assigned_client_id} onChange={field('assigned_client_id')} className={inputCls}>
            <option value="">{t('plan.noOne')}</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('plan.notes')}</label>
          <textarea value={form.notes} onChange={field('notes')} rows={2} placeholder={t('plan.notesPh')} aria-label={t('plan.notes')} className={inputCls} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-2 text-sm text-ink-500 hover:text-ink-700 dark:hover:text-parchment-50">{t('plan.cancel')}</button>
          <button onClick={submit} disabled={saving || !form.title.trim()} className="px-4 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 disabled:opacity-40 transition-opacity">
            {saving ? t('plan.saving') : (isEdit ? t('plan.save') : t('plan.add'))}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

export default function ServicePlanner() {
  const toast = useToast()
  const ask = useConfirm()
  const { canWrite } = useAuth()
  const { t, dateLocale } = useLocale()

  const [plans, setPlans]     = useState([])
  const [members, setMembers] = useState([])
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  const [selectedId, setSelectedId] = useState(null)
  const [plan, setPlan]   = useState(null)   // full selected plan + elements
  const [lit, setLit]     = useState(null)
  const [modal, setModal] = useState(null)   // { element } | { element: null } for new
  const [newDate, setNewDate] = useState(() => upcomingSundayISO())

  useEffect(() => {
    Promise.all([
      fetch(apiUrl('/api/service-plans')).then(r => (r.ok ? r.json() : { plans: [] })),
      fetch(apiUrl('/api/clients')).then(r => (r.ok ? r.json() : [])),
      fetch(apiUrl('/api/organization')).then(r => (r.ok ? r.json() : {})),
    ]).then(([p, mem, org]) => {
      setPlans(p.plans ?? [])
      setMembers(Array.isArray(mem) ? mem : (mem.clients ?? []))
      setOrgName(org?.name ?? '')
      if (p.plans?.length) setSelectedId(p.plans[0].id)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  // Load the selected plan in full + its liturgical day.
  useEffect(() => {
    if (!selectedId) { setPlan(null); return }
    let cancelled = false
    fetch(apiUrl(`/api/service-plans/${selectedId}`))
      .then(r => (r.ok ? r.json() : null))
      .then(p => {
        if (cancelled || !p) return
        setPlan(p)
        fetch(apiUrl(`/api/liturgical?date=${p.date}`)).then(r => (r.ok ? r.json() : null)).then(d => { if (!cancelled) setLit(d) }).catch(() => {})
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedId])

  async function createPlan() {
    try {
      const res = await fetch(apiUrl('/api/service-plans'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: newDate, title: t('plan.defaultTitle') }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "That didn't save — nothing was lost. Please try again.")
      setPlans(list => [{ ...d, element_count: 0 }, ...list])
      setSelectedId(d.id)
      toast.success(t('plan.created'))
    } catch (err) { toast.error(err.message) }
  }

  async function patchPlan(fields) {
    if (!plan) return
    try {
      const res = await fetch(apiUrl(`/api/service-plans/${plan.id}`), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "That didn't save — nothing was lost. Please try again.")
      setPlan(p => ({ ...p, ...d }))
      setPlans(list => list.map(x => (x.id === d.id ? { ...x, ...d } : x)))
    } catch (err) { toast.error(err.message) }
  }

  async function deletePlan() {
    if (!plan) return
    if (!(await ask({ title: t('plan.deleteConfirm'), confirmLabel: 'Delete plan' }))) return
    try {
      const res = await fetch(apiUrl(`/api/service-plans/${plan.id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error("That didn't delete — nothing was changed. Please try again.")
      setPlans(list => list.filter(p => p.id !== plan.id))
      const next = plans.find(p => p.id !== plan.id)
      setSelectedId(next ? next.id : null)
      setPlan(null)
    } catch (err) { toast.error(err.message) }
  }

  async function saveElement(values) {
    const editing = modal?.element?.id
    try {
      const url = editing
        ? apiUrl(`/api/service-plans/${plan.id}/elements/${editing}`)
        : apiUrl(`/api/service-plans/${plan.id}/elements`)
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "That didn't save — nothing was lost. Please try again.")
      // assigned_client_id comes back as a BIGINT string; roster ids are SERIAL
      // numbers — compare as strings so the assignee name resolves optimistically.
      const named = { ...d, assigned_name: members.find(m => String(m.id) === String(d.assigned_client_id))?.name ?? null }
      setPlan(p => ({
        ...p,
        elements: editing ? p.elements.map(e => (e.id === editing ? named : e)) : [...p.elements, named],
      }))
      bumpCount(editing ? 0 : 1)
      setModal(null)
    } catch (err) { toast.error(err.message) }
  }

  async function deleteElement(eid) {
    try {
      const res = await fetch(apiUrl(`/api/service-plans/${plan.id}/elements/${eid}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error("That didn't delete — nothing was changed. Please try again.")
      setPlan(p => ({ ...p, elements: p.elements.filter(e => e.id !== eid) }))
      bumpCount(-1)
    } catch (err) { toast.error(err.message) }
  }

  function bumpCount(delta) {
    if (!delta || !plan) return
    setPlans(list => list.map(x => (x.id === plan.id ? { ...x, element_count: (x.element_count ?? 0) + delta } : x)))
  }

  // Move an element up/down and persist the new order.
  async function move(idx, dir) {
    const j = idx + dir
    if (j < 0 || j >= plan.elements.length) return
    const prev = plan.elements
    const next = [...plan.elements]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setPlan(p => ({ ...p, elements: next }))
    try {
      const res = await fetch(apiUrl(`/api/service-plans/${plan.id}/elements/reorder`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: next.map(e => e.id) }),
      })
      if (!res.ok) throw new Error()
    } catch {
      // fetch doesn't throw on 4xx/5xx — revert the optimistic swap so the UI
      // can't keep an order the server rejected (e.g. the full-set 400).
      setPlan(p => ({ ...p, elements: prev }))
      toast.error(t('plan.orderError'))
    }
  }

  const litLabel = lit?.feast_name || (lit?.season ? seasonLabel(t, lit.season) : null)

  if (loading) {
    return <PageWrapper><div className="flex items-center justify-center py-24"><Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" /></div></PageWrapper>
  }

  return (
    <PageWrapper className="max-w-5xl mx-auto">
      <div className="space-y-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <ListMusic size={18} className="text-brass-600 dark:text-brass-300" />
              <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">{t('plan.title')}</h1>
            </div>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">{t('plan.sub')}</p>
          </div>
          {plan && (
            <button
              type="button"
              onClick={() => printOrderOfWorship({ orgName, plan, lit, t, dateLocale })}
              className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-parchment-100 dark:hover:bg-ink-800/70 transition-colors"
              title={t('plan.printHint')}
            >
              <Printer size={16} /> {t('plan.print')}
            </button>
          )}
        </motion.div>

        <div className="grid lg:grid-cols-[240px_1fr] gap-6">
          {/* Plans rail */}
          <div className="order-1">
            <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-4 space-y-3">
              {canWrite && (
                <div className="flex gap-2">
                  <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} aria-label={t('plan.newDate')} className="flex-1 min-w-0 px-2 py-1.5 text-xs rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400" />
                  <button onClick={createPlan} className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity"><Plus size={13} /> {t('plan.new')}</button>
                </div>
              )}
              {plans.length === 0 ? (
                <p className="text-xs text-ink-400 dark:text-parchment-300/60 py-1">{t('plan.none')}</p>
              ) : (
                <ul className="space-y-1 max-h-96 overflow-y-auto">
                  {plans.map(p => (
                    <li key={p.id}>
                      <button onClick={() => setSelectedId(p.id)} className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${p.id === selectedId ? 'bg-church-900/10 dark:bg-parchment-100/10' : 'hover:bg-parchment-100 dark:hover:bg-ink-800/60'}`}>
                        <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">{p.title}</p>
                        <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">{fmtShort(p.date, dateLocale)} · {t(p.element_count === 1 ? 'plan.item1' : 'plan.itemN', { n: p.element_count })}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Plan editor */}
          <div className="order-2">
            {!plan ? (
              <EmptyState icon={ListMusic} title={t('plan.noneSelected')} body={canWrite ? t('plan.noneSelectedBody') : t('plan.noneViewer')} />
            ) : (
              <div className="space-y-4">
                {/* Plan details — key={plan.id} so React remounts the
                    uncontrolled title/date inputs when the selected plan
                    changes. Without it, switching plans keeps the old
                    inputs mounted; their defaultValue is ignored on
                    re-render, so blurring would PATCH plan A's stale
                    value onto plan B. */}
                <div key={plan.id} className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <input
                      type="text" defaultValue={plan.title} disabled={!canWrite}
                      onBlur={e => { const v = e.target.value.trim(); if (v && v !== plan.title) patchPlan({ title: v }) }}
                      aria-label={t('plan.titleField')}
                      className="flex-1 font-display text-xl font-semibold bg-transparent text-ink-900 dark:text-parchment-50 border-b border-transparent hover:border-parchment-300/60 focus:border-brass-400 focus:outline-none disabled:opacity-100"
                    />
                    {/* Sunday Packet — the printable everything-sheet for
                        this plan's date (SPK.1, "the Thursday Button"). */}
                    <Link
                      to={`/packet?date=${plan.date}`}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors"
                    >
                      <Printer size={13} /> {t('plan.packet')}
                    </Link>
                    {/* Service Mode — the fullscreen run-sheet for the
                        liturgy itself. Read-only surface, so everyone
                        (including viewers at the sound desk) gets it. */}
                    <Link
                      to={`/service-mode/${plan.id}`}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity"
                    >
                      <Play size={13} /> {t('plan.serviceMode')}
                    </Link>
                    {canWrite && (
                      <button onClick={deletePlan} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-300/70 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"><Trash2 size={13} /> {t('plan.deletePlan')}</button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-ink-600 dark:text-parchment-200">
                    <CalendarIcon size={14} className="text-ink-400" />
                    <input type="date" defaultValue={plan.date} disabled={!canWrite} onBlur={e => { if (e.target.value && e.target.value !== plan.date) patchPlan({ date: e.target.value }) }} aria-label={t('plan.date')} className="px-2 py-1 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400" />
                    <span className="text-ink-500 dark:text-parchment-300/70">{fmtLong(plan.date, dateLocale)}</span>
                    {litLabel && (
                      <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md border ${LIT_COLOR_TEXT[lit?.color] ?? LIT_COLOR_TEXT.White}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${LIT_COLOR_DOT[lit?.color] ?? LIT_COLOR_DOT_NONE}`} />
                        {litLabel}
                      </span>
                    )}
                  </div>
                </div>

                {/* Elements */}
                <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">{t('plan.order')}</h2>
                    {canWrite && (
                      <button onClick={() => setModal({ element: null })} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity"><Plus size={13} /> {t('plan.addElement')}</button>
                    )}
                  </div>

                  {plan.elements.length === 0 ? (
                    <p className="text-sm text-ink-400 dark:text-parchment-300/60 py-3 text-center">Nothing yet. {canWrite ? 'Add the first element to start the order.' : ''}</p>
                  ) : (
                    <ol className="space-y-1.5">
                      {plan.elements.map((e, idx) => (
                        <li key={e.id} className="flex items-start gap-2 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-100/50 dark:bg-ink-800/40 p-2.5">
                          {canWrite && (
                            <div className="flex flex-col shrink-0 -my-0.5">
                              <button onClick={() => move(idx, -1)} disabled={idx === 0} className="p-0.5 text-ink-400 hover:text-ink-800 dark:hover:text-parchment-50 disabled:opacity-30" aria-label={t('plan.moveUp')}><ChevronUp size={14} /></button>
                              <button onClick={() => move(idx, 1)} disabled={idx === plan.elements.length - 1} className="p-0.5 text-ink-400 hover:text-ink-800 dark:hover:text-parchment-50 disabled:opacity-30" aria-label={t('plan.moveDown')}><ChevronDown size={14} /></button>
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${KIND_BADGE[e.kind] ?? KIND_BADGE.other}`}>{kindLabel(t, e.kind)}</span>
                              <span className="text-sm font-medium text-ink-900 dark:text-parchment-50">{e.title}</span>
                              {e.reference && <span className="text-xs text-ink-500 dark:text-parchment-300/70">{e.reference}</span>}
                            </div>
                            {(e.assigned_name || e.notes) && (
                              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
                                {e.assigned_name && <span className="text-church-700 dark:text-brass-300 font-medium">{e.assigned_name}</span>}
                                {e.assigned_name && e.notes && ' · '}
                                {e.notes}
                              </p>
                            )}
                          </div>
                          {canWrite && (
                            <div className="flex items-center gap-0.5 shrink-0">
                              <button onClick={() => setModal({ element: e })} className="p-1.5 text-ink-400 hover:text-ink-800 dark:hover:text-parchment-50" aria-label={t('plan.editElement')}><Pencil size={13} /></button>
                              <button onClick={() => deleteElement(e.id)} className="p-1.5 text-ink-400 hover:text-rose-700" aria-label={t('plan.deleteElement')}><Trash2 size={13} /></button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {modal && canWrite && (
          <ElementModal element={modal.element} members={members} onClose={() => setModal(null)} onSave={saveElement} />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}
