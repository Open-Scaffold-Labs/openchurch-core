import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { useLocale } from '../i18n'
import { toastMotion } from '../utils/motion'

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
// older ones drop), drift down into place and leave a little quicker
// (utils/motion.js toastMotion). Click the X
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
  const { t } = useLocale()
  const [toasts, setToasts] = useState([])
  const idRef = useRef(1)
  // Auto-dismiss timers still pending. Cleared on unmount so a timer
  // never calls setState after the provider (or a test's jsdom) is gone.
  const timersRef = useRef(new Set())
  useEffect(() => () => {
    for (const h of timersRef.current) clearTimeout(h)
    timersRef.current.clear()
  }, [])

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(item => item.id !== id))
  }, [])

  const push = useCallback((kind, message, opts = {}) => {
    const id = idRef.current++
    const duration = opts.duration ?? DEFAULT_DURATION
    setToasts(prev => {
      const next = [...prev, { id, kind, message }]
      return next.slice(-MAX_STACK)
    })
    if (duration > 0) {
      const h = setTimeout(() => {
        timersRef.current.delete(h)
        dismiss(id)
      }, duration)
      timersRef.current.add(h)
    }
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
        aria-label={t('toast.region')}
        aria-live="polite"
      >
        <AnimatePresence>
          {toasts.map(toast => (
            <Toast key={toast.id} {...toast} onDismiss={() => dismiss(toast.id)} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

function Toast({ kind, message, onDismiss }) {
  const { t } = useLocale()
  const v = VARIANTS[kind] || VARIANTS.info
  const Icon = v.Icon
  return (
    <motion.div
      layout
      initial={toastMotion.initial}
      animate={toastMotion.animate}
      exit={toastMotion.exit}
      className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-warm-md ${v.classes}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <Icon size={16} className={`shrink-0 mt-0.5 ${v.iconClass}`} />
      <p className="text-sm flex-1 leading-relaxed">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('toast.dismiss')}
        className="shrink-0 opacity-50 hover:opacity-100 transition-opacity -mr-1 -mt-0.5"
      >
        <X size={14} />
      </button>
    </motion.div>
  )
}
