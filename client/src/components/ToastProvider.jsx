import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'

// App-wide toast notifications. Replaces alert() everywhere — we
// accumulated a dozen-plus alert() sites once role enforcement
// started surfacing 403s, and the native dialog is jarring +
// blocks the UI thread.
//
// Usage:
//   const toast = useToast()
//   toast.success('Saved')
//   toast.error('Forbidden')
//   toast.info('Heads up...')
//   toast.dismiss(id)
//
// Toasts auto-dismiss after 4s, stack vertically (max 3 visible —
// older ones drop), slide in from the right, fade out. Click the X
// to dismiss early. Pointer-events-none on the container so toasts
// never block clicks behind them; the toast itself opts in.

const ToastContext = createContext(null)

const DEFAULT_DURATION = 4000
const MAX_STACK        = 3

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

const VARIANTS = {
  success: {
    Icon: CheckCircle2,
    classes: 'bg-brass-50 dark:bg-brass-900/30 border-brass-200/70 dark:border-brass-800/40 text-brass-900 dark:text-brass-100',
    iconClass: 'text-brass-700 dark:text-brass-300',
  },
  error: {
    Icon: AlertTriangle,
    classes: 'bg-rose-50 dark:bg-rose-900/30 border-rose-200/70 dark:border-rose-800/40 text-rose-900 dark:text-rose-100',
    iconClass: 'text-rose-700 dark:text-rose-300',
  },
  info: {
    Icon: Info,
    classes: 'bg-brass-50 dark:bg-brass-900/30 border-brass-200/70 dark:border-brass-800/40 text-ink-800 dark:text-parchment-100',
    iconClass: 'text-brass-700 dark:text-brass-300',
  },
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const idRef = useRef(1)

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const push = useCallback((kind, message, opts = {}) => {
    const id = idRef.current++
    const duration = opts.duration ?? DEFAULT_DURATION
    setToasts(prev => {
      const next = [...prev, { id, kind, message }]
      return next.slice(-MAX_STACK)
    })
    if (duration > 0) setTimeout(() => dismiss(id), duration)
    return id
  }, [dismiss])

  const value = useMemo(() => ({
    success: (msg, opts) => push('success', msg, opts),
    error:   (msg, opts) => push('error',   msg, opts),
    info:    (msg, opts) => push('info',    msg, opts),
    dismiss,
  }), [push, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-w-sm"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        <AnimatePresence>
          {toasts.map(t => (
            <Toast key={t.id} {...t} onDismiss={() => dismiss(t.id)} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

function Toast({ kind, message, onDismiss }) {
  const v = VARIANTS[kind] || VARIANTS.info
  const Icon = v.Icon
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 24, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
      className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-warm-md ${v.classes}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <Icon size={16} className={`shrink-0 mt-0.5 ${v.iconClass}`} />
      <p className="text-sm flex-1 leading-relaxed">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 opacity-50 hover:opacity-100 transition-opacity -mr-1 -mt-0.5"
      >
        <X size={14} />
      </button>
    </motion.div>
  )
}
