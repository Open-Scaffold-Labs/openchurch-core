import { useEffect, useRef, useState } from 'react'
import { BellRing, Loader2 } from 'lucide-react'
import { apiUrl } from '../api'
import { useLocale } from '../i18n'
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
//   2. Key unread              — the vapid-key read was refused, threw,
//                                or came back unreadable, including an
//                                OK body with no own publicKey. Say so
//                                with the shared load-failure copy. Do
//                                not claim the server has no VAPID keys,
//                                and do not enable the subscribe toggle.
//   3. No VAPID configured     — an OK response whose own publicKey is
//                                null or empty. Toggle disabled with a
//                                soft "push isn't set up on this server
//                                yet" hint. (Lets the feature ship before
//                                keys are generated.) The server sends
//                                null from getVapidPublicKey() when the
//                                env is unset.
//   4. Device unread           — the key is configured, but this
//                                device's subscription has never been
//                                read. Say that it is unknown, not off.
//                                Do not claim the server was unreachable.
//   5. Permission denied       — explicit deny from the OS. Toggle
//                                disabled with a "you blocked it; reset
//                                in browser settings" line.
//   6. Configured + permission default / granted — interactive toggle.
//                                on/off only after a successful device
//                                read. A later failed read keeps that
//                                answer. Subscribing requests permission
//                                via the browser, registers with the push
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

// An OK body is a fact about the server. Anything else is "we could
// not read it", which must not be stored as an empty key — that is
// the shape the unset card already uses.
function classifyVapidBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 'unread' }
  // `key == null` is true for a missing property too. An empty object
  // is then the same screen as a server that sent publicKey: null.
  if (!Object.hasOwn(body, 'publicKey')) return { status: 'unread' }
  const key = body.publicKey
  if (typeof key === 'string') {
    if (key.trim() === '') return { status: 'unset' }
    return { status: 'configured', publicKey: key }
  }
  if (key === null) return { status: 'unset' }
  return { status: 'unread' }
}

// probeNonce asks the same card to read again. Preferences does not
// pass it. Remounting would forget a subscription already read.
export default function PushSubscriptionToggle({ probeNonce = 0 }) {
  const { t } = useLocale()
  const toast = useToast()
  const [loading, setLoading]       = useState(true)
  const [busy, setBusy]             = useState(false)
  // null: this device has never been read. false is a successful read
  // of "no subscription", which is a different fact.
  const [subscribed, setSubscribed] = useState(null)
  const subscribedRef = useRef(null)
  subscribedRef.current = subscribed
  const [publicKey, setPublicKey]   = useState(null)
  const [probe, setProbe]           = useState('pending')
  const [attempt, setAttempt]       = useState(0)
  const [permission, setPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  )

  const supported = browserSupportsPush()

  // Probe: read the vapid key, then (only when it is a real key) ask
  // the current service worker for an existing subscription. Don't
  // request permission — we only check. A refused or unreadable key
  // stays unread; it is not rewritten into the unset shape. A failed
  // device lookup does not rewrite a known subscription into "off",
  // and it does not invent "off" when nothing has been read yet.
  useEffect(() => {
    let cancelled = false
    async function probeKey() {
      if (!supported) { setLoading(false); return }
      // A refresh of a device we already read leaves that answer on
      // screen. The first read is the one that has nothing to show.
      if (subscribedRef.current === null) setLoading(true)
      try {
        const keyRes = await fetch(apiUrl('/api/push/vapid-key'))
        if (cancelled) return
        if (!keyRes.ok) {
          setPublicKey(null)
          setProbe('unread')
          return
        }
        let keyData
        try {
          keyData = await keyRes.json()
        } catch {
          if (cancelled) return
          setPublicKey(null)
          setProbe('unread')
          return
        }
        if (cancelled) return
        const outcome = classifyVapidBody(keyData)
        if (outcome.status === 'configured') {
          setPublicKey(outcome.publicKey)
          try {
            const reg = await navigator.serviceWorker.ready
            const existing = await reg.pushManager.getSubscription()
            if (cancelled) return
            setSubscribed(Boolean(existing))
            setProbe('configured')
          } catch {
            if (cancelled) return
            // Unknown stays unknown. A subscription we already read
            // stays that subscription — this failure is not a new fact.
            if (subscribedRef.current === null) setProbe('device-unread')
            else setProbe('configured')
          }
        } else if (outcome.status === 'unset') {
          setPublicKey(null)
          setProbe('unset')
        } else {
          setPublicKey(null)
          setProbe('unread')
        }
      } catch {
        // The read did not finish. Say the card could not be read.
        // Do not leave it looking like push was never configured.
        if (!cancelled) {
          setPublicKey(null)
          setProbe('unread')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    probeKey()
    return () => { cancelled = true }
  }, [supported, attempt, probeNonce])

  function retryProbe() {
    setLoading(true)
    setAttempt(n => n + 1)
  }

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

  // 2. The key could not be read, or this device has never been read.
  //    No subscribe toggle — an off switch would pretend we know.
  //    Unset is excluded: a null subscribed there is "we have not
  //    asked the device", and the unset card is the server's answer.
  //    A device miss is not "the server could not be reached": the key
  //    read already succeeded.
  const deviceUnread = probe === 'device-unread' || (probe === 'configured' && subscribed === null)
  if (probe !== 'unset' && (probe !== 'configured' || subscribed === null)) {
    return (
      <div className={containerCls}>
        <Header />
        <div className="px-5 py-4" role="status">
          <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50">{deviceUnread ? t('push.deviceUnknownTitle') : t('load.failedTitle')}</p>
          <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">{deviceUnread ? t('push.deviceUnknownBody') : t('load.failedBody')}</p>
          <button
            type="button"
            onClick={retryProbe}
            className="tap mt-3 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-amber-300 dark:border-amber-700/50 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
          >
            {t('load.retry')}
          </button>
        </div>
      </div>
    )
  }

  // 3. No VAPID configured server-side. Disable the toggle with a soft hint.
  if (probe === 'unset' || !publicKey) {
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

  // 4. Permission explicitly denied by the OS.
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

  // 5. Interactive — default / granted.
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
