import { useCallback, useEffect, useState } from 'react'
import { LifeBuoy, Loader2, Undo2, Church } from 'lucide-react'
import PageWrapper, { itemVariants } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { motion } from 'framer-motion'
import { useToast } from '../components/ToastProvider'
import { useConfirm } from '../components/ConfirmProvider'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'

// Archive & Recovery — the parish-facing half of the Continuity Vault.
//
// The Vault spec deliberately deferred this page: "Do not begin with a
// public Vault interface. First make recovery real and tested." It is
// arriving now because recovery IS tested — there is a drill
// (scripts/restore-drill.mjs) and every guard has been proved able to
// fail. This page is allowed to be reassuring because the reassurance is
// true.
//
// Tone rules, from the spec and from the usability roadmap:
//   – no countdown, no red, no badge, nothing that expires loudly
//   – it must not invite browsing for something to undo
//   – it must not expose operational complexity: no table names, no
//     "entity", no "tenant", no "archive job"
//   – a person who cannot restore should still be able to SEE that their
//     mistake is recoverable, and be told who can put it back
//
// The most useful sentence on the page is the one about the register:
// somebody worried about a deletion is often worried about the wrong
// thing, and the register — the part that actually cannot be recreated —
// was never deletable in the first place.

const KIND_WORDS = {
  member:   'Member',
  donation: 'Gift',
  fund:     'Fund',
  group:    'Group',
  bulletin: 'Bulletin',
  form:     'Form',
  event:    'Event',
}

const day = v => (v ? String(v).slice(0, 10) : '')

// The server's reasons for a skipped cascaded child (server/src/vault,
// restoreEntry). Anything it says that we do not recognise is shown as
// it came — a reason we did not translate is better than one we made up.
const SKIP_REASONS = {
  'its related record is gone':  'vault.reasonGone',
  'could not be re-inserted':    'vault.reasonReinsert',
}

// A restore answers 200 with both halves: what came back and what did
// not. `not_restored.relinked` counts connections that now point at
// another record (the server never overwrites those); `not_restored.
// cascaded[]` lists children it could not re-insert, each with a reason.
// Turn that into sentences, or nothing if every count is zero.
function partialLines(t, notRestored) {
  const lines = []
  const relinked = Number(notRestored?.relinked) || 0
  if (relinked > 0) {
    lines.push(t(relinked === 1 ? 'vault.notRelinked' : 'vault.notRelinked_plural', { n: relinked }))
  }
  const byReason = new Map()
  for (const c of Array.isArray(notRestored?.cascaded) ? notRestored.cascaded : []) {
    const reason = SKIP_REASONS[c?.reason] ? t(SKIP_REASONS[c.reason]) : (c?.reason || t('vault.reasonReinsert'))
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }
  for (const [reason, n] of byReason) {
    lines.push(t(n === 1 ? 'vault.notCascaded' : 'vault.notCascaded_plural', { n, reason }))
  }
  return lines
}

export default function Archive() {
  const { t } = useLocale()
  const { user } = useAuth()
  const toast = useToast()
  const ask = useConfirm()

  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [showRestored, setShowRestored] = useState(false)
  const [busyId, setBusyId] = useState(null)
  // The last restore that came back incomplete: { label, lines }. Kept on
  // the page rather than only in a toast, because a toast is gone in four
  // seconds and this is the one sentence here that must be read.
  const [partial, setPartial] = useState(null)

  const isAdmin = user?.role === 'admin'

  const load = useCallback(async (withRestored) => {
    try {
      const res = await fetch(apiUrl(`/api/vault${withRestored ? '?include_restored=true' : ''}`))
      if (!res.ok) throw new Error()
      setData(await res.json())
      setError('')
    } catch {
      setError(t('vault.loadFailed'))
    }
  }, [t])

  useEffect(() => { load(showRestored) }, [load, showRestored])

  const restore = async (entry) => {
    if (!(await ask({
      title: t('vault.restoreAsk', { label: entry.label }),
      body: t('vault.restoreBody'),
      confirmLabel: t('vault.restoreConfirm'),
      tone: 'neutral',
    }))) return
    setBusyId(entry.id)
    setPartial(null)
    try {
      const res = await fetch(apiUrl(`/api/vault/${entry.id}/restore`), { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Say which refusal it was, in the parish's words. "409" is not a
        // sentence anybody can act on.
        const known = { occupied: 'vault.occupied', already_restored: 'vault.alreadyRestored' }[body.code]
        toast.error(known ? t(known) : (res.status === 403 ? t('vault.adminOnly') : t('vault.restoreFailed')))
        return
      }
      // A 200 is not "everything is back". The card promised "N
      // connections that would be restored"; if the server kept some of
      // them as they are, the plain sentence would be a false one.
      const lines = partialLines(t, body.not_restored)
      if (lines.length) {
        setPartial({ label: entry.label, lines })
        toast.info(t('vault.restoredPartly', { label: entry.label }), { duration: 8000 })
      } else {
        toast.success(t('vault.restored', { label: entry.label }))
      }
      load(showRestored)
    } catch {
      toast.error(t('vault.restoreFailed'))
    } finally {
      setBusyId(null)
    }
  }

  if (error) {
    return <PageWrapper><p className="text-sm text-ink-600 dark:text-parchment-300/80">{error}</p></PageWrapper>
  }
  if (!data) {
    return (
      <PageWrapper>
        <div className="flex justify-center py-24">
          <Loader2 size={22} className="animate-spin text-brass-500" aria-hidden="true" />
        </div>
      </PageWrapper>
    )
  }

  const entries = data.entries ?? []

  return (
    <PageWrapper>
      <motion.header variants={itemVariants} className="mb-7">
        <h1 className="font-display text-3xl font-bold text-ink-900 dark:text-parchment-50">{t('vault.title')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80 max-w-2xl">
          {t('vault.lede')}
        </p>
      </motion.header>

      {/* What is kept — the promise, stated once, with its limits. */}
      <motion.section
        variants={itemVariants}
        className="mb-8 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-100 dark:bg-ink-900/80 px-6 py-5 shadow-warm-md"
      >
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">
          <LifeBuoy size={17} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
          {t('vault.protectedTitle')}
        </h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {(data.protected_kinds ?? []).map(k => (
            <li
              key={k.kind}
              className="px-2.5 py-1 rounded-lg text-[12.5px] font-medium bg-parchment-200/70 dark:bg-ink-800 text-ink-700 dark:text-parchment-200"
            >
              {KIND_WORDS[k.kind] ?? k.noun}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-600 dark:text-parchment-300/80">
          {t('vault.protectedNote', { days: data.retention_days })}
        </p>
        <p className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed text-ink-600 dark:text-parchment-300/80 border-t border-parchment-300/60 dark:border-brass-900/30 pt-3">
          <Church size={15} className="shrink-0 mt-0.5 text-brass-600 dark:text-brass-300" aria-hidden="true" />
          <span>{t('vault.registerNote')}</span>
        </p>
      </motion.section>

      <motion.div variants={itemVariants} className="flex items-baseline justify-between mb-3">
        <h2 className="font-display text-lg font-semibold text-ink-900 dark:text-parchment-50">
          {t('vault.recentTitle')}
        </h2>
        <button
          onClick={() => setShowRestored(v => !v)}
          className="tap-reach text-[12.5px] font-medium text-ink-500 dark:text-parchment-300/70 hover:text-church-700 dark:hover:text-brass-300 transition-colors"
        >
          {showRestored ? t('vault.hideRestored') : t('vault.showRestored')}
        </button>
      </motion.div>

      {partial && (
        <div
          role="status"
          className="mb-4 rounded-2xl border border-brass-300/60 dark:border-brass-800/40 bg-brass-50 dark:bg-brass-900/20 px-5 py-4 text-[13px] leading-relaxed text-ink-800 dark:text-parchment-100"
        >
          <p className="font-medium">{t('vault.restoredPartly', { label: partial.label })}</p>
          <ul className="mt-1.5 space-y-1 text-ink-600 dark:text-parchment-300/80">
            {partial.lines.map(line => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}

      {entries.length === 0 ? (
        <EmptyState icon={LifeBuoy} title={t('vault.empty')} body={t('vault.emptyBody')} />
      ) : (
        <motion.ul variants={itemVariants} className="space-y-2.5">
          {entries.map(e => {
            const cascaded = e.summary?.cascaded_rows ?? 0
            const relinked = e.summary?.relinked_rows ?? 0
            return (
              <li
                key={e.id}
                className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-100 dark:bg-ink-900/80 px-5 py-4 shadow-warm-md"
              >
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-[0.14em] text-brass-600 dark:text-brass-300">
                      {KIND_WORDS[e.kind] ?? e.kind}
                    </p>
                    <p className="mt-0.5 font-medium text-ink-900 dark:text-parchment-50 break-words">{e.label}</p>
                    <p className="mt-1 text-[12.5px] text-ink-500 dark:text-parchment-300/70">
                      {day(e.deleted_at)}
                      {e.deleted_by_name ? ` · ${t('vault.removedBy', { name: e.deleted_by_name })}` : ''}
                    </p>
                    {cascaded > 0 && (
                      <p className="mt-1 text-[12.5px] text-ink-500 dark:text-parchment-300/70">
                        {t(cascaded === 1 ? 'vault.alsoIncluded' : 'vault.alsoIncluded_plural', { n: cascaded })}
                        {relinked > 0 && ` ${t(relinked === 1 ? 'vault.reconnects' : 'vault.reconnects_plural', { n: relinked })}`}
                      </p>
                    )}
                    {e.restored_at ? (
                      <p className="mt-1.5 text-[12.5px] font-medium text-brass-700 dark:text-brass-300">
                        {t('vault.restoredTitle')} · {day(e.restored_at)}
                        {e.restored_by_name ? ` · ${t('vault.restoredBy', { name: e.restored_by_name })}` : ''}
                      </p>
                    ) : (
                      <p className="mt-1.5 text-[12.5px] text-ink-500 dark:text-parchment-300/70">
                        {t('vault.keptUntil', { date: day(e.retention_until) })}
                      </p>
                    )}
                  </div>

                  {!e.restored_at && isAdmin && (
                    <button
                      onClick={() => restore(e)}
                      disabled={busyId === e.id}
                      className="tap shrink-0 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-semibold text-parchment-50 bg-brass-700 hover:bg-brass-800 disabled:opacity-60 transition-colors"
                    >
                      {busyId === e.id
                        ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> {t('vault.restoring')}</>
                        : <><Undo2 size={14} aria-hidden="true" /> {t('vault.restore')}</>}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </motion.ul>
      )}

      {!isAdmin && entries.length > 0 && (
        <motion.p variants={itemVariants} className="mt-4 text-[12.5px] leading-relaxed text-ink-500 dark:text-parchment-300/70">
          {t('vault.adminOnly')}
        </motion.p>
      )}
    </PageWrapper>
  )
}
