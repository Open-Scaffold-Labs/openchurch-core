import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Users, Plus, X, Loader2, Mail, Lock, User as UserIcon, Shield, Eye, AlertTriangle } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { SkeletonRowList } from '../components/Skeleton'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip } from '../components/MobileSheet'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import CalendarSync from '../components/CalendarSync'
import { useConfirm } from '../components/ConfirmProvider'
import ClosureReceipt from '../components/ClosureReceipt'

// Team-management page. Admin-only — the server enforces it on every
// /api/users request; this page just hides itself from non-admins via
// the sidebar filter, and renders a friendly Forbidden state if a
// non-admin somehow lands here directly.

const ROLES = [
  { value: 'admin',  label: 'Admin',  description: 'Full access' },
  { value: 'staff',  label: 'Staff',  description: 'Can edit data; no team or settings' },
  { value: 'viewer', label: 'Viewer', description: 'Read-only' },
]
const ROLE_PILL = {
  admin:  'bg-church-50 text-church-800 dark:bg-church-900/40 dark:text-brass-200',
  staff:  'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  viewer: 'bg-parchment-200 text-ink-600 dark:bg-ink-800/60 dark:text-parchment-200',
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function Team() {
  const { user: me } = useAuth()
  const { t } = useLocale()
  const ask = useConfirm()
  const [users,    setUsers]    = useState([])
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState('')
  const [showAdd,  setShowAdd]  = useState(false)
  const [turningOn, setTurningOn] = useState(null)
  const [closureNote, setClosureNote] = useState(null)
  const [closureBusy, setClosureBusy] = useState(null)
  // Each person whose restore response did not prove the new state keeps
  // their own unknown mark. Another person's attempt must not clear it,
  // and a retry must not clear it before that retry's own response.
  const [outcomeUnknown, setOutcomeUnknown] = useState(() => new Set())
  // Overlapping role-change and remove refetches each GET /api/users.
  // Only the latest claim may paint. An older [] must not win and say
  // "No team yet" after a newer list has already arrived.
  const usersLoadGen = useRef(0)

  async function fetchUsers() {
    const gen = ++usersLoadGen.current
    setLoading(true)
    setErr('')
    try {
      const res = await fetch(apiUrl('/api/users'))
      if (gen !== usersLoadGen.current) return
      if (res.status === 403) { setErr('You need admin access to view this page.'); setUsers([]); return }
      if (!res.ok) throw new Error(`Failed to load team (${res.status})`)
      const body = await res.json()
      if (gen !== usersLoadGen.current) return
      // A 200 that is not a list is not an empty team, and it must not
      // reach `.map`. Leave the people already on screen.
      if (!Array.isArray(body)) {
        setErr("Couldn't load the team. Nothing was lost — please retry.")
        return
      }
      // A null or id-less row is not a person. Mapping it throws on
      // u.id. Drop those rows. If nothing usable remains, this is a
      // failed read, not an empty team.
      const people = body.filter(row => row && row.id != null)
      if (people.length === 0 && body.length > 0) {
        setErr("Couldn't load the team. Nothing was lost — please retry.")
        return
      }
      // A current list establishes who is on the screen. It does not
      // establish the activation state of a person whose own restore
      // response was lost, so those unknown marks stay.
      setUsers(people)
    } catch (e) {
      if (gen !== usersLoadGen.current) return
      // A failed refetch is an error, not an empty team. Keep the rows.
      setErr("Couldn't load the team. Nothing was lost — please retry.")
    } finally {
      if (gen === usersLoadGen.current) setLoading(false)
    }
  }
  useEffect(() => { fetchUsers() }, [])

  async function changeRole(id, role) {
    setErr('')
    try {
      const res = await fetch(apiUrl(`/api/users/${id}/role`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "That didn't save — nothing was lost. Please try again.")
      fetchUsers()
    } catch (e) {
      setErr(e.message)
    }
  }

  async function reactivateUser(u) {
    if (!(await ask({
      title: t('team.turnOnTitle', { name: u.name }),
      body: t('team.turnOnBody'),
      confirmLabel: t('team.turnOnConfirm'),
    }))) return
    setErr('')
    setTurningOn(u.id)
    try {
      const res = await fetch(apiUrl(`/api/users/${u.id}/reactivate`), { method: 'POST' })
      let body = null
      try { body = await res.json() } catch { body = null }
      const provenOn = res.status === 200 && body &&
        (body.reactivated === true || (body.reactivated === false && body.already === true))
      if (!provenOn) {
        setOutcomeUnknown(current => {
          const next = new Set(current)
          next.add(u.id)
          return next
        })
        setErr(t('team.turnOnFailed'))
        return
      }
      setOutcomeUnknown(current => {
        if (!current.has(u.id)) return current
        const next = new Set(current)
        next.delete(u.id)
        return next
      })
      setUsers(list => list.map(row => row.id === u.id ? { ...row, deactivated: false } : row))
      fetchUsers()
    } catch {
      setOutcomeUnknown(current => {
        const next = new Set(current)
        next.add(u.id)
        return next
      })
      setErr(t('team.turnOnFailed'))
    } finally {
      setTurningOn(null)
    }
  }

  async function closeUser(u) {
    if (!(await ask({
      title: t('team.closeTitle', { name: u.name }),
      body: t('team.closeBody'),
      confirmLabel: t('team.closeConfirm'),
      tone: 'destructive',
    }))) return
    setErr('')
    setClosureBusy(u.id)
    setClosureNote(null)
    try {
      const res = await fetch(apiUrl(`/api/users/${u.id}/close`), { method: 'POST' })
      if (res.status === 409) {
        setErr(t('team.closeLastAdmin'))
        return
      }
      let body = null
      try { body = await res.json() } catch { body = null }
      if (res.status === 200 && body?.closed === true) {
        setClosureNote(body)
        fetchUsers()
        if (!Array.isArray(body.reviews)) await showClosure(u, true)
        return
      }
      setErr(t('team.closeFailed'))
    } catch {
      setErr(t('team.closeFailed'))
    } finally { setClosureBusy(null) }
  }

  async function showClosure(u, knownClosed = u.closed === true) {
    setErr('')
    setClosureBusy(u.id)
    try {
      const res = await fetch(apiUrl(`/api/users/${u.id}/closure`))
      const body = await res.json().catch(() => null)
      if (res.status === 200 && body?.closed === true) {
        setClosureNote(body)
        return
      }
      setErr(t(knownClosed ? 'team.receiptFailed' : 'team.closeFailed'))
    } catch {
      setErr(t(knownClosed ? 'team.receiptFailed' : 'team.closeFailed'))
    } finally { setClosureBusy(null) }
  }

  // Forbidden state — non-admins shouldn't see this page, but if they
  // navigate here directly the server returns 403 and we render a
  // helpful message rather than a blank list.
  if (err && err.includes('admin access')) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState
            icon={Shield}
            title="Admins only"
            body="Team management is restricted to admins. Ask an admin in your church to invite or update accounts on your behalf."
          />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Team</h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
              The people with login access to your workspace. Members of your church (parishioners, volunteers) live in the <span className="font-semibold">Members</span> page instead.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-bold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
          >
            <Plus size={16} /> Add team member
          </button>
        </motion.div>

        {/* Self-serve calendar feed — quietly renders nothing for team
            members not on the church's member roster. */}
        <CalendarSync selfServe />

        <ClosureReceipt receipt={closureNote} t={t} />

        {err && (
          <div role="alert" className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2 flex items-start gap-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>{err}</span>
          </div>
        )}

        {loading ? (
          <SkeletonRowList count={4} />
        ) : users.length === 0 ? (
          err ? null : (
          <EmptyState
            icon={Users}
            title="No team yet"
            body="Add your first teammate to share the workload — pastors, staff, or volunteer coordinators."
            action={{ label: 'Add team member', onClick: () => setShowAdd(true) }}
          />
          )
        ) : (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm-md overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[40rem]">
              <thead className="bg-parchment-100/60 dark:bg-ink-800/40 border-b border-parchment-300/60 dark:border-brass-900/30">
                <tr>
                  {['Name', 'Email', 'Role', 'Joined', ''].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-bold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
                {users.map(u => {
                  const isMe = me?.id === u.id
                  return (
                    <tr key={u.id} className="hover:bg-parchment-100/40 dark:hover:bg-ink-800/40 transition-colors">
                      <td className="px-4 py-3 font-medium text-ink-900 dark:text-parchment-50">
                        {u.closed ? t('team.formerOperator') : u.name}
                        {isMe && <span className="ml-2 text-[10px] font-semibold text-brass-600 dark:text-brass-300 uppercase tracking-wider">You</span>}
                        {outcomeUnknown.has(u.id) ? (
                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider bg-rose-50 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200">
                            {t('team.turnOnUnknownStatus')}
                          </span>
                        ) : u.closed ? (
                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider bg-rose-50 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200">
                            {t('team.loginClosed')}
                          </span>
                        ) : u.deactivated && (
                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider bg-rose-50 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200">
                            {t('team.loginOff')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-600 dark:text-parchment-300">{u.closed ? '—' : u.email}</td>
                      <td className="px-4 py-3">
                        <select
                          value={u.role}
                          onChange={e => changeRole(u.id, e.target.value)}
                          /* A role picker with no accessible name is announced
                             as just "combo box" — in a table of people, with
                             no way to hear WHOSE role is about to change. The
                             visible pill carries the value, not the subject,
                             so the name has to say the person. */
                          aria-label={`Role for ${u.closed ? t('team.formerOperator') : (u.name || u.email)}`}
                          disabled={u.closed || undefined}
                          className={`appearance-none px-3 py-1.5 rounded-lg text-xs font-semibold border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-brass-400 ${ROLE_PILL[u.role] ?? ROLE_PILL.viewer}`}
                        >
                          {ROLES.map(r => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-ink-500 dark:text-parchment-300/70">{fmtDate(u.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center justify-end gap-3">
                          {u.deactivated && !u.closed && (
                            <button
                              type="button"
                              onClick={() => reactivateUser(u)}
                              disabled={turningOn === u.id}
                              aria-busy={turningOn === u.id || undefined}
                              className="min-h-[44px] px-3 text-sm font-semibold text-church-800 dark:text-brass-200 underline-offset-2 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                              aria-label={t('team.turnOnName', { name: u.name })}
                            >
                              {turningOn === u.id ? t('team.turnOnSaving') : t('team.turnOn')}
                            </button>
                          )}
                          {u.closed ? (
                            <button
                              type="button"
                              onClick={() => showClosure(u)}
                              disabled={closureBusy !== null}
                              className="min-h-[44px] px-3 text-sm font-semibold text-church-800 dark:text-brass-200 underline-offset-2 hover:underline"
                            >
                              {t(closureBusy === u.id ? 'team.receiptLoading' : 'team.closureStatus')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => closeUser(u)}
                              disabled={closureBusy !== null}
                              className="min-h-[44px] px-3 text-sm font-semibold text-rose-800 dark:text-rose-200 underline-offset-2 hover:underline"
                              aria-label={t('team.closeName', { name: u.name })}
                            >
                              {t(closureBusy === u.id ? 'team.closeSaving' : 'team.closeConfirm')}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </motion.div>
        )}

        {/* Helpful footer */}
        <p className="text-xs text-ink-500 dark:text-parchment-300/60 leading-relaxed">
          New team members get a temporary password from you. They can change it at any time via <span className="font-mono">/forgot</span>. Email-based invites are coming once we wire up the email provider.
        </p>
      </div>

      <AnimatePresence>
        {showAdd && (
          <AddTeamMemberModal
            onClose={() => setShowAdd(false)}
            onCreated={() => { setShowAdd(false); fetchUsers() }}
          />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}

function AddTeamMemberModal({ onClose, onCreated }) {
  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [role,     setRole]     = useState('staff')
  const [loading,  setLoading]  = useState(false)
  const [err,      setErr]      = useState('')

  async function submit(e) {
    e.preventDefault()
    setErr('')
    if (password.length < 8) return setErr('Password must be at least 8 characters.')
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/users'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password, role }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "That didn't save — nothing was lost. Please try again.")
      onCreated()
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className={sheetOverlayCls}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={e => e.stopPropagation()}
        className={sheetPanelCls}
      >
        <MobileSheetGrip />
        <div className="flex items-center justify-between px-6 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
          <h2 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">Add team member</h2>
          <button type="button" onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:text-parchment-400/60 dark:hover:text-parchment-100">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">Name</label>
            <div className="relative">
              <UserIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 dark:text-parchment-400/60" />
              <input required value={name} onChange={e => setName(e.target.value)} placeholder="Pastor Jane Doe"
                className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-brass-400" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">Email</label>
            <div className="relative">
              <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 dark:text-parchment-400/60" />
              <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@yourchurch.com"
                className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-brass-400" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">Temporary password</label>
            <div className="relative">
              <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 dark:text-parchment-400/60" />
              <input type="text" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters"
                className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg bg-parchment-100 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-brass-400" />
            </div>
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/60">
              Share this with the new member out-of-band. They can change it via Forgot Password.
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">Role</label>
            <div className="grid grid-cols-3 gap-2">
              {ROLES.map(r => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setRole(r.value)}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors text-left ${
                    role === r.value
                      ? 'bg-church-900 dark:bg-church-700 text-parchment-50 border-church-900 dark:border-church-700 shadow-warm'
                      : 'bg-parchment-100 dark:bg-ink-800 border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-200 hover:bg-parchment-200 dark:hover:bg-ink-800/70'
                  }`}
                >
                  <div>{r.label}</div>
                  <div className={`mt-0.5 text-[10px] font-medium ${role === r.value ? 'text-parchment-200/80' : 'text-ink-500 dark:text-parchment-300/60'}`}>
                    {r.description}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {err && (
            <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-lg px-3 py-2">
              {err}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-parchment-300/60 dark:border-brass-900/30">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-semibold text-ink-500 hover:text-ink-800 dark:text-parchment-300/70 dark:hover:text-parchment-100 transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name || !email || !password}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              {loading ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  )
}

