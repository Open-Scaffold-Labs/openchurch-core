// HTTP admission for /api/ai and /api/assistant from the native shell.
// Mounted before the route handlers so a refused call never reserves
// quota and never reaches dispatch. dispatch() checks again: this
// middleware is not the only gate.

import { aiRefusal, refusalBody } from './gate.js'
import { configuredNativeAiMode, effectiveNativeAiMode, isNativeShellRequest, nativeAiCeilingFromRequest } from './nativeAiMode.js'
import { hasActiveNativeAiConsent } from './nativeAiConsent.js'

function refuse(res, code) {
  const r = refusalBody(aiRefusal(code))
  return res.status(r.status).json(r.body)
}

export async function nativeAiHttpGate(req, res, next) {
  if (!isNativeShellRequest(req)) return next()
  const mode = effectiveNativeAiMode(configuredNativeAiMode(), nativeAiCeilingFromRequest(req))
  if (mode !== 'consent-required') return refuse(res, 'ai_excluded')
  try {
    const active = await hasActiveNativeAiConsent(req.organizationId, req.user.id)
    if (!active) return refuse(res, 'ai_consent_required')
    return next()
  } catch {
    return refuse(res, 'ai_consent_unknown')
  }
}
