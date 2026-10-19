import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, X, Loader2, Users2, Trash2, CalendarPlus, Check, UserPlus, Mail, Phone } from 'lucide-react'
import { apiUrl } from '../api'
import { loadList } from '../utils/format'
import { useLocale } from '../i18n'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import MemberPicker from '../components/MemberPicker'
import { useToast } from '../components/ToastProvider'
import { useConfirm } from '../components/ConfirmProvider'

// Anchor 4 / A4.2 — Groups admin UI.
//
// Single-page list + modal. Modal does both create and edit; member-
// roster changes inside the modal are diffed against the original
// roster on save and resolved via /:id/members add/remove calls (the
// PATCH endpoint only handles core group fields, not the roster).

const CATEGORIES = [
  { value: 'ministry',    label: 'Ministry'    },
  { value: 'life_group',  label: 'Life group'  },
  { value: 'small_group', label: 'Small group' },
  { value: 'committee',   label: 'Committee'   },
]
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.value, c.label]))
const CAT_TONE = {
  ministry:    'bg-church-100 dark:bg-church-900/40 text-church-800 dark:text-brass-200',
  life_group:  'bg-brass-100 dark:bg-brass-900/30 text-brass-800 dark:text-brass-200',
  small_group: 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200',
  committee:   'bg-rose-100 dark:bg-rose-900/30 text-rose-800 dark:text-rose-200',
}

const EMPTY_FORM = {
  name: '',
  category: 'ministry',
  description: '',
  leader_client_id: '',
  member_ids: [],
}

export default function Groups() {
  const { t } = useLocale()
  const [groups,    setGroups]    = useState([])
  const [members,   setMembers]   = useState([])
  const [membersFailed, setMembersFailed] = useState(false)
  const [groupsFailed, setGroupsFailed] = useState(false)
  const [interests, setInterests] = useState([]) // pending connect-card requests (CC.3)
  const [interestsFailed, setInterestsFailed] = useState(false)
  const [busyId,    setBusyId]    = useState(null) // interest id being approved/declined
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(null) // null | {} for create | full group for edit
  const toast = useToast()
  const navigate = useNavigate()
  // Overlapping reloads (save, approve, retry) each GET /api/groups.
  // Only the latest claim may paint. An older [] must not replace a newer list.
  const groupsLoadGen = useRef(0)

  const load = async () => {
    const gen = ++groupsLoadGen.current
    setLoading(true)
    try {
      const [gRes, roster, iRes] = await Promise.all([
        fetch(apiUrl('/api/groups')),
        // Members feed the group's picker — a bounded sample is enough, so
        // ask for the max (200) rather than relying on the /api/clients
        // endpoint's invisible safety cap. loadList refuses a 200 that is
        // not an array. `m.clients ?? []` used to turn `{}` into an empty
        // picker and leave membersFailed false.
        loadList(apiUrl('/api/clients?limit=200')),
        fetch(apiUrl('/api/connect?status=pending')),
      ])
      if (gen !== groupsLoadGen.current) return
      // A failed groups call left `groups` at [] and the page rendered
      // "No groups yet — Create your first ministry team". The only signal
      // was a toast, which is gone seconds later. Observed 27 Aug.
      // A 200 null used to throw on `.groups` and take that same path.
      // Non-OK is left unread: it is a failure, not an empty list.
      let g = null
      if (gRes.ok) {
        g = await gRes.json()
        if (gen !== groupsLoadGen.current) return
      }
      // A 200 null used to throw on `.interests` before the failure note,
      // so the page looked like nobody was waiting.
      let i = null
      if (iRes.ok) {
        i = await iRes.json()
        if (gen !== groupsLoadGen.current) return
      }
      // An empty roster here feeds the same MemberPicker as Events. A failed
      // call must not arrive there looking like a parish with no members.
      setMembersFailed(!roster.ok)
      setMembers(roster.data)
      // A 200 whose list is not a list is not an empty parish, and it must
      // not reach `.map`. A real empty list is an array.
      const groupsList = g && typeof g === 'object' && !Array.isArray(g) && Array.isArray(g.groups) ? g.groups : null
      setGroupsFailed(!gRes.ok || groupsList === null)
      setGroups(groupsList ?? [])
      const interestList = i && typeof i === 'object' && !Array.isArray(i) && Array.isArray(i.interests) ? i.interests : null
      setInterestsFailed(!iRes.ok || interestList === null)
      setInterests(interestList ?? [])
    } catch (err) {
      if (gen !== groupsLoadGen.current) return
      // A thrown read is the failure banner, not "No groups yet".
      setGroupsFailed(true)
      toast.error(t('err.load'))
    } finally {
      if (gen === groupsLoadGen.current) setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Approve a connect-card interest → links/creates the member and adds
  // them to the requested group (CC.1). Reload so group member counts
  // reflect the new join.
  const onApprove = async (interest) => {
    setBusyId(interest.id)
    try {
      const res = await fetch(apiUrl(`/api/connect/${interest.id}/approve`), { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Failed (${res.status})`)
      }
      setInterests(list => list.filter(i => i.id !== interest.id))
      toast.success(`${interest.name} added${interest.group_name ? ` to ${interest.group_name}` : ''}`)
      load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const onDecline = async (interest) => {
    setBusyId(interest.id)
    try {
      const res = await fetch(apiUrl(`/api/connect/${interest.id}/decline`), { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Failed (${res.status})`)
      }
      setInterests(list => list.filter(i => i.id !== interest.id))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const onOpenCreate = () => setModal({})

  const onOpenEdit = async (g) => {
    try {
      const res = await fetch(apiUrl(`/api/groups/${g.id}`))
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      setModal(await res.json())
    } catch (err) {
      toast.error(`Couldn't load group: ${err.message}`)
    }
  }

  return (
    <PageWrapper>
      <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-display text-ink-900 dark:text-parchment-50">
              Groups
            </h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
              Ministries, life groups, small groups, and committees.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenCreate}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity"
          >
            <Plus size={15} />
            New group
          </button>
        </div>

        {/* Connection requests (CC.3) — pending connect-card submissions
            from the public church page. Approving links/creates the
            member and adds them to the requested group. */}
        {interestsFailed && (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
            {t('load.failedBody')}
          </p>
        )}

        {interests.length > 0 && (
          <section className="rounded-2xl border border-brass-200/70 dark:border-brass-900/40 bg-gradient-to-br from-brass-50 to-parchment-50 dark:from-ink-900 dark:to-ink-900/80 shadow-warm p-4 md:p-5">
            <div className="flex items-center gap-2 mb-3">
              <UserPlus size={15} className="text-brass-700 dark:text-brass-300" />
              <h2 className="text-sm font-bold uppercase tracking-widest text-brass-700 dark:text-brass-300">
                Connection requests
              </h2>
              <span className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70">({interests.length})</span>
            </div>
            <ul className="space-y-2">
              {interests.map(it => (
                <li
                  key={it.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-ink-900 dark:text-parchment-50">{it.name}</p>
                      {it.group_name && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-church-100 dark:bg-church-900/40 text-church-800 dark:text-brass-200">
                          {it.group_name}
                        </span>
                      )}
                    </div>
                    {(it.email || it.phone) && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
                        {it.email && <span className="inline-flex items-center gap-1"><Mail size={11} /> {it.email}</span>}
                        {it.phone && <span className="inline-flex items-center gap-1"><Phone size={11} /> {it.phone}</span>}
                      </div>
                    )}
                    {it.message && (
                      <p className="mt-1 text-xs text-ink-600 dark:text-parchment-300/80 leading-snug">{it.message}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onApprove(it)}
                      disabled={busyId === it.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40"
                    >
                      {busyId === it.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => onDecline(it)}
                      disabled={busyId === it.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:text-rose-700 dark:hover:text-rose-300 transition-colors disabled:opacity-40"
                    >
                      <X size={12} /> Decline
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="animate-spin text-brass-600" size={28} />
          </div>
        ) : groupsFailed ? (
          <div role="status" className="flex items-start gap-3 rounded-2xl border border-amber-300/70 dark:border-amber-700/40 bg-amber-50/70 dark:bg-amber-900/15 px-5 py-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('load.failedTitle')}</p>
              <p className="text-sm text-ink-600 dark:text-parchment-300/80 mt-0.5">
                {t('load.failedBody')}
              </p>
            </div>
            <button onClick={load} className="shrink-0 text-sm font-medium text-church-700 dark:text-brass-300 underline min-h-[32px]">{t('error.tryAgain')}</button>
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={Users2}
            title="No groups yet"
            body="Create your first ministry team, life group, small group, or committee."
          />
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {groups.map(g => (
              <div
                key={g.id}
                className="flex flex-col bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden hover:border-church-400/50 transition-colors"
              >
                <button
                  type="button"
                  onClick={() => onOpenEdit(g)}
                  className="text-left p-4 flex-1"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-base font-bold text-ink-900 dark:text-parchment-50 truncate">
                        {g.name}
                      </h2>
                      {g.leader_name && (
                        <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
                          Leader: {g.leader_name}
                        </p>
                      )}
                    </div>
                    <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 ${CAT_TONE[g.category] || ''}`}>
                      {CAT_LABEL[g.category] || g.category}
                    </span>
                  </div>
                  {g.description && (
                    <p className="text-xs text-ink-600 dark:text-parchment-300/80 mt-2 line-clamp-2 leading-snug">
                      {g.description}
                    </p>
                  )}
                  <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 mt-2">
                    {g.member_count} member{g.member_count === 1 ? '' : 's'}
                  </p>
                </button>
                {/* Deep-link to the Schedule page's new-event modal with
                    this group pre-selected (A4.3). Kept outside the edit
                    button so the two actions don't nest. */}
                <div className="border-t border-parchment-300/50 dark:border-brass-900/25 px-4 py-2">
                  <button
                    type="button"
                    onClick={() => navigate(`/schedule?group=${g.id}&new=1`)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-church-800 dark:text-brass-300 hover:text-church-900 dark:hover:text-brass-200 transition-colors"
                  >
                    <CalendarPlus size={13} /> Create event for this group
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {modal && (
          <GroupModal
            group={modal}
            members={members}
            membersFailed={membersFailed}
            onClose={() => setModal(null)}
            onSaved={async () => { setModal(null); await load() }}
          />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}

function GroupModal({ group, members, membersFailed, onClose, onSaved }) {
  const { t } = useLocale()
  const isEdit = !!group?.id
  const [form, setForm] = useState(() => {
    if (!isEdit) return EMPTY_FORM
    return {
      name:             group.name             || '',
      category:         group.category         || 'ministry',
      description:      group.description      || '',
      leader_client_id: group.leader_client_id ?? '',
      member_ids:       (group.members ?? []).map(m => m.client_id),
    }
  })
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const ask = useConfirm()

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500'

  const handleSave = async () => {
    if (!form.name.trim()) return
    setBusy(true)
    try {
      const url    = isEdit ? `/api/groups/${group.id}` : '/api/groups'
      const method = isEdit ? 'PATCH' : 'POST'
      const body   = {
        name:             form.name.trim(),
        category:         form.category,
        description:      form.description || null,
        leader_client_id: form.leader_client_id ? Number(form.leader_client_id) : null,
      }
      // member_ids only on create — edit syncs through /members endpoints
      // so the diff between current and new roster is preserved.
      if (!isEdit) body.member_ids = form.member_ids

      const res = await fetch(apiUrl(url), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        toast.error(d.error || `Save failed (${res.status})`)
        setBusy(false); return
      }

      // Edit-mode roster diff. The PATCH above only touches core fields,
      // so we sync membership via paired add/remove calls. Each call's
      // status is checked — if any add/remove fails we surface an error
      // instead of falsely toasting "Group saved" while the roster is
      // half-applied.
      if (isEdit) {
        const before = new Set((group.members ?? []).map(m => m.client_id))
        const after  = new Set(form.member_ids)
        const toAdd = [...after].filter(id => !before.has(id))
        const toRem = [...before].filter(id => !after.has(id))
        let membershipOk = true
        for (const id of toAdd) {
          const r = await fetch(apiUrl(`/api/groups/${group.id}/members`), {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ client_id: id }),
          })
          if (!r.ok) membershipOk = false
        }
        for (const id of toRem) {
          const r = await fetch(apiUrl(`/api/groups/${group.id}/members/${id}`), { method: 'DELETE' })
          if (!r.ok && r.status !== 204) membershipOk = false
        }
        if (!membershipOk) {
          toast.error('Group details saved, but some roster changes failed — reopen to retry.')
          await onSaved()
          return
        }
      }

      toast.success(isEdit ? 'Group saved' : 'Group created')
      await onSaved()
    } catch (err) {
      toast.error("That didn't save — nothing was lost. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!isEdit) return
    if (!(await ask({
      title: `Remove “${group.name}”?`,
      body: 'The roster for this group goes with it. Everyone on it stays on your parish roster.',
      confirmLabel: 'Remove group',
      recoverable: true,
    }))) return
    setBusy(true)
    try {
      const res = await fetch(apiUrl(`/api/groups/${group.id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) {
        const d = await res.json().catch(() => ({}))
        toast.error(d.error || `Delete failed (${res.status})`)
        return
      }
      toast.success('Group deleted')
      await onSaved()
    } catch (err) {
      toast.error("That didn't save — nothing was lost. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center p-0 md:p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.18 }}
        className="w-full md:max-w-lg bg-parchment-50 dark:bg-ink-900 rounded-t-2xl md:rounded-2xl shadow-warm border border-parchment-300/60 dark:border-brass-900/30 max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25">
          <h2 className="font-bold text-ink-900 dark:text-parchment-50">
            {isEdit ? 'Edit group' : 'New group'}
          </h2>
          <button onClick={onClose} className="-m-2 p-2 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {membersFailed && (
            <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
              {t('mem.listFailed')}
            </p>
          )}
          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">
              Name *
            </label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g., Worship Team"
              className={inputCls}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">
                Category
              </label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className={inputCls}
              >
                {CATEGORIES.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">
                Leader
              </label>
              <select
                value={form.leader_client_id}
                onChange={e => setForm(f => ({ ...f, leader_client_id: e.target.value }))}
                className={inputCls}
              >
                <option value="">— No leader assigned —</option>
                {members.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name}{m.role ? ` · ${m.role}` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">
              Description
            </label>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={2}
              placeholder="Optional — purpose, meeting cadence, anything."
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1.5">
              Members
            </label>
            <MemberPicker
              failed={membersFailed}
              members={members}
              value={form.member_ids}
              onChange={ids => setForm(f => ({ ...f, member_ids: ids }))}
              placeholder="Search members to add to the group…"
            />
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-parchment-300/50 dark:border-brass-900/25">
          <div>
            {isEdit && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="text-xs font-medium text-rose-500 hover:text-rose-700 transition-colors flex items-center gap-1.5 disabled:opacity-40"
              >
                <Trash2 size={13} /> Delete
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors px-3 py-1.5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy || !form.name.trim()}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {busy ? 'Saving…' : (isEdit ? 'Save' : 'Create')}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
