import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  DollarSign, Clock, Users, Plus, X, Trash2, Pencil,
  ChevronLeft, ChevronRight, MoreHorizontal, Briefcase,
  Calendar, AlertTriangle, TrendingUp, Loader2,
} from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip, scrimCls } from '../components/MobileSheet'
import { apiUrl } from '../api'
import { initials } from '../utils/format'
import { toLocalISO } from '../utils/dates'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { useConfirm } from '../components/ConfirmProvider'

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

function fmtCurrency(n) {
  return Number(n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
function fmtHours(n) {
  const h = Number(n ?? 0)
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
        aria-label="Row actions"
        className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors"
      >
        <MoreHorizontal size={15} />
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: -4 }} transition={{ duration: 0.12 }}
            className="absolute right-0 mt-1 w-44 bg-parchment-50 dark:bg-ink-900 rounded-xl shadow-warm-lg border border-parchment-300/50 dark:border-brass-900/30 overflow-hidden z-30"
          >
            {[
              { icon: Pencil,   label: 'Edit Staff',  action: onEdit,     cls: '' },
              { icon: Clock,    label: 'Add Shift',   action: onAddShift, cls: '' },
              { icon: Trash2,   label: 'Remove',      action: onDelete,   cls: 'text-rose-500 dark:text-rose-400' },
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
function StaffModal({ staff, onClose, onSave }) {
  const [form, setForm] = useState(staff ?? { name: '', role: 'Staff', pay_rate: '', status: 'active' })
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }))
  return (
    <div className={sheetOverlayCls}>
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.18 }}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
          <h2 className="font-bold text-ink-900 dark:text-parchment-50">{staff ? 'Edit Staff Member' : 'Add Staff Member'}</h2>
          <button onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Full Name *</label>
            <input value={form.name} onChange={f('name')} placeholder="e.g. James Rivera" aria-label="e.g. James Rivera" className={inp} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Role</label>
              <select value={form.role} onChange={f('role')} className={inp}>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Status</label>
              <select value={form.status} onChange={f('status')} className={inp}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Hourly Pay Rate ($)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 text-sm">$</span>
              <input type="number" min="0" step="0.01" value={form.pay_rate} onChange={f('pay_rate')}
                placeholder="0.00" aria-label="0.00" className={`${inp} pl-7`} />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-parchment-300/50 dark:border-brass-900/25">
          <button onClick={onClose} className="text-sm text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors px-3 py-1.5">Cancel</button>
          <button onClick={() => onSave(form)} disabled={!form.name.trim()}
            className="px-5 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {staff ? 'Save Changes' : 'Add Staff'}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

// ── Shift modal ───────────────────────────────────────────────
function ShiftModal({ staffList, prefillStaff, weekStart, onClose, onSave }) {
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
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.18 }}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
          <h2 className="font-bold text-ink-900 dark:text-parchment-50">Log Shift</h2>
          <button onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Staff Member *</label>
            <select value={form.staff_id} onChange={f('staff_id')} className={inp}>
              <option value="">— Select staff —</option>
              {active.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Date *</label>
              <input type="date" value={form.date} onChange={f('date')} className={inp} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Hours Worked *</label>
              <input type="number" min="0.5" max="24" step="0.5" value={form.hours}
                onChange={f('hours')} placeholder="e.g. 4" aria-label="e.g. 4" className={inp} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Shift Type</label>
            <div className="flex flex-wrap gap-2">
              {SHIFT_TYPES.map(t => (
                <button key={t} type="button" onClick={() => setForm(p => ({ ...p, type: t }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all capitalize ${
                    form.type === t
                      ? `${SHIFT_COLORS[t]} border-transparent`
                      : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70'
                  }`}
                >{t}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">Notes</label>
            <input value={form.notes} onChange={f('notes')} placeholder="Optional details" aria-label="Optional details" className={inp} />
          </div>
        </div>
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-parchment-300/50 dark:border-brass-900/25">
          <button onClick={onClose} className="text-sm text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors px-3 py-1.5">Cancel</button>
          <button onClick={() => onSave(form)}
            disabled={!form.staff_id || !form.date || !form.hours}
            className="px-5 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            Log Shift
          </button>
        </div>
      </motion.div>
    </div>
  )
}

// ── Shifts drawer ─────────────────────────────────────────────
function ShiftsDrawer({ staff, shifts, onClose, onDelete }) {
  const staffShifts = shifts.filter(s => s.staff_id === staff.id)
  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose} className={`${scrimCls} z-40`}
      />
      <motion.div
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 280 }}
        className="fixed right-0 top-0 h-full w-96 bg-parchment-50 dark:bg-ink-900 border-l border-parchment-300/60 dark:border-brass-900/30 shadow-warm-lg z-50 flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-parchment-300/50 dark:border-brass-900/30">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-parchment-50 text-xs font-bold ${avatarColor(staff.name)}`}>
              {initials(staff.name)}
            </div>
            <div>
              <p className="font-bold text-ink-900 dark:text-parchment-50">{staff.name}</p>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70">{staffShifts.length} shifts this period</p>
            </div>
          </div>
          <button onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {staffShifts.length === 0 ? (
            <div className="text-center py-16 text-ink-500 dark:text-parchment-300/70 text-sm">No shifts logged this period.</div>
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
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${SHIFT_COLORS[sh.type] ?? SHIFT_COLORS.admin}`}>
                          {sh.type}
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
            <span className="text-ink-500 dark:text-parchment-300/70">Total Hours</span>
            <span className="font-bold text-ink-900 dark:text-parchment-50">{fmtHours(staff.hours_worked)}</span>
          </div>
          <div className="flex justify-between text-sm mt-1">
            <span className="text-ink-500 dark:text-parchment-300/70">Total Pay</span>
            <span className="font-black text-brass-700 dark:text-brass-300 text-base">{fmtCurrency(staff.total_pay)}</span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

// ── Main page ─────────────────────────────────────────────────
export default function Payroll() {
  const [weekStart, setWeekStart] = useState(() => getMondayOf(new Date()))
  const [staff, setStaff]         = useState([])
  const [shifts, setShifts]       = useState([])
  const [summary, setSummary]     = useState(null)
  const [staffModal, setStaffModal]   = useState(null)   // null | 'new' | staff obj
  const [shiftModal, setShiftModal]   = useState(null)   // null | { prefillStaff? }
  const [drawer, setDrawer]           = useState(null)   // staff obj
  const { canWrite } = useAuth()
  const toast = useToast()
  const ask = useConfirm()

  const weekEnd = addDays(weekStart, 6)
  const start   = toDateStr(weekStart)
  const end     = toDateStr(weekEnd)

  // Loading guard for the very first fetch only — week-nav reloads
  // keep existing data visible to avoid flicker between week clicks.
  const [initialLoading, setInitialLoading] = useState(true)

  const load = async () => {
    try {
      const [staffData, shiftsData, summaryData] = await Promise.all([
        fetch(apiUrl(`/api/payroll/staff?start=${start}&end=${end}`)).then(r => r.ok ? r.json() : []),
        fetch(apiUrl(`/api/payroll/shifts?start=${start}&end=${end}`)).then(r => r.ok ? r.json() : []),
        fetch(apiUrl(`/api/payroll/summary?start=${start}&end=${end}`)).then(r => r.ok ? r.json() : null),
      ])
      setStaff(staffData)
      setShifts(shiftsData)
      setSummary(summaryData)
    } catch {}
    setInitialLoading(false)
  }

  useEffect(() => { load() }, [start, end])

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
      toast.error("That didn't save — nothing was lost. Please try again.")
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
      title: 'Remove this staff member?',
      body: 'Every shift logged for them is removed as well.',
      confirmLabel: 'Remove staff member',
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
    if (!(await ask({ title: 'Delete this shift?', confirmLabel: 'Delete shift' }))) return
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
    <PageWrapper>
      <div className="space-y-7">

        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-start justify-between gap-4 flex-wrap"
        >
          <div>
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Payroll</h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">Track staff hours and calculate pay.</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Week nav */}
            <div className="flex items-center gap-1 bg-parchment-50 dark:bg-ink-900 border border-parchment-300/60 dark:border-brass-900/30 rounded-xl p-1 shadow-sm">
              <button onClick={() => setWeekStart(d => addDays(d, -7))} aria-label="Previous week"
                className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
                <ChevronLeft size={16} />
              </button>
              <div className="px-3 py-1 text-center min-w-36">
                <p className="text-xs font-bold text-ink-900 dark:text-parchment-50">{weekLabel}</p>
                {isCurrentWeek && <p className="text-[10px] text-brass-600 dark:text-brass-300 font-semibold mt-0.5">Current Week</p>}
              </div>
              <button onClick={() => setWeekStart(d => addDays(d, 7))} aria-label="Next week"
                className="p-1.5 rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 hover:bg-parchment-200 dark:hover:bg-ink-800 transition-colors">
                <ChevronRight size={16} />
              </button>
            </div>
            {canWrite && (
              <>
                <button onClick={() => setShiftModal({})}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 text-ink-700 dark:text-parchment-100 text-sm font-semibold shadow-sm hover:bg-parchment-100 dark:hover:bg-ink-800 transition-colors"
                >
                  <Clock size={14} /> Log Shift
                </button>
                <button onClick={() => setStaffModal('new')}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 text-sm font-semibold shadow hover:opacity-90 transition-opacity"
                >
                  <Plus size={14} /> Add Staff
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
        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SummaryCard index={0} icon={DollarSign} label="Total Payroll"   accent="bg-brass-700"
            value={fmtCurrency(summary?.total_payroll)}
            sub={`${summary?.shift_count ?? 0} shifts logged`}
          />
          <SummaryCard index={1} icon={Clock}      label="Hours Worked"    accent="bg-brass-700"
            value={fmtHours(summary?.total_hours)}
            sub={`Week of ${weekLabel}`}
          />
          <SummaryCard index={2} icon={Users}      label="Active Staff"    accent="bg-ink-700"
            value={summary?.staff_count ?? '—'}
            sub="On payroll roster"
          />
        </div>

        {/* Staff payroll table */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}
          className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
            <h2 className="font-bold text-ink-900 dark:text-parchment-50">Staff Breakdown</h2>
            <span className="text-xs text-ink-500 dark:text-parchment-300/70">{weekLabel}</span>
          </div>

          {staff.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <div className="w-14 h-14 rounded-2xl bg-church-50 dark:bg-church-900/40 flex items-center justify-center mb-4 text-church-800 dark:text-brass-300">
                <Briefcase size={22} />
              </div>
              <p className="font-display text-xl font-semibold text-ink-900 dark:text-parchment-50">No staff yet</p>
              <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70 max-w-md mx-auto leading-relaxed mb-5">
                Add the people who help your church run. Hours and pay rates roll up here so payroll stays a quick weekly close.
              </p>
              {canWrite && (
                <button onClick={() => setStaffModal('new')}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
                >
                  <Plus size={14} /> Add your first staff member
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-parchment-100/80 dark:bg-ink-800/60 border-b border-parchment-300/50 dark:border-brass-900/25">
                  <tr>
                    {['Staff Member', 'Role', 'Hours', 'Rate / hr', 'Total Pay', ''].map(h => (
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
                                  <span className="text-[10px] text-ink-500 dark:text-parchment-300/70">Inactive</span>
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
                      <td colSpan={2} className="px-5 py-3 text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">Totals</td>
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
              <h2 className="font-bold text-ink-900 dark:text-parchment-50">Shift Log</h2>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">All shifts for {weekLabel}</p>
            </div>
            <div className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
              {shifts.map((sh, i) => (
                <motion.div key={sh.id}
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.025 }}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-parchment-100/60 dark:hover:bg-ink-800/50 transition-colors group"
                >
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-parchment-50 text-[10px] font-bold shrink-0 ${avatarColor(sh.staff_name)}`}>
                    {initials(sh.staff_name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{sh.staff_name}</span>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${SHIFT_COLORS[sh.type] ?? SHIFT_COLORS.admin}`}>{sh.type}</span>
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
        />
      )}
    </PageWrapper>
  )
}
