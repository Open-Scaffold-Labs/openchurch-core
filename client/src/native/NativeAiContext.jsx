import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { apiUrl } from '../api'
import { isNativeShell } from './nativeShell'
import { nativeAiBuildCeiling, nativeAiFetchInit, intersectNativeAiMode } from './nativeAiCeiling'
import { NATIVE_AI_DISCLOSURE_VERSION } from './nativeAiDisclosure'

const WEB = {
  kind: 'web',
  consent: null,
  agree: async () => ({ ok: false }),
  withdraw: async () => ({ ok: false }),
}

const NativeAiContext = createContext(WEB)

export function useNativeAi() {
  return useContext(NativeAiContext)
}

export function classifyNativeAccess(data, { ceiling = nativeAiBuildCeiling(), renderedVersion = NATIVE_AI_DISCLOSURE_VERSION } = {}) {
  if (!data || data.applies !== true) return 'unavailable'
  const mode = intersectNativeAiMode(ceiling, data.mode)
  if (mode !== 'consent-required') {
    if (data.mode === 'excluded' || ceiling !== 'consent-required') return 'excluded'
    return 'unavailable'
  }
  if (data.required_disclosure_version !== renderedVersion) return 'disclosure-stale'
  const c = data.consent
  if (data.consent_active === true && c && !c.withdrawn_at && c.consented_at && c.disclosure_version === renderedVersion) {
    return 'open'
  }
  return 'consent'
}

export function NativeAiState({ kind = 'web', consent = null, agree, withdraw, children }) {
  const value = useMemo(() => ({
    kind,
    consent,
    agree: agree || (async () => ({ ok: false })),
    withdraw: withdraw || (async () => ({ ok: false })),
  }), [kind, consent, agree, withdraw])
  return <NativeAiContext.Provider value={value}>{children}</NativeAiContext.Provider>
}

async function readJson(res) {
  // A non-OK body is not access data. Callers treat null as unavailable.
  if (!res.ok) return null
  try { return await res.json() } catch { return null }
}

export function NativeAiProvider({ children }) {
  const native = isNativeShell()
  const [kind, setKind] = useState(native ? 'pending' : 'web')
  const [consent, setConsent] = useState(null)

  const apply = useCallback((data) => {
    setConsent(data?.consent ?? null)
    setKind(classifyNativeAccess(data))
  }, [])

  const refresh = useCallback(async () => {
    if (!isNativeShell()) {
      setKind('web')
      setConsent(null)
      return { ok: true, kind: 'web' }
    }
    try {
      const res = await fetch(apiUrl('/api/ai/native-access'), nativeAiFetchInit())
      const data = await readJson(res)
      if (!res.ok || !data) {
        setKind('unavailable')
        setConsent(null)
        return { ok: false, kind: 'unavailable' }
      }
      apply(data)
      return { ok: true, kind: classifyNativeAccess(data) }
    } catch {
      setKind('unavailable')
      setConsent(null)
      return { ok: false, kind: 'unavailable' }
    }
  }, [apply])

  useEffect(() => {
    if (!native) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(apiUrl('/api/ai/native-access'), nativeAiFetchInit())
        const data = await readJson(res)
        if (cancelled) return
        if (!res.ok || !data) {
          setKind('unavailable')
          setConsent(null)
          return
        }
        apply(data)
      } catch {
        if (!cancelled) {
          setKind('unavailable')
          setConsent(null)
        }
      }
    })()
    return () => { cancelled = true }
  }, [native, apply])

  const agree = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/ai/native-access'), nativeAiFetchInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disclosure_version: NATIVE_AI_DISCLOSURE_VERSION }),
      }))
      const data = await readJson(res)
      if (res.ok && classifyNativeAccess(data) === 'open') {
        apply(data)
        return { ok: true }
      }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  }, [apply])

  const withdraw = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/ai/native-access/withdraw'), nativeAiFetchInit({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }))
      const data = await readJson(res)
      if (res.ok && data?.consent_active === false) {
        apply({
          ...data,
          applies: true,
          mode: 'consent-required',
          required_disclosure_version: data.required_disclosure_version || NATIVE_AI_DISCLOSURE_VERSION,
        })
        return { ok: true }
      }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  }, [apply])

  const value = useMemo(
    () => (native ? { kind, consent, agree, withdraw } : WEB),
    [native, kind, consent, agree, withdraw],
  )

  return <NativeAiContext.Provider value={value}>{children}</NativeAiContext.Provider>
}
