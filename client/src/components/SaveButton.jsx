import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Check } from 'lucide-react'
import { useLocale } from '../i18n'

// useSaveStatus — wraps an async save fn with idle/saving/saved/error
// states. The 'saved' state auto-resets to 'idle' after holdMs so the
// button doesn't hang on a permanent green checkmark.
//
//   const { status, run } = useSaveStatus(savePrefs)
//   <form onSubmit={e => { e.preventDefault(); run(formData) }}>
//     …
//     <SaveButton status={status} disabled={!isValid}>Save preferences</SaveButton>
//   </form>
//
// Errors do not auto-reset — the consumer is expected to surface the
// error (toast / inline) and reset by calling run() again. We keep the
// button readable as 'Save' (idle label) on error so the user can
// retry without confusion.
export function useSaveStatus(saveFn, { holdMs = 1400, onSuccess } = {}) {
  const [status, setStatus] = useState('idle')
  const timeoutRef = useRef(null)

  // Cancel pending hold on unmount so we don't setState on a dead
  // component (React warning + leak).
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  const run = useCallback(async (...args) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setStatus('saving')
    try {
      const result = await saveFn(...args)
      setStatus('saved')
      onSuccess?.(result)
      timeoutRef.current = setTimeout(() => {
        setStatus(prev => (prev === 'saved' ? 'idle' : prev))
      }, holdMs)
      return result
    } catch (err) {
      setStatus('idle') // reset to idle so the button is usable again
      throw err
    }
  }, [saveFn, holdMs, onSuccess])

  return { status, run, reset: () => setStatus('idle') }
}

// SaveButton — primary CTA that reads { status } and animates between
// idle / saving / saved. Children are the idle label ("Save", "Save
// preferences", etc). Pass-through `disabled` is honored on top of the
// implicit `status === 'saving'` lockout.
export default function SaveButton({
  status = 'idle',
  disabled,
  children,
  type = 'submit',
  className = '',
  onClick,
}) {
  const { t } = useLocale()
  const isLocked = disabled || status === 'saving' || status === 'saved'
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isLocked}
      // Saved turns the button sage for its hold (V1.4, study #6) and keeps
      // full strength: it is locked, but it is an answer, not a dead control.
      // sage-700 under parchment-50 is 7.6:1; sage-600 in dark is 5.4:1.
      className={`relative inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-parchment-50 text-sm font-semibold shadow-warm transition-colors duration-200 disabled:cursor-not-allowed ${
        status === 'saved'
          ? 'bg-sage-700 dark:bg-sage-600'
          : 'bg-church-900 dark:bg-church-700 hover:bg-church-800 dark:hover:bg-church-600 disabled:opacity-60'
      } ${className}`}
    >
      <AnimatePresence mode="wait" initial={false}>
        {status === 'saving' ? (
          <motion.span
            key="saving"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="inline-flex items-center gap-2"
          >
            <Loader2 size={15} className="animate-spin" />
            {t('save.saving')}
          </motion.span>
        ) : status === 'saved' ? (
          <motion.span
            key="saved"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="inline-flex items-center gap-2"
          >
            <Check size={15} strokeWidth={3} />
            {t('save.saved')}
          </motion.span>
        ) : (
          <motion.span
            key="idle"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            className="inline-flex items-center gap-2"
          >
            {children}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  )
}
