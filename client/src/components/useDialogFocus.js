import { useEffect } from 'react'

// Modal keyboard behavior for a hand-rolled dialog, the same pattern
// ConfirmProvider uses: focus moves inside on open, Tab and Shift+Tab wrap
// at both ends (and pull escaped focus back in), Escape calls onClose, and
// on unmount focus returns to whatever opened the dialog.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Only the top-most modal owns the keyboard. A ConfirmProvider alertdialog
// (or any later aria-modal) raised above this panel renders after it in
// document order; while it is open this hook stands down for Tab AND Escape,
// so the two capture handlers never fight (R369-1). Exported for tests.
export function isTopDialog(panel) {
  if (!panel) return false
  const modals = document.querySelectorAll('[aria-modal="true"]')
  const top = modals[modals.length - 1]
  return !top || top === panel || panel.contains(top)
}

export default function useDialogFocus(panelRef, onClose) {
  useEffect(() => {
    const opener = document.activeElement
    const first = panelRef.current?.querySelector(FOCUSABLE)
    ;(first || panelRef.current)?.focus()
    return () => { if (opener?.isConnected) opener.focus() }
  }, [panelRef])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' && e.key !== 'Tab') return
      if (!isTopDialog(panelRef.current)) return
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
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
  }, [panelRef, onClose])
}
