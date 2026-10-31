// Native iOS AI capability. This is not the platform AI stop.
//
// ochr_platform_ai_switch (migration 116, /api/admin/ai-switch) is the
// operator kill switch: it stops AI for every caller, web and native.
// dispatch() still consults that switch first (ai/gate.js assertAiRunning).
//
// OC_NATIVE_AI_MODE is the host's permission. It can tighten a native
// candidate. It cannot raise one. The candidate's ceiling is the user
// agent ios:sync baked into the shell (OpenChurchNativeAi/consent-required).
// A hosted bundle's X-OC-Native-Ai-Ceiling header cannot raise that.
// Missing or any other archive token is excluded. Web requests do not
// consult either one. Do not store a provider key here.

export const NATIVE_AI_ARCHIVE_TOKEN = 'OpenChurchNativeAi/consent-required'

export const NATIVE_AI_DISCLOSURE_VERSION = 'draft-2026-10-24'

const NATIVE_UA = /OpenChurchNative/i

export function configuredNativeAiMode(env = process.env) {
  // Literal process.env read so the env tripwire sees OC_NATIVE_AI_MODE.
  // Tests pass a fake env object; the live process uses the real variable.
  const raw = env === process.env ? process.env.OC_NATIVE_AI_MODE : env.OC_NATIVE_AI_MODE
  return raw === 'consent-required' ? 'consent-required' : 'excluded'
}

export function nativeAiCeilingFromUserAgent(ua) {
  const parts = String(ua || '').split(/\s+/)
  return parts.includes(NATIVE_AI_ARCHIVE_TOKEN) ? 'consent-required' : 'excluded'
}

export function nativeAiCeilingFromRequest(req) {
  const ua = req?.get?.('user-agent') || req?.headers?.['user-agent'] || ''
  const archive = nativeAiCeilingFromUserAgent(ua)
  // The hosted page cannot raise an excluded archive. A header may only
  // tighten a consent-capable one. An absent header leaves the archive.
  if (archive !== 'consent-required') return 'excluded'
  const raw = req?.get?.('x-oc-native-ai-ceiling') ?? req?.headers?.['x-oc-native-ai-ceiling']
  if (raw == null) return 'consent-required'
  return String(raw) === 'consent-required' ? 'consent-required' : 'excluded'
}

// Host permission intersected with the binary's ceiling. Either side
// being anything other than consent-required leaves the shell excluded.
export function effectiveNativeAiMode(hostMode, ceiling) {
  if (hostMode === 'consent-required' && ceiling === 'consent-required') return 'consent-required'
  return 'excluded'
}

// The shipped shell appends OpenChurchNative to its user agent
// (client/capacitor.config.json). A browser cannot set that header.
// A browser that somehow presents it loses AI (fail closed). A rebuilt
// shell that strips the token is indistinguishable from the web app.
export function isNativeShellRequest(req) {
  const ua = req?.get?.('user-agent') || req?.headers?.['user-agent'] || ''
  return NATIVE_UA.test(String(ua))
}

// Problem-report triage is a provider send. The ticket itself is not.
// Web: allowed (the platform stop inside dispatch still applies).
// Native excluded, or consent-required without an active agreement: no send.
export function supportTriageAllowed({ native, mode, consentActive }) {
  if (!native) return true
  if (mode !== 'consent-required') return false
  return consentActive === true
}
