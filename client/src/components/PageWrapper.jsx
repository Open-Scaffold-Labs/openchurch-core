import { motion, useReducedMotion } from 'framer-motion'
import { itemEntranceVariants, pageEntranceVariants } from '../utils/motion'

export function useItemVariants() {
  return itemEntranceVariants(!!useReducedMotion())
}

// Motion-on constant so existing `variants={itemVariants}` call sites
// stay valid. MotionConfig in main.jsx zeros their duration when the
// user prefers reduced motion; screens that switch to useItemVariants()
// also skip the y-offset.
const itemVariants = itemEntranceVariants(false)
export { itemVariants }

// One content width per page type so list, record and document pages
// share a single framing decision (Jarvis quiet craft #3).
export const PAGE_WIDTH = {
  list: 'max-w-6xl mx-auto',
  record: 'max-w-3xl mx-auto',
  document: 'max-w-2xl mx-auto',
}

/**
 * One page header: a single serif title, optional subtitle, actions on
 * the right. Pages used to invent eight different title styles; this is
 * the only one. Keep leading (icon) optional and quiet — brass, never
 * decorative.
 */
export function PageHeader({ title, subtitle, actions, leading, className = '' }) {
  return (
    <div
      data-page-header
      className={`flex items-start justify-between gap-4 flex-wrap ${className}`.trim()}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {leading ? (
            <span className="shrink-0 text-brass-600 dark:text-brass-300" aria-hidden="true">
              {leading}
            </span>
          ) : null}
          {title != null && title !== '' ? (
            <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
              {title}
            </h1>
          ) : null}
        </div>
        {subtitle ? (
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-0.5">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2 shrink-0 flex-wrap">{actions}</div>
      ) : null}
    </div>
  )
}

// Default width is 5xl which fits most card-style pages. Pass `type` for
// the shared list / record / document widths. Data-dense pages that need
// full bleed (Schedule calendar) still override via `className` without
// losing the stagger-on-mount animation. Optional title/subtitle/actions
// render PageHeader above children (Getting Settled already passed title).
export default function PageWrapper({
  children,
  className,
  type,
  title,
  subtitle,
  actions,
  leading,
}) {
  const reduceMotion = !!useReducedMotion()
  const pageVariants = pageEntranceVariants(reduceMotion)
  const widthFromType = type && PAGE_WIDTH[type] ? PAGE_WIDTH[type] : null
  const resolvedClass =
    className != null
      ? className
      : widthFromType || 'max-w-5xl mx-auto'
  const showHeader = title != null || subtitle != null || actions != null || leading != null

  return (
    <motion.div
      variants={pageVariants}
      initial={reduceMotion ? false : 'hidden'}
      animate="show"
      data-reduced-motion={reduceMotion ? 'reduce' : 'full'}
      data-page-type={type || undefined}
      className={resolvedClass}
    >
      {showHeader ? (
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={actions}
          leading={leading}
          className="mb-6"
        />
      ) : null}
      {children}
    </motion.div>
  )
}
