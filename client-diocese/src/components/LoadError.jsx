import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'

// One banner for "this screen could not load", so every diocese page says it
// the same way and none of them says it by going quiet.
//
// The defect this exists to prevent: every page in this app was written
// `.catch(() => setRows([]))`, and every page renders an empty array as its
// welcome state. A chancery with forty parishes whose request fails was being
// told to invite its first one — the app inventing an empty diocese out of a
// dropped connection. `variant="empty"` is the whole-screen form of that;
// `variant="partial"` is the strip used when only some of a page failed.
//
// Voice: name the failure, say what it is NOT, offer the retry. Never
// apologise for the user's data, because their data is fine.
export default function LoadError({
  variant = 'empty',
  title,
  body,
  onRetry,
  retrying = false,
}) {
  const heading = title || (variant === 'partial' ? "Some of this didn't load." : "This didn't load.")
  const text = body || (variant === 'partial'
    ? 'Anything showing a dash is missing, not zero. Nothing is wrong with your records — this is a connection problem.'
    : "We couldn't reach the server. This is not an empty diocese — your records are untouched.")

  return (
    <div
      role="status"
      className={
        variant === 'partial'
          ? 'flex items-start gap-3 rounded-2xl border border-amber-300/70 bg-amber-50/70 px-5 py-4 mb-6'
          : 'flex flex-col items-center gap-3 rounded-2xl border border-amber-300/70 bg-amber-50/70 px-6 py-10 text-center'
      }
    >
      <AlertCircle
        size={variant === 'partial' ? 18 : 22}
        className={variant === 'partial' ? 'shrink-0 mt-0.5 text-amber-700' : 'text-amber-700'}
        aria-hidden="true"
      />
      <div className={variant === 'partial' ? 'flex-1 min-w-0' : 'max-w-md'}>
        <p className="text-sm font-semibold text-ink-900">{heading}</p>
        <p className="text-sm text-ink-600 mt-0.5">{text}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-amber-300 text-amber-800 hover:bg-amber-100 disabled:opacity-50 transition-colors"
        >
          {retrying ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Try again
        </button>
      )}
    </div>
  )
}
