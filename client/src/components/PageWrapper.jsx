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

// Default width is 5xl which fits most card-style pages. Data-dense
// pages (Members table, Schedule calendar) override via `className`
// without losing the stagger-on-mount animation.
export default function PageWrapper({ children, className = 'max-w-5xl mx-auto' }) {
  const reduceMotion = !!useReducedMotion()
  const pageVariants = pageEntranceVariants(reduceMotion)
  return (
    <motion.div
      variants={pageVariants}
      initial={reduceMotion ? false : 'hidden'}
      animate="show"
      data-reduced-motion={reduceMotion ? 'reduce' : 'full'}
      className={className}
    >
      {children}
    </motion.div>
  )
}
