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
