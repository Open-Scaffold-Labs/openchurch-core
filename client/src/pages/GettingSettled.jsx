import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Loader2, ArrowRight, Check, LifeBuoy, FileText, Church } from 'lucide-react'
import PageWrapper, { itemVariants } from '../components/PageWrapper'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'

// Getting settled — the first week, without a progress bar.
//
// THE ONE DESIGN DECISION EVERYTHING ELSE FOLLOWS FROM. The Dashboard
// card this replaces filled a bar to doneCount/totalCount. People do
// like finishing things — that instinct was right — but a bar has an
// empty half, and the empty half says: there is a standard, we set it,
// you are below it. Said to a parish secretary who did not ask to become
// a software user, on her first morning.
//
// So: "What is in place" only ever lists things that are TRUE. No greyed
// rows, no empty circles, no strikethrough, no total. A parish with three
// entries reads three things done — not three of eight — because there is
// no eight anywhere on the page to read.
//
// And the suggestions below it are deliberately NOT the missing half. If
// they were, a reader would reassemble the denominator in her head and
// we would have shipped the same bar with extra steps. The server caps
// them at three, shapes them by role, and never presents them as a set.
//
// Nothing here blocks anything. The page is reachable from Admin forever,
// dismissing hides a card and never a destination, and every route it
// offers is one the reader is already allowed to walk.

const day = v => (v ? String(v).slice(0, 10) : '')

// "1 members are on file" is the kind of small wrongness that tells a
// reader nobody looked at this screen. One helper, one convention: a
// `_one` key beside the plural, falling back to the plural when a
// language does not need the distinction.
const plural = (t, key, count, vars = {}) =>
  (count === 1 ? t(`${key}_one`, { count, ...vars }) : t(key, { count, ...vars }))

// Each in-place entry renders from its own key plus an optional detail
// line. Kept as data rather than branching JSX so adding one is a string
// and a row here, and cannot accidentally introduce a "not yet" state.
function detailFor(t, e) {
  const d = e.detail || {}
  switch (e.key) {
    case 'setup.inPlace.people':  return plural(t, 'settled.inPlace.peopleCount', d.count)
    case 'setup.inPlace.import':  return d.imported != null ? plural(t, 'settled.inPlace.importCount', d.imported) : null
    default: return null
  }
}

function labelFor(t, e, parish) {
  const d = e.detail || {}
  const key = e.key.replace('setup.inPlace.', 'settled.inPlace.')
  if (d.count != null) return plural(t, key, d.count, { parish: parish ?? '', tradition: d.tradition ?? '' })
  return t(key, { parish: parish ?? '', tradition: d.tradition ?? '' })
}

export default function GettingSettled() {
  const { t } = useLocale()
  const { user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()

  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/setup'))
      if (!res.ok) throw new Error()
      setData(await res.json())
    } catch {
      setData({ error: true })
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Every one of these used to swallow the failure and then toast
  // success. On a page whose whole promise is "nothing important is
  // rushed and you can come back", telling somebody their choice was
  // saved when it was not is the worst small lie available — she comes
  // back tomorrow and the thing she put away is still sitting there.
  // One helper, so no caller can forget to check.
  async function save(url, opts, okMessage) {
    try {
      const res = await fetch(apiUrl(url), opts)
      if (!res.ok) throw new Error(String(res.status))
      if (okMessage) toast.success(okMessage)
      return true
    } catch {
      toast.error(t('settled.saveFailed'))
      return false
    }
  }

  async function comeBackLater() {
    setBusy('dismiss')
    const ok = await save('/api/setup/dismiss', { method: 'POST' }, t('settled.dismissed'))
    setBusy('')
    if (ok) navigate('/')
  }

  async function showAgain() {
    setBusy('dismiss')
    await save('/api/setup/dismiss', { method: 'DELETE' }, t('settled.restored'))
    setBusy('')
    load()
  }

  async function leaveForLater(key) {
    setBusy(key)
    await save('/api/setup/later', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_key: key }),
    }, t('settled.laterDone'))
    setBusy('')
    load()
  }

  async function bringBack(key) {
    setBusy(key)
    await save(`/api/setup/later/${encodeURIComponent(key)}`, { method: 'DELETE' }, null)
    setBusy('')
    load()
  }

  if (!data) {
    return (
      <PageWrapper title={t('settled.title')}>
        <div className="flex justify-center py-20"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
      </PageWrapper>
    )
  }

  // A failed load used to fall through and render the welcome with every
  // section empty — which reads as "your parish has nothing", the single
  // most alarming thing this page could say to somebody who just imported
  // four hundred members.
  if (data.error) {
    return (
      <PageWrapper title={t('settled.title')}>
        <motion.div variants={itemVariants} className="max-w-xl">
          <p className="text-[15px] text-ink-600 dark:text-parchment-300/85">{t('settled.loadFailed')}</p>
          <Link to="/" className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-church-800 dark:text-brass-200 hover:underline">
            <Church size={14} aria-hidden="true" /> {t('settled.return')}
          </Link>
        </motion.div>
      </PageWrapper>
    )
  }

  const parish = data.parish || user?.organization?.name
  const arrived = data.import_context

  return (
    <PageWrapper title={t('settled.title')}>
      {/* Welcome. A sentence, not a banner — and no name for how far
          along anyone is. */}
      <motion.section variants={itemVariants} className="max-w-2xl">
        <h2 className="font-display text-2xl sm:text-3xl text-church-900 dark:text-parchment-100">
          {t('settled.welcome')}
        </h2>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-600 dark:text-parchment-300/85">
          {t('settled.sub')}
        </p>
      </motion.section>

      {/* ── What is in place ────────────────────────────────────────────
          A ledger. Only true things, and it only grows. */}
      {data.in_place?.length > 0 && (
        <motion.section variants={itemVariants} className="mt-10 max-w-2xl">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">
            {t('settled.inPlaceTitle')}
          </h3>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-500 dark:text-parchment-300/70">
            {t('settled.inPlaceNote')}
          </p>
          <ul className="mt-4 space-y-2.5">
            {data.in_place.map(e => {
              const detail = detailFor(t, e)
              return (
                <li key={e.key} className="flex items-start gap-3">
                  <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-brass-100 dark:bg-brass-900/40 flex items-center justify-center">
                    <Check size={12} className="text-brass-700 dark:text-brass-300" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[15px] text-ink-900 dark:text-parchment-50">
                      {labelFor(t, e, parish)}
                    </p>
                    {(detail || e.on) && (
                      <p className="text-[13px] text-ink-500 dark:text-parchment-300/70">
                        {detail}
                        {detail && e.on ? ' · ' : ''}
                        {e.on ? t('settled.since', { date: day(e.on) }) : ''}
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </motion.section>
      )}

      {/* ── What arrived ────────────────────────────────────────────────
          Only for someone allowed to see an import. The protection
          sentences come straight off the receipt, so this page cannot
          drift into claiming the source file was kept. */}
      {arrived && (
        <motion.section variants={itemVariants} className="mt-10 max-w-2xl rounded-2xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100/50 dark:bg-ink-900/60 p-5">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">
            {t('settled.arrivedTitle')}
          </h3>
          <p className="mt-2 text-[15px] text-ink-900 dark:text-parchment-50">
            {t('settled.arrivedOn', { date: day(arrived.committed_at), source: arrived.source_name || '—' })}
          </p>
          <ul className="mt-2 space-y-1 text-[14px] text-ink-600 dark:text-parchment-300/85">
            <li>{plural(t, 'settled.arrivedImported', arrived.imported)}</li>
            {(arrived.held_for_follow_up + arrived.duplicates_left_for_review) > 0 && (
              <li>{plural(t, 'settled.arrivedHeld', arrived.held_for_follow_up + arrived.duplicates_left_for_review)}</li>
            )}
            {arrived.ignored_columns?.length > 0 && (
              <li>{t('settled.arrivedIgnored', { columns: arrived.ignored_columns.join(', ') })}</li>
            )}
          </ul>
          {arrived.protection && (
            <p className="mt-3 text-[13px] leading-relaxed text-ink-500 dark:text-parchment-300/70">
              {arrived.protection.source_file} {arrived.protection.staged_rows}
            </p>
          )}
          <Link
            to={`/migration/${arrived.id}/receipt`}
            className="mt-3 inline-flex items-center gap-1.5 text-[14px] font-semibold text-church-800 dark:text-brass-200 hover:underline"
          >
            <FileText size={14} aria-hidden="true" /> {t('settled.arrivedReceipt')}
          </Link>
        </motion.section>
      )}

      {/* ── A good place to begin ───────────────────────────────────────
          At most three. Never framed as a set to get through. */}
      {data.begin_here?.length > 0 && (
        <motion.section variants={itemVariants} className="mt-10 max-w-2xl">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">
            {t('settled.beginTitle')}
          </h3>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-500 dark:text-parchment-300/70">
            {t('settled.beginNote')}
          </p>
          <ul className="mt-4 space-y-3">
            {data.begin_here.map(item => {
              const base = item.key.replace('setup.begin.', 'settled.begin.')
              return (
                <li
                  key={item.key}
                  className="rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900/50 p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Link
                        to={item.to}
                        className="group inline-flex items-center gap-1.5 text-[15px] font-semibold text-ink-900 dark:text-parchment-50 hover:text-church-800 dark:hover:text-brass-200 transition-colors"
                      >
                        {t(base)}
                        <ArrowRight size={14} className="opacity-60 group-hover:translate-x-0.5 transition-transform" aria-hidden="true" />
                      </Link>
                      <p className="mt-1 text-[13.5px] leading-relaxed text-ink-600 dark:text-parchment-300/80">
                        {item.count != null
                          ? plural(t, `${base}Body`, item.count)
                          : t(`${base}Body`)}
                      </p>
                    </div>
                    {/* `deferrable` comes from the server, so this button
                        exists only where POST /later will accept it. It used
                        to render on every suggestion — including the import
                        receipt, which is not deferrable and is always the
                        first item after an import, making the most prominent
                        control on the page a guaranteed error toast. */}
                    {data.can_edit_context && item.deferrable && (
                      <button
                        type="button"
                        onClick={() => leaveForLater(item.key)}
                        disabled={busy === item.key}
                        className="tap-reach shrink-0 text-[12.5px] font-medium text-ink-500 dark:text-parchment-300/70 hover:text-church-700 dark:hover:text-brass-300 disabled:opacity-50 transition-colors"
                      >
                        {t('settled.later')}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </motion.section>
      )}

      {/* ── Left for later, on purpose ──────────────────────────────────
          Stated as a decision with a name on it. This is the section that
          lets the printed record tell the truth about a deferral instead
          of implying an omission. */}
      {data.deferred?.length > 0 && (
        <motion.section variants={itemVariants} className="mt-10 max-w-2xl">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70">
            {t('settled.deferredTitle')}
          </h3>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-500 dark:text-parchment-300/70">
            {t('settled.deferredNote')}
          </p>
          <ul className="mt-3 space-y-2">
            {data.deferred.map(d => (
              <li key={d.item_key} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[14px] text-ink-700 dark:text-parchment-200">
                    {t(d.item_key.replace('setup.begin.', 'settled.begin.'))}
                  </p>
                  {d.noted_by && (
                    <p className="text-[12.5px] text-ink-500 dark:text-parchment-300/70">
                      {t('settled.deferredBy', { name: d.noted_by, date: day(d.noted_at) })}
                    </p>
                  )}
                </div>
                {data.can_edit_context && (
                  <button
                    type="button"
                    onClick={() => bringBack(d.item_key)}
                    disabled={busy === d.item_key}
                    className="tap-reach shrink-0 text-[12.5px] font-medium text-ink-500 dark:text-parchment-300/70 hover:text-church-700 dark:hover:text-brass-300 disabled:opacity-50 transition-colors"
                  >
                    {t('settled.laterUndo')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </motion.section>
      )}

      {/* ── When you are ready ──────────────────────────────────────────
          Every setup page ends here: a way out, a way back, and help. */}
      <motion.section variants={itemVariants} className="mt-12 max-w-2xl border-t border-parchment-300/70 dark:border-brass-900/40 pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70">
          {t('settled.closeTitle')}
        </h3>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Link to="/" className="tap inline-flex items-center gap-1.5 text-[14px] font-semibold text-church-800 dark:text-brass-200 hover:underline">
            <Church size={14} aria-hidden="true" /> {t('settled.return')}
          </Link>
          {data.dismissed_at ? (
            <button type="button" onClick={showAgain} disabled={busy === 'dismiss'}
              className="tap-reach text-[14px] font-medium text-ink-600 dark:text-parchment-300/80 hover:text-church-700 dark:hover:text-brass-300 disabled:opacity-50 transition-colors">
              {t('settled.comeBackAgain')}
            </button>
          ) : (
            <button type="button" onClick={comeBackLater} disabled={busy === 'dismiss'}
              className="tap-reach text-[14px] font-medium text-ink-600 dark:text-parchment-300/80 hover:text-church-700 dark:hover:text-brass-300 disabled:opacity-50 transition-colors">
              {t('settled.comeBack')}
            </button>
          )}
          <Link to="/support" className="tap-reach inline-flex items-center gap-1.5 text-[14px] font-medium text-ink-600 dark:text-parchment-300/80 hover:text-church-700 dark:hover:text-brass-300 transition-colors">
            <LifeBuoy size={14} aria-hidden="true" /> {t('settled.help')}
          </Link>
          {data.can_edit_context && (
            <Link to="/getting-settled/record" className="tap-reach inline-flex items-center gap-1.5 text-[14px] font-medium text-ink-600 dark:text-parchment-300/80 hover:text-church-700 dark:hover:text-brass-300 transition-colors">
              <FileText size={14} aria-hidden="true" /> {t('settled.recordOpen')}
            </Link>
          )}
        </div>
      </motion.section>
    </PageWrapper>
  )
}
