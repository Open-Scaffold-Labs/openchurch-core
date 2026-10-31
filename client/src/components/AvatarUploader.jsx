import { useRef, useState } from 'react'
import { Camera, Loader2, Trash2 } from 'lucide-react'
import UserAvatar from './UserAvatar'
import { useToast } from './ToastProvider'
import { useLocale } from '../i18n'

// Controlled profile-picture picker. Used both for the signed-in
// user's own avatar (Preferences) and for a member's avatar (the
// member edit modal) — the parent owns persistence; this component
// only produces a resized base64 data URL.
//
// Props:
//   value     — current avatar data URL, or null
//   name      — person's name, for the initials fallback + alt text
//   onChange  — called with the new data URL, or null when removed
//   busy      — optional; disables the controls while the parent saves
//
// Every selected file is center-cropped to a square and downscaled to
// 256px, re-encoded JPEG q0.82 in a canvas. That caps the payload at
// ~30–50 KB before it ever leaves the browser — essential, since the
// avatar is stored as base64 in a DB column. A 6 MB phone photo would
// otherwise become a ~8 MB row.

const OUTPUT_SIZE = 256
const JPEG_QUALITY = 0.82

// Rejections carry an i18n key, not an English sentence, so the toast
// follows the parish language.
function keyedError(key) {
  const err = new Error(key)
  err.i18nKey = key
  return err
}

function fileToSquareDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(keyedError('avatar.notImage'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(keyedError('avatar.readFailed'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(keyedError('avatar.invalidImage'))
      img.onload = () => {
        // Center-crop the longest side to a square, then downscale.
        const min = Math.min(img.width, img.height)
        const sx = (img.width  - min) / 2
        const sy = (img.height - min) / 2
        const canvas = document.createElement('canvas')
        canvas.width = OUTPUT_SIZE
        canvas.height = OUTPUT_SIZE
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, sx, sy, min, min, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

export default function AvatarUploader({ value, name, onChange, busy = false }) {
  const fileRef = useRef(null)
  const [processing, setProcessing] = useState(false)
  const toast = useToast()
  const { t } = useLocale()

  const disabled = busy || processing

  async function handleFile(e) {
    const file = e.target.files?.[0]
    // Reset the input so picking the same file twice still fires onChange.
    e.target.value = ''
    if (!file) return
    setProcessing(true)
    try {
      const dataUrl = await fileToSquareDataUrl(file)
      onChange(dataUrl)
    } catch (err) {
      toast.error(t(err?.i18nKey || 'avatar.processFailed'))
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative">
        <UserAvatar
          avatar={value}
          name={name}
          className="w-20 h-20"
          textClassName="text-xl"
        />
        {processing && (
          <div className="absolute inset-0 rounded-full bg-ink-900/50 flex items-center justify-center">
            <Loader2 size={18} className="animate-spin text-parchment-50" />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={handleFile}
          className="hidden"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-church-900 dark:bg-church-700 text-parchment-50 text-xs font-semibold shadow-warm hover:bg-church-800 dark:hover:bg-church-600 transition-colors disabled:opacity-50"
        >
          <Camera size={13} aria-hidden="true" />
          {value ? t('avatar.change') : t('avatar.upload')}
        </button>
        {value && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(null)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-500 dark:text-parchment-300/70 hover:text-rose-700 dark:hover:text-rose-300 transition-colors disabled:opacity-50"
          >
            <Trash2 size={12} aria-hidden="true" /> {t('avatar.remove')}
          </button>
        )}
        {/* ink-500, not ink-400. At 11px on parchment, ink-400 measures
              3.62:1 — under the 4.5:1 AA floor for body text. Found by axe
              while reviewing the language card on this page; the helper text
              beside it already used ink-500 and passed, which is what made
              the difference visible. */}
          <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 leading-snug max-w-[12rem]">
          {t('avatar.help')}
        </p>
      </div>
    </div>
  )
}
