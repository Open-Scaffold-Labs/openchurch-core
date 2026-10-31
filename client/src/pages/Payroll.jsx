import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  DollarSign, Clock, Users, Plus, X, Trash2, Pencil,
  ChevronLeft, ChevronRight, MoreHorizontal, Briefcase,
  Calendar, AlertTriangle, TrendingUp, Loader2,
} from 'lucide-react'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip, scrimCls } from '../components/MobileSheet'
import { apiUrl } from '../api'
import LoadFailure from '../components/LoadFailure'
import { useLoad } from '../hooks/useLoad'
import { useLocale } from '../i18n'
import { initials } from '../utils/format'
import { toLocalISO } from '../utils/dates'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { useConfirm } from '../components/ConfirmProvider'
import { dialogMotionNow, drawerMotion, menuMotion } from '../utils/motion'

// ── Constants ─────────────────────────────────────────────────
const ROLES = ['Pastor', 'Associate Pastor', 'Worship Leader', 'Youth Director', 'Administrator', 'Facilities', 'Volunteer Coordinator', 'Media Tech', 'Staff']
const SHIFT_TYPES = ['service', 'event', 'admin', 'outreach', 'maintenance']

const SHIFT_TONE = 'bg-brass-50 text-brass-700 dark:bg-brass-900/20 dark:text-brass-300'
const SHIFT_COLORS = {
  service:     SHIFT_TONE,
  event:       SHIFT_TONE,
  admin:       'bg-amber-100  text-amber-700  dark:bg-amber-900/30  dark:text-amber-300',
  outreach:    SHIFT_TONE,
  maintenance: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
}

const AVATAR_COLORS = [
  'bg-church-600','bg-brass-700','bg-ink-700',
  'bg-church-800','bg-brass-800','bg-ink-600',
]
function avatarColor(name = '') {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % AVATAR_COLORS.length
  return AVATAR_COLORS[h]
}

// ── Date helpers ──────────────────────────────────────────────
function getMondayOf(date) {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  d.setHours(0, 0, 0, 0)
  return d
}
function addDays(date, n) {
  const d = new Date(date); d.setDate(d.getDate() + n); return d
}
// Local 'YYYY-MM-DD'. This is a money page and the value keys the pay
// week + the current-week check, so a UTC off-by-one would file a shift
// into the wrong week near midnight. Use the local-date helper (1.1).
function toDateStr(d) { return toLocalISO(d) }

// A week with no shifts is a real answer and prints $0.00. A week we could
// not read is not, and used to print $0.00 as well — `Number(n ?? 0)` turned
// every unread total into a confident zero, on the page that tells a parish
// what it owes people.
function fmtCurrency(n) {
  if (n == null) return '—'
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
function fmtHours(n) {
  if (n == null) return '—'
  const h = Number(n)
  if (!Number.isFinite(h)) return '—'
  return h === 1 ? '1 hr' : `${h % 1 === 0 ? h : h.toFixed(1)} hrs`
}

// ── Input class ───────────────────────────────────────────────
const inp = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400/40 placeholder-ink-400 dark:placeholder-parchment-400/50'

// ── Summary card ──────────────────────────────────────────────
function SummaryCard({ icon: Icon, label, value, sub, accent, index }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.28 }}
      className="relative overflow-hidden bg-parchment-50 dark:bg-ink-900/90 rounded-2xl p-6 border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md"
    >
      <div className={`absolute -top-6 -right-6 w-28 h-28 rounded-full blur-2xl opacity-10 dark:opacity-20 ${accent}`} />
      <div className="relative">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 shadow-md ${accent}`}>
          <Icon size={17} className="text-parchment-50" />
        </div>
        <p className="text-3xl font-black text-ink-900 dark:text-parchment-50 tracking-tighter">{value}</p>
        <p className="text-sm font-semibold text-ink-700 dark:text-parchment-100 mt-0.5">{label}</p>
        {sub && <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-1">{sub}</p>}
      </div>
    </motion.div>
  )
}

// ── Actions dropdown ──────────────────────────────────────────
function ActionsMenu({ onEdit, onAddShift, onDelete }) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  return (
    <div ref={ref} className="relative" onClick={e => e.stopPropagation()}>
      <motion.button
        onClick={() => setOpen(o => !o)}
        aria-label={t('pay.rowActions')}
        className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors"
      >
        <MoreHorizontal size={15} />
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            {...menuMotion}
            className="absolute right-0 mt-1 w-44 bg-parchment-50 dark:bg-ink-900 rounded-xl shadow-warm-lg border border-parchment-300/50 dark:border-brass-900/30 overflow-hidden z-30"
          >
            {[
              { icon: Pencil,   label: t('pay.editStaffShort'),  action: onEdit,     cls: '' },
              { icon: Clock,    label: t('pay.addShift'),   action: onAddShift, cls: '' },
              { icon: Trash2,   label: t('pay.remove'),      action: onDelete,   cls: 'text-rose-500 dark:text-rose-400' },
            ].map(({ icon: Ic, label, action, cls }) => (
              <button key={label} onClick={() => { action(); setOpen(false) }}
                className={`flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm hover:bg-parchment-100 dark:hover:bg-ink-800 transition-colors ${cls || 'text-ink-700 dark:text-parchment-100'}`}
              >
                <Ic size={13} /> {label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Staff modal ───────────────────────────────────────────────
// SP-031: a stored role outside ROLES (e.g. "Office Manager") has no
// <option>, so the browser showed the first one, "Pastor", as the role.
// The record's own role is always offered and stays selected.
function roleOptions(current) {
  return current && !ROLES.includes(current) ? [current, ...ROLES] : ROLES
}
function StaffModal({ staff, onClose, onSave }) {
  const { t } = useLocale()
  const [form, setForm] = useState(staff ?? { name: '', role: 'Staff', pay_rate: '', status: 'active' })
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }))
  return (
    <div className={sheetOverlayCls}>
      <motion.div {...dialogMotionNow()}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
          <h2 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 leading-snug">{staff ? t('pay.editStaff') : t('pay.addStaffMember')}</h2>
          <button onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('pay.fullName')}</label>
            <input value={form.name} onChange={f('name')} placeholder={t('pay.fullNamePh')} aria-label={t('pay.fullNamePh')} className={inp} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('pay.role')}</label>
              <select value={form.role ?? ''} onChange={f('role')} className={inp}>
                {roleOptions(form.role).map(r => <option key={r} value={r}>{t('pay.role.' + r) === 'pay.role.' + r ? r : t('pay.role.' + r)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('pay.status')}</label>
              <select value={form.status} onChange={f('status')} className={inp}>
                <option value="active">{t('pay.active')}</option>
                <option value="inactive">{t('pay.inactive')}</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('pay.hourlyRate')}</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 text-sm">$</span>
              <input type="number" min="0" step="0.01" value={form.pay_rate} onChange={f('pay_rate')}
                placeholder="0.00" aria-label="0.00" className={`${inp} pl-7`} />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-parchment-300/50 dark:border-brass-900/25">
          <button onClick={onClose} className="text-sm text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors px-3 py-1.5">{t('pay.cancel')}</button>
          <button onClick={() => onSave(form)} disabled={!form.name.trim()}
            className="px-5 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {staff ? t('pay.saveChanges') : t('pay.addStaff')}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

// ── Shift modal ───────────────────────────────────────────────
function ShiftModal({ staffList, prefillStaff, weekStart, onClose, onSave }) {
  const { t } = useLocale()
  const today = toDateStr(new Date())
  const [form, setForm] = useState({
    staff_id: prefillStaff?.id ?? '',
    date:     today,
    hours:    '',
    type:     'service',
    notes:    '',
  })
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }))
  const active = staffList.filter(s => s.status === 'active')
  return (
    <div className={sheetOverlayCls}>
      <motion.div {...dialogMotionNow()}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
          <h2 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 leading-snug">{t('pay.logShift')}</h2>
          <button onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('pay.staffMemberReq')}</label>
            <select value={form.staff_id} onChange={f('staff_id')} className={inp}>
              <option value="">— Select staff —</option>
              {active.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('pay.dateReq')}</label>
              <input type="date" value={form.date} onChange={f('date')} className={inp} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('pay.hoursReq')}</label>
              <input type="number" min="0.5" max="24" step="0.5" value={form.hours}
                onChange={f('hours')} placeholder={t('pay.hoursPh')} aria-label={t('pay.hoursPh')} className={inp} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('pay.shiftType')}</label>
            <div className="flex flex-wrap gap-2">
              {SHIFT_TYPES.map(st => (
                <button key={st} type="button" onClick={() => setForm(p => ({ ...p, type: st }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all capitalize ${
                    form.type === st
                      ? `${SHIFT_COLORS[st]} border-transparent`
                      : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70'
                  }`}
                >{t('pay.type.' + st)}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">{t('pay.notes')}</label>
            <input value={form.notes} onChange={f('notes')} placeholder={t('pay.notesPh')} aria-label={t('pay.notesPh')} className={inp} />
          </div>
        </div>
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-parchment-300/50 dark:border-brass-900/25">
          <button onClick={onClose} className="text-sm text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors px-3 py-1.5">{t('pay.cancel')}</button>
          <button onClick={() => onSave(form)}
            disabled={!form.staff_id || !form.date || !form.hours}
            className="px-5 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {t('pay.logShift')}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

// ── Shifts drawer ─────────────────────────────────────────────
// `shiftsUnread` rather than the load object: a drawer does not need to know
// how its data was fetched, only whether the emptiness in front of it is a
// fact or an unanswered question.
function ShiftsDrawer({ staff, shifts, onClose, onDelete, shiftsUnread, emptyText, unreadText }) {
  const { t } = useLocale()
  const staffShifts = shifts.filter(s => s.staff_id === staff.id)
  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose} className={`${scrimCls} z-40`}
      />
      <motion.div
        {...drawerMotion}
        className="fixed right-0 top-0 h-full w-96 bg-parchment-50 dark:bg-ink-900 border-l border-parchment-300/60 dark:border-brass-900/30 shadow-warm-lg z-50 flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-parchment-300/50 dark:border-brass-900/30">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-parchment-50 text-xs font-bold ${avatarColor(staff.name)}`}>
              {initials(staff.name)}
            </div>
            <div>
              <p className="font-bold text-ink-900 dark:text-parchment-50">{staff.name}</p>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70">{t('pay.shiftsLogged', { n: staffShifts.length })}</p>
            </div>
          </div>
          <button onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {staffShifts.length === 0 ? (
            <div className="text-center py-16 text-ink-500 dark:text-parchment-300/70 text-sm">
              {shiftsUnread ? unreadText : emptyText}
            </div>
          ) : (
            <div className="space-y-2">
              {staffShifts.map(sh => (
                <div key={sh.id} className="flex items-center justify-between bg-parchment-100 dark:bg-ink-800 rounded-xl px-4 py-3 group">
                  <div className="flex items-center gap-3">
                    <div className="text-center">
                      <p className="text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase">
                        {new Date(sh.date).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}
                      </p>
                      <p className="text-lg font-black text-ink-900 dark:text-parchment-50 leading-none">
                        {new Date(sh.date).toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' })}
                      </p>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${SHIFT_COLORS[sh.type] ?? SHIFT_COLORS.admin}`}>
                          {t('pay.type.' + (sh.type || 'admin'))}
                        </span>
                        <span className="text-xs font-semibold text-ink-700 dark:text-parchment-200">{fmtHours(sh.hours)}</span>
                      </div>
                      <p className="text-xs text-brass-700 dark:text-brass-300 font-bold mt-0.5">{fmtCurrency(sh.shift_pay)}</p>
                      {sh.notes && <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5 truncate">{sh.notes}</p>}
                    </div>
                  </div>
                  <button onClick={() => onDelete(sh.id)}
                    className="opacity-0 group-hover:opacity-100 text-ink-300 hover:text-rose-400 transition-all p-1 rounded"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-parchment-300/50 dark:border-brass-900/30 bg-parchment-100 dark:bg-ink-800/50">
          <div className="flex justify-between text-sm">
            <span className="text-ink-500 dark:text-parchment-300/70">{t('pay.totalHours')}</span>
            <span className="font-bold text-ink-900 dark:text-parchment-50">{fmtHours(staff.hours_worked)}</span>
          </div>
          <div className="flex justify-between text-sm mt-1">
            <span className="text-ink-500 dark:text-parchment-300/70">{t('pay.totalPay')}</span>
            <span className="font-black text-brass-700 dark:text-brass-300 text-base">{fmtCurrency(staff.total_pay)}</span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

// ── Main page ─────────────────────────────────────────────────
export default function Payroll() {
  const { t } = useLocale()
  const [weekStart, setWeekStart] = useState(() => getMondayOf(new Date()))
  const [staffModal, setStaffModal]   = useState(null)   // null | 'new' | staff obj
  const [shiftModal, setShiftModal]   = useState(null)   // null | { prefillStaff? }
  const [drawer, setDrawer]           = useState(null)   // staff obj
  const { canWrite } = useAuth()
  const toast = useToast()
  const ask = useConfirm()

  const weekEnd = addDays(weekStart, 6)
  const start   = toDateStr(weekStart)
  const end     = toDateStr(weekEnd)


  // Three reads, three answers. They rode one Promise.all with
  // `r.ok ? r.json() : []` on each and a bare `catch {}` around the lot, so
  // any failure produced an empty roster, an empty week and a null summary
  // — rendered as "$0.00" and "0 shifts logged", in silence.
  //
  // The week-nav behaviour the old code wanted (keep what is on screen while
  // the next week loads) is what the primitive calls stale, so it comes for
  // free instead of costing a flag.
  const readJson = (path) => async () => {
    const res = await fetch(apiUrl(path))
    if (!res.ok) throw new Error(`Failed (${res.status})`)
    return res.json()
  }
  const staffLoad   = useLoad(readJson(`/api/payroll/staff?start=${start}&end=${end}`),   [start, end])
  const shiftsLoad  = useLoad(readJson(`/api/payroll/shifts?start=${start}&end=${end}`),  [start, end], { initial: [] })
  // A summary of a week with nothing in it is still a summary, so this load
  // is never "empty" — emptiness belongs to the shift list.
  const summaryLoad = useLoad(readJson(`/api/payroll/summary?start=${start}&end=${end}`), [start, end], { isEmpty: () => false })

  const staff   = staffLoad.data ?? []
  const shifts  = shiftsLoad.data ?? []
  const summary = summaryLoad.state === 'failed' ? null : summaryLoad.data
  const initialLoading = staffLoad.state === 'loading' && shiftsLoad.state === 'loading'
  const load = async () => {
    await Promise.all([staffLoad.reload(), shiftsLoad.reload(), summaryLoad.reload()])
  }

  // Helper — handles fetch + non-OK response + network error in one
  // place so each callsite only worries about success-path effects.
  // Returns true if the request succeeded; false otherwise (after
  // alerting the user) so the caller can early-return.
  async function doWrite(url, method, body) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body:    body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      toast.error(t('pay.saveFailed'))
      return false
    }
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || `Request failed (${res.status})`)
      return false
    }
    return true
  }

  const handleSaveStaff = async (form) => {
    const isEdit = staffModal && staffModal !== 'new'
    const url    = isEdit ? apiUrl(`/api/payroll/staff/${staffModal.id}`) : apiUrl('/api/payroll/staff')
    const ok = await doWrite(url, isEdit ? 'PATCH' : 'POST', form)
    if (!ok) return
    setStaffModal(null); load()
  }

  const handleDeleteStaff = async (id) => {
    if (!(await ask({
      title: t('pay.removeStaffTitle'),
      body: t('pay.removeStaffBody'),
      confirmLabel: t('pay.removeStaffConfirm'),
    }))) return
    const ok = await doWrite(apiUrl(`/api/payroll/staff/${id}`), 'DELETE')
    if (!ok) return
    if (drawer?.id === id) setDrawer(null)
    load()
  }

  const handleSaveShift = async (form) => {
    const ok = await doWrite(apiUrl('/api/payroll/shifts'), 'POST', form)
    if (!ok) return
    setShiftModal(null); load()
  }

  const handleDeleteShift = async (id) => {
    if (!(await ask({ title: t('pay.deleteShiftTitle'), confirmLabel: t('pay.deleteShiftConfirm') }))) return
    const ok = await doWrite(apiUrl(`/api/payroll/shifts/${id}`), 'DELETE')
    if (!ok) return
    load()
  }

  // Week label
  const monthA = weekStart.toLocaleDateString('en-US', { month: 'short' })
  const monthB = weekEnd.toLocaleDateString('en-US', { month: 'short' })
  const weekLabel = monthA === monthB
    ? `${monthA} ${weekStart.getDate()} – ${weekEnd.getDate()}`
    : `${monthA} ${weekStart.getDate()} – ${monthB} ${weekEnd.getDate()}`

  const isCurrentWeek = toDateStr(getMondayOf(new Date())) === start

  return (
    <PageWrapper type="list">
      <div className="space-y-7">

        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-start justify-between gap-4 flex-wrap"
        >
          <PageHeader title={t('pay.title')} subtitle={t('pay.subtitle')} />
          <div className="flex items-center gap-3 flex-wrap">
            {/* Week nav */}
            <div className="flex items-center gap-1 bg-parchment-50 dark:bg-ink-900 border border-parchment-300/60 dark:border-brass-900/30 rounded-xl p-1 shadow-sm">
              <button onClick={() => setWeekStart(d => addDays(d, -7))} aria-label={t('pay.prevWeek')}
                className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
                <ChevronLeft size={16} />
              </button>
              <div className="px-3 py-1 text-center min-w-36">
                <p className="text-xs font-bold text-ink-900 dark:text-parchment-50">{weekLabel}</p>
                {isCurrentWeek && <p className="text-[11px] text-brass-600 dark:text-brass-300 font-semibold mt-0.5">{t('pay.currentWeek')}</p>}
              </div>
              <button onClick={() => setWeekStart(d => addDays(d, 7))} aria-label={t('pay.nextWeek')}
                className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
                <ChevronRight size={16} />
              </button>
            </div>
            {canWrite && (
              <>
                <button onClick={() => setShiftModal({})}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 text-ink-700 dark:text-parchment-100 text-sm font-semibold shadow-sm hover:bg-parchment-100 dark:hover:bg-ink-800 transition-colors"
                >
                  <Clock size={14} /> {t('pay.logShift')}
                </button>
                <button onClick={() => setStaffModal('new')}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 text-sm font-semibold shadow hover:opacity-90 transition-opacity"
                >
                  <Plus size={14} /> {t('pay.addStaff')}
                </button>
              </>
            )}
          </div>
        </motion.div>

        {initialLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
          </div>
        ) : (<>
        {/* What could not be read, said where the money is — not swallowed by
            a bare catch {} as it was. */}
        {summaryLoad.state === 'failed' && (
          <LoadFailure variant="strip" body={t('pay.summaryFailedBody')} cause={summaryLoad.error}
            onRetry={summaryLoad.reload} retrying={summaryLoad.retrying} className="mb-4" />
        )}
        {shiftsLoad.state === 'failed' && (
          <LoadFailure variant="strip" body={t('pay.shiftsFailedBody')} cause={shiftsLoad.error}
            onRetry={shiftsLoad.reload} retrying={shiftsLoad.retrying} className="mb-4" />
        )}
        {(summaryLoad.isStale || shiftsLoad.isStale || staffLoad.isStale) && (
          <LoadFailure variant="strip" body={t('load.staleBody')} onRetry={load} className="mb-4" />
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SummaryCard index={0} icon={DollarSign} label={t('pay.totalPayroll')}   accent="bg-brass-700"
            value={fmtCurrency(summary?.total_payroll)}
            sub={summary?.shift_count == null ? t('pay.shiftsUnknown') : `${t('pay.shiftsLogged', { n: summary.shift_count })}`}
          />
          <SummaryCard index={1} icon={Clock}      label={t('pay.hoursWorked')}    accent="bg-brass-700"
            value={fmtHours(summary?.total_hours)}
            sub={t('pay.weekOf', { range: weekLabel })}
          />
          <SummaryCard index={2} icon={Users}      label={t('pay.activeStaff')}    accent="bg-ink-700"
            value={summary?.staff_count ?? '—'}
            sub={t('pay.onRoster')}
          />
        </div>

        {/* Staff payroll table */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}
          className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
            <h2 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 leading-snug">{t('pay.staffBreakdown')}</h2>
            <span className="text-xs text-ink-500 dark:text-parchment-300/70">{weekLabel}</span>
          </div>

          {/* The roster is the third read, and was the one still saying
              "No staff yet" on a 500 while the tiles above showed real
              money. FAILED is its own branch; EMPTY is reachable only from
              a successful read. */}
          {staffLoad.state === 'failed' ? (
            <div className="px-5 py-5">
              <LoadFailure variant="strip" body={t('pay.staffFailedBody')} cause={staffLoad.error}
                onRetry={staffLoad.reload} retrying={staffLoad.retrying} />
            </div>
          ) : staffLoad.state === 'loading' ? (
            <div className="flex justify-center py-12">
              <Loader2 size={18} className="animate-spin text-church-700 dark:text-brass-300" aria-hidden="true" />
            </div>
          ) : staff.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <div className="w-14 h-14 rounded-2xl bg-church-50 dark:bg-church-900/40 flex items-center justify-center mb-4 text-church-800 dark:text-brass-300">
                <Briefcase size={22} />
              </div>
              <p className="font-display text-xl font-semibold text-ink-900 dark:text-parchment-50">{t('pay.noStaffTitle')}</p>
              <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70 max-w-md mx-auto leading-relaxed mb-5">
                {t('pay.noStaffBody')}
              </p>
              {canWrite && (
                <button onClick={() => setStaffModal('new')}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
                >
                  <Plus size={14} /> {t('pay.addFirstStaff')}
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-parchment-100/80 dark:bg-ink-800/60 border-b border-parchment-300/50 dark:border-brass-900/25">
                  <tr>
                    {[t('pay.colStaff'), t('pay.colRole'), t('pay.colHours'), t('pay.colRate'), t('pay.colTotalPay'), ''].map(h => (
                      <th key={h} className="text-left px-5 py-3 text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
                  <AnimatePresence>
                    {staff.map((s, i) => {
                      const hasHours = Number(s.hours_worked) > 0
                      return (
                        <motion.tr key={s.id}
                          initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 6 }} transition={{ delay: i * 0.03, duration: 0.2 }}
                          onClick={() => setDrawer(s)}
                          className="hover:bg-parchment-100/60 dark:hover:bg-ink-800/50 transition-colors cursor-pointer group"
                        >
                          {/* Name */}
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-parchment-50 text-xs font-bold shrink-0 ${avatarColor(s.name)}`}>
                                {initials(s.name)}
                              </div>
                              <div>
                                <p className="font-semibold text-ink-900 dark:text-parchment-50">{s.name}</p>
                                {s.status === 'inactive' && (
                                  <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">Inactive</span>
                                )}
                              </div>
                            </div>
                          </td>
                          {/* Role */}
                          <td className="px-5 py-4">
                            <span className="text-xs font-medium text-ink-500 dark:text-parchment-300/70 bg-parchment-200 dark:bg-ink-800 px-2.5 py-1 rounded-full">{s.role}</span>
                          </td>
                          {/* Hours */}
                          <td className="px-5 py-4">
                            <span className={`font-bold ${hasHours ? 'text-ink-900 dark:text-parchment-50' : 'text-ink-300 dark:text-parchment-400/50'}`}>
                              {hasHours ? fmtHours(s.hours_worked) : '—'}
                            </span>
                          </td>
                          {/* Rate */}
                          <td className="px-5 py-4 text-ink-500 dark:text-parchment-300/70 font-medium">
                            {Number(s.pay_rate) > 0 ? `$${Number(s.pay_rate).toFixed(2)}` : <span className="text-ink-300 dark:text-parchment-400/50">—</span>}
                          </td>
                          {/* Total pay */}
                          <td className="px-5 py-4">
                            <span className={`text-base font-black ${Number(s.total_pay) > 0 ? 'text-brass-700 dark:text-brass-300' : 'text-ink-300 dark:text-parchment-400/50'}`}>
                              {Number(s.total_pay) > 0 ? fmtCurrency(s.total_pay) : '—'}
                            </span>
                          </td>
                          {/* Actions */}
                          <td className="px-5 py-4">
                            <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                              <ActionsMenu
                                onEdit={() => setStaffModal(s)}
                                onAddShift={() => setShiftModal({ prefillStaff: s })}
                                onDelete={() => handleDeleteStaff(s.id)}
                              />
                            </div>
                          </td>
                        </motion.tr>
                      )
                    })}
                  </AnimatePresence>
                </tbody>
                {/* Totals footer */}
                {staff.some(s => Number(s.hours_worked) > 0) && (
                  <tfoot className="border-t-2 border-parchment-300/50 dark:border-brass-900/30 bg-parchment-100/50 dark:bg-ink-800/40">
                    <tr>
                      <td colSpan={2} className="px-5 py-3 text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">{t('pay.totals')}</td>
                      <td className="px-5 py-3 font-bold text-ink-900 dark:text-parchment-50">
                        {fmtHours(summary?.total_hours)}
                      </td>
                      <td className="px-5 py-3" />
                      <td className="px-5 py-3 text-base font-black text-brass-700 dark:text-brass-300">
                        {fmtCurrency(summary?.total_payroll)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </motion.div>

        {/* Recent shifts log */}
        {shifts.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}
            className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden"
          >
            <div className="px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
              <h2 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 leading-snug">{t('pay.shiftLog')}</h2>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">All shifts for {weekLabel}</p>
            </div>
            <div className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
              {shifts.map((sh, i) => (
                <motion.div key={sh.id}
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.025 }}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-parchment-100/60 dark:hover:bg-ink-800/50 transition-colors group"
                >
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-parchment-50 text-[11px] font-bold shrink-0 ${avatarColor(sh.staff_name)}`}>
                    {initials(sh.staff_name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{sh.staff_name}</span>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${SHIFT_COLORS[sh.type] ?? SHIFT_COLORS.admin}`}>{sh.type}</span>
                    </div>
                    {sh.notes && <p className="text-xs text-ink-500 dark:text-parchment-300/70 truncate">{sh.notes}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-ink-500 dark:text-parchment-300/70">
                      {new Date(sh.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}
                    </p>
                    <p className="text-xs font-bold text-ink-700 dark:text-parchment-200">{fmtHours(sh.hours)}</p>
                    <p className="text-xs font-bold text-brass-700 dark:text-brass-300">{fmtCurrency(sh.shift_pay)}</p>
                  </div>
                  <button onClick={() => handleDeleteShift(sh.id)}
                    className="opacity-0 group-hover:opacity-100 text-ink-300 hover:text-rose-400 transition-all p-1.5 rounded-lg hover:bg-parchment-200 dark:hover:bg-ink-800 ml-1 shrink-0"
                  >
                    <Trash2 size={13} />
                  </button>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
        </>)}
      </div>

      {/* Modals */}
      <AnimatePresence>
        {staffModal && (
          <StaffModal
            staff={staffModal === 'new' ? null : staffModal}
            onClose={() => setStaffModal(null)}
            onSave={handleSaveStaff}
          />
        )}
        {shiftModal !== null && (
          <ShiftModal
            staffList={staff}
            prefillStaff={shiftModal?.prefillStaff ?? null}
            weekStart={weekStart}
            onClose={() => setShiftModal(null)}
            onSave={handleSaveShift}
          />
        )}
      </AnimatePresence>

      {/* Shifts drawer */}
      {drawer && (
        <ShiftsDrawer
          staff={drawer}
          shifts={shifts}
          onClose={() => setDrawer(null)}
          onDelete={id => { handleDeleteShift(id); setDrawer(null) }}
          shiftsUnread={shiftsLoad.state === 'failed'}
          emptyText={t('pay.noShifts')}
          unreadText={t('pay.shiftsFailedBody')}
        />
      )}
    </PageWrapper>
  )
}
