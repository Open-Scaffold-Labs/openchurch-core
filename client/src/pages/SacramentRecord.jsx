import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, FileText, History, Loader2, PenLine, RotateCcw, ShieldOff } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import LoadFailure from '../components/LoadFailure'
import LoadState from '../components/LoadState'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { useLoad } from '../hooks/useLoad'
import { usePrompt } from '../components/ConfirmProvider'
import { useToast } from '../components/ToastProvider'
import { apiUrl } from '../api'
import { formatLocalDate, formatStoredDate } from '../utils/dates'

// One register entry, its state, and everything that has been done to it.
// (REG.1, built in Pass 8 — the server has supported all of this since
// migration 073 and none of it was reachable from the product.)
//
// The record stays primary. History is contextual evidence underneath it,
// not an audit console: a secretary opens this page to read an entry, and
// only sometimes to ask what happened to it.
//
// Vocabulary is the register's, not the software's. A correction is a
// CORRECTION. Retiring an entry is VOIDING, never deleting or removing —
// the server abolished DELETE precisely so the word would stop being
// available, and a UI that keeps saying it re-opens the door.

const FIELD_LABELS = {
  member_name:    'record.f.subject',
  type:           'record.f.type',
  date:           'record.f.date',
  minister:       'record.f.minister',
  place:          'record.f.place',
  certificate_no: 'record.f.certNo',
  notes:          'record.f.notes',
  client_id:      'record.f.member',
  voided_at:      'record.f.voided',
  voided_reason:  'record.f.voidReason',
}
// Fields whose change is machinery rather than meaning. Showing them turns
// a two-line correction into a wall.
const NOISE = new Set(['updated_at', 'created_at', 'id', 'organization_id', 'meta_attributes'])

const MIN_REASON = 3   // mirrors readReason() in server/src/routes/sacraments.js

export default function SacramentRecord() {
  const { id } = useParams()
  const { t, dateLocale } = useLocale()
  const { user } = useAuth()
  const askFor = usePrompt()
  const toast = useToast()
  const navigate = useNavigate()

  const canCorrect = user?.role === 'admin' || user?.role === 'staff'
  const isAdmin    = user?.role === 'admin'

  const record = useLoad(async () => {
    const res = await fetch(apiUrl(`/api/sacraments/${id}`))
    if (res.status === 404) throw new Error(t('record.notFound'))
    if (!res.ok) throw new Error(`Failed (${res.status})`)
    return res.json()
  }, [id], { isEmpty: () => false })

  // A separate read, so a history that will not load never costs the reader
  // the entry itself.
  const history = useLoad(async () => {
    const res = await fetch(apiUrl(`/api/sacraments/${id}/amendments`))
    if (!res.ok) throw new Error(`Failed (${res.status})`)
    return (await res.json()).amendments ?? []
    // initial: [] matters. `data` is null until the first successful read,
    // and the record resolves before the history does — so the history
    // branch rendered against null and threw `Cannot read properties of null
    // (reading 'map')` on a real page while the tests, whose two stubs
    // resolve together, stayed green.
  }, [id], { initial: [] })

  const r = record.data
  const isVoid = !!r?.voided_at

  // After a write the server holds the truth and this page holds the last
  // thing it read. Those agree only once the re-read succeeds. Until it does
  // the entry on screen is a fact about the past, and the actions beneath it
  // — Void on an entry the server has just voided — would be claims about
  // the present. useLoad already names that condition (`isStale`: we have
  // data and the latest refresh failed); this page used to compute it and
  // never look. Now a stale record puts a notice on the panel and pauses the
  // actions until a retry brings screen and server back into agreement. (C1)
  const refresh = () => Promise.all([record.reload(), history.reload()])
  const unread = record.isStale

  // Every one of these three asks for a reason, and the reason IS the
  // confirmation: typing why is the deliberate act. A second "are you sure?"
  // would add friction without adding thought.
  const askReason = (opts) => askFor({
    tone: 'neutral',
    required: true,
    inputLabel: t('record.reasonLabel'),
    ...opts,
  })

  const send = async (path, reason, method = 'POST') => {
    const res = await fetch(apiUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || `Failed (${res.status})`)
    }
    return res.json()
  }

  const onCorrectName = async () => {
    const name = await askFor({
      title: t('record.correctTitle'),
      body: t('record.correctBody'),
      inputLabel: t('record.f.subject'),
      defaultValue: r?.member_name ?? '',
      confirmLabel: t('record.correctNext'),
      tone: 'neutral',
      required: true,
    })
    if (name === null) return
    const reason = await askReason({
      title: t('record.reasonTitle'),
      body: t('record.reasonBody'),
      placeholder: t('record.reasonPlaceholder'),
      confirmLabel: t('record.correctConfirm'),
    })
    if (reason === null) return
    if (reason.trim().length < MIN_REASON) { toast.error(t('record.reasonTooShort')); return }
    try {
      const res = await fetch(apiUrl(`/api/sacraments/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_name: name, reason }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Failed (${res.status})`)
      }
      toast.success(t('record.corrected'))
      await refresh()
    } catch (err) { toast.error(err.message) }
  }

  const onVoid = async () => {
    const reason = await askReason({
      title: t('record.voidTitle'),
      // Says plainly what survives. Nothing is being destroyed, and the
      // copy should not borrow the language of software that destroys things.
      body: t('record.voidBody'),
      placeholder: t('record.voidPlaceholder'),
      confirmLabel: t('record.voidConfirm'),
    })
    if (reason === null) return
    if (reason.trim().length < MIN_REASON) { toast.error(t('record.reasonTooShort')); return }
    try {
      await send(`/api/sacraments/${id}/void`, reason)
      toast.success(t('record.voided'))
      await refresh()
    } catch (err) { toast.error(err.message) }
  }

  const onRestore = async () => {
    const reason = await askReason({
      title: t('record.restoreTitle'),
      body: t('record.restoreBody'),
      placeholder: t('record.restorePlaceholder'),
      confirmLabel: t('record.restoreConfirm'),
    })
    if (reason === null) return
    if (reason.trim().length < MIN_REASON) { toast.error(t('record.reasonTooShort')); return }
    try {
      await send(`/api/sacraments/${id}/restore`, reason)
      toast.success(t('record.restored'))
      await refresh()
    } catch (err) { toast.error(err.message) }
  }

  if (record.state === 'loading') {
    return <PageWrapper><div className="flex justify-center py-24">
      <Loader2 size={22} className="animate-spin text-brass-600" /></div></PageWrapper>
  }
  if (record.state === 'failed') {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-10 space-y-4">
          <LoadFailure cause={record.error} onRetry={record.reload} retrying={record.retrying} />
          <Link to="/register" className="tap inline-flex items-center gap-1 text-sm text-church-700 dark:text-brass-300 hover:underline">
            <ChevronLeft size={16} /> {t('cert.back')}
          </Link>
        </div>
      </PageWrapper>
    )
  }

  const fmt = (v) => (v == null || v === '' ? '—' : String(v))
  const Row = ({ label, value }) => (
    <div className="flex items-baseline gap-3 py-1.5 border-t first:border-t-0 border-parchment-300/50 dark:border-brass-900/25">
      <dt className="w-32 shrink-0 text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">{label}</dt>
      <dd className="text-sm text-ink-800 dark:text-parchment-100">{value}</dd>
    </div>
  )

  // A correction shows as the fields that changed, in words. before_json and
  // after_json are the schema's own snapshots — a field-by-field comparison
  // is all that is needed, and a diff engine would be a bigger answer than
  // the question.
  const changedFields = (a) => {
    const before = a.before_json ?? {}
    const after  = a.after_json ?? {}
    return Object.keys({ ...before, ...after })
      .filter(k => !NOISE.has(k) && FIELD_LABELS[k])
      .filter(k => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
      .map(k => ({ key: k, from: before[k], to: after[k] }))
  }

  const KIND_LABEL = { correction: 'record.k.correction', void: 'record.k.void', restore: 'record.k.restore' }

  return (
    <PageWrapper>
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3">
          <Link to="/register" className="tap inline-flex items-center gap-1 text-sm text-ink-600 dark:text-parchment-200 hover:text-church-700 dark:hover:text-brass-300">
            <ChevronLeft size={16} /> {t('cert.back')}
          </Link>
          {isVoid ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest bg-parchment-200 text-ink-600 dark:bg-ink-800 dark:text-parchment-200">
              <ShieldOff size={12} aria-hidden="true" /> {t('record.void')}
            </span>
          ) : null}
        </div>

        <div>
          <h1 className="font-display text-3xl font-bold text-ink-900 dark:text-parchment-50">
            {t(`sac.${r.type}`)}
          </h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">{t('record.sub')}</p>
        </div>

        {/* The write is on the server; what follows is what we last read.
            Same strip LoadState uses for stale data, with the register's
            own words: "saved" first, because it was. */}
        {unread && (
          <LoadFailure variant="strip" body={t('record.rereadFailed')} cause={record.error}
            onRetry={refresh} retrying={record.retrying} />
        )}

        {isVoid && (
          <div role="status" className="rounded-2xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 px-5 py-4">
            <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{t('record.voidedTitle')}</p>
            <p className="text-sm text-ink-600 dark:text-parchment-300 mt-0.5">{t('record.voidedBody')}</p>
            {r.voided_reason && (
              <p className="text-sm italic text-ink-500 dark:text-parchment-300/70 mt-2">“{r.voided_reason}”</p>
            )}
          </div>
        )}

        <dl className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 shadow-warm px-5 py-4">
          <Row label={t('record.f.subject')} value={fmt(r.member_name)} />
          <Row label={t('record.f.date')} value={r.date ? formatStoredDate(r.date, { year: 'numeric', month: 'long', day: 'numeric' }, dateLocale) : '—'} />
          <Row label={t('record.f.minister')} value={fmt(r.minister)} />
          <Row label={t('record.f.place')} value={fmt(r.place)} />
          <Row label={t('record.f.certNo')} value={fmt(r.certificate_no)} />
          {r.notes && <Row label={t('record.f.notes')} value={r.notes} />}
        </dl>

        {/* Actions. A control the caller may not use is DISABLED with its
            reason readable, not hidden: a secretary who cannot void needs to
            know voiding exists and who to ask. The server is the authority
            either way — this only saves a wasted click. */}
        <div className="flex flex-wrap gap-2">
          {/* No certificate while the entry is unread: it may already be
              void, and §12 forbids certifying as active what is void. */}
          {!isVoid && !unread && (
            <Link
              to={`/register/${id}/certificate`}
              className="tap inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900"
            >
              <FileText size={15} aria-hidden="true" /> {t('record.certificate')}
            </Link>
          )}
          <button
            type="button"
            onClick={onCorrectName}
            disabled={!canCorrect || isVoid || unread}
            title={unread ? t('record.rereadPending') : !canCorrect ? t('record.needStaff') : isVoid ? t('record.voidNoCorrect') : undefined}
            className="tap inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800 disabled:opacity-50"
          >
            <PenLine size={15} aria-hidden="true" /> {t('record.correct')}
          </button>
          {isVoid ? (
            <button
              type="button" onClick={onRestore} disabled={!isAdmin || unread}
              title={unread ? t('record.rereadPending') : !isAdmin ? t('record.needAdmin') : undefined}
              className="tap inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800 disabled:opacity-50"
            >
              <RotateCcw size={15} aria-hidden="true" /> {t('record.restore')}
            </button>
          ) : (
            <button
              type="button" onClick={onVoid} disabled={!isAdmin || unread}
              title={unread ? t('record.rereadPending') : !isAdmin ? t('record.needAdmin') : undefined}
              className="tap inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800 disabled:opacity-50"
            >
              <ShieldOff size={15} aria-hidden="true" /> {t('record.void')}
            </button>
          )}
        </div>
        {!isAdmin && (
          <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">{t('record.needAdmin')}</p>
        )}

        {/* History — contextual, and deliberately quieter than the record. */}
        <section className="pt-2">
          <div className="flex items-center gap-2 mb-2">
            <History size={14} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('record.history')}</h2>
          </div>

          {/* This branch is where the page died: `history.data.map` ran while
              the record had resolved and the history had not. LoadState makes
              that unreachable — children() is only called once a read has
              succeeded. */}
          <LoadState
            load={history}
            failure={<LoadFailure variant="strip" body={t('record.historyFailed')} cause={history.error}
              onRetry={history.reload} retrying={history.retrying} />}
            empty={<p className="text-[12px] text-ink-500 dark:text-parchment-300/70">{t('record.historyEmpty')}</p>}
          >
            {entries => (
            <ol className="space-y-3">
              {entries.map(a => (
                <li key={a.id} className="text-sm border-l-2 border-brass-700/30 pl-3">
                  <p className="text-[11px] uppercase tracking-widest text-brass-700 dark:text-brass-300">
                    {t(KIND_LABEL[a.kind] ?? 'record.k.correction')}
                    {' · '}
                    {formatLocalDate(a.created_at, { year: 'numeric', month: 'short', day: 'numeric' }, dateLocale)}
                    {a.amended_by_name ? ` · ${a.amended_by_name}` : ''}
                  </p>
                  {a.reason && <p className="text-ink-700 dark:text-parchment-200 mt-0.5">“{a.reason}”</p>}
                  {/* Only a CORRECTION has fields worth naming. For a void
                      or a restore the kind and the reason ARE the content —
                      showing the diff there printed a raw ISO timestamp
                      ("Voided: 2026-08-27T18:48:36.451Z → —") into a
                      parish-facing history, which is machinery leaking into
                      the book. Observed at 390px. */}
                  {a.kind === 'correction' && changedFields(a).map(c => (
                    <p key={c.key} className="text-[12px] text-ink-500 dark:text-parchment-300/70 mt-0.5">
                      {t(FIELD_LABELS[c.key])}: {fmt(c.from)} → {fmt(c.to)}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
            )}
          </LoadState>
        </section>
      </div>
    </PageWrapper>
  )
}
