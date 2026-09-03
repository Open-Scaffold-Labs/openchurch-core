import { useEffect, useState } from 'react'
import { Loader2, Send, RotateCcw, ShieldCheck } from 'lucide-react'
import { apiUrl } from '../api'
import { loadOne, postJson } from '../utils/format'
import LoadError from '../components/LoadError'

// The chancery's own people (PILOT.2).
//
// Two things are deliberate here.
//
// FIRST, nobody types anybody else's password. An invitation creates the
// account unusable and the person sets their own from a one-time link, so
// the administrator never holds a credential belonging to a colleague.
// The old flow — type a temporary password and pass it along — is what this
// page exists to replace.
//
// SECOND, pastoral leadership is presented as a SEPARATE question from the
// role, because it is one. The role says what somebody may do; pastoral
// leadership says whether they may read what a parish told the office in
// confidence. An operations admin frequently should not, and a canon who
// is only `staff` frequently should.

const ROLE_MEANS = {
  admin: 'Manages the account: invites people, changes roles, and grants pastoral leadership.',
  staff: 'Does the everyday work — Parish Care, follow-ups, reports.',
  viewer: 'Can read, and change nothing.',
}

export default function Team() {
  const [users, setUsers] = useState(null)
  const [form, setForm] = useState({ name: '', email: '', role: 'staff', pastoral_lead: false })
  const [invite, setInvite] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // `Array.isArray(d) ? d : []` swallowed a 500 too — an error body is not
  // an array, so a failed load rendered as a chancery with nobody in it,
  // including the person reading the screen.
  const [failed, setFailed] = useState(false)

  const load = async () => {
    setFailed(false)
    const { ok, data } = await loadOne(apiUrl('/api/users'))
    if (!ok || !Array.isArray(data)) { setFailed(true); setUsers([]); return }
    setUsers(data)
  }
  useEffect(() => { load() }, [])

  const send = async (e) => {
    e.preventDefault(); setError(''); setInvite(null); setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/users/invite'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Could not send that invitation'); return }
      setInvite({ ...d.invite, name: d.user.name })
      setForm({ name: '', email: '', role: 'staff', pastoral_lead: false })
      await load()
    } finally { setBusy(false) }
  }

  const resend = async (u) => {
    setError(''); setInvite(null)
    const res = await fetch(apiUrl(`/api/users/${u.id}/invite/resend`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d.error || 'Could not resend'); return }
    setInvite({ ...d.invite, name: u.name })
  }

  // This checkbox is an access-control decision: pastoral leadership is what
  // lets somebody read what a parish told the office in confidence. It threw
  // the response away, so a failed PATCH left the box in its new position
  // until the reload put it back — and an administrator who ticks a box,
  // sees it tick, and looks away has every reason to believe access was
  // granted or revoked when it wasn't. Say so instead.
  const setLead = async (u, next) => {
    setError('')
    const { ok, error } = await postJson(
      apiUrl(`/api/users/${u.id}/pastoral-lead`),
      { pastoral_lead: next },
      'PATCH',
    )
    if (!ok) {
      setError(`${error} ${u.name}'s access is unchanged — they ${u.pastoral_lead ? 'still have' : 'still do not have'} pastoral leadership.`)
      return
    }
    await load()
  }

  const input = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300 bg-parchment-50 text-ink-900 focus:outline-none focus:ring-2 focus:ring-brass-400'

  return (
    <div className="max-w-3xl">
      <h1 className="font-serif text-3xl font-bold text-church-600 mb-1">The chancery</h1>
      <p className="text-sm text-ink-500 mb-7">
        Who works here, and what each of them may see.
      </p>

      <section className="mb-9">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-3">Invite someone</h2>
        <form onSubmit={send} className="rounded-xl border border-parchment-300/70 bg-parchment-50 p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="inv-name" className="block text-[11px] font-semibold text-ink-500 mb-1">Name</label>
              <input id="inv-name" className={input} value={form.name} required
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label htmlFor="inv-email" className="block text-[11px] font-semibold text-ink-500 mb-1">Email</label>
              <input id="inv-email" type="email" className={input} value={form.email} required
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            </div>
          </div>

          <div>
            <label htmlFor="inv-role" className="block text-[11px] font-semibold text-ink-500 mb-1">Role</label>
            <select id="inv-role" className={input} value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
              <option value="staff">Staff</option>
              <option value="admin">Administrator</option>
              <option value="viewer">Viewer</option>
            </select>
            <p className="mt-1 text-[11.5px] text-ink-500 leading-relaxed">{ROLE_MEANS[form.role]}</p>
          </div>

          {/* A separate question from the role, on purpose. */}
          <div className="rounded-lg border border-parchment-300/60 bg-parchment-100/60 p-3">
            <label className="flex items-start gap-2 text-[13px] text-ink-800">
              <input type="checkbox" className="mt-0.5" checked={form.pastoral_lead}
                onChange={e => setForm(f => ({ ...f, pastoral_lead: e.target.checked }))} />
              <span>
                Pastoral leadership
                <span className="block text-[11.5px] text-ink-500 leading-relaxed mt-0.5">
                  May read the office’s internal notes about a parish, and print a brief
                  carrying contact details. Give this to the people who actually sit with
                  parishes — it is not a seniority marker, and it is not the same as
                  administering the account.
                </span>
              </span>
            </label>
          </div>

          <button type="submit" disabled={busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-church-600 text-parchment-50 text-sm font-semibold hover:bg-church-700 disabled:opacity-60">
            <Send size={14} /> Send the invitation
          </button>
          <p className="text-[11.5px] text-ink-400 leading-relaxed">
            They choose their own password. You will never see it.
          </p>
        </form>

        {error && <p className="mt-3 text-[13px] text-church-700">{error}</p>}

        {/* Until an email provider is picked, the link is shown so it can be
            passed along by hand. It is a one-time link, not a password —
            it dies when used, when reissued, or after seven days. */}
        {invite && (
          <div className="mt-3 rounded-xl border border-brass-300/60 bg-brass-50/50 p-4">
            <p className="text-[13px] text-ink-800 mb-2">
              Invitation ready for <span className="font-semibold">{invite.name}</span>.
              Send them this link — it stops working once used, and expires{' '}
              {String(invite.expires_at).slice(0, 10)}.
            </p>
            <code className="block text-[12px] text-ink-700 break-all bg-parchment-50 rounded-lg border border-parchment-300/70 p-2">
              {invite.url}
            </code>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-brass-600 mb-3">People</h2>
        {failed ? (
          <LoadError
            title="The team list didn't load."
            body="Don't invite from this screen until it does — the colleague you're about to add may already be here."
            onRetry={load}
          />
        ) : !users ? (
          <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-brass-500" /></div>
        ) : (
          <ul className="rounded-xl border border-parchment-300/70 divide-y divide-parchment-300/60 overflow-hidden">
            {users.map(u => (
              <li key={u.id} className="bg-parchment-50 px-4 py-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium text-ink-900">
                    {u.name}
                    {u.pending && (
                      <span className="ml-2 inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold bg-parchment-200/80 text-ink-600">
                        invitation not accepted yet
                      </span>
                    )}
                  </p>
                  <p className="text-[12px] text-ink-500 mt-0.5">
                    {[u.email, u.role,
                      u.pending && u.invited_by_name && `invited by ${u.invited_by_name}`,
                     ].filter(Boolean).join(' · ')}
                  </p>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <label className="flex items-center gap-1.5 text-[12px] text-ink-600">
                    <input type="checkbox" checked={u.pastoral_lead}
                      onChange={e => setLead(u, e.target.checked)} />
                    <ShieldCheck size={13} className="text-brass-600" aria-hidden="true" />
                    Pastoral leadership
                  </label>
                  {u.pending && (
                    <button type="button" onClick={() => resend(u)}
                      className="inline-flex items-center gap-1 text-[12px] text-church-700 hover:underline">
                      <RotateCcw size={12} /> Resend
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
