import { useState, useRef } from 'react'
import { Mic, MicOff } from 'lucide-react'
import { useToast } from './ToastProvider'

export default function DictationInput({ value, onChange, placeholder, className = '', ...props }) {
  const toast = useToast()
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef(null)

  const toggleDictation = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      // Was a native alert() — the last one in the app. It is a fallback
      // notice rather than an error, so it goes through the toast channel
      // like every other message. (OPERATOR P1.)
      toast.info('Dictation is not supported in this browser. You can still type.')
      return
    }

    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript
      onChange({ target: { value: value ? `${value} ${transcript}` : transcript } })
    }

    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)

    recognitionRef.current = recognition
    recognition.start()
    setListening(true)
  }

  return (
    <div className="relative flex items-center">
      <input
        value={value}
        onChange={onChange}
        placeholder={placeholder} aria-label={placeholder}
        className={`pr-9 ${className}`}
        {...props}
      />
      <button
        type="button"
        onClick={toggleDictation}
        className={`absolute right-2 p-1 rounded transition-colors ${
          listening
            ? 'text-rose-500 hover:text-rose-700'
            : 'text-ink-400 hover:text-church-600'
        }`}
        title={listening ? 'Stop dictation' : 'Start dictation'}
      >
        {listening ? <MicOff size={15} /> : <Mic size={15} />}
      </button>
    </div>
  )
}
