// Runtime fact: this page is inside the Capacitor iOS shell.
//
// The native bridge sets window.Capacitor before page scripts run, and
// the shell appends OpenChurchNative to the user agent. Neither check
// imports a Capacitor package, so the hosted web bundle does not load
// one. A desktop browser has neither signal.

export function isNativeShell() {
  if (typeof window === 'undefined') return false
  try {
    if (window.Capacitor?.isNativePlatform?.()) return true
  } catch {
    // A broken bridge is not a native shell.
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
  return /OpenChurchNative/i.test(ua)
}
