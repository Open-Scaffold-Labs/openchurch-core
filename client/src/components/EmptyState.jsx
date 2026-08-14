import { motion } from 'framer-motion'

// Warm empty-state card — shown when a list page has nothing at all
// to show (no rows, no filters applied). Filter-empty cases stay as
// minimalist text rows because "no matches for your search" is a
// different, less-scary situation than "you have nothing yet."
//
// Props:
//   illustration — optional component that renders an SVG line-art
//                  panel (see components/illustrations.jsx). When
//                  present, takes the place of the icon pill and
//                  reads as a quiet flourish rather than a generic
//                  status badge. Preferred for the "you have nothing
//                  yet" entry-point cards.
//   icon   — lucide icon component to render inside an accent pill.
//            Used as a fallback when no illustration is supplied
//            (modal-internal empty states, smaller surfaces).
//   title  — short heading (e.g. "No members yet")
//   body   — one-line explanation of what this page is for
//   action — { label, onClick } rendered as the primary CTA button
//   secondary — optional { label, onClick } rendered as a smaller link
export default function EmptyState({ illustration: Illustration, icon: Icon, title, body, action, secondary }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
      className="bg-parchment-100 dark:bg-ink-900/80 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm-md px-6 py-12 text-center"
    >
      {Illustration ? (
        <div className="text-brass-600 dark:text-brass-300 mb-6">
          <Illustration />
        </div>
      ) : Icon && (
        <div className="inline-flex w-14 h-14 rounded-2xl bg-church-50 dark:bg-church-900/40 items-center justify-center text-church-800 dark:text-brass-300 mb-5">
          <Icon size={22} />
        </div>
      )}
      <h3 className="font-display text-xl font-semibold text-ink-900 dark:text-parchment-50">
        {title}
      </h3>
      {body && (
        <p className="mt-2 text-sm text-ink-500 dark:text-parchment-300/70 max-w-md mx-auto leading-relaxed">
          {body}
        </p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-sm font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors"
        >
          {action.label}
        </button>
      )}
      {secondary && (
        <button
          type="button"
          onClick={secondary.onClick}
          className="block mx-auto mt-3 text-xs font-medium text-ink-500 hover:text-church-800 dark:text-parchment-300/60 dark:hover:text-brass-200 transition-colors"
        >
          {secondary.label}
        </button>
      )}
    </motion.div>
  )
}
