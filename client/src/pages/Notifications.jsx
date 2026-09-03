import { motion } from 'framer-motion'
import { Bell, Clock, AlertTriangle, Loader2 } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadState from '../components/LoadState'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { useLoad } from '../hooks/useLoad'
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

// 'sent' means the provider accepted it. 'delivered' means it arrived —
// a distinction the log could not previously draw, which is how a column
// of reassuring 'sent' badges came to sit against an address that had not
// accepted mail in a year. Bounced and complained are the corrections a
// delivery webhook writes back; suppressed is a send withheld before it
// was attempted, and it reads muted rather than alarming because nothing
// went wrong this time — the address was already known to be dead.
const STATUS_STYLES = {
  sent:       'bg-brass-100 text-brass-700 dark:bg-brass-900/30 dark:text-brass-300',
  delivered:  'bg-brass-200 text-brass-800 dark:bg-brass-900/50 dark:text-brass-200',
  stubbed:    'bg-church-100 text-church-800 dark:bg-church-900/40 dark:text-brass-200',
  skipped:    'bg-parchment-200 text-ink-500 dark:bg-ink-800 dark:text-parchment-300/70',
  suppressed: 'bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-200',
  failed:     'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
  bounced:    'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
  complained: 'bg-rose-200 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200',
  pending:    'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
}

// An unknown status must still LOOK like a badge. Falling through to no
// classes renders the word as bare text, which reads as a rendering bug
// rather than as a status the client has not been taught yet.
const FALLBACK_STATUS_STYLE = 'bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-200'

export default function Notifications() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const { t } = useLocale()

  // Two panels, two reads, two independent answers — which is the whole of
  // partial failure. `r.ok ? r.json() : { scheduled: [] }` used to turn a
  // 500 on either endpoint into "Nothing queued right now.", and the .catch
  // only fired for a network or parse error, so the commonest failure was
  // also the quietest one.
  const read = (path, key) => async () => {
    const res = await fetch(apiUrl(path))
    if (!res.ok) throw new Error(`Failed (${res.status})`)
    const body = await res.json()
    return body[key] ?? []
  }
  const scheduled = useLoad(read('/api/admin/notifications/scheduled', 'scheduled'), [], { enabled: isAdmin })
  const log       = useLoad(read('/api/admin/notifications/log', 'log'),             [], { enabled: isAdmin })
  const loading   = scheduled.state === 'loading' || log.state === 'loading'

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

  // This was a hand-rolled four-branch ladder. <LoadState> is the same
  // ladder, written once, with the ready branch unreachable until a read has
  // actually succeeded.
  const Panel = ({ load, emptyText, children }) => (
    <div className="[&>*:first-child]:m-4">
      <LoadState
        load={load}
        empty={<p className="px-4 py-6 text-center text-xs text-ink-500 dark:text-parchment-300/70">{emptyText}</p>}
      >
        {() => children}
      </LoadState>
    </div>
  )

  const Row = ({ left, type, status, when }) => (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-parchment-300/50 dark:border-brass-900/25 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 capitalize truncate">{humanizeType(type)}</p>
        <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 truncate">{left || '—'}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">{when}</span>
        {status && (
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLES[status] || FALLBACK_STATUS_STYLE}`}>
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

        {/* Upcoming */}
        <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <Clock size={14} className="text-brass-600 dark:text-brass-300" />
            <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">Upcoming</h2>
            <span className="text-xs text-ink-500 dark:text-parchment-300/70">
              ({scheduled.state === 'failed' ? '—' : (scheduled.data?.length ?? 0)})
            </span>
          </div>
          <Panel load={scheduled} emptyText="Nothing queued right now.">
            {scheduled.data?.map(s => (
              <Row key={s.id} type={s.notification_type} left={s.recipient_email} status={s.status} when={fmtWhen(s.send_at)} />
            ))}
          </Panel>
        </section>

        {/* Recent */}
        <section className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <Bell size={14} className="text-brass-600 dark:text-brass-300" />
            <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">Recent</h2>
            <span className="text-xs text-ink-500 dark:text-parchment-300/70">
              ({log.state === 'failed' ? '—' : (log.data?.length ?? 0)})
            </span>
          </div>
          <Panel load={log} emptyText="Nothing sent yet.">
            {log.data?.map(l => (
              <Row key={l.id} type={l.notification_type} left={l.recipient_email} status={l.status} when={fmtWhen(l.created_at)} />
            ))}
          </Panel>
        </section>
      </div>
    </PageWrapper>
  )
}
