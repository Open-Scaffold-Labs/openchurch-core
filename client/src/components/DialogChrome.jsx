// Shared dialog chrome for Quiet Craft 5: one serif title style and a
// footer with Cancel as text on the left of the primary action. Keeps
// every sheet and modal reading as the same object as the pages.
import { forwardRef } from 'react'

export const DIALOG_TITLE_CLS =
  'font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50 leading-snug'

export const DIALOG_CANCEL_CLS =
  'px-3 py-2.5 text-sm font-medium text-ink-500 dark:text-parchment-300/70 hover:text-ink-800 dark:hover:text-parchment-50 transition-colors'

export const DIALOG_PRIMARY_CLS =
  'px-4 py-2.5 rounded-xl text-sm font-bold text-parchment-50 bg-church-900 hover:bg-church-800 dark:bg-church-800 dark:hover:bg-church-700 transition-colors disabled:opacity-40'

// Footer: primary on the right; Cancel as a text button (not a bordered twin).
export const DialogFooter = forwardRef(function DialogFooter(
  { cancelLabel, onCancel, primaryLabel, onPrimary, primaryType = 'button', primaryDisabled = false, primaryClassName, leading, className = 'mt-6' },
  ref,
) {
  return (
    <div className={`${className} flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2`}>
      {leading ? <div className="sm:mr-auto sm:flex-1">{leading}</div> : null}
      <button type="button" ref={ref} onClick={onCancel} className={DIALOG_CANCEL_CLS}>
        {cancelLabel}
      </button>
      <button
        type={primaryType}
        onClick={onPrimary}
        disabled={primaryDisabled}
        className={primaryClassName || DIALOG_PRIMARY_CLS}
      >
        {primaryLabel}
      </button>
    </div>
  )
})
