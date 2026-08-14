// Skeleton loading primitives — used in place of <Loader2 /> spinners on
// list-shaped pages. The shimmer reads as "page is rendering" rather than
// "something is busy", which is closer to the actual UX (we're filling
// the rows in once the fetch resolves).
//
// Tone: parchment-200 in light mode, ink-800 in dark — NOT slate/gray.
// Keeps the warmth on first paint instead of dropping into a cold blank.

export function SkeletonBlock({ className = '', width, height }) {
  // Generic rectangle. Use width/height as inline styles when the size
  // can't be expressed as a Tailwind class (e.g. a pixel-precise label
  // width that varies per page).
  const style = {}
  if (width)  style.width  = typeof width  === 'number' ? `${width}px`  : width
  if (height) style.height = typeof height === 'number' ? `${height}px` : height
  return (
    <div
      aria-hidden="true"
      style={style}
      className={`animate-pulse rounded bg-parchment-200/70 dark:bg-ink-800/70 ${className}`}
    />
  )
}

// One row of a list — avatar circle, two stacked text lines, a trailing
// chip. Mirrors the shape of a Member/Task/Audit row so the visual jump
// when real data lands is small.
export function SkeletonRow({ withAvatar = true, withTrailing = true }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="flex items-center gap-3 px-4 py-3 border-b border-parchment-200/60 dark:border-ink-800/60 last:border-0"
    >
      {withAvatar && <SkeletonBlock className="w-9 h-9 rounded-full shrink-0" />}
      <div className="flex-1 min-w-0 space-y-2">
        <SkeletonBlock className="h-3.5 w-1/3" />
        <SkeletonBlock className="h-3 w-1/2" />
      </div>
      {withTrailing && <SkeletonBlock className="h-6 w-16 rounded-full shrink-0" />}
    </div>
  )
}

// Card-shaped skeleton for grid layouts (Library, AI generations).
// Title bar + 3 lines of body + footer chips.
export function SkeletonCard() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 p-5"
    >
      <SkeletonBlock className="h-4 w-2/3 mb-4" />
      <div className="space-y-2 mb-5">
        <SkeletonBlock className="h-3 w-full" />
        <SkeletonBlock className="h-3 w-5/6" />
        <SkeletonBlock className="h-3 w-3/4" />
      </div>
      <div className="flex gap-2">
        <SkeletonBlock className="h-5 w-14 rounded-full" />
        <SkeletonBlock className="h-5 w-20 rounded-full" />
      </div>
    </div>
  )
}

// Convenience wrapper: render N rows. Default 5 fits the average list
// page initial fold.
export function SkeletonRowList({ count = 5, ...rowProps }) {
  return (
    <div className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 overflow-hidden">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} {...rowProps} />
      ))}
    </div>
  )
}
