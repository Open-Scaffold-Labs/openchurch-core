import { useEffect, useState } from 'react'
import { Calendar, Copy, Check, ExternalLink, RefreshCw } from 'lucide-react'
import { useToast } from './ToastProvider'
import { useConfirm } from './ConfirmProvider'

// Two modes:
//   - admin/staff lookup (default): pass `clientId`. Hits /link/:clientId.
//   - self-serve: pass `selfServe`. Hits /my-link, which matches the
//     auth'd user's email to a member roster row. If the user isn't on
//     the roster, the component renders nothing (silent hide) so the
//     mounting page can include it unconditionally.
export default function CalendarSync({ clientId, clientName, selfServe = false }) {
  const [url, setUrl] = useState(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [hidden, setHidden] = useState(false) // true when self-serve has no match
  const toast = useToast()
  const ask = useConfirm()

  const endpoint = selfServe
    ? '/api/calendar-sync/my-link'
    : `/api/calendar-sync/link/${clientId}`
  const rotateEndpoint = selfServe
    ? '/api/calendar-sync/my-rotate'
    : `/api/calendar-sync/rotate/${clientId}`

  // In self-serve mode, probe the endpoint on mount so we can quietly
  // hide the card for users without a roster match. We don't surface
  // an error here — "you're not on the member roster" is a state, not
  // a failure.
  useEffect(() => {
    if (!selfServe) return
    let cancelled = false
    fetch(endpoint).then(async res => {
      if (cancelled) return
      if (res.status === 404) {
        const data = await res.json().catch(() => ({}))
        if (data.code === 'no_member_match') setHidden(true)
        return
      }
      if (res.ok) {
        const data = await res.json()
        setUrl(data.url)
      }
    }).catch(() => { /* network — show the manual button as a fallback */ })
    return () => { cancelled = true }
  }, [selfServe, endpoint])

  async function getLink() {
    setLoading(true)
    try {
      const res = await fetch(endpoint)
      if (!res.ok) throw new Error('Failed to get calendar link')
      const data = await res.json()
      setUrl(data.url)
    } catch (e) {
      toast.error(e.message || 'Failed to get calendar link')
    } finally {
      setLoading(false)
    }
  }

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  // Rotate immediately invalidates any previous subscription. Confirm
  // before doing it because anyone already subscribed will have to
  // resubscribe with the new URL.
  async function rotate() {
    const ok = await ask({
      title: 'Generate a new calendar link?',
      body: 'Any existing subscriptions stop working and will need to be added again with the new link.',
      confirmLabel: 'Generate new link',
    })
    if (!ok) return
    setRotating(true)
    try {
      const res = await fetch(rotateEndpoint, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to rotate calendar link')
      const data = await res.json()
      setUrl(data.url)
      toast.success('New calendar link generated')
    } catch (e) {
      toast.error(e.message || 'Failed to rotate calendar link')
    } finally {
      setRotating(false)
    }
  }

  // The same opaque URL, served back through the calendar-app schemes
  // each platform expects. Apple Calendar / iOS opens webcal:// natively;
  // Google Calendar's "add by URL" flow takes the same string wrapped in
  // its render endpoint.
  const webcalUrl = url ? url.replace(/^https?:\/\//, 'webcal://') : null
  const googleUrl = url
    ? `https://www.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl)}`
    : null

  if (hidden) return null

  return (
    <div className="mt-3 p-3 rounded-lg bg-parchment-50 dark:bg-ink-900/50 border border-parchment-300/60 dark:border-white/[0.06]">
      <div className="flex items-center gap-2 mb-2">
        <Calendar size={14} className="text-church-600 dark:text-parchment-300/70" />
        <span className="text-xs font-semibold text-ink-600 dark:text-parchment-300">
          {/* "Sync" is banned vocabulary (P4) — the parish word is "feed". */}
          {selfServe ? 'Your calendar feed' : 'Calendar feed'}
        </span>
      </div>

      {!url ? (
        <>
          <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 mb-2 leading-snug">
            Subscribe to see assigned events and tasks alongside personal calendar entries.
          </p>
          <button
            onClick={getLink}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-md bg-church-900 dark:bg-ink-700 text-parchment-50 hover:opacity-80 transition-opacity disabled:opacity-50"
          >
            {loading ? 'Generating…' : 'Get Calendar Link'}
          </button>
        </>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <input
              readOnly
              value={url}
              className="flex-1 text-[11px] px-2 py-1.5 rounded-md bg-white dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/40 text-ink-600 dark:text-parchment-300 font-mono truncate"
            />
            <button
              onClick={copy}
              className="p-1.5 rounded-md bg-white dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/40 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors"
              title="Copy link"
            >
              {copied ? <Check size={13} className="text-brass-500" /> : <Copy size={13} />}
            </button>
            <button
              onClick={rotate}
              disabled={rotating}
              className="p-1.5 rounded-md bg-white dark:bg-ink-800 border border-parchment-300/60 dark:border-brass-900/40 text-ink-400 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors disabled:opacity-50"
              title="Regenerate link (invalidates existing subscriptions)"
            >
              <RefreshCw size={13} className={rotating ? 'animate-spin' : ''} />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {webcalUrl && (
              <a
                href={webcalUrl}
                className="inline-flex items-center gap-1.5 text-[11px] text-church-700 dark:text-parchment-300/70 hover:text-church-900 dark:hover:text-parchment-50 transition-colors"
              >
                <ExternalLink size={11} />
                Add to Apple Calendar
              </a>
            )}
            {googleUrl && (
              <a
                href={googleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[11px] text-church-700 dark:text-parchment-300/70 hover:text-church-900 dark:hover:text-parchment-50 transition-colors"
              >
                <ExternalLink size={11} />
                Add to Google Calendar
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
