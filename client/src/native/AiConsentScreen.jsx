import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Feather } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import { scrimCls } from '../components/MobileSheet'
import useDialogFocus from '../components/useDialogFocus'
import { useLocale } from '../i18n'
import { useNativeAi } from './NativeAiContext'

const ease = [0.25, 0.1, 0.25, 1]

function ConsentBody({ variant = 'page', panelRef, onClose }) {
  const { t } = useLocale()
  const { agree } = useNativeAi()
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const dialog = variant === 'dialog'
  const Panel = dialog ? motion.div : motion.section

  async function onAgree() {
    if (saving) return
    setSaving(true)
    setFailed(false)
    const result = await agree()
    setSaving(false)
    if (!result?.ok) {
      setFailed(true)
      return
    }
    // Agreement closes the dialog. It does not send the note or the question
    // that opened it. The person asks again if they still want that send.
    if (onClose) onClose()
  }

  function onDecline() {
    if (onClose) onClose()
    else navigate('/')
  }

  return (
    <Panel
      ref={panelRef}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease }}
      data-testid="ai-consent"
      role={dialog ? 'dialog' : undefined}
      aria-modal={dialog ? 'true' : undefined}
      aria-labelledby="ai-consent-title"
      tabIndex={dialog ? -1 : undefined}
      className="w-full max-w-xl rounded-2xl border border-parchment-300/70 bg-parchment-50 p-6 shadow-warm dark:border-brass-900/30 dark:bg-ink-900"
    >
      <p data-testid="ai-consent-draft" className="rounded-lg border border-amber-200/80 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 dark:border-amber-800/40 dark:bg-amber-900/25 dark:text-amber-200">
        {t('ai.consent.draft')}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <Feather size={18} aria-hidden="true" className="text-church-700 dark:text-brass-400" />
        <h1 id="ai-consent-title" className="font-display text-2xl font-semibold text-ink-900 dark:text-parchment-50">
          {t('ai.consent.title')}
        </h1>
      </div>
      <div className="mt-4 space-y-3 text-sm leading-relaxed text-ink-700 dark:text-parchment-200">
        <p>{t('ai.consent.lead')}</p>
        <p>{t('ai.consent.parish')}</p>
        <p>{t('ai.consent.triage')}</p>
        <p>{t('ai.consent.later')}</p>
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-sm text-rose-700 dark:text-rose-300">{t('ai.consent.saveFailed')}</p>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="ai-consent-agree"
          onClick={onAgree}
          disabled={saving}
          className="tap inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-church-800 hover:bg-church-900 text-parchment-50 text-sm font-semibold shadow-warm transition-colors focus:outline-none focus:ring-2 focus:ring-brass-400 disabled:opacity-50"
        >
          {saving ? t('ai.consent.saving') : t('ai.consent.agree')}
        </button>
        <button
          type="button"
          data-testid="ai-consent-decline"
          onClick={onDecline}
          disabled={saving}
          className="tap inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-parchment-300 bg-white text-sm font-semibold text-ink-800 hover:bg-parchment-100 focus:outline-none focus:ring-2 focus:ring-brass-400 disabled:opacity-50 dark:border-brass-900/40 dark:bg-ink-800 dark:text-parchment-100 dark:hover:bg-ink-700"
        >
          {t('ai.consent.decline')}
        </button>
      </div>
    </Panel>
  )
}

function ConsentDialog({ onClose }) {
  const panelRef = useRef(null)

  // Effect order matters on unmount: React runs cleanups first→last.
  // Restore body overflow and #root interactivity BEFORE useDialogFocus
  // returns focus to the opener. Overflow-after-focus left the opener
  // focus call racing a locked body and flaked Gate 40921110048
  // (activeElement stayed on <body style="overflow: hidden">).
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  useEffect(() => {
    const root = document.getElementById('root')
    if (!root || root.contains(panelRef.current)) return undefined
    const wasInert = root.hasAttribute('inert')
    const hadHidden = root.getAttribute('aria-hidden')
    root.inert = true
    root.setAttribute('inert', '')
    root.setAttribute('aria-hidden', 'true')
    return () => {
      if (!wasInert) { root.inert = false; root.removeAttribute('inert') }
      if (hadHidden === null) root.removeAttribute('aria-hidden')
      else root.setAttribute('aria-hidden', hadHidden)
    }
  }, [])

  useDialogFocus(panelRef, onClose)

  return createPortal(
    <div className={`${scrimCls} z-50 flex items-center justify-center p-4`}>
      <ConsentBody variant="dialog" panelRef={panelRef} onClose={onClose} />
    </div>,
    document.body,
  )
}

export function AiHold({ testid, message }) {
  return (
    <PageWrapper>
      <div data-testid={testid} className="mx-auto max-w-xl rounded-2xl border border-parchment-300/70 bg-parchment-50 p-6 shadow-warm dark:border-brass-900/30 dark:bg-ink-900">
        <p className="text-sm leading-relaxed text-ink-700 dark:text-parchment-200">{message}</p>
      </div>
    </PageWrapper>
  )
}

export function AiConsentScreen({ variant = 'page', onClose }) {
  if (variant === 'dialog') return <ConsentDialog onClose={onClose} />
  return (
    <PageWrapper>
      <div className="flex justify-center py-6">
        <ConsentBody />
      </div>
    </PageWrapper>
  )
}

export function AiSurfaceGate({ children }) {
  const { kind } = useNativeAi()
  const { t } = useLocale()
  if (kind === 'pending') return <AiHold testid="ai-pending" message={t('ai.hold.pending')} />
  if (kind === 'unavailable') return <AiHold testid="ai-unavailable" message={t('ai.hold.unavailable')} />
  if (kind === 'excluded') return <AiHold testid="ai-closed" message={t('ai.hold.excluded')} />
  if (kind === 'disclosure-stale') return <AiHold testid="ai-disclosure-stale" message={t('ai.hold.disclosure')} />
  if (kind === 'consent') return <AiConsentScreen />
  return children
}
