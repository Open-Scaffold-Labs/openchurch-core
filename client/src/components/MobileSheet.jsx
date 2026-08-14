// Mobile-sheet conversion kit — visual primitives + class-string
// constants that retrofit OpenChurch's existing modals into bottom-
// sheets on mobile WITHOUT rewriting any modal JSX.
//
// Why class strings instead of a wrapper component:
//   Every modal in OpenChurch has its own motion.div + onClose +
//   form-submit wiring. A wrapper component would have to swallow all
//   that, and getting the AnimatePresence + framer-motion + click-
//   outside-to-close interactions right per-modal is the part that
//   breaks. Class strings let each modal opt in incrementally — apply
//   once, eyeball, move on.
//
// The pattern:
//   1. Outer overlay: `sheetOverlayCls` — anchors children to bottom
//      on mobile (`items-end`), centers on md+. Backdrop is the same
//      black/40 the codebase already uses.
//   2. Panel: `sheetPanelCls` — full-width on mobile flush to viewport
//      edge with rounded top corners only; max-w-lg centered modal on
//      md+ with all corners rounded. Caps height at 90vh with internal
//      flex-col so headers/footers stay visible while the body scrolls.
//   3. Grip: `<MobileSheetGrip />` — small visual pill at the top of
//      the panel that signals "this is a sheet you can swipe" on
//      mobile. Hidden on md+ via `md:hidden`. Pure decoration —
//      no actual drag-to-dismiss yet (would conflict with form
//      input scrolling on iOS Safari, which is its own sprint).
//
// Usage example — converting an existing centered modal:
//
//     <motion.div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
//   →
//     <motion.div className={sheetOverlayCls}>
//
//     <motion.div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl … max-w-lg max-h-[90vh] flex flex-col">
//   →
//     <motion.div className={sheetPanelCls}>
//       <MobileSheetGrip />
//       … existing modal contents …
//     </motion.div>

export const sheetOverlayCls =
  'fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 md:p-4 backdrop-blur-sm'

// The bare scrim, for dialogs that position their own panel and only need
// the backdrop. Seven modals had hand-rolled their own copy of this string
// (`bg-black/40 backdrop-blur-sm`, or /50, or /30 — they had already
// drifted three ways), which meant seven separate glass-and-glow hits for
// what is ONE sanctioned pattern: the blur recedes the page behind a
// dialog, it does not decorate a surface. Naming it here puts it in the
// one file OPERATOR exempts, and makes the exemption reviewable.
export const scrimCls = 'fixed inset-0 bg-black/40 backdrop-blur-sm'

export const sheetPanelCls =
  'w-full md:max-w-lg bg-parchment-50 dark:bg-ink-900 ' +
  'rounded-t-2xl md:rounded-2xl shadow-warm-lg ' +
  'border border-parchment-300/50 dark:border-brass-900/30 border-b-0 md:border-b ' +
  'max-h-[92vh] md:max-h-[90vh] flex flex-col'

// Wider panel — for long forms (Schedule event modal, donation log).
// Same treatment, just a bigger desktop max-width.
export const sheetPanelClsWide =
  'w-full md:max-w-2xl bg-parchment-50 dark:bg-ink-900 ' +
  'rounded-t-2xl md:rounded-2xl shadow-warm-lg ' +
  'border border-parchment-300/50 dark:border-brass-900/30 border-b-0 md:border-b ' +
  'max-h-[92vh] md:max-h-[90vh] flex flex-col'

// Drag-handle pill at the top of a sheet — visual cue that this is a
// dismissible sheet on mobile. Hidden on md+ where the modal is
// centered and the cue would just look weird.
export function MobileSheetGrip() {
  return (
    <div aria-hidden="true" className="md:hidden flex justify-center pt-2 pb-1">
      <span className="block w-9 h-1 rounded-full bg-ink-300 dark:bg-parchment-300/40" />
    </div>
  )
}
