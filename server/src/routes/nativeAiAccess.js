// The native shell asks this route what it is allowed to show, and — only
// in consent-required mode — records or withdraws one person's agreement.
// Web clients get applies:false and cannot write a row.
//
// Identifiers are the verified JWT only. A user_id in the body is ignored.

import { Router } from 'express'
import {
  NATIVE_AI_DISCLOSURE_VERSION,
  configuredNativeAiMode,
  effectiveNativeAiMode,
  isNativeShellRequest,
  nativeAiCeilingFromRequest,
} from '../ai/nativeAiMode.js'
import {
  nativeAiConsentView,
  recordNativeAiConsent,
  withdrawNativeAiConsent,
} from '../ai/nativeAiConsent.js'
import { ORGANIZATION_HELD, isHoldRefusal } from '../auth/organizationHold.js'
import { monitor } from '../monitoring/index.js'

const router = Router()

function webBody() {
  return { applies: false, mode: 'web', consent_active: false, consent: null }
}

function nativeMode(req) {
  return effectiveNativeAiMode(configuredNativeAiMode(), nativeAiCeilingFromRequest(req))
}

router.get('/', async (req, res) => {
  if (!isNativeShellRequest(req)) return res.json(webBody())
  const mode = nativeMode(req)
  if (mode !== 'consent-required') {
    return res.json({ applies: true, mode: 'excluded', consent_active: false, consent: null })
  }
  try {
    const view = await nativeAiConsentView(req.organizationId, req.user.id)
    res.json({
      applies: true,
      mode: 'consent-required',
      required_disclosure_version: NATIVE_AI_DISCLOSURE_VERSION,
      ...view,
    })
  } catch (err) {
    monitor.error('nativeAi.access.get', err, { orgId: req.organizationId })
    res.status(503).json({ code: 'ai_consent_unknown', error: 'We could not read the AI agreement, so AI stays off. Nothing was sent.' })
  }
})

router.post('/', async (req, res) => {
  if (!isNativeShellRequest(req)) {
    return res.status(403).json({ code: 'not_native', error: 'This agreement is only recorded in the iOS app.' })
  }
  if (nativeMode(req) !== 'consent-required') {
    return res.status(403).json({ code: 'ai_excluded', error: 'AI is not part of this app. Nothing was saved.' })
  }
  const disclosureVersion = typeof req.body?.disclosure_version === 'string' ? req.body.disclosure_version : ''
  try {
    const view = await recordNativeAiConsent({
      organizationId: req.organizationId,
      userId: req.user.id,
      disclosureVersion,
    })
    res.status(view.already ? 200 : 201).json({
      applies: true,
      mode: 'consent-required',
      required_disclosure_version: NATIVE_AI_DISCLOSURE_VERSION,
      ...view,
    })
  } catch (err) {
    if (err?.code === 'ai_disclosure_mismatch') {
      return res.status(409).json({
        code: 'ai_disclosure_mismatch',
        required_disclosure_version: NATIVE_AI_DISCLOSURE_VERSION,
        error: 'This app is showing an agreement that is not the current one. Nothing was saved. AI stays off.',
      })
    }
    if (isHoldRefusal(err)) return res.status(409).json({ error: ORGANIZATION_HELD })
    monitor.error('nativeAi.access.record', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'That did not save. Nothing was sent. Please try again.' })
  }
})

router.patch('/withdraw', async (req, res) => {
  if (!isNativeShellRequest(req)) {
    return res.status(403).json({ code: 'not_native', error: 'This agreement is only recorded in the iOS app.' })
  }
  if (nativeMode(req) !== 'consent-required') {
    return res.status(403).json({ code: 'ai_excluded', error: 'AI is not part of this app. Nothing was changed.' })
  }
  try {
    const view = await withdrawNativeAiConsent({ organizationId: req.organizationId, userId: req.user.id })
    res.json({
      applies: true,
      mode: 'consent-required',
      required_disclosure_version: NATIVE_AI_DISCLOSURE_VERSION,
      ...view,
    })
  } catch (err) {
    if (isHoldRefusal(err)) return res.status(409).json({ error: ORGANIZATION_HELD })
    monitor.error('nativeAi.access.withdraw', err, { orgId: req.organizationId })
    res.status(500).json({ error: 'That did not withdraw. The agreement is unchanged. Nothing new was sent.' })
  }
})

export default router
