import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Send, Loader2, Bug, Lightbulb, Heart } from 'lucide-react'
import { sheetOverlayCls, sheetPanelCls, MobileSheetGrip } from './MobileSheet'
import { useToast } from './ToastProvider'
import { apiUrl } from '../api'
import { useDialogMotion } from '../hooks/useDialogMotion'
import { useLocale } from '../i18n'

// Feedback & Support (FB.1) — a calm, in-app line to the founder's workbench.
// Rendered through a portal to <body> because the sidebar that launches it
// uses CSS transforms (the mobile drawer), and a `fixed` overlay inside a
// transformed ancestor would be positioned relative to that ancestor, not
// the viewport. POSTs to /api/feedback with the current route for context.

const CATEGORIES = [
  { value: 'bug',           labelKey: 'fb.cat.bug',           icon: Bug },
  { value: 'suggestion',    labelKey: 'fb.cat.suggestion',    icon: Lightbulb },
  { value: 'pastoral_note', labelKey: 'fb.cat.pastoral_note', icon: Heart },
]

export default function FeedbackModal({ open, onClose }) {
  // Phone: rises from the bottom as a sheet; wider: lifts gently (V1.5).
  const panelMotion = useDialogMotion()
  const toast = useToast()
  const { t } = useLocale()
  const [category, setCategory] = useState('suggestion')
  const [message,  setMessage]  = useState('')
  const [busy,     setBusy]     = useState(false)

  useEffect(() => { if (open) { setCategory('suggestion'); setMessage(''); setBusy(false) } }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const send = async (e) => {
    e.preventDefault()
    if (!message.trim()) return
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, message: message.trim(), route: window.location.pathname }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Failed (${res.status})`)
      }
      onClose()
      toast.success(t('fb.delivered'))
    } catch (err) {
      toast.error(err.message || t('fb.sendFailed'))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={sheetOverlayCls}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
        >
          <motion.div
            className={sheetPanelCls}
            initial={panelMotion.initial} animate={panelMotion.animate} exit={{ y: 10, opacity: 0, transition: { duration: 0.16 } }}
            transition={panelMotion.transition}
          >
            <MobileSheetGrip />
            <div className="flex items-start justify-between px-5 pt-4">
              <div>
                <h2 className="font-display text-xl font-semibold text-church-900 dark:text-parchment-50">{t('fb.title')}</h2>
                <p className="text-[12px] text-ink-500 dark:text-parchment-300/70">{t('fb.subtitle')}</p>
              </div>
              <button type="button" onClick={onClose} aria-label={t('fb.close')}
                className="-m-1 p-1 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-100"><X size={18} /></button>
            </div>

            <form onSubmit={send} className="px-5 pb-5 pt-3 space-y-3 overflow-y-auto">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300 mb-1.5">{t('fb.category')}</label>
                <div className="grid grid-cols-3 gap-2">
                  {CATEGORIES.map(({ value, labelKey, icon: Icon }) => {
                    const active = category === value
                    return (
                      <button key={value} type="button" onClick={() => setCategory(value)}
                        aria-pressed={active}
                        className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[12px] font-medium transition-colors ${
                          active
                            ? 'border-brass-500 bg-parchment-200 text-church-800 dark:bg-ink-800 dark:text-parchment-50 dark:border-brass-600'
                            : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-200/80 hover:bg-parchment-100 dark:hover:bg-ink-800'
                        }`}>
                        <Icon size={15} /> {t(labelKey)}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label htmlFor="fb-msg" className="block text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300 mb-1.5">{t('fb.message')}</label>
                <textarea id="fb-msg" value={message} onChange={e => setMessage(e.target.value)} rows={5} autoFocus
                  placeholder={t('fb.messagePh')}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500 resize-none" />
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button type="button" onClick={onClose} className="text-[13px] text-ink-500 dark:text-parchment-300/70 hover:underline">{t('fb.cancel')}</button>
                <button type="submit" disabled={busy || !message.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-church-700 text-parchment-50 hover:bg-church-800 disabled:opacity-60">
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {t('fb.send')}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
