import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import { useLocale } from '../i18n'

// One way for a parish screen to say it could not read something, so no
// screen says it by going quiet instead.
//
// Ported from the diocese app's LoadError, which existed because every page
// there was written `.catch(() => setRows([]))` and every page renders an
// empty array as a welcome. The parish app had the same defect and no such
// component at all.
//
//   variant="block"   the whole panel could not be read
//   variant="strip"   part of the page could not be read; the rest is usable
//
// Voice: name the failure, say what it is NOT, offer the retry. Never
// apologise for the person's data — their data is fine.
export default function LoadFailure({
  variant = 'block',
  title,
  body,
  cause,
  onRetry,
  retrying = false,
  className = '',
}) {
  const { t } = useLocale()
  const strip = variant === 'strip'

  return (
    <div
      role="status"
      className={`${strip
        ? 'flex items-start gap-3 rounded-xl border border-amber-300/70 dark:border-amber-700/40 bg-amber-50/70 dark:bg-amber-950/20 px-4 py-3'
        : 'flex flex-col items-center gap-3 rounded-2xl border border-amber-300/70 dark:border-amber-700/40 bg-amber-50/70 dark:bg-amber-950/20 px-6 py-10 text-center'} ${className}`}
    >
      <AlertCircle
        size={strip ? 17 : 22}
        className={`${strip ? 'shrink-0 mt-0.5' : ''} text-amber-700 dark:text-amber-400`}
        aria-hidden="true"
      />
      <div className={strip ? 'flex-1 min-w-0' : 'max-w-md'}>
        <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">
          {title || t(strip ? 'load.partialTitle' : 'load.failedTitle')}
        </p>
        <p className="text-sm text-ink-600 dark:text-parchment-300 mt-0.5">
          {body || t(strip ? 'load.partialBody' : 'load.failedBody')}
          {cause && (
            <span className="text-ink-500 dark:text-parchment-300/70"> ({cause})</span>
          )}
        </p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="tap shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-amber-300 dark:border-amber-700/50 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50 transition-colors"
        >
          {retrying
            ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            : <RefreshCw size={12} aria-hidden="true" />}
          {t('load.retry')}
        </button>
      )}
    </div>
  )
}
