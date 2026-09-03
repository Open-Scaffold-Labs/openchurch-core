import { useState, useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Plus, X, Pencil, Trash2, Users, TrendingUp,
  Activity, UserCheck, ChevronDown, MoreHorizontal,
  Phone, Mail, Building2, FileText, Tag, Eye, Calendar, Upload,
  ArrowRight,
} from 'lucide-react'
import DictationInput from '../components/DictationInput'
import AITextArea from '../components/AITextArea'
import AnimatedButton from '../components/AnimatedButton'
import CalendarSync from '../components/CalendarSync'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'
import { MembersIllustration } from '../components/illustrations'
import PageWrapper from '../components/PageWrapper'
import ImportMembersModal from '../components/ImportMembersModal'
import AvatarUploader from '../components/AvatarUploader'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { useToast } from '../components/ToastProvider'
import { apiUrl } from '../api'
import { initials, loadOne, loadList } from '../utils/format'
import { celebrateFirstAction } from '../utils/firstActionToast'
import { LIT_COLOR_DOT, LIT_COLOR_TEXT } from '../utils/liturgicalColors'
import { useConfirm } from '../components/ConfirmProvider'
import { scrimCls } from '../components/MobileSheet'

/* ── Helpers ── */
// Warm-palette avatars (QA audit C3): per-member variety WITHOUT the
// startup rainbow — every tone is drawn from the church/brass/ink
// scales. The a11y rule from the earlier WCAG pass still binds: only
// deep tones, so the parchment-50 initials on top clear 4.5:1. Keep
// any addition comfortably dark.
const AVATAR_COLORS = [
  'bg-church-600', 'bg-brass-700', 'bg-ink-700',
  'bg-church-800', 'bg-brass-800', 'bg-ink-600',
]
function avatarColor(name = '') {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % AVATAR_COLORS.length
  return AVATAR_COLORS[h]
}

// Member avatar — the uploaded photo when present, else the per-name
// coloured initials circle the member list has always used. Kept
// member-specific (rather than the shared UserAvatar) so members
// without a photo keep their playful colour variety; UserAvatar's
// burgundy fallback is reserved for the signed-in account.
function MemberAvatar({ member, className = 'w-9 h-9', textClassName = 'text-xs' }) {
  if (member?.avatar) {
    return (
      <img
        src={member.avatar}
        alt={member.name ? `${member.name}'s photo` : 'Member photo'}
        className={`${className} rounded-full object-cover shrink-0 shadow-sm`}
      />
    )
  }
  return (
    <div className={`${className} ${textClassName} rounded-full flex items-center justify-center text-parchment-50 font-bold shrink-0 shadow-sm ${avatarColor(member?.name)}`}>
      {initials(member?.name)}
    </div>
  )
}
function timeAgo(date, t) {
  if (!date) return '—'
  const s = Math.floor((Date.now() - new Date(date)) / 1000)
  if (s < 60)   return t('aist.justNow')
  if (s < 3600) return t('aist.ago', { n: `${Math.floor(s / 60)}m` })
  if (s < 86400)return t('aist.ago', { n: `${Math.floor(s / 3600)}h` })
  return t('aist.ago', { n: `${Math.floor(s / 86400)}d` })
}

// Stored values stay canonical English (the server and existing rows
// know them); only the LABELS localize, via mem.role.* / mem.status.* /
// mem.tag.* keys.
const ROLES = ['Member', 'Volunteer', 'Leader', 'Staff', 'Guest']
const STATUSES = ['active', 'inactive', 'new']
const TAG_OPTIONS = ['Volunteer', 'New', 'Leader', 'Youth', 'Worship', 'Outreach']
// Humanize an unmapped value ("sunday-service" → "Sunday Service") so a
// value with no string entry degrades to readable text instead of leaking
// the raw key ("mem.tag.sunday-service") — covers custom, user-entered
// roles/tags that were never in the taxonomy.
const humanize = (s) => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const localize = (t, key, raw) => { const v = t(key); return v === key ? humanize(raw) : v }
const roleLabel   = (t, r) => localize(t, `mem.role.${r}`, r)
const statusLabel = (t, s_) => localize(t, `mem.status.${s_}`, s_)
const tagLabel    = (t, g) => localize(t, `mem.tag.${g}`, g)

// Tags are labels, not traffic lights (OPERATOR: amber/rose never as
// category colors). One quiet brass voice for all of them.
const TAG_TONE = 'bg-brass-50 text-brass-700 border border-brass-200/70 dark:bg-brass-900/20 dark:text-brass-300 dark:border-brass-800/40'
const TAG_COLORS = {
  Volunteer: TAG_TONE, New: TAG_TONE, Leader: TAG_TONE,
  Youth: TAG_TONE, Worship: TAG_TONE, Outreach: TAG_TONE,
}
// Status is quiet fact, not signal color (emerald-as-success is banned).
const STATUS_COLORS = {
  active:   'bg-brass-50 text-brass-700 dark:bg-brass-900/25 dark:text-brass-300',
  inactive: 'bg-parchment-200 text-ink-500 dark:bg-ink-800 dark:text-parchment-300/70',
  new:      'bg-church-50 text-church-800 dark:bg-church-900/40 dark:text-brass-200',
}

const empty = { name: '', company: '', email: '', phone: '', notes: '', status: 'active', role: 'Member', tags: '', birth_date: '', joined_date: '', avatar: null }

/* ── Stat pill ── */
function StatPill({ icon: Icon, label, value, sub, accent, index }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.28 }}
      className="flex items-center gap-3 bg-parchment-50 dark:bg-ink-900/90 rounded-2xl px-5 py-4 border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md flex-1"
    >
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${accent}`}>
        <Icon size={17} className="text-parchment-50" />
      </div>
      <div>
        <p className="text-2xl font-black text-ink-900 dark:text-parchment-50 tracking-tight leading-none">{value ?? '—'}</p>
        <p className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mt-0.5">{label}</p>
        {sub && <p className="text-xs text-ink-400 dark:text-parchment-400/50">{sub}</p>}
      </div>
    </motion.div>
  )
}

/* ── Actions dropdown ── */
function ActionsMenu({ member, onEdit, onDelete, onView }) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])
  return (
    <div ref={ref} className="relative" onClick={e => e.stopPropagation()}>
      <motion.button
        onClick={() => setOpen(o => !o)}
        aria-label="Member actions"
        aria-expanded={open}
        className="p-1.5 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 rounded-lg hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors"
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: -4 }}
            transition={{ duration: 0.13 }}
            className="absolute right-0 mt-1 w-40 bg-parchment-50 dark:bg-ink-900 rounded-xl shadow-warm-lg border border-parchment-300/50 dark:border-brass-900/30 overflow-hidden z-30"
          >
            {[
              { icon: Eye,    label: t('mem.viewProfile'), action: () => { onView(member); setOpen(false) }, cls: '' },
              { icon: Pencil, label: t('mem.edit'),          action: () => { onEdit(member); setOpen(false) }, cls: '' },
              { icon: Trash2, label: t('mem.delete'),        action: () => { onDelete(member.id, member.name); setOpen(false) }, cls: 'text-rose-500 dark:text-rose-300' },
            ].map(({ icon: Icon, label, action, cls }) => (
              <button key={label} onClick={action} className={`flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm hover:bg-parchment-100 dark:hover:bg-ink-800 transition-colors ${cls || 'text-ink-700 dark:text-parchment-100'}`}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// Format a YYYY-MM-DD birth_date as "March 25" (no year). The year is
// often unknown/private and a feast-day overlap is what's interesting.
function fmtBirthMonthDay(iso, dateLocale) {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d).toLocaleDateString(dateLocale, { month: 'long', day: 'numeric' })
}

/* ── Slide-over panel ── */
function SlideOver({ member, onClose, onEdit }) {
  const { t, dateLocale } = useLocale()
  const tags = member?.tags ? member.tags.split(',').filter(Boolean) : []

  // Liturgical feast-day overlap for the member's birthday. We use
  // the ACTUAL birth year (not "this year") so the answer is
  // historically accurate: "Born on Easter Sunday, 1999" is true
  // because Easter actually fell that day that year. Year-rolled
  // would change every spring as Easter moves. Fixed-date feasts
  // (Christmas, Annunciation) read the same regardless.
  const [birthFeast, setBirthFeast] = useState(null)
  useEffect(() => {
    if (!member?.birth_date) { setBirthFeast(null); return }
    let cancelled = false
    fetch(apiUrl(`/api/liturgical?date=${member.birth_date}`))
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setBirthFeast(d?.feast_name ? d : null) })
      .catch(() => { if (!cancelled) setBirthFeast(null) })
    return () => { cancelled = true }
  }, [member?.birth_date])

  return (
    <AnimatePresence>
      {member && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className={`${scrimCls} z-40`} />
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 280 }}
            className="fixed right-0 top-0 h-full w-96 bg-parchment-50 dark:bg-ink-900 border-l border-parchment-300/60 dark:border-brass-900/30 shadow-warm-lg z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-parchment-300/50 dark:border-brass-900/30">
              <h2 className="font-bold text-ink-900 dark:text-parchment-50">{t('mem.profile')}</h2>
              <motion.button transition={{ duration: 0.15 }} onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50">
                <X size={18} />
              </motion.button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
              {/* Avatar + name */}
              <div className="flex flex-col items-center text-center gap-3">
                <MemberAvatar member={member} className="w-20 h-20" textClassName="text-2xl" />
                <div>
                  <h3 className="text-xl font-bold text-ink-900 dark:text-parchment-50">{member.name}</h3>
                  {member.company && <p className="text-sm text-ink-500 dark:text-parchment-300/70">{member.company}</p>}
                  <div className="flex items-center justify-center gap-2 mt-2 flex-wrap">
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full capitalize ${STATUS_COLORS[member.status] || STATUS_COLORS.active}`}>{statusLabel(t, member.status || 'active')}</span>
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-parchment-200 dark:bg-ink-800 text-ink-600 dark:text-parchment-200">{roleLabel(t, member.role || 'Member')}</span>
                  </div>
                </div>
              </div>

              {/* Contact */}
              <div className="space-y-3">
                <p className="text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-widest">{t('mem.contact')}</p>
                {[
                  { icon: Mail,      val: member.email,   label: 'Email' },
                  { icon: Phone,     val: member.phone,   label: 'Phone' },
                  { icon: Building2, val: member.company, label: t('mem.ministry') },
                ].map(({ icon: Icon, val, label }) => val ? (
                  <div key={label} className="flex items-center gap-3 text-sm">
                    <Icon size={14} className="text-ink-400 shrink-0" />
                    <span className="text-ink-700 dark:text-parchment-200">{val}</span>
                  </div>
                ) : null)}
              </div>

              {/* Tags */}
              {tags.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-widest">{t('mem.tags')}</p>
                  <div className="flex flex-wrap gap-2">
                    {tags.map(tg => (
                      <span key={tg} className={`text-xs font-semibold px-2.5 py-1 rounded-full ${TAG_COLORS[tg] || 'bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-200'}`}>{tagLabel(t, tg)}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Birthday + feast-day overlap. Hidden when no birth_date
                  is on file. The feast tag only shows when the date
                  is a named feast (Christmas, Annunciation, Easter
                  Sunday for that particular year, etc.) — Ordinary-
                  Time birthdays render just the date. */}
              {member.birth_date && (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-widest">{t('mem.birthday')}</p>
                  <div className="flex items-center gap-2 text-sm text-ink-700 dark:text-parchment-200">
                    <Calendar size={13} className="text-ink-400 shrink-0" />
                    <span>{fmtBirthMonthDay(member.birth_date, dateLocale)}</span>
                  </div>
                  {birthFeast?.feast_name && (
                    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-medium ${LIT_COLOR_TEXT[birthFeast.color] ?? LIT_COLOR_TEXT.White}`}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${LIT_COLOR_DOT[birthFeast.color] ?? 'bg-parchment-300'}`} />
                      <span>{t('mem.bornOn', { feast: birthFeast.feast_name })}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Notes */}
              {member.notes && (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-widest">{t('mem.notes')}</p>
                  <p className="text-sm text-ink-600 dark:text-parchment-300 leading-relaxed bg-parchment-100 dark:bg-ink-800 rounded-xl p-3">{member.notes}</p>
                </div>
              )}

              {/* Meta */}
              <div className="space-y-2">
                <p className="text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-widest">{t('mem.activity')}</p>
                <div className="flex items-center gap-2 text-sm text-ink-500 dark:text-parchment-300/70">
                  <Calendar size={13} />
                  <span>{t('mem.joined', { date: new Date(member.created_at).toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', year: 'numeric' }) })}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-ink-500 dark:text-parchment-300/70">
                  <Activity size={13} />
                  <span>{t('mem.updated', { ago: timeAgo(member.updated_at, t) })}</span>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-parchment-300/50 dark:border-brass-900/30 space-y-3">
              <CalendarSync clientId={member.id} clientName={member.name} />
              {/* Open full profile — Sprint M / M.2. Slide-over stays
                  the quick-view; the full route hosts donation history
                  and richer detail. */}
              <Link
                to={`/clients/${member.id}`}
                onClick={onClose}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-parchment-100 dark:hover:bg-ink-800/70 transition-colors"
              >
                {t('mem.openFull')} <ArrowRight size={14} />
              </Link>
              <AnimatedButton onClick={() => onEdit(member)} className="w-full flex items-center justify-center gap-2 bg-church-900 hover:bg-church-700 dark:bg-church-800 dark:hover:bg-church-700 text-parchment-50 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                <Pencil size={14} /> {t('mem.editMember')}
              </AnimatedButton>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

/* ── Main page ── */
export default function Clients() {
  const [clients, setClients]       = useState([])
  const [stats, setStats]           = useState(null)
  const [statsFailed, setStatsFailed] = useState(false)
  const [listFailed, setListFailed]   = useState(false)
  const [search, setSearch]         = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterRole, setFilterRole] = useState('')
  const [showForm, setShowForm]     = useState(false)
  const [editing, setEditing]       = useState(null)
  const [selected, setSelected]     = useState(null)
  const [form, setForm]             = useState(empty)
  const [loading, setLoading]       = useState(false)
  const [showImport, setShowImport] = useState(false)
  // Pagination (1.5). The list fetches a page at a time; "Load more"
  // appends the next page. `hasMore` is derived from whether the last
  // page came back full — a short page means we've hit the end.
  const [hasMore, setHasMore]       = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // The members list previously had NO loading state — `loading` above is
  // the form-submit flag. First paint therefore showed the empty state (or
  // "none found") for as long as the fetch took, which reads as "this
  // parish has no members" on exactly the page a secretary opens first.
  const [listLoading, setListLoading] = useState(true)
  const { canWrite } = useAuth()
  const toast = useToast()
  const ask = useConfirm()
  const { t, dateLocale } = useLocale()

  const PAGE_SIZE = 50

  useEffect(() => { fetchStats() }, [])
  // Any change to search/filters resets paging and refetches from the
  // top — the offset from a previous query would be meaningless against
  // a different result set.
  useEffect(() => { fetchClients() }, [search, filterStatus, filterRole])

  // Observed 27 Aug: a 500 here assigned the ERROR BODY to `stats`, which is
  // truthy, so the growth tile rendered the literal string "undefined%" and
  // the three count tiles went blank — a measurement that failed presented as
  // a measurement that came back empty. loadOne keeps `stats` null on
  // failure, which the tiles already render as "—", and the flag says why.
  async function fetchStats() {
    const { ok, data } = await loadOne(apiUrl('/api/clients/stats'))
    setStats(ok ? data : null)
    setStatsFailed(!ok)
  }

  // Fetch the first page. Replaces the list and recomputes hasMore.
  // `if (!res.ok) return` left `clients` at [] with no failure flag, so a
  // 500 rendered the full first-run card — "No members yet / Add your first
  // member" — underneath stat tiles reading the real total. Found by an
  // auditor 27 Aug, after the same cycle "fixed" fetchStats in this file and
  // left this one alone. Fixing the surface you were looking at is not the
  // same as fixing the page.
  async function fetchClients() {
    setListLoading(true)
    const params = new URLSearchParams()
    if (search)       params.set('search', search)
    if (filterStatus) params.set('status', filterStatus)
    if (filterRole)   params.set('role', filterRole)
    params.set('limit',  String(PAGE_SIZE))
    params.set('offset', '0')
    const { ok, data } = await loadList(apiUrl(`/api/clients?${params}`))
    setClients(data)
    setListFailed(!ok)
    // A full page implies there may be more; a short page is the end.
    setHasMore(ok && data.length === PAGE_SIZE)
    setListLoading(false)
  }

  // Fetch the next page and APPEND. Offset is the current row count so
  // it stays correct regardless of how many pages we've loaded.
  async function loadMoreClients() {
    if (loadingMore) return
    setLoadingMore(true)
    const params = new URLSearchParams()
    if (search)       params.set('search', search)
    if (filterStatus) params.set('status', filterStatus)
    if (filterRole)   params.set('role', filterRole)
    params.set('limit',  String(PAGE_SIZE))
    params.set('offset', String(clients.length))
    const { ok, data } = await loadList(apiUrl(`/api/clients?${params}`))
    // A silent return here is FAILED presented as NONE: the spinner
    // stops, no rows appear, and the person concludes they have reached
    // the end of their own records. Say it instead.
    if (!ok) { toast.error(t('mem.loadMoreFailed')); setLoadingMore(false); return }
    setClients(prev => [...prev, ...data])
    setHasMore(data.length === PAGE_SIZE)
    setLoadingMore(false)
  }

  function openAdd() { setEditing(null); setForm(empty); setShowForm(true) }

  // Onboarding deep-link (POL.3): arriving at /clients?new=1 (from the
  // Dashboard checklist or the Welcome page) opens the add-member form
  // straight away, so the first action is one click, not a hunt for the
  // button. Strip the param afterward so a refresh doesn't re-open it.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get('new')) {
      openAdd()
      const next = new URLSearchParams(searchParams)
      next.delete('new')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  function openEdit(c) {
    setEditing(c.id)
    setForm({
      name: c.name, company: c.company || '', email: c.email || '', phone: c.phone || '',
      notes: c.notes || '', status: c.status || 'active', role: c.role || 'Member', tags: c.tags || '',
      // Postgres DATE comes back as 'YYYY-MM-DD' or a Date — normalize to the date input's expected ISO slice.
      birth_date:  c.birth_date  ? String(c.birth_date).slice(0, 10) : '',
      joined_date: c.joined_date ? String(c.joined_date).slice(0, 10) : '',
      avatar:      c.avatar || null,
    })
    setSelected(null)
    setShowForm(true)
  }
  const field = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function save(e) {
    e.preventDefault(); setLoading(true)
    const method = editing ? 'PATCH' : 'POST'
    const url = editing ? apiUrl(`/api/clients/${editing}`) : apiUrl('/api/clients')
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      // Don't discard the user's input on a failed write. Keep the modal
      // open and surface the error so they can retry or fix the field
      // the server rejected, rather than silently losing their edit.
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error || t('err.save'))
        return
      }
      setShowForm(false); fetchClients(); fetchStats()
      if (!editing) celebrateFirstAction('member', toast)
    } catch (err) {
      toast.error(t('err.save'))
    } finally {
      setLoading(false)
    }
  }

  async function remove(id, name) {
    // Say what actually happens before it happens. Removing a member also
    // takes her attendance, her place on every group roster and her
    // availability — and leaves her baptism in the register without a
    // name to point at. All of it is captured and comes back together.
    if (!(await ask({
      title: t('mem.removeConfirm'),
      body: t('mem.removeBody'),
      confirmLabel: 'Remove member',
      recoverable: true,
    }))) return
    const res = await fetch(apiUrl(`/api/clients/${id}`), { method: 'DELETE' })
    if (!res.ok && res.status !== 204) { toast.error(t('err.save')); return }
    toast.success(t('vault.removedToast', { label: name || t('nav.Members') }))
    fetchClients(); fetchStats()
  }

  const inputCls = 'w-full border border-parchment-300/60 dark:border-brass-900/30 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brass-400/50 bg-parchment-100 dark:bg-ink-800/80 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50'
  const selectCls = inputCls + ' cursor-pointer'

  const statPills = [
    { icon: Users,     label: t('mem.total'),    value: stats?.total   ?? '—', accent: 'bg-church-900 dark:bg-church-700', index: 0 },
    { icon: TrendingUp,label: t('mem.newWeek'),    value: stats?.newWeek ?? '—', accent: 'bg-brass-700',                   index: 1 },
    { icon: UserCheck, label: t('mem.active'),   value: stats?.active  ?? '—', accent: 'bg-brass-700',                  index: 2 },
    { icon: Activity,  label: t('mem.growth'),           value: stats ? `${stats.growth > 0 ? '+' : ''}${stats.growth}%` : '—', accent: 'bg-ink-700', index: 3 },
  ]

  return (
    <PageWrapper className="max-w-6xl mx-auto space-y-6">

      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">{t('mem.title')}</h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">{t('mem.sub')}</p>
        </div>
        {canWrite && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-church-800 dark:text-brass-200 bg-parchment-100 dark:bg-ink-800/80 border border-parchment-300/60 dark:border-brass-900/30 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors"
          >
            <Upload size={15} /> {t('mem.importCsv')}
          </button>
          <AnimatedButton
            onClick={openAdd}
            className="flex items-center gap-2 bg-church-900 hover:bg-church-700 dark:bg-church-700 dark:hover:bg-church-600 text-parchment-50 px-5 py-2.5 rounded-xl text-sm font-bold shadow-warm-md  transition-colors"
          >
            <Plus size={16} /> {t('mem.addMember')}
          </AnimatedButton>
        </div>
        )}
      </motion.div>

      {/* Stats bar */}
      <div className="flex gap-4">
        {statPills.map(s => <StatPill key={s.label} {...s} />)}
      </div>
      {statsFailed && (
        <p role="status" className="-mt-1 text-xs text-amber-700 dark:text-amber-400">
          {t('mem.statsFailed')}
        </p>
      )}

      {/* Search + filters */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('mem.searchPh')}
            className="w-full pl-9 pr-4 py-2.5 border border-parchment-300/60 dark:border-brass-900/30 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brass-400/50 bg-parchment-50 dark:bg-ink-900/90 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 shadow-sm"
          />
        </div>
        <div className="relative">
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} aria-label={t('mem.allStatuses')} className="appearance-none pl-3 pr-8 py-2.5 border border-parchment-300/60 dark:border-brass-900/30 rounded-xl text-sm bg-parchment-50 dark:bg-ink-900/90 text-ink-700 dark:text-parchment-200 focus:outline-none focus:ring-2 focus:ring-brass-400/50 shadow-sm cursor-pointer">
            <option value="">{t('mem.allStatuses')}</option>
            {STATUSES.map(s => <option key={s} value={s}>{statusLabel(t, s)}</option>)}
          </select>
          <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
        </div>
        <div className="relative">
          <select value={filterRole} onChange={e => setFilterRole(e.target.value)} aria-label={t('mem.allRoles')} className="appearance-none pl-3 pr-8 py-2.5 border border-parchment-300/60 dark:border-brass-900/30 rounded-xl text-sm bg-parchment-50 dark:bg-ink-900/90 text-ink-700 dark:text-parchment-200 focus:outline-none focus:ring-2 focus:ring-brass-400/50 shadow-sm cursor-pointer">
            <option value="">{t('mem.allRoles')}</option>
            {ROLES.map(r => <option key={r} value={r}>{roleLabel(t, r)}</option>)}
          </select>
          <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
        </div>
      </motion.div>

      {/* Table or empty state — empty state only when there's truly
          nothing here, not when a filter narrowed everything away. */}
      {listLoading ? (
        <div className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden">
          <SkeletonRowList count={6} />
        </div>
      ) : !listFailed && !search && !filterStatus && !filterRole && clients.length === 0 ? (
        <EmptyState
          illustration={MembersIllustration}
          title={t('mem.emptyTitle')}
          body={t('mem.emptyBody')}
          action={canWrite ? { label: t('mem.addFirst'), onClick: openAdd } : null}
        />
      ) : (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[44rem]">
          <thead className="bg-parchment-100/80 dark:bg-ink-800/60 border-b border-parchment-300/50 dark:border-brass-900/25">
            <tr>
              {[t('mem.colMember'), t('mem.colRole'), t('mem.colContact'), t('mem.colTags'), t('mem.colJoined'), ''].map((h, hi) => (
                <th key={hi} className="text-left px-4 py-3.5 text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
            {clients.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-16 text-center text-ink-500 dark:text-parchment-300/70">
                {listFailed ? t('mem.listFailed') : t('mem.noneFound')}
              </td></tr>
            )}
            <AnimatePresence>
              {clients.map((c, i) => {
                const tags = c.tags ? c.tags.split(',').filter(Boolean) : []
                return (
                  <motion.tr
                    key={c.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 8 }}
                    transition={{ delay: i * 0.025, duration: 0.2 }}
                    onClick={() => setSelected(c)}
                    className="hover:bg-parchment-100 dark:hover:bg-ink-800/50 transition-colors cursor-pointer group"
                  >
                    {/* Member */}
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <MemberAvatar member={c} className="w-9 h-9" textClassName="text-xs" />
                        <div>
                          <p className="font-semibold text-ink-900 dark:text-parchment-50 leading-none">{c.name}</p>
                          {c.email && <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">{c.email}</p>}
                        </div>
                      </div>
                    </td>
                    {/* Role / Status */}
                    <td className="px-4 py-3.5">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-semibold text-ink-600 dark:text-parchment-200">{roleLabel(t, c.role || 'Member')}</span>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full w-fit capitalize ${STATUS_COLORS[c.status] || STATUS_COLORS.active}`}>{statusLabel(t, c.status || 'active')}</span>
                      </div>
                    </td>
                    {/* Contact */}
                    <td className="px-4 py-3.5">
                      <div className="space-y-0.5">
                        {c.phone && <p className="text-xs text-ink-500 dark:text-parchment-300/70 flex items-center gap-1.5"><Phone size={10} />{c.phone}</p>}
                        {c.company && <p className="text-xs text-ink-500 dark:text-parchment-300/70 flex items-center gap-1.5"><Building2 size={10} />{c.company}</p>}
                        {!c.phone && !c.company && <span className="text-xs text-ink-300 dark:text-parchment-400/50">—</span>}
                      </div>
                    </td>
                    {/* Tags */}
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap gap-1">
                        {tags.length > 0 ? tags.slice(0, 2).map(tg => (
                          <span key={tg} className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TAG_COLORS[tg] || 'bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-200'}`}>{tagLabel(t, tg)}</span>
                        )) : <span className="text-xs text-ink-300 dark:text-parchment-400/50">—</span>}
                        {tags.length > 2 && <span className="text-xs text-ink-500 dark:text-parchment-300/70">+{tags.length - 2}</span>}
                      </div>
                    </td>
                    {/* Joined */}
                    <td className="px-4 py-3.5 text-xs text-ink-500 dark:text-parchment-300/70">
                      {c.created_at ? new Date(c.created_at).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                    </td>
                    {/* Actions — viewers only see the row click-through */}
                    <td className="px-4 py-3.5">
                      {canWrite && (
                        <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                          <ActionsMenu member={c} onEdit={openEdit} onDelete={remove} onView={setSelected} />
                        </div>
                      )}
                    </td>
                  </motion.tr>
                )
              })}
            </AnimatePresence>
          </tbody>
        </table>
        </div>
      </motion.div>
      )}

      {/* Load more — only while the last page came back full. Appends
          the next page rather than replacing (1.5). */}
      {hasMore && clients.length > 0 && (
        <div className="flex justify-center">
          <button
            onClick={loadMoreClients}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-church-800 dark:text-brass-200 bg-parchment-100 dark:bg-ink-800/80 border border-parchment-300/60 dark:border-brass-900/30 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors disabled:opacity-50"
          >
            {loadingMore ? t('mem.loading') : t('mem.loadMore')}
          </button>
        </div>
      )}

      {/* Slide-over */}
      <SlideOver member={selected} onClose={() => setSelected(null)} onEdit={openEdit} />

      {/* Import CSV modal */}
      <AnimatePresence>
        {showImport && (
          <ImportMembersModal
            onClose={() => setShowImport(false)}
            onImported={() => { fetchClients(); fetchStats() }}
          />
        )}
      </AnimatePresence>

      {/* Add/Edit Modal */}
      <AnimatePresence>
        {showForm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={`${scrimCls} flex items-center justify-center z-50 p-4`}>
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 10 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="bg-parchment-50 dark:bg-ink-900 rounded-2xl shadow-warm-lg w-full max-w-lg border border-parchment-300/50 dark:border-brass-900/30 max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-parchment-300/50 dark:border-brass-900/30">
                <h2 className="font-bold text-ink-900 dark:text-parchment-50 text-lg">{editing ? t('mem.editMember') : t('mem.addNew')}</h2>
                <motion.button transition={{ duration: 0.15 }} onClick={() => setShowForm(false)} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50">
                  <X size={18} />
                </motion.button>
              </div>
              <form onSubmit={save} className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-2 uppercase tracking-wide">{t('mem.photo')}</label>
                  <AvatarUploader
                    value={form.avatar}
                    name={form.name}
                    onChange={(v) => setForm(f => ({ ...f, avatar: v }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-1.5 uppercase tracking-wide">{t('mem.fullName')} *</label>
                  <DictationInput value={form.name} onChange={field('name')} placeholder={t('mem.namePh')} className={inputCls} required />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-1.5 uppercase tracking-wide">{t('mem.role')}</label>
                    <select value={form.role} onChange={field('role')} className={selectCls}>
                      {ROLES.map(r => <option key={r} value={r}>{roleLabel(t, r)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-1.5 uppercase tracking-wide">{t('mem.statusLabel')}</label>
                    <select value={form.status} onChange={field('status')} className={selectCls}>
                      {STATUSES.map(s => <option key={s} value={s}>{statusLabel(t, s)}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-1.5 uppercase tracking-wide">{t('mem.ministryLabel')}</label>
                  <input value={form.company} onChange={field('company')} placeholder={t('mem.ministryPh')} aria-label={t('mem.ministryLabel')} className={inputCls} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-1.5 uppercase tracking-wide">{t('mem.email')}</label>
                    <input type="email" value={form.email} onChange={field('email')} placeholder="email@church.org" aria-label={t('mem.email')} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-1.5 uppercase tracking-wide">{t('mem.phone')}</label>
                    <input type="tel" value={form.phone} onChange={field('phone')} placeholder="(555) 000-0000" aria-label={t('mem.phone')} className={inputCls} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-1.5 uppercase tracking-wide">{t('mem.birthday')}</label>
                    <input type="date" value={form.birth_date} onChange={field('birth_date')} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-1.5 uppercase tracking-wide">{t('mem.joinedLabel')}</label>
                    <input type="date" value={form.joined_date} onChange={field('joined_date')} className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-2 uppercase tracking-wide flex items-center gap-1.5"><Tag size={11} /> {t('mem.tags')}</label>
                  <div className="flex flex-wrap gap-2">
                    {TAG_OPTIONS.map(tg => {
                      const active = (form.tags || '').split(',').includes(tg)
                      return (
                        <button
                          key={tg} type="button"
                          onClick={() => {
                            const current = form.tags ? form.tags.split(',').filter(Boolean) : []
                            const next = active ? current.filter(x => x !== tg) : [...current, tg]
                            setForm(f => ({ ...f, tags: next.join(',') }))
                          }}
                          className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-all ${active ? (TAG_COLORS[tg] || 'bg-parchment-200 text-ink-700') + ' border-transparent' : 'border-parchment-300/70 dark:border-white/[0.1] text-ink-500 dark:text-parchment-300/70 hover:border-brass-400/60'}`}
                        >
                          {tagLabel(t, tg)}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink-500 dark:text-parchment-300/70 mb-1.5 uppercase tracking-wide flex items-center gap-1.5"><FileText size={11} /> {t('mem.notes')}</label>
                  <AITextArea value={form.notes} onChange={field('notes')} placeholder={t('mem.notesPh')} context="Church member management" className={`${inputCls} resize-none`} rows={3} />
                </div>
                <div className="flex justify-end gap-3 pt-2 border-t border-parchment-300/50 dark:border-brass-900/30 mt-2">
                  <AnimatedButton type="button" onClick={() => setShowForm(false)} className="px-4 py-2.5 text-sm font-semibold text-ink-500 dark:text-parchment-300/70 hover:text-ink-800 dark:hover:text-parchment-50 transition-colors">{t('mem.cancel')}</AnimatedButton>
                  <AnimatedButton type="submit" disabled={loading} className="px-6 py-2.5 bg-church-900 hover:bg-church-700 dark:bg-church-700 dark:hover:bg-church-600 text-parchment-50 text-sm font-bold rounded-xl transition-colors disabled:opacity-50 shadow-warm-md">
                    {loading ? t('mem.saving') : editing ? t('mem.saveChanges') : t('mem.addMember')}
                  </AnimatedButton>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}
