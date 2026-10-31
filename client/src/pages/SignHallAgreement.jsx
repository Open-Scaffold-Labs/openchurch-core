// The signer opens the hall agreement from the copied link.
// Nothing on this page charges. Declining does not sign.
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import LoadFailure from '../components/LoadFailure'
import AnimatedButton from '../components/AnimatedButton'
import { SkeletonBlock } from '../components/Skeleton'

// What the server said, in words the signer can act on (SP-235).
const SIGN_REFUSALS = {
  counsel_pending: 'sign.counselPending',
  name: 'sign.nameInvalid',
  consent: 'sign.consentMissing',
  already_signed: 'sign.alreadySigned',
  not_open: 'sign.notOpen',
  not_held: 'sign.notHeld',
}

const primaryCls = 'rounded-lg bg-church-800 px-4 py-2 text-sm text-parchment-50 hover:bg-church-900 focus:ring-2 focus:ring-brass-400 disabled:opacity-60'

export default function SignHallAgreement() {
  const { token } = useParams()
  const [params] = useSearchParams()
  const { t, locale, setPublicLocale } = useLocale()
  const [doc, setDoc] = useState(null)
  const [failed, setFailed] = useState(false)
  const [missing, setMissing] = useState(false)
  const [notice, setNotice] = useState('')
  const [accepted, setAccepted] = useState([])
  const asked = params.get('locale') === 'es' ? 'es' : params.get('locale') === 'en' ? 'en' : locale
  const [choice, setChoice] = useState(asked)

  useEffect(() => {
    setChoice(asked)
    if (asked === 'es' || asked === 'en') setPublicLocale(asked)
  }, [asked, setPublicLocale])

  function pickLanguage(next) {
    setChoice(next)
    setPublicLocale(next)
  }

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    setMissing(false)
    setDoc(null)
    fetch(apiUrl(`/api/hall-sign/${encodeURIComponent(token)}?locale=${choice}`))
      .then(async (res) => {
        const data = await res.json().catch(() => null)
        if (cancelled) return
        if (res.status === 404) { setMissing(true); return }
        // SP-235: an expired or rate-limited link says so; "try again" would not help.
        if (res.status === 410) { setDoc({ status: 'expired' }); return }
        if (res.status === 429) { setNotice(t('sign.rateLimited')); setDoc({ status: 'rate_limited' }); return }
        if (!res.ok || !data || data.payments !== 'on_hold' || typeof data.contract !== 'string' || !Array.isArray(data.consent)) {
          setFailed(true)
          return
        }
        setDoc(data)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [token, choice])

  async function sign(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    let res
    try {
      res = await fetch(apiUrl(`/api/hall-sign/${encodeURIComponent(token)}/sign`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signer_name: form.get('signer_name'),
          accepted,
          locale: choice,
        }),
      })
    } catch {
      setNotice(t('sign.nothingLost'))
      return
    }
    const data = await res.json().catch(() => null)
    if (res.status === 410) { setNotice(t('sign.expired')); return }
    const reason = SIGN_REFUSALS[data?.code]
    if (!res.ok && (res.status === 429 || reason)) {
      setNotice(t(res.status === 429 ? 'sign.rateLimited' : reason))
      if (data?.code === 'counsel_pending') setDoc(d => d ? { ...d, counsel_pending: true } : d)
      return
    }
    if (!res.ok || data?.payments !== 'on_hold' || data?.status !== 'signed') {
      setNotice(t('sign.nothingLost'))
      return
    }
    setNotice(t('sign.done'))
    setDoc(d => d ? { ...d, status: 'signed' } : d)
  }

  async function decline(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    let res
    try {
      res = await fetch(apiUrl(`/api/hall-sign/${encodeURIComponent(token)}/decline`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: form.get('reason') }),
      })
    } catch {
      setNotice(t('sign.nothingLost'))
      return
    }
    const data = await res.json().catch(() => null)
    if (res.status === 410) { setNotice(t('sign.expired')); return }
    if (res.status === 429) { setNotice(t('sign.rateLimited')); return }
    if (res.status === 400 && data?.code === 'reason') { setNotice(t('sign.reasonShort')); return }
    if (!res.ok || data?.status !== 'declined') { setNotice(t('sign.nothingLost')); return }
    setNotice(t('sign.declined'))
    setDoc(d => d ? { ...d, status: 'declined' } : d)
  }

  return (
    <main className="min-h-screen bg-parchment-50 px-4 py-10 text-ink-900">
      <article className="mx-auto max-w-2xl">
        <h1 className="font-display text-3xl">{t('sign.title')}</h1>
        <div className="mt-3 flex gap-3">
          <button type="button" className="inline-flex min-h-[24px] min-w-[24px] items-center text-sm text-church-800 underline" onClick={() => pickLanguage('en')}>{t('prefs.english')}</button>
          <button type="button" className="inline-flex min-h-[24px] min-w-[24px] items-center text-sm text-church-800 underline" onClick={() => pickLanguage('es')}>{t('prefs.spanish')}</button>
        </div>
        <p className="mt-3 rounded-lg border border-brass-400/60 bg-parchment-100 px-4 py-3 text-sm" role="note">{t('sign.hold')}</p>
        {notice && <p className="mt-4 text-sm" role="status">{notice}</p>}
        {missing && <p className="mt-6 text-sm">{t('sign.notFound')}</p>}
        {failed && <LoadFailure title={t('sign.loadFailed')} body={t('sign.nothingLost')} onRetry={() => window.location.reload()} />}
        {doc == null && !failed && !missing && (
          <div className="mt-6" aria-busy="true" aria-label={t('sign.loading')}>
            <SkeletonBlock className="h-40 w-full" />
          </div>
        )}
        {doc?.status === 'expired' && <p className="mt-6 text-sm" role="status" aria-live="polite" data-testid="sign-expired">{t('sign.expired')}</p>}
        {doc?.status === 'rate_limited' && <p className="mt-6 text-sm">{t('sign.rateLimited')}</p>}
        {doc && doc.status !== 'expired' && doc.status !== 'rate_limited' && (
          <>
            <pre className="mt-6 whitespace-pre-wrap font-display text-base leading-relaxed">{doc.contract}</pre>
            {doc.status === 'sent' && doc.counsel_pending && (
              <p className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm" role="status" aria-live="polite" data-testid="counsel-pending">{t('sign.counselPending')}</p>
            )}
            {doc.status === 'sent' && !doc.counsel_pending && (
              <form onSubmit={sign} className="mt-6 space-y-3 print:hidden">
                <ul className="space-y-2">
                  {doc.consent.map(point => (
                    <li key={point.id}>
                      <label className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={accepted.includes(point.id)}
                          onChange={e => setAccepted(cur => e.target.checked ? [...cur, point.id] : cur.filter(id => id !== point.id))}
                        />
                        <span>{point.text}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <label className="block text-sm">
                  {t('sign.name')}
                  <input name="signer_name" required className="mt-1 w-full rounded-lg border border-parchment-300 bg-parchment-50 px-3 py-2 focus:ring-2 focus:ring-brass-400" />
                </label>
                <AnimatedButton type="submit" className={primaryCls}>{t('sign.sign')}</AnimatedButton>
              </form>
            )}
            {doc.status === 'sent' && (
              <form onSubmit={decline} className="mt-4 space-y-2 print:hidden">
                <label className="block text-sm">
                  {t('sign.reason')}
                  <input name="reason" required className="mt-1 w-full rounded-lg border border-parchment-300 bg-parchment-50 px-3 py-2" />
                </label>
                <button type="submit" className="inline-flex min-h-[24px] min-w-[24px] items-center text-sm text-ink-700 underline">{t('sign.decline')}</button>
              </form>
            )}
            {doc.status === 'signed' && <p className="mt-6 text-sm">{t('sign.done')}</p>}
            {doc.status === 'declined' && <p className="mt-6 text-sm">{t('sign.declined')}</p>}
          </>
        )}
      </article>
    </main>
  )
}
