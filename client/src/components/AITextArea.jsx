import { useState } from 'react'
import { Feather, Loader2 } from 'lucide-react'
import { apiUrl } from '../api'
import { nativeAiFetchInit } from '../native/nativeAiCeiling'
import { useLocale } from '../i18n'
import { useToast } from './ToastProvider'
import { aiRefusalMessage } from '../utils/aiRefusal'
import { allowsAiSend, aiSurfacesClosed } from '../native/aiGate'
import { useNativeAi } from '../native/NativeAiContext'
import { AiConsentScreen } from '../native/AiConsentScreen'

export default function AITextArea({ value, onChange, placeholder, className = '', context = '', ...props }) {
  const [loading, setLoading] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)
  const { t } = useLocale()
  const toast = useToast()
  const { kind } = useNativeAi()
  const closed = aiSurfacesClosed(kind)

  const enhance = async () => {
    if (!value.trim()) return
    if (!allowsAiSend(kind)) {
      setConsentOpen(true)
      return
    }
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/ai/enhance'), nativeAiFetchInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: value, context }),
      }))
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.result) onChange({ target: { value: data.result } })
      // A refusal is said out loud; the original text is left intact.
      else if (!res.ok) toast.error(aiRefusalMessage(t, data, 'ai.refusal.ai_failed'))
    } catch {
      // network failure — leave original text intact
    } finally {
      setLoading(false)
    }
  }

  if (closed) {
    return (
      <textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder} aria-label={placeholder}
        className={className}
        {...props}
      />
    )
  }

  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder} aria-label={placeholder}
        className={`pr-9 ${className}`}
        {...props}
      />
      <button
        type="button"
        data-testid="ai-enhance"
        onClick={enhance}
        disabled={loading || !value.trim()}
        className="absolute top-2 right-2 p-1 rounded text-ink-400 hover:text-church-600 disabled:opacity-30 transition-colors"
        title={t('ai.enhance')}
      >
        {loading ? <Loader2 size={15} className="animate-spin" /> : <Feather size={15} />}
      </button>
      {consentOpen && <AiConsentScreen variant="dialog" onClose={() => setConsentOpen(false)} />}
    </div>
  )
}
