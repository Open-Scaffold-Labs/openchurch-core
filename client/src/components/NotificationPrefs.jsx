import { useEffect, useState } from 'react'
import { Bell, Loader2 } from 'lucide-react'
import { apiUrl } from '../api'
import { useToast } from './ToastProvider'

// Notification preferences toggle list. Self-serve — reads/writes
// /api/notification-prefs which scopes to the auth'd user.
//
// Optimistic update: flipping a toggle updates the UI immediately, the
// PATCH happens in the background, and on failure the toggle reverts.
// Avoids the "click → spinner → tick" delay on every interaction.

export default function NotificationPrefs() {
  const [prefs, setPrefs]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [savingType, setSavingType] = useState(null)
  const toast = useToast()

  useEffect(() => {
    let cancelled = false
    fetch(apiUrl('/api/notification-prefs'))
      .then(async r => {
        if (!r.ok) throw new Error('Failed to load preferences')
        return r.json()
      })
      .then(data => { if (!cancelled) setPrefs(data.prefs ?? []) })
      .catch(err => { if (!cancelled) toast.error(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [toast])

  async function toggle(notification_type, nextEnabled) {
    // Optimistic flip — user sees the change immediately.
    setPrefs(p => p.map(x =>
      x.notification_type === notification_type ? { ...x, enabled: nextEnabled } : x
    ))
    setSavingType(notification_type)
    try {
      const res = await fetch(apiUrl('/api/notification-prefs'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notification_type, enabled: nextEnabled }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Save failed (${res.status})`)
      }
    } catch (err) {
      // Revert the optimistic flip — keep the visual model honest.
      setPrefs(p => p.map(x =>
        x.notification_type === notification_type ? { ...x, enabled: !nextEnabled } : x
      ))
      toast.error(err.message || 'Could not update preference')
    } finally {
      setSavingType(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
      </div>
    )
  }
  if (!prefs?.length) return null

  return (
    <div className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25 flex items-center gap-2">
        <Bell size={15} className="text-brass-600 dark:text-brass-300" />
        <h2 className="font-semibold text-ink-900 dark:text-parchment-50">Notification preferences</h2>
      </div>
      <ul className="divide-y divide-parchment-200/50 dark:divide-brass-900/20">
        {prefs.map(p => {
          const isSaving = savingType === p.notification_type
          return (
            <li key={p.notification_type} className="px-5 py-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-900 dark:text-parchment-50">{p.label}</p>
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">{p.description}</p>
              </div>
              <button
                role="switch"
                aria-checked={p.enabled}
                aria-label={`${p.enabled ? 'Disable' : 'Enable'} ${p.label}`}
                disabled={isSaving}
                onClick={() => toggle(p.notification_type, !p.enabled)}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${
                  p.enabled
                    ? 'bg-church-900 dark:bg-brass-500'
                    : 'bg-parchment-300 dark:bg-ink-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                    p.enabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="px-5 py-3 border-t border-parchment-300/50 dark:border-brass-900/25 bg-parchment-100/40 dark:bg-ink-800/20 text-xs text-ink-500 dark:text-parchment-300/70">
        Email delivery is being set up — for now, notifications are recorded but not sent.
      </div>
    </div>
  )
}
