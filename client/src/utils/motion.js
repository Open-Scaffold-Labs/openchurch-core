// Shared entrance variants. Motion is deliberate and rare (P8):
// short, ease-out fades when motion is welcome; duration 0 / no offset
// when prefers-reduced-motion is set. PageWrapper and other entrances
// pick a set through these factories so the reduced-motion path is one
// place, not a per-page guess.

export const MOTION_EASE = [0.4, 0, 0.2, 1]

export function pageEntranceVariants(reduceMotion) {
  if (reduceMotion) {
    return {
      hidden: { opacity: 1, y: 0 },
      show: {
        opacity: 1,
        y: 0,
        transition: { duration: 0, ease: MOTION_EASE, staggerChildren: 0 },
      },
    }
  }
  return {
    hidden: { opacity: 0, y: 12 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.25, ease: 'easeOut', staggerChildren: 0.06 },
    },
  }
}

export function itemEntranceVariants(reduceMotion) {
  if (reduceMotion) {
    return {
      hidden: { opacity: 1, y: 0 },
      show: { opacity: 1, y: 0, transition: { duration: 0, ease: MOTION_EASE } },
    }
  }
  return {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut' } },
  }
}

// ── Motion studies (PHILOSOPHY §12, amended 2026-10-25) ─────────────────────
// One place for the approved durations so every surface moves alike.
// Control feedback 150–300ms, panels and dialogs 240–400ms, exits quicker.
// MotionConfig reducedMotion="user" (main.jsx) zeroes transforms for anyone
// who asks for less motion; CSS keyframes yield in index.css.
export const EASE_SETTLE = [0.22, 0.8, 0.32, 1]

// Dialog / certificate panel: rises a few pixels as it fades in, like a page
// lifted off the desk. Entrance only — see ConfirmProvider for why dialogs
// here unmount without an exit animation.
export const dialogPanelMotion = {
  initial: { opacity: 0, y: 14, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { duration: 0.26, ease: EASE_SETTLE },
}

// The scrim behind a dialog dims in a touch faster than the panel arrives.
export const scrimMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.2, ease: 'easeOut' },
}

// Toasts drift down from their corner, then leave a little quicker.
export const toastMotion = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE_SETTLE } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.16, ease: 'easeIn' } },
}

// Rows arriving in a freshly loaded list: one after another, 30ms apart.
export function listRowMotion(index = 0) {
  return {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.26, ease: EASE_SETTLE, delay: Math.min(index, 12) * 0.03 },
  }
}

// A certificate (or any printable document) lifts onto the screen like a
// page set down on the desk. Slightly slower than a dialog: it is the
// document, not a question.
export const paperLiftMotion = {
  initial: { opacity: 0, y: 16, scale: 0.99 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { duration: 0.34, ease: EASE_SETTLE },
}

// A section unfolding to its real height (V1.4, study #15). Height leads,
// content fades in a beat behind it; folding back is quicker.
export const unfoldMotion = {
  initial: { height: 0, opacity: 0 },
  animate: {
    height: 'auto',
    opacity: 1,
    transition: { height: { duration: 0.24, ease: EASE_SETTLE }, opacity: { duration: 0.2, delay: 0.06 } },
  },
  exit: {
    height: 0,
    opacity: 0,
    transition: { height: { duration: 0.18, ease: 'easeIn' }, opacity: { duration: 0.12 } },
  },
}

// A small menu or popover: settles a few pixels into place. Never grows
// from a smaller scale (OPERATOR P8: nothing springs or grows).
export const menuMotion = {
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.16, ease: EASE_SETTLE } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12, ease: 'easeIn' } },
}

// On a phone, dialogs are bottom sheets (MobileSheet sheetPanelCls), so
// they rise from the bottom edge, within thumb reach (V1.5, study #11). On
// wider screens they keep the gentle desk-lift of dialogPanelMotion.
export const sheetRiseMotion = {
  initial: { opacity: 1, y: '100%' },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.32, ease: EASE_SETTLE },
}

// For dialogs that live inside page components: the same phone-aware panel
// motion as useDialogMotion, read at render time so a page needs no extra
// hook. Exit is quick and plain (fade and 8px); nothing scales or springs.
const DIALOG_EXIT = { opacity: 0, y: 8, transition: { duration: 0.16, ease: 'easeIn' } }
export function dialogMotionNow() {
  const phone = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 767px)').matches
  return { ...(phone ? sheetRiseMotion : dialogPanelMotion), exit: DIALOG_EXIT }
}

// A side drawer (member, gift, payroll detail) slides in from the right on
// an eased curve and leaves quicker. Never a spring (OPERATOR P8).
export const drawerMotion = {
  initial: { x: '100%' },
  animate: { x: 0, transition: { duration: 0.32, ease: EASE_SETTLE } },
  exit: { x: '100%', transition: { duration: 0.22, ease: 'easeIn' } },
}

// A shared marker that glides between tabs or links (layoutId).
export const glideTransition = { duration: 0.22, ease: EASE_SETTLE }
