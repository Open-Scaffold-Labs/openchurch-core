import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Newspaper, Loader2, Plus, Trash2, Save, Calendar as CalendarIcon, Printer, Copy, ExternalLink, ListMusic } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../context/AuthContext'
import { apiUrl } from '../api'
import { LIT_COLOR_TEXT, LIT_COLOR_DOT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { useConfirm } from '../components/ConfirmProvider'

// Weekly bulletin editor (BUL.2). The admin picks a date (defaults to the
// upcoming Sunday); the page pulls that day's liturgical context and the
// week's services live so the bulletin always reflects the real schedule,
// and the admin fills the human-written parts (announcements, readings,
// intentions, a note). Saves upsert by date via /api/bulletins (BUL.1).
// The print-ready output + public link come in BUL.3.

function pad(n) { return String(n).padStart(2, '0') }
function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n)
  return toISO(dt)
}
// Next Sunday on/after today (today if it's already Sunday).
function upcomingSundayISO() {
  const d = new Date()
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7))
  return toISO(d)
}
function fmtLong(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}
function fmtShort(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function fmtTime(hms) {
  if (!hms) return ''
  const [h, m] = String(hms).split(':').map(Number)
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// Canonical liturgical hex for the print header band (Tailwind classes
// don't reach the print window). White falls back to a warm brass so the
// band stays visible on paper.
const LIT_HEX = { Purple: '#6b21a8', White: '#b08d57', Green: '#15803d', Red: '#b91c1c', Gold: '#b8860b' }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}
// Escaped multi-line text → paragraphs (blank line splits) with <br> for
// single newlines, so a typed list keeps its shape on the printed page.
function richBlock(text) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  return t.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
}

// Open a print window with a clean, paper-ready bulletin. Mirrors the
// printTag pattern in Check-in (no PDF library — the browser's "Save as
// PDF" handles the rest). Pulls everything already on the page.
function printBulletin({ orgName, date, lit, services, form }) {
  const w = window.open('', '_blank', 'width=800,height=1000')
  if (!w) return
  const accent = LIT_HEX[lit?.color] ?? '#7B2D26'
  const litLine = lit?.feast_name || lit?.season || ''
  const longDate = (() => {
    const [y, m, d] = date.slice(0, 10).split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  })()
  const svcRows = (services || []).map(s => {
    const [yy, mm, dd] = String(s.date).slice(0, 10).split('-').map(Number)
    const day = new Date(yy, mm - 1, dd).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const time = s.start_time ? new Date(2000, 0, 1, ...String(s.start_time).split(':').map(Number)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''
    return `<tr><td class="svc-when">${escapeHtml(day)}${time ? ` &middot; ${escapeHtml(time)}` : ''}</td><td class="svc-what">${escapeHtml(s.title)}</td></tr>`
  }).join('')

  const section = (title, body) => body ? `<section><h2>${escapeHtml(title)}</h2>${body}</section>` : ''

  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Bulletin — ${escapeHtml(longDate)}</title><style>
    @page { margin: 18mm }
    * { box-sizing: border-box }
    body { font-family: Georgia, 'Times New Roman', serif; color: #2b2622; margin: 0; line-height: 1.5 }
    .band { height: 8px; background: ${accent} }
    header { text-align: center; padding: 20px 0 14px; border-bottom: 1px solid #e6ddcf }
    header .org { font-size: 26px; font-weight: 700; letter-spacing: .5px; color: #2b2622 }
    header .sub { font-size: 13px; text-transform: uppercase; letter-spacing: 3px; color: #8a7d6a; margin-top: 4px }
    header .date { font-size: 15px; margin-top: 8px; color: #4a4036 }
    header .lit { display: inline-block; margin-top: 8px; font-size: 13px; font-weight: 700; color: ${accent} }
    section { margin-top: 18px; page-break-inside: avoid }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 2px; color: ${accent}; border-bottom: 1px solid #e6ddcf; padding-bottom: 4px; margin: 0 0 8px }
    p { margin: 0 0 8px; font-size: 14px }
    table { width: 100%; border-collapse: collapse }
    td { padding: 3px 0; font-size: 14px; vertical-align: top }
    .svc-when { color: #6a5f50; width: 42%; white-space: nowrap; padding-right: 10px }
    footer { margin-top: 26px; text-align: center; font-size: 11px; color: #a89c88; border-top: 1px solid #e6ddcf; padding-top: 10px }
  </style></head><body>
    <div class="band"></div>
    <header>
      <div class="org">${escapeHtml(orgName || 'Parish Bulletin')}</div>
      <div class="sub">Weekly Bulletin</div>
      <div class="date">${escapeHtml(longDate)}</div>
      ${litLine ? `<div class="lit">${escapeHtml(litLine)}</div>` : ''}
    </header>
    ${section('Readings', richBlock(form.readings))}
    ${svcRows ? `<section><h2>This Week</h2><table>${svcRows}</table></section>` : ''}
    ${section('Announcements', richBlock(form.announcements))}
    ${section('Prayer &amp; Mass Intentions', richBlock(form.intentions))}
    ${section('From the Pastor', richBlock(form.pastor_note))}
    <footer>${escapeHtml(orgName || '')}</footer>
    <script>window.onload = function () { window.print() }<\/script>
  </body></html>`)
  w.document.close()
}

const EMPTY = { announcements: '', readings: '', intentions: '', pastor_note: '', published: false }

export default function Bulletin() {
  const toast = useToast()
  const ask = useConfirm()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [bulletins, setBulletins] = useState([])
  const [loading, setLoading]     = useState(true)
  const [orgName, setOrgName]     = useState('')
  const [orgSlug, setOrgSlug]     = useState('')

  const [date, setDate]   = useState(() => upcomingSundayISO())
  const [form, setForm]   = useState(EMPTY)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving]       = useState(false)

  const [lit, setLit]         = useState(null)   // liturgical context for `date`
  const [services, setServices] = useState([])   // that week's events
  const [litErr, setLitErr]     = useState(false) // liturgical fetch failed
  const [svcErr, setSvcErr]     = useState(false) // services fetch failed
  const [loadedDate, setLoadedDate] = useState(null) // date the form was hydrated for

  // Initial load: the bulletin list + parish name.
  useEffect(() => {
    if (!isAdmin) { setLoading(false); return }
    Promise.all([
      fetch(apiUrl('/api/bulletins')).then(r => (r.ok ? r.json() : { bulletins: [] })),
      fetch(apiUrl('/api/organization')).then(r => (r.ok ? r.json() : {})),
    ]).then(([b, org]) => {
      setBulletins(b.bulletins ?? [])
      setOrgName(org?.name ?? '')
      setOrgSlug(org?.slug ?? '')
    }).catch(() => {}).finally(() => setLoading(false))
  }, [isAdmin])

  // Hydrate the form from the existing bulletin for the selected date — but
  // only when the date actually changes (or once the list first arrives for
  // it). Guarding on `loadedDate` keeps this from re-running on every
  // `bulletins` mutation, which would otherwise clobber unsaved edits when an
  // unrelated bulletin is saved or deleted from the rail.
  useEffect(() => {
    if (!isAdmin || loading || loadedDate === date) return
    const existing = bulletins.find(b => b.date === date)
    if (existing) {
      setEditingId(existing.id)
      setForm({
        announcements: existing.announcements ?? '',
        readings:      existing.readings ?? '',
        intentions:    existing.intentions ?? '',
        pastor_note:   existing.pastor_note ?? '',
        published:     !!existing.published,
      })
    } else {
      setEditingId(null)
      setForm(EMPTY)
    }
    setLoadedDate(date)
  }, [date, bulletins, isAdmin, loading, loadedDate])

  // Refresh the live context (liturgical day + that week's services) shown
  // alongside the editor. Depends only on `date`, so list mutations don't
  // re-fire it.
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    setLitErr(false)
    setSvcErr(false)
    fetch(apiUrl(`/api/liturgical?date=${date}`))
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
      .then(d => { if (!cancelled) setLit(d) })
      .catch(() => { if (!cancelled) { setLit(null); setLitErr(true) } })
    fetch(apiUrl(`/api/calendar?start=${date}&end=${addDays(date, 6)}`))
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
      .then(rows => { if (!cancelled) setServices(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (!cancelled) { setServices([]); setSvcErr(true) } })
    return () => { cancelled = true }
  }, [date, isAdmin])

  const field = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  // Pull the day's readings from the service plan for this date (SVC.3b).
  // Finds a plan dated the same as the bulletin, then fills the Readings
  // field from its reading/psalm elements (title — reference).
  const [pulling, setPulling] = useState(false)
  async function pullFromPlan() {
    setPulling(true)
    try {
      const list = await fetch(apiUrl('/api/service-plans')).then(r => (r.ok ? r.json() : { plans: [] }))
      const match = (list.plans ?? []).find(p => p.date === date)
      if (!match) { toast.info('No service plan for this date yet'); return }
      const full = await fetch(apiUrl(`/api/service-plans/${match.id}`)).then(r => (r.ok ? r.json() : null))
      const readings = (full?.elements ?? [])
        .filter(e => e.kind === 'reading' || e.kind === 'psalm')
        .map(e => `${e.title}${e.reference ? ` — ${e.reference}` : ''}`)
      if (!readings.length) { toast.info('That service plan has no readings yet'); return }
      if (form.readings.trim() && !(await ask({
        title: 'Replace the current Readings?',
        body: 'The readings from the service plan will overwrite what is in the Readings field now.',
        confirmLabel: 'Replace readings',
        tone: 'neutral',
      }))) return
      setForm(f => ({ ...f, readings: readings.join('\n') }))
      toast.success('Readings pulled from the service plan')
    } catch (err) {
      toast.error("Couldn't pull from the service plan. Nothing was lost — please retry.")
    } finally {
      setPulling(false)
    }
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(apiUrl('/api/bulletins'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, ...form }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "That didn't save — nothing was lost. Please try again.")
      if (!d?.id || !d?.date) throw new Error('Saved, but the response was malformed — refresh to confirm')
      setBulletins(list => [d, ...list.filter(b => b.date !== d.date)].sort((a, b) => b.date.localeCompare(a.date)))
      setEditingId(d.id)
      setLoadedDate(d.date)
      toast.success('Bulletin saved')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(id) {
    if (!(await ask({ title: 'Delete this bulletin?', confirmLabel: 'Delete bulletin' }))) return
    try {
      const res = await fetch(apiUrl(`/api/bulletins/${id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error("That didn't delete — nothing was changed. Please try again.")
      setBulletins(list => list.filter(b => b.id !== id))
      if (editingId === id) { setEditingId(null); setForm(EMPTY) }
    } catch (err) {
      toast.error(err.message)
    }
  }

  const litLabel = lit?.feast_name || lit?.season
  const dirty = useMemo(() => {
    const existing = bulletins.find(b => b.date === date)
    const base = existing
      ? { announcements: existing.announcements ?? '', readings: existing.readings ?? '', intentions: existing.intentions ?? '', pastor_note: existing.pastor_note ?? '', published: !!existing.published }
      : EMPTY
    return JSON.stringify(base) !== JSON.stringify(form)
  }, [bulletins, date, form])

  if (!isAdmin) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState icon={Newspaper} title="Admins only" body="The bulletin editor is restricted to admins." />
        </div>
      </PageWrapper>
    )
  }

  if (loading) {
    return (
      <PageWrapper>
        <div className="flex items-center justify-center py-24">
          <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper className="max-w-5xl mx-auto">
      <div className="space-y-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <Newspaper size={18} className="text-brass-600 dark:text-brass-300" />
              <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Weekly Bulletin</h1>
            </div>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
              Build {orgName ? `${orgName}'s ` : 'the '}weekly bulletin. The liturgical day and that week's services fill in automatically — you add the announcements.
            </p>
          </div>
          <button
            type="button"
            onClick={() => printBulletin({ orgName, date, lit, services, form })}
            className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-parchment-100 dark:hover:bg-ink-800/70 transition-colors"
            title="Open a print-ready bulletin (Save as PDF or print)"
          >
            <Printer size={16} /> Print / PDF
          </button>
        </motion.div>

        <div className="grid lg:grid-cols-[1fr_260px] gap-6">
          {/* Editor */}
          <div className="space-y-5 order-2 lg:order-1">
            {/* Date + live context */}
            <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                <div>
                  <label htmlFor="bdate" className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">Bulletin date</label>
                  <input
                    id="bdate"
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    className="px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
                  />
                </div>
                <p className="text-sm text-ink-600 dark:text-parchment-200 pb-1">{fmtLong(date)}</p>
              </div>

              {/* Auto-pulled context (read-only) */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {litLabel && (
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md border ${LIT_COLOR_TEXT[lit?.color] ?? LIT_COLOR_TEXT.White}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${LIT_COLOR_DOT[lit?.color] ?? LIT_COLOR_DOT_NONE}`} />
                    {litLabel}
                  </span>
                )}
                {litErr
                  ? <span className="text-[11px] text-rose-700 dark:text-rose-300">Couldn't load the liturgical day</span>
                  : <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">auto-filled from the liturgical calendar</span>}
              </div>

              {/* This week's services */}
              <div>
                <p className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5 flex items-center gap-1.5">
                  <CalendarIcon size={13} /> This week's services
                </p>
                {svcErr ? (
                  <p className="text-xs text-rose-700 dark:text-rose-300">Couldn't load this week's services — change the date or retry before publishing.</p>
                ) : services.length === 0 ? (
                  <p className="text-xs text-ink-500 dark:text-parchment-300/70">No events scheduled this week. Add them in Schedule and they'll appear here.</p>
                ) : (
                  <ul className="space-y-1">
                    {services.map(s => (
                      <li key={s.id} className="text-sm text-ink-700 dark:text-parchment-200 flex items-baseline gap-2">
                        <span className="text-xs text-ink-500 dark:text-parchment-300/70 w-24 shrink-0">{fmtShort(s.date)} {fmtTime(s.start_time)}</span>
                        <span className="truncate">{s.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Pull the day's readings from the service plan (SVC.3b). */}
              <button
                type="button"
                onClick={pullFromPlan}
                disabled={pulling}
                className="flex items-center gap-1.5 text-xs font-semibold text-church-700 dark:text-brass-300 hover:underline disabled:opacity-50"
                title="Fill Readings from this date's order of worship"
              >
                {pulling ? <Loader2 size={13} className="animate-spin" /> : <ListMusic size={13} />}
                Pull readings from service plan
              </button>
            </div>

            {/* Written sections */}
            <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-4">
              {[
                ['announcements', 'Announcements', 'Parish news, events, and notices for the week…', 7],
                ['readings', 'Readings', "First reading · Psalm · Second reading · Gospel", 3],
                ['intentions', 'Prayer / Mass intentions', 'For whom the Masses this week are offered…', 3],
                ['pastor_note', "Pastor's note", 'A short word from the pastor…', 4],
              ].map(([key, label, ph, rows]) => (
                <div key={key}>
                  <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">{label}</label>
                  <textarea
                    value={form[key]}
                    onChange={field(key)}
                    rows={rows}
                    placeholder={ph}
                    className="w-full px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
                  />
                </div>
              ))}

              {/* Public read-online link (BUL.3b) — shown once the saved
                  bulletin for this date is published. */}
              {bulletins.find(b => b.date === date)?.published && orgSlug && (
                <div className="flex items-center gap-2 text-xs bg-parchment-100/70 dark:bg-ink-800/50 rounded-lg px-3 py-2">
                  <ExternalLink size={13} className="shrink-0 text-brass-600 dark:text-brass-300" />
                  <a href={`/p/${orgSlug}/bulletin`} target="_blank" rel="noreferrer" className="truncate text-church-800 dark:text-brass-200 hover:underline">
                    {window.location.origin}/p/{orgSlug}/bulletin
                  </a>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/p/${orgSlug}/bulletin`).then(() => toast.success('Public link copied'), () => {})}
                    className="ml-auto shrink-0 p-1 rounded text-ink-500 hover:text-ink-900 dark:text-parchment-300/70 dark:hover:text-parchment-50"
                    aria-label="Copy public bulletin link"
                  >
                    <Copy size={13} />
                  </button>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-2 border-t border-parchment-300/60 dark:border-brass-900/25">
                <label className="flex items-center gap-2 text-sm text-ink-700 dark:text-parchment-200 cursor-pointer">
                  <input type="checkbox" checked={form.published} onChange={e => setForm(f => ({ ...f, published: e.target.checked }))} className="rounded border-parchment-300 text-church-700 focus:ring-brass-400" />
                  Published
                </label>
                <div className="flex items-center gap-2">
                  {editingId && (
                    <button onClick={() => remove(editingId)} className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-rose-300/70 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors">
                      <Trash2 size={14} /> Delete
                    </button>
                  )}
                  <button
                    onClick={save}
                    disabled={saving || !dirty}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 disabled:opacity-40 transition-opacity"
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    {editingId ? 'Save' : 'Create bulletin'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Recent bulletins */}
          <div className="order-1 lg:order-2">
            <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">Bulletins</p>
                <button
                  onClick={() => setDate(upcomingSundayISO())}
                  className="flex items-center gap-1 text-[11px] font-semibold text-church-700 dark:text-brass-300 hover:underline"
                  title="Jump to the upcoming Sunday"
                >
                  <Plus size={12} /> This Sunday
                </button>
              </div>
              {bulletins.length === 0 ? (
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 py-2">No bulletins yet.</p>
              ) : (
                <ul className="space-y-1 max-h-80 overflow-y-auto">
                  {bulletins.map(b => (
                    <li key={b.id}>
                      <button
                        onClick={() => setDate(b.date)}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                          b.date === date
                            ? 'bg-church-900/10 dark:bg-parchment-100/10 text-ink-900 dark:text-parchment-50 font-semibold'
                            : 'text-ink-700 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800/60'
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          {fmtShort(b.date)}
                          {b.published
                            ? <span className="text-[10px] font-semibold uppercase tracking-wide text-brass-600 dark:text-brass-400">Live</span>
                            : <span className="text-[10px] uppercase tracking-wide text-ink-400 dark:text-parchment-300/50">Draft</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </PageWrapper>
  )
}
