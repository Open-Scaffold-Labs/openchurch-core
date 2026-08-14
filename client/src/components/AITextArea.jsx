import { useState } from 'react'
import { Feather, Loader2 } from 'lucide-react'
import { apiUrl } from '../api'

export default function AITextArea({ value, onChange, placeholder, className = '', context = '', ...props }) {
  const [loading, setLoading] = useState(false)

  const enhance = async () => {
    if (!value.trim()) return
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/ai/enhance'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: value, context }),
      })
      const data = await res.json()
      if (data.result) onChange({ target: { value: data.result } })
    } catch {
      // silently fail — leave original text intact
    } finally {
      setLoading(false)
    }
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
        onClick={enhance}
        disabled={loading || !value.trim()}
        className="absolute top-2 right-2 p-1 rounded text-ink-400 hover:text-church-600 disabled:opacity-30 transition-colors"
        title="Enhance with AI"
      >
        {loading ? <Loader2 size={15} className="animate-spin" /> : <Feather size={15} />}
      </button>
    </div>
  )
}
