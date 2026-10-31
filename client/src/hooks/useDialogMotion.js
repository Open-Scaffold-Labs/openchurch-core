import { useEffect, useState } from 'react'
import { dialogPanelMotion, sheetRiseMotion } from '../utils/motion'

// Matches the md breakpoint MobileSheet uses: below it a dialog is a
// bottom sheet and rises from the bottom; at md and up it lifts gently.
const PHONE_QUERY = '(max-width: 767px)'

function isPhone() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(PHONE_QUERY).matches
}

export function useDialogMotion() {
  const [phone, setPhone] = useState(isPhone)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(PHONE_QUERY)
    const onChange = (e) => setPhone(e.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return phone ? sheetRiseMotion : dialogPanelMotion
}
