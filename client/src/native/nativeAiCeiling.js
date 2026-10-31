// The archive ceiling is the user agent baked into the iOS shell at
// ios:sync, not a Vite variable in the page. With CAP_SERVER_URL set, the
// WebView loads hosted JavaScript, and that bundle's VITE value can change
// without a new archive. The shell's appendUserAgent cannot. Missing or
// any other token stays excluded. A server may tighten this ceiling. A
// hosted bundle cannot raise it. This is not device attestation.
//
// A rebuilt shell that strips OpenChurchNative is indistinguishable from
// the web app. A browser that presents the token is treated as that shell.

import { isNativeShell } from './nativeShell.js'

export const NATIVE_SHELL_UA = 'OpenChurchNative'
export const NATIVE_AI_ARCHIVE_TOKEN = 'OpenChurchNativeAi/consent-required'
export const NATIVE_AI_CEILING_HEADER = 'X-OC-Native-Ai-Ceiling'

export function archiveNativeAiCeiling(env = {}) {
  return env.OC_IOS_AI_CEILING === 'consent-required' ? 'consent-required' : 'excluded'
}

export function nativeShellUserAgent(ceiling) {
  return ceiling === 'consent-required'
    ? `${NATIVE_SHELL_UA} ${NATIVE_AI_ARCHIVE_TOKEN}`
    : NATIVE_SHELL_UA
}

export function ceilingFromUserAgent(ua) {
  const parts = String(ua || '').split(/\s+/)
  return parts.includes(NATIVE_AI_ARCHIVE_TOKEN) ? 'consent-required' : 'excluded'
}

// ios:sync writes this onto capacitor.config.json before cap sync, then
// restores the committed file. The copy Xcode archives keeps the token.
export function applyArchiveAiCeiling(config, env = {}) {
  return { ...config, appendUserAgent: nativeShellUserAgent(archiveNativeAiCeiling(env)) }
}

export function nativeAiBuildCeiling(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  return ceilingFromUserAgent(ua)
}

export function intersectNativeAiMode(ceiling, serverMode) {
  if (ceiling === 'consent-required' && serverMode === 'consent-required') return 'consent-required'
  return 'excluded'
}

export function nativeAiFetchInit(init = {}) {
  if (!isNativeShell()) return init
  const headers = new Headers(init.headers || {})
  headers.set(NATIVE_AI_CEILING_HEADER, nativeAiBuildCeiling())
  return { ...init, headers }
}
