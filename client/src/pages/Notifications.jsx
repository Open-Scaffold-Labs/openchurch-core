import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Bell, Clock, AlertTriangle, Loader2 } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useAuth } from '../context/AuthContext'
import { apiUrl } from '../api'

// Notifications admin view (NV.1 / Sprint 2). Makes the notification
// pipeline legible: what's queued to go out, and what recently did.
// Admin-only — reads /api/admin/notifications/{scheduled,log}.

function humanizeType(t) {
  return String(t || '').replace(/_/g, ' ')
}

function fmtWhen(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

const STATUS_STYLES = {
  sent:     'bg-brass-100 text-brass-700 dark:bg-brass-900/30 dark:text-brass-300',
  stubbed:  'bg-church-100 text-church-800 dark:bg-church-900/40 dark:text-brass-200',
  skipped:  'bg-parchment-200 text-ink-500 dark:bg-ink-800 dark:text-parchment-300/70',
  failed:   'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
  pending:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
}

export default function Notifications() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [scheduled, setScheduled] = useState([])
  const [log, setLog]             = useState([])
  const [loading, setLoad]        = useState(true)
  const [err, setErr]             = useState('')

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    Promise.all([
      fetch(apiUrl('/api/admin/notifications/scheduled')).then(r => (r.ok ? r.json() : { scheduled: [] })),
      fetch(apiUrl('/api/admin/notifications/log')).then(r => (r.ok ? r.json() : { log: [] })),
    ])
      .then(([s, l]) => {
        if (cancelled) return
        setScheduled(s.scheduled ?? [])
        setLog(l.log ?? [])
      })
      .catch(() => { if (!cancelled) setErr("Couldn't load notifications. Nothing was lost — please retry.") })
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [isAdmin])

  if (!isAdmin) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState icon={AlertTriangle} title="Admins only"
            body="The notifications view is restricted to admins." />
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

  const Row = ({ left, type, status, when }) => (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-parchment-300/50 dark:border-brass-900/25 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 capitalize truncate">{humanizeType(type)}</p>
        <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 truncate">{left || '—'}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">{when}</span>
        {status && (
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLES[status] || ''}`}>
            {status}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <PageWrapper>
      <div className="max-w-3xl mx-auto space-y-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          <div className="flex items-center gap-2">
            <Bell size={18} className="text-brass-600 dark:text-brass-300" />
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">Notifications</h1>
          </div>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            What's queued to go out, and what recently did.
          </p>
        </motion.div>

        {err && <p className="text-sm text-rose-700 dark:text-rose-300">{err}</p>}

        {/* Upcoming */}
        <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <Clock size={14} className="text-brass-600 dark:text-brass-300" />
            <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">Upcoming</h2>
            <span className="text-xs text-ink-500 dark:text-parchment-300/70">({scheduled.length})</span>
          </div>
          {scheduled.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-500 dark:text-parchment-300/70">Nothing queued right now.</p>
          ) : (
            scheduled.map(s => (
              <Row key={s.id} type={s.notification_type} left={s.recipient_email} status={s.status} when={fmtWhen(s.send_at)} />
            ))
          )}
        </section>

        {/* Recent */}
        <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <Bell size={14} className="text-brass-600 dark:text-brass-300" />
            <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">Recent</h2>
            <span className="text-xs text-ink-500 dark:text-parchment-300/70">({log.length})</span>
          </div>
          {log.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-500 dark:text-parchment-300/70">Nothing sent yet.</p>
          ) : (
            log.map(l => (
              <Row key={l.id} type={l.notification_type} left={l.recipient_email} status={l.status} when={fmtWhen(l.created_at)} />
            ))
          )}
        </section>
      </div>
    </PageWrapper>
  )
}
