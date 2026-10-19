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

function fmtWhen(iso, dateLocale) {
  if (!iso) return '—'
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return '—'
  return when.toLocaleString(dateLocale, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

// Static t() calls. A template `np.status.${status}` is invisible to
// lint:client-scope, so deleting the Spanish string stayed green and the
// badge fell back to English. An unknown token still stays the server word.
const STATUS_LABEL = {
  sent: (t) => t('np.status.sent'),
  delivered: (t) => t('np.status.delivered'),
  stubbed: (t) => t('np.status.stubbed'),
  skipped: (t) => t('np.status.skipped'),
  suppressed: (t) => t('np.status.suppressed'),
  failed: (t) => t('np.status.failed'),
  bounced: (t) => t('np.status.bounced'),
  complained: (t) => t('np.status.complained'),
  pending: (t) => t('np.status.pending'),
}

function statusLabel(status, t) {
  if (!status) return null
  const labelOf = STATUS_LABEL[status]
  if (!labelOf) return status
  const label = labelOf(t)
  return label === `np.status.${status}` ? status : label
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

  const { t, dateLocale } = useLocale()

  // Two panels, two reads, two independent answers — which is the whole of
  // partial failure. `r.ok ? r.json() : { scheduled: [] }` used to turn a
  // 500 on either endpoint into "Nothing queued right now.", and the .catch
  // only fired for a network or parse error, so the commonest failure was
  // also the quietest one.
  // HTTP non-OK already throws the book sentence. A rejected fetch, a
  // body that will not parse, or JSON `null` used to fall through
  // useLoad's err.message into LoadFailure's cause, so a Spanish session
  // read "Failed to fetch" or "Cannot read properties of null".
  // The alert stays the i18n sentence. The raw diagnostic stays in the console.
  const readFailed = (path, err) => {
    console.error('[Notifications] read failed', path, err)
    throw new Error(t('np.loadFailed'))
  }
  const read = (path, key) => async () => {
    let res
    try {
      res = await fetch(apiUrl(path))
    } catch (err) {
      readFailed(path, err)
    }
    if (!res.ok) {
      console.error('[Notifications] read refused', { path, status: res.status })
      throw new Error(t('np.loadFailed'))
    }
    let body
    try {
      body = await res.json()
    } catch (err) {
      readFailed(path, err)
    }
    // `null` is valid JSON and throws on body[key]. An array is an object,
    // so body[key] is missing and the panel used to render an empty list.
    // Both are a body this page cannot read, not a quiet success.
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      console.error('[Notifications] read malformed', path, body)
      throw new Error(t('np.loadFailed'))
    }
    // `{scheduled: null}`, a missing field, a scalar, or an object is not
    // an empty queue. `body[key] ?? []` used to say nothing was waiting.
    const rows = body[key]
    if (!Array.isArray(rows)) {
      console.error('[Notifications] read malformed', path, body)
      throw new Error(t('np.loadFailed'))
    }
    return rows
  }
  const scheduled = useLoad(read('/api/admin/notifications/scheduled', 'scheduled'), [], { enabled: isAdmin })
  const log       = useLoad(read('/api/admin/notifications/log', 'log'),             [], { enabled: isAdmin })
  const loading   = scheduled.state === 'loading' || log.state === 'loading'

  if (!isAdmin) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState icon={AlertTriangle} title={t('np.adminsOnly')}
            body={t('np.adminsBody')} />
        </div>
      </PageWrapper>
    )
  }

  if (loading) {
    return (
      <PageWrapper>
        <div role="status" aria-label={t('np.loading')} className="flex items-center justify-center py-24">
          <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" aria-hidden="true" />
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
        <time className="text-[11px] text-ink-500 dark:text-parchment-300/70">{when}</time>
        {status && (
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLES[status] || FALLBACK_STATUS_STYLE}`}>
            {statusLabel(status, t)}
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
            <Bell size={18} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">{t('np.title')}</h1>
          </div>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            {t('np.subtitle')}
          </p>
        </motion.div>

        {/* Upcoming */}
        <section aria-labelledby="np-upcoming" className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <Clock size={14} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h2 id="np-upcoming" className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('np.upcoming')}</h2>
            <span className="text-xs text-ink-500 dark:text-parchment-300/70">
              ({scheduled.state === 'failed' ? '—' : (scheduled.data?.length ?? 0)})
            </span>
          </div>
          <Panel load={scheduled} emptyText={t('np.emptyQueued')}>
            {scheduled.data?.map(s => (
              <Row key={s.id} type={s.notification_type} left={s.recipient_email} status={s.status} when={fmtWhen(s.send_at, dateLocale)} />
            ))}
          </Panel>
        </section>

        {/* Recent */}
        <section aria-labelledby="np-recent" className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <Bell size={14} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h2 id="np-recent" className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('np.recent')}</h2>
            <span className="text-xs text-ink-500 dark:text-parchment-300/70">
              ({log.state === 'failed' ? '—' : (log.data?.length ?? 0)})
            </span>
          </div>
          <Panel load={log} emptyText={t('np.emptySent')}>
            {log.data?.map(l => (
              <Row key={l.id} type={l.notification_type} left={l.recipient_email} status={l.status} when={fmtWhen(l.created_at, dateLocale)} />
            ))}
          </Panel>
        </section>
      </div>
    </PageWrapper>
  )
}
