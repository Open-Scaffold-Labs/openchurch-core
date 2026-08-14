import { motion } from 'framer-motion'

const pageVariants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.25, ease: 'easeOut', staggerChildren: 0.06 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut' } },
}

export { itemVariants }

// Default width is 5xl which fits most card-style pages. Data-dense
// pages (Members table, Schedule calendar) override via `className`
// without losing the stagger-on-mount animation.
export default function PageWrapper({ children, className = 'max-w-5xl mx-auto' }) {
  return (
    <motion.div
      variants={pageVariants}
      initial="hidden"
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  )
}
