import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Newspaper, Loader2, Plus, Trash2, Save, Calendar as CalendarIcon, Printer, Copy, ExternalLink, ListMusic, BookOpen } from 'lucide-react'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../context/AuthContext'
import { apiUrl } from '../api'
import LoadFailure from '../components/LoadFailure'
import { useLoad } from '../hooks/useLoad'
import { useLocale } from '../i18n'
import { LIT_COLOR_TEXT, LIT_COLOR_DOT, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { seasonLabel } from '../i18n/liturgical'
import { useConfirm } from '../components/ConfirmProvider'
import { sheetWeekStart, sheetWeekEnd } from '../../../server/src/utils/sheetWeek.js'
import { plansForDateAscending, readingLinesFromElements } from '../utils/bulletinReadingsPull.js'

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
// `locale` is the parish's date locale (useLocale().dateLocale), so a
// Spanish parish reads "domingo, 1 de noviembre de 2026", not the
// browser's default.
function fmtLong(iso, locale) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}
function fmtShort(iso, locale) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}
function fmtTime(hms, locale) {
  if (!hms) return ''
  const [h, m] = String(hms).split(':').map(Number)
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
}

// SP-304: weekday solemnities (All Souls, etc.) must show on "This week's
// services" and the print sheet. Calendar rows may already carry feast_name;
// sample / older rows often do not — fall back to the liturgical range map.
export function feastLabelForService(service, litByDate) {
  const fromEvent = typeof service?.feast_name === 'string' ? service.feast_name.trim() : ''
  if (fromEvent) return fromEvent
  const day = String(service?.date ?? '').slice(0, 10)
  const fromLit = day && litByDate?.[day]?.feast_name
  return typeof fromLit === 'string' && fromLit.trim() ? fromLit.trim() : ''
}

export function formatServiceTitle(service, litByDate) {
  const title = service?.title || ''
  const feast = feastLabelForService(service, litByDate)
  if (!feast) return title
  if (title && title.toLocaleLowerCase().includes(feast.toLocaleLowerCase())) return title
  return title ? `${title} · ${feast}` : feast
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
// PDF" handles the rest). Pulls everything already on the page. The sheet
// chrome and dates follow the parish language (`t`, `locale`).
function printBulletin({ orgName, date, lit, services, litByDate, form, t, locale, isDraft }) {
  const w = window.open('', '_blank', 'width=800,height=1000')
  if (!w) return
  const accent = LIT_HEX[lit?.color] ?? '#7B2D26'
  const litLine = lit?.feast_name || lit?.season || ''
  const longDate = (() => {
    const [y, m, d] = date.slice(0, 10).split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  })()
  const svcRows = (services || []).map(s => {
    const [yy, mm, dd] = String(s.date).slice(0, 10).split('-').map(Number)
    const day = new Date(yy, mm - 1, dd).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })
    const time = s.start_time ? new Date(2000, 0, 1, ...String(s.start_time).split(':').map(Number)).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) : ''
    return `<tr><td class="svc-when">${escapeHtml(day)}${time ? ` &middot; ${escapeHtml(time)}` : ''}</td><td class="svc-what">${escapeHtml(formatServiceTitle(s, litByDate))}</td></tr>`
  }).join('')

  const section = (title, body) => body ? `<section><h2>${escapeHtml(title)}</h2>${body}</section>` : ''

  w.document.write(`<!doctype html><html lang="${locale === 'es' ? 'es' : 'en'}"><head><meta charset="utf-8"><title>${escapeHtml(t('bul.printDocTitle', { date: longDate }))}</title><style>
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
    footer .draft { margin-top: 6px; font-size: 12px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #8a7d6a }
  </style></head><body>
    <div class="band"></div>
    <header>
      <div class="org">${escapeHtml(orgName || t('bul.printFallbackOrg'))}</div>
      <div class="sub">${escapeHtml((form.title && form.title.trim()) || t('bulletin.title'))}</div>
      <div class="date">${escapeHtml(longDate)}</div>
      ${litLine ? `<div class="lit">${escapeHtml(litLine)}</div>` : ''}
    </header>
    ${section(t('bulletin.readings'), richBlock(form.readings))}
    ${svcRows ? `<section><h2>${escapeHtml(t('bul.printThisWeek'))}</h2><table>${svcRows}</table></section>` : ''}
    ${section(t('bulletin.announcements'), richBlock(form.announcements))}
    ${section(t('bulletin.intentions'), richBlock(form.intentions))}
    ${section(t('bulletin.pastor'), richBlock(form.pastor_note))}
    <footer>${escapeHtml(orgName || '')}${isDraft ? `<div class="draft">${escapeHtml(t('bul.printDraftMark'))}</div>` : ''}</footer>
    <script>window.onload = function () { window.print() }<\/script>
  </body></html>`)
  w.document.close()
}

const EMPTY = { title: '', announcements: '', readings: '', intentions: '', pastor_note: '', published: false }

export default function Bulletin() {
  const { t, tradition, dateLocale } = useLocale()
  const toast = useToast()
  const ask = useConfirm()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'


  const [date, setDate]   = useState(() => upcomingSundayISO())
  const [form, setForm]   = useState(EMPTY)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving]       = useState(false)

  const [lit, setLit]         = useState(null)   // liturgical context for `date`
  const [services, setServices] = useState([])   // that week's events
  const [litByDate, setLitByDate] = useState(null) // SP-304 feast labels; null = UNKNOWN (unread)
  const [litErr, setLitErr]     = useState(false) // liturgical fetch failed
  const [svcErr, setSvcErr]     = useState(false) // services fetch failed
  const [loadedDate, setLoadedDate] = useState(null) // date the form was hydrated for

  // Two reads that answer different questions, so they answer separately.
  // `r.ok ? r.json() : { bulletins: [] }` turned a 500 into "No bulletins
  // yet." — a parish told it has never published one — and the .catch was
  // empty, so nothing was said either way.
  const bulletinsLoad = useLoad(async () => {
    const res = await fetch(apiUrl('/api/bulletins'))
    if (!res.ok) throw new Error(`Failed (${res.status})`)
    return (await res.json()).bulletins ?? []
  }, [], { enabled: isAdmin, initial: [] })

  const orgLoad = useLoad(async () => {
    const res = await fetch(apiUrl('/api/organization'))
    if (!res.ok) throw new Error(`Failed (${res.status})`)
    return res.json()
  }, [], { enabled: isAdmin, isEmpty: () => false })

  const bulletins = bulletinsLoad.data ?? []
  const orgName = orgLoad.data?.name ?? ''
  const orgSlug = orgLoad.data?.slug ?? ''
  const loading = bulletinsLoad.state === 'loading'

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
        title:         existing.title ?? '',
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
    // SP-296: same Sat–Fri liturgical week as the sacristy sheet / packet
    // so the Saturday vigil for this Sunday is included.
    const weekStart = sheetWeekStart(date) || date
    const weekEnd = sheetWeekEnd(weekStart) || addDays(date, 6)
    fetch(apiUrl(`/api/calendar?start=${weekStart}&end=${weekEnd}`))
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
      .then(rows => { if (!cancelled) setServices(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (!cancelled) { setServices([]); setSvcErr(true) } })
    // SP-304: feast names for every day in the services window (sample
    // calendar rows often lack feast_name). TARS #476: a refused range
    // must not keep the prior week's map (stale All Saints on Nov 2).
    // null = UNKNOWN; {} after a successful empty map is fine. UNKNOWN
    // is not EMPTY — titles still render without a feast suffix.
    setLitByDate(null)
    fetch(apiUrl(`/api/liturgical/range?start=${weekStart}&end=${weekEnd}`))
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
      .then(map => { if (!cancelled && map && typeof map === 'object') setLitByDate(map) })
      .catch(() => { if (!cancelled) setLitByDate(null) })
    return () => { cancelled = true }
  }, [date, isAdmin])

  const field = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  // Pull the day's readings from the service plan for this date (SVC.3b).
  // Finds a plan dated the same as the bulletin, then fills the Readings
  // field from its reading/psalm elements (title — reference).
  // A refused list is not "no plan for this date," and a refused plan is
  // not "no readings yet."
  const [pulling, setPulling] = useState(false)

  const [pullingIntentions, setPullingIntentions] = useState(false)

  // SP-294. Fill Prayer / Mass intentions from the intention book for the
  // same Sat–Fri week the sacristy sheet uses. Scheduled only; keep †;
  // Mass title + time; never the stipend dollar amount.
  async function pullFromIntentions() {
    setPullingIntentions(true)
    try {
      const weekStart = sheetWeekStart(date) || date
      const weekEnd = sheetWeekEnd(weekStart) || addDays(date, 6)
      const res = await fetch(apiUrl(`/api/mass-intentions/weekly?start=${weekStart}&end=${weekEnd}`))
      if (!res.ok) { toast.error(t('bul.intentionsUnread')); return }
      const d = await res.json()
      const rows = Array.isArray(d?.intentions) ? d.intentions
        : Array.isArray(d?.rows) ? d.rows
        : Array.isArray(d?.manifest) ? d.manifest
        : null
      if (!rows) { toast.error(t('bul.intentionsUnread')); return }
      const scheduled = rows.filter(r => !r.status || r.status === 'scheduled')
      if (!scheduled.length) { toast.info(t('bul.intentionsNone')); return }
      const lines = scheduled.map(r => {
        const day = r.mass_date ? fmtShort(String(r.mass_date).slice(0, 10), dateLocale) : ''
        const timeRaw = r.mass_time ? String(r.mass_time) : ''
        const time = timeRaw ? fmtTime(timeRaw.length === 5 ? `${timeRaw}:00` : timeRaw, dateLocale) : ''
        const massBits = [r.mass_title, time].filter(Boolean).join(' ')
        const head = [day, massBits].filter(Boolean).join(' · ')
        const body = r.formatted_intention || r.intention || ''
        return head ? `${head} — ${body}` : body
      }).filter(Boolean)
      if (!lines.length) { toast.info(t('bul.intentionsNone')); return }
      if (form.intentions.trim() && !(await ask({
        title: t('bul.replaceIntentionsTitle'),
        body: t('bul.replaceIntentionsBody'),
        confirmLabel: t('bul.replaceConfirm'),
        tone: 'neutral',
      }))) return
      setForm(f => ({ ...f, intentions: lines.join('\n') }))
      toast.success(t('bul.intentionsPulled'))
    } catch {
      toast.error(t('bul.intentionsFailed'))
    } finally {
      setPullingIntentions(false)
    }
  }

  async function pullFromPlan() {
    setPulling(true)
    try {
      const listRes = await fetch(apiUrl('/api/service-plans'))
      if (!listRes.ok) { toast.error(t('bul.pullUnread')); return }
      const list = await listRes.json()
      const plans = list?.plans
      if (!Array.isArray(plans)) { toast.error(t('bul.pullUnread')); return }
      // SP-308: list is date DESC, id DESC — do not plans.find the first
      // same-date row (a hymns-only plan can shadow one with readings).
      const candidates = plansForDateAscending(plans, date)
      if (!candidates.length) { toast.info(t('bul.pullNone')); return }
      let readings = null
      let sawUnreadPlan = false
      for (const candidate of candidates) {
        const fullRes = await fetch(apiUrl(`/api/service-plans/${candidate.id}`))
        if (!fullRes.ok) { sawUnreadPlan = true; continue }
        const full = await fullRes.json()
        const elements = full?.elements
        if (!Array.isArray(elements)) { sawUnreadPlan = true; continue }
        const lines = readingLinesFromElements(elements)
        if (lines.length) { readings = lines; break }
      }
      if (!readings) {
        if (sawUnreadPlan && candidates.length === 1) {
          toast.error(t('bul.pullPlanUnread'))
        } else if (!sawUnreadPlan) {
          toast.info(t('bul.pullNoReadings'))
        } else {
          // Mixed unread + empty: prefer honest unread over a false empty.
          toast.error(t('bul.pullPlanUnread'))
        }
        return
      }
      if (form.readings.trim() && !(await ask({
        title: t('bul.replaceTitle'),
        body: t('bul.replaceBody'),
        confirmLabel: t('bul.replaceConfirm'),
        tone: 'neutral',
      }))) return
      setForm(f => ({ ...f, readings: readings.join('\n') }))
      toast.success(t('bul.pulled'))
    } catch {
      toast.error(t('bul.pullFailed'))
    } finally {
      setPulling(false)
    }
  }

  // SP-299: confirm before Published goes false → true. Cancel makes no request.
  async function onPublishedChange(wantPublished) {
    if (wantPublished && !form.published) {
      if (!(await ask({
        title: t('bul.publishConfirmTitle'),
        body: t('bul.publishConfirmBody'),
        confirmLabel: t('bul.publishConfirmAction'),
        tone: 'neutral',
      }))) return
    } else if (!wantPublished && form.published) {
      if (!(await ask({
        title: t('bul.unpublishConfirmTitle'),
        body: t('bul.unpublishConfirmBody'),
        confirmLabel: t('bul.unpublishConfirmAction'),
        recoverable: true,
      }))) return
    }
    setForm(f => ({ ...f, published: wantPublished }))
  }

  async function save() {
    const priorPublished = !!bulletins.find(b => b.date === date)?.published
    if (form.published && !priorPublished) {
      if (!(await ask({
        title: t('bul.publishConfirmTitle'),
        body: t('bul.publishConfirmBody'),
        confirmLabel: t('bul.publishConfirmAction'),
        tone: 'neutral',
      }))) return
    }
    setSaving(true)
    try {
      const res = await fetch(apiUrl('/api/bulletins'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, ...form }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || t('bul.saveFailed'))
      if (!d?.id || !d?.date) throw new Error(t('bul.saveMalformed'))
      await bulletinsLoad.reload()
      setEditingId(d.id)
      setLoadedDate(d.date)
      toast.success(t('bul.saved'))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(id) {
    if (!(await ask({
      title: t('bul.removeTitle'),
      body: t('bul.removeBody'),
      confirmLabel: t('bul.removeConfirm'),
      recoverable: true,
    }))) return
    try {
      const res = await fetch(apiUrl(`/api/bulletins/${id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(t('bul.deleteFailed'))
      await bulletinsLoad.reload()
      if (editingId === id) { setEditingId(null); setForm(EMPTY) }
    } catch (err) {
      toast.error(err.message)
    }
  }

  // On screen and on the printed sheet the chrome follows the parish's
  // language and tradition. The feast name is server data and stays as sent.
  const litLabel = lit?.feast_name || (lit?.season ? seasonLabel(t, lit.season, { tradition, block: lit.ordinary_block }) : lit?.season)
  const dirty = useMemo(() => {
    const existing = bulletins.find(b => b.date === date)
    const base = existing
      ? { title: existing.title ?? '', announcements: existing.announcements ?? '', readings: existing.readings ?? '', intentions: existing.intentions ?? '', pastor_note: existing.pastor_note ?? '', published: !!existing.published }
      : EMPTY
    return JSON.stringify(base) !== JSON.stringify(form)
  }, [bulletins, date, form])

  if (!isAdmin) {
    return (
      <PageWrapper type="list">
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState icon={Newspaper} title={t('bul.adminsOnlyTitle')} body={t('bul.adminsOnlyBody')} />
        </div>
      </PageWrapper>
    )
  }

  if (loading) {
    return (
      <PageWrapper type="list">
        <div className="flex items-center justify-center py-24">
          <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper type="list" className="max-w-5xl mx-auto">
      <div className="space-y-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between gap-4 flex-wrap">
          <PageHeader title={t('bulletin.title')} leading={<Newspaper size={18} />} subtitle={orgName ? t('bul.introNamed', { org: orgName }) : t('bul.intro')} />
          <button
            type="button"
            onClick={() => printBulletin({ orgName, date, lit, services, litByDate, form, t, locale: dateLocale, isDraft: !form.published })}
            className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-parchment-100 dark:hover:bg-ink-800/70 transition-colors"
            title={t('bul.printTitle')}
          >
            <Printer size={16} aria-hidden="true" /> {t('bul.print')}
          </button>
        </motion.div>

        <div className="grid lg:grid-cols-[1fr_260px] gap-6">
          {/* Editor */}
          <div className="space-y-5 order-2 lg:order-1">
            {/* Date + live context */}
            <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                <div>
                  <label htmlFor="bdate" className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('bul.date')}</label>
                  <input
                    id="bdate"
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    className="px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
                  />
                </div>
                <p className="text-sm text-ink-600 dark:text-parchment-200 pb-1">{fmtLong(date, dateLocale)}</p>
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
                  ? <span className="text-[11px] text-rose-700 dark:text-rose-300">{t('bul.litFailed')}</span>
                  : <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">{t('bul.litAuto')}</span>}
              </div>

              {/* This week's services */}
              <div>
                <p className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5 flex items-center gap-1.5">
                  <CalendarIcon size={13} aria-hidden="true" /> {t('bul.weekServices')}
                </p>
                {svcErr ? (
                  <p className="text-xs text-rose-700 dark:text-rose-300">{t('bul.svcFailed')}</p>
                ) : services.length === 0 ? (
                  <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('bul.svcEmpty')}</p>
                ) : (
                  <ul className="space-y-1">
                    {services.map(s => (
                      <li key={s.id} className="text-sm text-ink-700 dark:text-parchment-200 flex items-baseline gap-2" data-testid="bul-week-service">
                        <span className="text-xs text-ink-500 dark:text-parchment-300/70 w-24 shrink-0">{fmtShort(s.date, dateLocale)} {fmtTime(s.start_time, dateLocale)}</span>
                        <span className="truncate">{formatServiceTitle(s, litByDate)}</span>
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
                title={t('bul.pullTitle')}
              >
                {pulling ? <Loader2 size={13} className="animate-spin" /> : <ListMusic size={13} />}
                {t('bul.pull')}
              </button>
              <button
                type="button"
                onClick={pullFromIntentions}
                disabled={pullingIntentions}
                className="flex items-center gap-1.5 text-xs font-semibold text-church-700 dark:text-brass-300 hover:underline disabled:opacity-50"
                title={t('bul.intentionsPullTitle')}
              >
                {pullingIntentions ? <Loader2 size={13} className="animate-spin" /> : <BookOpen size={13} />}
                {t('bul.intentionsPull')}
              </button>
            </div>

            {/* Written sections */}
            <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5 space-y-4">
              <div>
                <label htmlFor="bul-title" className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">{t('bul.field.title')}</label>
                <input
                  id="bul-title"
                  type="text"
                  value={form.title}
                  onChange={field('title')}
                  maxLength={200}
                  placeholder={t('bul.field.title.ph')}
                  className="w-full px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
                />
              </div>
              {[
                ['announcements', 7],
                ['readings', 3],
                ['intentions', 3],
                ['pastor_note', 4],
              ].map(([key, rows]) => (
                <div key={key}>
                  <label htmlFor={`bul-${key}`} className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">{t(`bul.field.${key}`)}</label>
                  <textarea
                    id={`bul-${key}`}
                    value={form[key]}
                    onChange={field(key)}
                    rows={rows}
                    placeholder={t(`bul.field.${key}.ph`)}
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
                    onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/p/${orgSlug}/bulletin`).then(() => toast.success(t('bul.linkCopied')), () => {})}
                    className="ml-auto shrink-0 p-1 rounded text-ink-500 hover:text-ink-900 dark:text-parchment-300/70 dark:hover:text-parchment-50"
                    aria-label={t('bul.copyLink')}
                  >
                    <Copy size={13} aria-hidden="true" />
                  </button>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-2 border-t border-parchment-300/60 dark:border-brass-900/25">
                <label className="flex items-center gap-2 text-sm text-ink-700 dark:text-parchment-200 cursor-pointer">
                  <input type="checkbox" checked={form.published} onChange={e => onPublishedChange(e.target.checked)} className="h-11 w-11 min-h-[44px] min-w-[44px] rounded border-parchment-300 text-church-700 focus:ring-brass-400" />
                  {t('bul.published')}
                </label>
                <div className="flex items-center gap-2">
                  {editingId && (
                    <button onClick={() => remove(editingId)} className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-rose-300/70 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors">
                      <Trash2 size={14} aria-hidden="true" /> {t('bul.delete')}
                    </button>
                  )}
                  <button
                    onClick={save}
                    disabled={saving || !dirty}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 disabled:opacity-40 transition-opacity"
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    {editingId ? t('bul.save') : t('bul.create')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Recent bulletins */}
          <div className="order-1 lg:order-2">
            <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">{t('bul.list')}</p>
                <button
                  onClick={() => setDate(upcomingSundayISO())}
                  className="flex items-center gap-1 text-[11px] font-semibold text-church-700 dark:text-brass-300 hover:underline"
                  title={t('bul.thisSundayTitle')}
                >
                  <Plus size={12} aria-hidden="true" /> {t('bul.thisSunday')}
                </button>
              </div>
              {bulletinsLoad.state === 'failed' ? (
                <LoadFailure variant="strip" body={t('bul.listFailedBody')} cause={bulletinsLoad.error}
                  onRetry={bulletinsLoad.reload} retrying={bulletinsLoad.retrying} />
              ) : bulletins.length === 0 ? (
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 py-2">{t('bul.empty')}</p>
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
                          {fmtShort(b.date, dateLocale)}
                          {b.published
                            ? <span className="text-[11px] font-semibold uppercase tracking-wide text-brass-600 dark:text-brass-400">{t('bul.live')}</span>
                            : <span className="text-[11px] uppercase tracking-wide text-ink-400 dark:text-parchment-300/70">{t('bul.draft')}</span>}
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
