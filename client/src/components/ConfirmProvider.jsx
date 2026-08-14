import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { sheetOverlayCls, sheetPanelCls } from './MobileSheet'

// App-wide confirmation dialog. Replaces native confirm() everywhere.
//
// OPERATOR tolerated confirm() only as a destructive double-check "until
// the styled dialog exists". This is that dialog. A browser confirm() is
// the loudest generic-SaaS tell left in the product: system font, system
// chrome, an OS-blue button, and a title bar that says the domain name.
// It undoes the Parchment & Brass surface in one modal — and it appears
// at precisely the moments that deserve the most ceremony, when someone
// is about to delete a parish record.
//
// Usage — the API is promise-based, because a React dialog cannot block
// the thread the way the native one does:
//
//   const ask = useConfirm()
//   if (!(await ask('Delete this task?'))) return
//
//   if (!(await ask({
//     title: 'Delete this pledge?',
//     body: 'The matched donations stay; just the pledge record goes away.',
//     confirmLabel: 'Delete pledge',
//   }))) return
//
// Every call site already sat inside an async handler, so migration was a
// matter of adding `await` rather than restructuring anything. The hook is
// named `ask` at call sites deliberately: shadowing the global `confirm`
// would mean any scoping mistake silently fell back to the native dialog
// instead of failing loudly.
//
// Deliberately NOT a toast: a toast is for something that already
// happened. This is a question, and questions must be answered before the
// thing happens.
//
// The same dialog also answers questions that need a typed reply, which is
// what retired the last native prompt() calls — see usePrompt() below:
//
//   const askFor = usePrompt()
//   const note = await askFor({ title: 'What should the parish fix?', required: true })
//   if (note === null) return          // cancelled — NOT the same as ''

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

  // Cancel value depends on the mode: a yes/no question answers false, a
  // typed question answers null. Kept in one place so the leak-guard below
  // and the three dismissal paths cannot disagree about what "no" means.
  const cancelValue = pending => (pending?.isPrompt ? null : false)

  const confirm = useCallback(opts => {
    const options = typeof opts === 'string' ? { body: opts } : (opts || {})
    const isPrompt = options.prompt === true
    return new Promise(resolve => {
      // A second question while one is open used to overwrite the pending
      // resolver, leaving the first promise unsettled and its `await` hung
      // forever. The modal makes that hard to reach from the UI, but a
      // background async flow can do it. Settle the old one as cancelled
      // first: the caller asked and got no answer, which is a cancel.
      const previous = pendingRef.current
      if (previous) previous.resolve(cancelValue(previous))

      pendingRef.current = { resolve, isPrompt }
      setValue(isPrompt ? String(options.defaultValue ?? '') : '')
      setRequest({
        title: options.title || 'Are you sure?',
        body: options.body || '',
        confirmLabel: options.confirmLabel || (isPrompt ? 'Save' : 'Confirm'),
        cancelLabel: options.cancelLabel || 'Cancel',
        // 'destructive' is the default because every current caller is a
        // destructive double-check. Pass tone: 'neutral' for a question
        // that only changes something reversible.
        tone: options.tone === 'neutral' ? 'neutral' : 'destructive',
        isPrompt,
        inputLabel: options.inputLabel || '',
        placeholder: options.placeholder || '',
        inputType: options.inputType || 'text',
        // A required reply cannot be confirmed empty — the old prompt()
        // sites all bailed on an empty string, so make that a disabled
        // button rather than a silent no-op.
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

  // Escape always cancels. A confirmation that can only be dismissed by
  // choosing an answer is a trap, and the safe answer must be the easy one.
  //
  // Tab is caught here too: aria-modal tells a screen reader the page
  // behind is inert, but it does nothing to the tab ring, so without this
  // the next Tab lands on whatever is underneath the scrim.
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
      // Wrap at both ends, and pull focus back in if it has already escaped.
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

  // Focus lands on Cancel, not Confirm. If someone hits Enter reflexively
  // the outcome is "nothing happened", which is the recoverable direction.
  // A typed question is the exception: there the field is the whole point,
  // and Enter there submits rather than confirming blind.
  //
  // On close, focus returns to whatever opened the dialog — otherwise it
  // resets to <body> and a keyboard user restarts from the top of the page.
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
      {/* No AnimatePresence. It held the dismissed dialog mounted forever in
          production builds: the scrim stayed on screen at full opacity with
          pointer-events on, so the page behind was unclickable until a reload
          and the dialog looked frozen. Dev builds unmounted normally, which is
          why it shipped. The chancery copy never used framer-motion here and
          never had the bug.

          An exit animation is not worth a dialog that can strand the app, so
          the dialog now unmounts the moment it is dismissed. The entrance
          animation is kept — that one runs on mount and cannot wedge. */}
      {request && (
          <div
            className={sheetOverlayCls}
            onMouseDown={e => { if (e.target === e.currentTarget) cancel() }}
          >
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
              aria-describedby={request.body ? 'confirm-body' : undefined}
              className={`${sheetPanelCls} md:max-w-md`}
            >
              <div className="p-6">
                <div className="flex items-start gap-3">
                  {destructive && (
                    <span className="shrink-0 mt-1 w-9 h-9 rounded-full bg-church-50 dark:bg-church-900/40 flex items-center justify-center">
                      <AlertTriangle size={18} className="text-church-800 dark:text-brass-300" aria-hidden="true" />
                    </span>
                  )}
                  <div className="min-w-0">
                    <h2
                      id="confirm-title"
                      className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 leading-snug"
                    >
                      {request.title}
                    </h2>
                    {request.body && (
                      <p id="confirm-body" className="mt-2 text-sm leading-relaxed text-ink-600 dark:text-parchment-300/80">
                        {request.body}
                      </p>
                    )}
                  </div>
                </div>

                {request.isPrompt && (
                  <div className="mt-4">
                    {request.inputLabel && (
                      <label htmlFor="confirm-input" className="block text-sm font-medium text-ink-700 dark:text-parchment-200 mb-1.5">
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
                      // Enter submits, matching the native prompt() this
                      // replaced. Guarded by canConfirm so a required field
                      // cannot be submitted empty by reflex.
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); accept() } }}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
                    />
                  </div>
                )}

                <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                  <button
                    ref={cancelRef}
                    onClick={cancel}
                    className="px-4 py-2.5 rounded-xl text-sm font-semibold text-ink-700 dark:text-parchment-200 border border-parchment-300/70 dark:border-brass-900/40 hover:bg-parchment-200/60 dark:hover:bg-ink-800 transition-colors"
                  >
                    {request.cancelLabel}
                  </button>
                  <button
                    onClick={accept}
                    disabled={!canConfirm}
                    className={
                      (destructive
                        ? 'px-4 py-2.5 rounded-xl text-sm font-bold text-parchment-50 bg-church-900 hover:bg-church-800 dark:bg-church-800 dark:hover:bg-church-700 transition-colors'
                        : 'px-4 py-2.5 rounded-xl text-sm font-bold text-parchment-50 bg-brass-700 hover:bg-brass-800 transition-colors') +
                      (canConfirm ? '' : ' opacity-50 cursor-not-allowed')
                    }
                  >
                    {request.confirmLabel}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
    </ConfirmContext.Provider>
  )
}
