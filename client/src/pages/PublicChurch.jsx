import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Clock, MapPin, Loader2, AlertTriangle, Calendar, ArrowRight, Users, Send, Check, Heart } from 'lucide-react'
import { apiUrl } from '../api'

// Public church homepage (Anchor 5 / A5.2). Unauthenticated — anyone
// with the URL sees the church's published homepage. Like the public
// events page, it renders outside the app shell so it reads as a
// church website, not a SaaS dashboard.
//
// URL: /p/:slug
// Data: GET /api/public/:slug/page  (gated on page_published server-
//       side — unpublished or unknown slug → 404 → "not found" view).
//
// Sections are fixed order (the "editable fixed page" model): hero +
// service times, about, location. Each renders only when its content
// exists, so a half-filled page still looks intentional.

// Service times are free text, one service per line. Blank lines are
// dropped so trailing newlines don't render as empty rows.
function splitLines(text) {
  if (!text) return []
  return String(text).split('\n').map(l => l.trim()).filter(Boolean)
}

// "Get connected" card (CC.2). Lets a visitor express interest in a
// ministry; the submission becomes a pending interest an admin approves
// (CC.1 backend) — never an auto-add. Fetches the church's groups for
// the picker; works as a general "reach out" form even if there are
// none. On success it swaps to a thank-you state rather than clearing,
// so a double-submit isn't tempting.
function ConnectCard({ slug }) {
  const [groups, setGroups] = useState([])
  const [form, setForm] = useState({ group_id: '', name: '', email: '', phone: '', message: '' })
  const [status, setStatus] = useState('idle') // idle | submitting | done
  const [error, setError] = useState('')

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    fetch(apiUrl(`/api/public/${slug}/groups`))
      .then(r => (r.ok ? r.json() : { groups: [] }))
      .then(d => { if (!cancelled) setGroups(d.groups ?? []) })
      .catch(() => { if (!cancelled) setGroups([]) })
    return () => { cancelled = true }
  }, [slug])

  const field = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim() || status === 'submitting') return
    setStatus('submitting'); setError('')
    try {
      const res = await fetch(apiUrl(`/api/public/${slug}/connect`), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_id: form.group_id || undefined,
          name:     form.name.trim(),
          email:    form.email.trim() || undefined,
          phone:    form.phone.trim() || undefined,
          message:  form.message.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Something went wrong (${res.status})`)
      }
      setStatus('done')
    } catch (err) {
      setError(err.message)
      setStatus('idle')
    }
  }

  const inputCls = 'w-full px-3 py-2.5 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-church-500'

  return (
    <section className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Users size={15} className="text-brass-600 dark:text-brass-300" />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200">
          Get connected
        </h2>
      </div>

      {status === 'done' ? (
        <div className="flex items-start gap-3 py-2">
          <span className="shrink-0 w-8 h-8 rounded-full bg-brass-100 dark:bg-brass-900/40 flex items-center justify-center text-brass-700 dark:text-brass-300">
            <Check size={16} />
          </span>
          <div>
            <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">Thanks for reaching out!</p>
            <p className="text-sm text-ink-600 dark:text-parchment-300/80 mt-0.5">
              Someone from the church will be in touch soon.
            </p>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-ink-600 dark:text-parchment-300/80 mb-4">
            New here or want to join a ministry? Leave your details and we&apos;ll reach out.
          </p>
          <form onSubmit={onSubmit} className="space-y-3">
            {groups.length > 0 && (
              <div>
                <label className="block text-xs font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">
                  I&apos;m interested in
                </label>
                <select value={form.group_id} onChange={field('group_id')} className={inputCls}>
                  <option value="">I&apos;m not sure yet</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            )}
            <input
              type="text"
              value={form.name}
              onChange={field('name')}
              placeholder="Your name *" aria-label="Your name *"
              className={inputCls}
            />
            <div className="grid sm:grid-cols-2 gap-3">
              <input type="email" value={form.email} onChange={field('email')} placeholder="Email" aria-label="Email" className={inputCls} />
              <input type="tel" value={form.phone} onChange={field('phone')} placeholder="Phone" aria-label="Phone" className={inputCls} />
            </div>
            <textarea
              value={form.message}
              onChange={field('message')}
              rows={3}
              placeholder="Anything you'd like us to know? (optional)" aria-label="Anything you'd like us to know? (optional)"
              className={`${inputCls} resize-none`}
            />
            {error && <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
            <button
              type="submit"
              disabled={!form.name.trim() || status === 'submitting'}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-40"
            >
              {status === 'submitting'
                ? <><Loader2 size={15} className="animate-spin" /> Sending…</>
                : <><Send size={15} /> Send</>}
            </button>
          </form>
        </>
      )}
    </section>
  )
}

export default function PublicChurch() {
  const { slug } = useParams()
  const [data, setData]    = useState(null)
  const [loading, setLoad] = useState(true)
  const [err, setErr]      = useState('')
  // Whether the church has active giving funds — gates the Give button
  // so we don't advertise giving before it's set up (GIV.2).
  const [hasGiving, setHasGiving] = useState(false)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    fetch(apiUrl(`/api/public/${slug}/funds`))
      .then(r => (r.ok ? r.json() : { funds: [] }))
      .then(d => { if (!cancelled) setHasGiving((d.funds ?? []).length > 0) })
      .catch(() => { if (!cancelled) setHasGiving(false) })
    return () => { cancelled = true }
  }, [slug])

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    fetch(apiUrl(`/api/public/${slug}/page`))
      .then(r => {
        if (r.status === 404) throw new Error('not-found')
        if (!r.ok) throw new Error(`Failed (${r.status})`)
        return r.json()
      })
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [slug])

  // Per-church browser title: this reads as the church's own website,
  // so the tab should carry the church name, not the product default.
  // Restore the neutral default on unmount so navigating away doesn't
  // leave a stale church name in the tab.
  useEffect(() => {
    const name = data?.church?.name
    if (name) document.title = name
    return () => { document.title = 'OpenChurch' }
  }, [data?.church?.name])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-parchment-50 dark:bg-ink-950">
        <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
      </div>
    )
  }

  if (err === 'not-found') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-parchment-50 dark:bg-ink-950">
        <div className="text-center max-w-md">
          <AlertTriangle size={28} className="mx-auto text-amber-600 dark:text-amber-300 mb-3" />
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            Church not found
          </h1>
          <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70">
            We couldn't find a published page at <span className="font-mono">/p/{slug}</span>. Double-check the link.
          </p>
        </div>
      </div>
    )
  }

  if (err || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-parchment-50 dark:bg-ink-950">
        <div className="text-center max-w-md">
          <AlertTriangle size={28} className="mx-auto text-rose-700 dark:text-rose-300 mb-3" />
          <h1 className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
            Couldn't load page
          </h1>
          <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70">{err}</p>
        </div>
      </div>
    )
  }

  const { church, page } = data
  const services = splitLines(page.service_times)
  const aboutParas = splitLines(page.about)
  const mapsUrl = page.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(page.address)}`
    : null

  return (
    <div className="min-h-screen bg-parchment-50 dark:bg-ink-950 px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
        className="w-full max-w-2xl mx-auto"
      >
        {/* Brand mark — same quiet 'powered by' cue as the events page. */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-church-900 dark:bg-brass-200 flex items-center justify-center shadow-warm">
            <svg width="16" height="20" viewBox="0 0 14 18" fill="currentColor" className="text-brass-200 dark:text-church-900">
              <rect x="5.5" y="0" width="3" height="18" rx="1" />
              <rect x="0" y="4" width="14" height="3" rx="1" />
            </svg>
          </div>
        </div>

        {/* ── Hero ── */}
        <header className="text-center mb-10">
          <h1 className="font-display text-4xl md:text-5xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
            {church.name}
          </h1>
          {page.tagline && (
            <p className="mt-4 text-lg md:text-xl text-ink-600 dark:text-parchment-200 font-display italic">
              {page.tagline}
            </p>
          )}
        </header>

        {/* ── Service times ── */}
        {services.length > 0 && (
          <section className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <Clock size={15} className="text-brass-600 dark:text-brass-300" />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200">
                Service times
              </h2>
            </div>
            <ul className="space-y-2">
              {services.map((line, i) => (
                <li key={i} className="text-base text-ink-800 dark:text-parchment-100">
                  {line}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── About ── */}
        {aboutParas.length > 0 && (
          <section className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200 mb-4">
              Welcome
            </h2>
            <div className="space-y-3">
              {aboutParas.map((para, i) => (
                <p key={i} className="text-base leading-relaxed text-ink-700 dark:text-parchment-200">
                  {para}
                </p>
              ))}
            </div>
          </section>
        )}

        {/* ── Location ── */}
        {page.address && (
          <section className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <MapPin size={15} className="text-brass-600 dark:text-brass-300" />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-700 dark:text-parchment-200">
                Find us
              </h2>
            </div>
            <p className="text-base text-ink-800 dark:text-parchment-100">{page.address}</p>
            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 mt-3 text-sm font-semibold text-church-800 dark:text-brass-300 hover:text-church-900 dark:hover:text-brass-200 transition-colors"
              >
                Get directions <ArrowRight size={14} />
              </a>
            )}
          </section>
        )}

        {/* ── Get connected (CC.2) ── */}
        <ConnectCard slug={slug} />

        {/* Primary actions — events feed, and giving when it's set up. */}
        <div className="flex flex-wrap items-center justify-center gap-3 mt-8">
          <Link
            to={`/p/${slug}/events`}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
          >
            <Calendar size={15} /> Upcoming events
          </Link>
          {hasGiving && (
            <Link
              to={`/p/${slug}/give`}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-church-900/30 dark:border-brass-300/40 text-church-900 dark:text-brass-200 text-sm font-semibold hover:bg-parchment-100 dark:hover:bg-ink-900/60 transition-colors"
            >
              <Heart size={15} /> Give
            </Link>
          )}
        </div>

        {/* Footer attribution — quiet */}
        <p className="mt-12 text-center text-[11px] text-ink-500 dark:text-parchment-300/50">
          Powered by OpenChurch
        </p>
      </motion.div>
    </div>
  )
}
