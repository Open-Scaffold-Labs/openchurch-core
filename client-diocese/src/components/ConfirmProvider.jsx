import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

// Chancery confirmation dialog. Mirrors the parish client's
// components/ConfirmProvider.jsx in behaviour and voice, deliberately
// duplicated rather than extracted — the OpenDiocese blueprint says to copy
// the handful of shared primitives until a third client exists, because a
// workspace package is infrastructure ahead of need.
//
// Two differences from the parish version, both intentional:
//
//   1. No framer-motion. The chancery app does not depend on it, and adding
//      an animation library to satisfy one dialog would be the wrong trade
//      (OPERATOR bans new UI/animation libraries). A plain fade via CSS is
//      enough, and a finance back office wants less motion, not more.
//   2. The MobileSheet class constants are inlined for the same reason.
//
// Usage:
//   const ask = useConfirm()
//   if (!(await ask({ title: 'Close this year?', body: '…' }))) return
//
//   const askFor = usePrompt()
//   const v = await askFor({ title: 'New rate (%)', inputType: 'number' })
//   if (v === null) return          // cancelled — NOT the same as ''

const ConfirmContext = createContext(null)

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return ctx
}

// Text-reply variant. Resolves to the trimmed string, or null if cancelled —
// null is the only cancel signal, so an empty reply and a dismissed dialog
// stay distinguishable the way prompt() distinguished '' from null.
export function usePrompt() {
  const confirm = useConfirm()
  return useCallback(opts => {
    const options = typeof opts === 'string' ? { title: opts } : (opts || {})
    return confirm({ ...options, tone: options.tone || 'neutral', prompt: true })
  }, [confirm])
}

// Tab must not walk out of a modal and into the page behind it.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null)
  const [value, setValue] = useState('')
  const pendingRef = useRef(null)
  const cancelRef = useRef(null)
  const inputRef = useRef(null)
  const panelRef = useRef(null)
  const restoreRef = useRef(null)

  const cancelValue = pending => (pending?.isPrompt ? null : false)

  const confirm = useCallback(opts => {
    const options = typeof opts === 'string' ? { body: opts } : (opts || {})
    const isPrompt = options.prompt === true
    return new Promise(resolve => {
      // A second question while one is open used to overwrite the pending
      // resolver, leaving the first promise unsettled and its `await` hung
      // forever. Settle the old one as cancelled: the caller asked and got
      // no answer, which is a cancel.
      const previous = pendingRef.current
      if (previous) previous.resolve(cancelValue(previous))

      pendingRef.current = { resolve, isPrompt }
      setValue(isPrompt ? String(options.defaultValue ?? '') : '')
      setRequest({
        title: options.title || 'Are you sure?',
        body: options.body || '',
        confirmLabel: options.confirmLabel || (isPrompt ? 'Save' : 'Confirm'),
        cancelLabel: options.cancelLabel || 'Cancel',
        tone: options.tone === 'neutral' ? 'neutral' : 'destructive',
        isPrompt,
        inputLabel: options.inputLabel || '',
        placeholder: options.placeholder || '',
        inputType: options.inputType || 'text',
        required: options.required === true,
      })
    })
  }, [])

  const settle = useCallback(result => {
    const pending = pendingRef.current
    pendingRef.current = null
    setRequest(null)
    setValue('')
    pending?.resolve(result)
  }, [])

  const cancel = useCallback(() => settle(cancelValue(pendingRef.current)), [settle])

  const trimmed = value.trim()
  const canConfirm = !request?.isPrompt || !request.required || trimmed !== ''
  const accept = useCallback(() => {
    if (!canConfirm) return
    settle(pendingRef.current?.isPrompt ? trimmed : true)
  }, [canConfirm, settle, trimmed])

  // Escape always cancels; the safe answer must be the easy one. Tab is
  // caught here too: aria-modal tells a screen reader the page behind is
  // inert, but it does nothing to the tab ring.
  useEffect(() => {
    if (!request) return
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); return }
      if (e.key !== 'Tab') return
      const nodes = [...(panelRef.current?.querySelectorAll(FOCUSABLE) || [])]
      if (!nodes.length) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (!panelRef.current?.contains(active)) {
        e.preventDefault(); (e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request, cancel])

  // Focus Cancel, not Confirm — a reflexive Enter should do nothing. A typed
  // question is the exception: there the field is the point. On close, focus
  // returns to whatever opened the dialog.
  useEffect(() => {
    if (request) {
      restoreRef.current = document.activeElement
      if (request.isPrompt) inputRef.current?.focus()
      else cancelRef.current?.focus()
      return
    }
    const restore = restoreRef.current
    restoreRef.current = null
    if (restore?.isConnected) restore.focus()
  }, [request])

  const destructive = request?.tone === 'destructive'

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <div
          className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 md:p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) cancel() }}
        >
          <div
            ref={panelRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby={request.body ? 'confirm-body' : undefined}
            className="w-full md:max-w-md bg-parchment-50 rounded-t-2xl md:rounded-2xl shadow-warm-lg border border-parchment-300/50"
          >
            <div className="p-6">
              <div className="flex items-start gap-3">
                {destructive && (
                  <span className="shrink-0 mt-1 w-9 h-9 rounded-full bg-church-50 flex items-center justify-center">
                    <AlertTriangle size={18} className="text-church-800" aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0">
                  <h2 id="confirm-title" className="font-display text-2xl font-semibold text-ink-900 leading-snug">
                    {request.title}
                  </h2>
                  {request.body && (
                    <p id="confirm-body" className="mt-2 text-sm leading-relaxed text-ink-600">
                      {request.body}
                    </p>
                  )}
                </div>
              </div>

              {request.isPrompt && (
                <div className="mt-4">
                  {request.inputLabel && (
                    <label htmlFor="confirm-input" className="block text-sm font-medium text-ink-700 mb-1.5">
                      {request.inputLabel}
                    </label>
                  )}
                  <input
                    id="confirm-input"
                    ref={inputRef}
                    type={request.inputType}
                    value={value}
                    placeholder={request.placeholder}
                    onChange={e => setValue(e.target.value)}
                    // Enter submits, matching the native prompt() this replaced.
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); accept() } }}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 bg-parchment-100 text-ink-900 focus:outline-none focus:ring-2 focus:ring-church-500"
                  />
                </div>
              )}

              <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <button
                  ref={cancelRef}
                  onClick={cancel}
                  className="px-4 py-2.5 rounded-xl text-sm font-semibold text-ink-700 border border-parchment-300/70 hover:bg-parchment-200/60 transition-colors"
                >
                  {request.cancelLabel}
                </button>
                <button
                  onClick={accept}
                  disabled={!canConfirm}
                  className={
                    (destructive
                      ? 'px-4 py-2.5 rounded-xl text-sm font-bold text-parchment-50 bg-church-900 hover:bg-church-800 transition-colors'
                      : 'px-4 py-2.5 rounded-xl text-sm font-bold text-parchment-50 bg-brass-700 hover:bg-brass-800 transition-colors') +
                    (canConfirm ? '' : ' opacity-50 cursor-not-allowed')
                  }
                >
                  {request.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
