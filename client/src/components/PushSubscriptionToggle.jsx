import { useEffect, useState } from 'react'
import { BellRing, Loader2 } from 'lucide-react'
import { apiUrl } from '../api'
import { useToast } from './ToastProvider'

// Web Push device-subscription toggle (Sprint PWA / PWA.4b).
//
// Sits on the Preferences page next to the per-template notification
// prefs. Different axis from those: prefs control WHICH templates a
// user wants; this toggle controls WHETHER THIS DEVICE receives push
// at all. Multi-device by design — flipping it on a phone doesn't
// affect the user's laptop subscription.
//
// Render states, in priority order:
//   1. Not supported           — browser lacks serviceWorker / PushManager.
//                                Render an info card explaining iOS needs
//                                home-screen install first.
//   2. No VAPID configured     — server returned publicKey: null. Toggle
//                                disabled with a soft "push isn't set up
//                                on this server yet" hint. (Lets the
//                                feature ship before keys are generated.)
//   3. Permission denied       — explicit deny from the OS. Toggle
//                                disabled with a "you blocked it; reset
//                                in browser settings" line.
//   4. Configured + permission default / granted — interactive toggle.
//                                Subscribing requests permission via
//                                the browser, registers with the push
//                                service, and POSTs to /api/push/subscribe.
//
// Permission model: we never auto-prompt. The user explicitly opts in
// by flipping the toggle. Pre-prompt education lives in the component
// description text so the OS prompt isn't a surprise.

// VAPID public keys are URL-safe base64 strings; the browser
// subscribe() API wants a Uint8Array. Standard W3C boilerplate.
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function browserSupportsPush() {
  return typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager'  in window
      && 'Notification' in window
}

export default function PushSubscriptionToggle() {
  const toast = useToast()
  const [loading, setLoading]       = useState(true)
  const [busy, setBusy]             = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [publicKey, setPublicKey]   = useState(null)
  const [permission, setPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  )

  const supported = browserSupportsPush()

  // Initial probe: fetch vapid-key + ask the current SW for an
  // existing subscription. Don't request permission — we only check.
  useEffect(() => {
    let cancelled = false
    async function probe() {
      if (!supported) { setLoading(false); return }
      try {
        const keyRes = await fetch(apiUrl('/api/push/vapid-key'))
        const keyData = keyRes.ok ? await keyRes.json() : { publicKey: null }
        if (cancelled) return
        setPublicKey(keyData.publicKey || null)

        const reg = await navigator.serviceWorker.ready
        const existing = await reg.pushManager.getSubscription()
        if (!cancelled) setSubscribed(Boolean(existing))
      } catch {
        // Probe failures shouldn't surface a toast — the worst case
        // is the toggle renders as "off" and the user can flip it on,
        // which will surface a real error if there is one.
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    probe()
    return () => { cancelled = true }
  }, [supported])

  async function subscribe() {
    if (!publicKey) return
    setBusy(true)
    try {
      // Permission first — if not granted, ask. The OS surface will
      // remember 'denied' across sessions; we have to send the user
      // to browser settings to reset.
      let p = Notification.permission
      if (p === 'default') p = await Notification.requestPermission()
      setPermission(p)
      if (p !== 'granted') {
        toast.error('Notification permission was not granted')
        return
      }

      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, // browser requires user-visible push
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })

      const res = await fetch(apiUrl('/api/push/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        // If the server can't accept it, tear down the local
        // subscription so the next attempt starts clean.
        await sub.unsubscribe().catch(() => {})
        throw new Error(data.error || `Subscribe failed (${res.status})`)
      }
      setSubscribed(true)
      toast.success?.('Push notifications enabled on this device')
    } catch (err) {
      toast.error(err.message || 'Could not enable push')
    } finally {
      setBusy(false)
    }
  }

  async function unsubscribe() {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        // Soft-remove on the server FIRST (still uses the endpoint).
        // If the server rejects we leave the device subscribed so the
        // two stay in sync. Only after the server ack do we unsubscribe
        // locally.
        // This block's own comment says the local unsubscribe happens only
        // after the server acknowledges — it did not check, so the two could
        // and did drift apart. Now it actually waits for the ack.
        const res = await fetch(apiUrl('/api/push/subscribe'), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        })
        if (!res.ok) throw new Error('Could not disable push just now')
        await sub.unsubscribe().catch(() => {})
      }
      setSubscribed(false)
    } catch (err) {
      toast.error(err.message || 'Could not disable push')
    } finally {
      setBusy(false)
    }
  }

  // ---- Render branches --------------------------------------------------

  const containerCls = 'bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-sm overflow-hidden'

  if (loading) {
    return (
      <div className={containerCls}>
        <div className="flex items-center justify-center py-10">
          <Loader2 size={18} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      </div>
    )
  }

  // 1. Not supported (older browser, iOS Safari before home-screen install).
  if (!supported) {
    return (
      <div className={containerCls}>
        <Header />
        <div className="px-5 py-4 text-xs text-ink-500 dark:text-parchment-300/70">
          Push notifications aren't supported in this browser. On iPhone,
          install OpenChurch to your home screen first — push works inside
          the installed app, not in the Safari tab.
        </div>
      </div>
    )
  }

  // 2. No VAPID configured server-side. Disable the toggle with a soft hint.
  if (!publicKey) {
    return (
      <div className={containerCls}>
        <Header />
        <Row
          label="Push notifications on this device"
          description="Server-side push isn't configured yet. Once your team lead adds VAPID keys this toggle will go live."
          enabled={false}
          disabled
        />
      </div>
    )
  }

  // 3. Permission explicitly denied by the OS.
  if (permission === 'denied') {
    return (
      <div className={containerCls}>
        <Header />
        <Row
          label="Push notifications on this device"
          description="You blocked notifications for this site. Reset the permission in your browser settings to enable push."
          enabled={false}
          disabled
        />
      </div>
    )
  }

  // 4. Interactive — default / granted.
  return (
    <div className={containerCls}>
      <Header />
      <Row
        label="Push notifications on this device"
        description={subscribed
          ? "Reminders for the templates above will pop on this device. You'll see a small icon in your tray when one arrives."
          : "Turn on to receive event + task reminders even when OpenChurch isn't open."
        }
        enabled={subscribed}
        disabled={busy}
        onClick={() => (subscribed ? unsubscribe() : subscribe())}
      />
    </div>
  )
}

function Header() {
  return (
    <div className="px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25 flex items-center gap-2">
      <BellRing size={15} className="text-brass-600 dark:text-brass-300" />
      <h2 className="font-semibold text-ink-900 dark:text-parchment-50">Push on this device</h2>
    </div>
  )
}

function Row({ label, description, enabled, disabled, onClick }) {
  return (
    <div className="px-5 py-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-900 dark:text-parchment-50">{label}</p>
        <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        aria-label={enabled ? 'Disable push on this device' : 'Enable push on this device'}
        disabled={disabled}
        onClick={onClick}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${
          enabled
            ? 'bg-church-900 dark:bg-brass-500'
            : 'bg-parchment-300 dark:bg-ink-700'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            enabled ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}
