// OC-WEB-1 PR-D — admin publish for the parish page.
// The draft stays private until a confirmed publish copies it.

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Loader2 } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useConfirm } from '../components/ConfirmProvider'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'

const BTN = 'inline-flex items-center justify-center min-h-[44px] px-4 rounded-lg text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brass-400 focus:ring-offset-2 focus:ring-offset-parchment-50 dark:focus:ring-offset-ink-950 disabled:opacity-50'
const PRIMARY = `${BTN} bg-church-900 text-parchment-50 hover:bg-church-800 dark:bg-church-700 dark:hover:bg-church-600`
const QUIET = `${BTN} border border-parchment-300/80 dark:border-brass-900/40 text-ink-800 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800`

function bilingual(value, locale) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const lang = locale === 'es' ? 'es' : 'en'
  const text = value[lang] || value.en || value.es || ''
  return typeof text === 'string' ? text : ''
}

function blockLabel(block, locale) {
  const direct = bilingual(block?.headline, locale) || bilingual(block?.title, locale)
  if (direct) return direct
  const faqs = Array.isArray(block?.faqs) ? block.faqs : []
  for (const faq of faqs) {
    const question = bilingual(faq?.question, locale)
    if (question) return question
  }
  return ''
}

function homeBlocks(site) {
  const pages = site?.draft?.pages
  if (!Array.isArray(pages)) return []
  const home = pages.find((p) => p && p.id === 'home') || pages[0]
  return Array.isArray(home?.blocks) ? home.blocks : []
}

function usableSite(site) {
  if (!site || typeof site !== 'object' || Array.isArray(site)) return false
  if (typeof site.revision !== 'number' || !Number.isSafeInteger(site.revision) || site.revision < 0) return false
  if (!site.draft || typeof site.draft !== 'object' || !Array.isArray(site.draft.pages)) return false
  if (!Array.isArray(site.history)) return false
  if (typeof site.has_published !== 'boolean') return false
  if (typeof site.can_revert !== 'boolean') return false
  if (typeof site.page_published !== 'boolean') return false
  if (typeof site.draft_matches_published !== 'boolean') return false
  return true
}

function statusCopy(site, t) {
  const blocks = homeBlocks(site)
  if (!site.has_published && blocks.length === 0) return t('site.pub.statusDraftEmpty')
  if (site.has_published && site.published == null) return t('site.pub.statusPublishedBlank')
  if (!site.has_published) return t('site.pub.statusDraftOnly')
  if (site.draft_matches_published && site.page_published) return t('site.pub.statusLiveMatch')
  if (site.draft_matches_published) return t('site.pub.statusPublishedAddressOff')
  if (!site.page_published) return t('site.pub.statusDraftAheadAddressOff')
  return t('site.pub.statusDraftAhead')
}

function historyCopy(action, t) {
  if (action === 'publish') return t('site.pub.historyPublish')
  if (action === 'unpublish') return t('site.pub.historyUnpublish')
  if (action === 'revert') return t('site.pub.historyRevert')
  return ''
}

function formatWhen(value, dateLocale) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })
}

async function readResponse(res) {
  let body = {}
  try {
    const parsed = await res.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed
  } catch {
    body = {}
  }
  if (!res.ok) return { ok: false, status: res.status, body }
  return { ok: true, status: res.status, body }
}

const NOTICE_KEY = {
  site_draft_empty: 'site.pub.emptyPublish',
  site_no_previous: 'site.pub.noPrevious',
  site_not_published: 'site.pub.notPublished',
  site_confirm_required: 'site.pub.confirmRequired',
  site_revision_required: 'site.pub.revisionRequired',
  site_doc_invalid: 'site.pub.genericFail',
  site_actor_invalid: 'site.pub.genericFail',
}

export default function SitePublish() {
  const { user } = useAuth()
  const { t, locale, dateLocale } = useLocale()
  const ask = useConfirm()
  const isAdmin = user?.role === 'admin'
  const loadGen = useRef(0)
  const alertRef = useRef(null)
  const [site, setSite] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState('')
  const [conflict, setConflict] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return undefined
    }
    const mine = ++loadGen.current
    let cancelled = false
    setLoading(true)
    fetch(apiUrl('/api/organization/site'))
      .then(async (res) => {
        const result = await readResponse(res)
        if (cancelled || mine !== loadGen.current) return
        if (!result.ok || !usableSite(result.body.site)) {
          setLoadFailed(true)
          return
        }
        setSite(result.body.site)
        setLoadFailed(false)
        setConflict(false)
      })
      .catch(() => {
        if (cancelled || mine !== loadGen.current) return
        setLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled && mine === loadGen.current) setLoading(false)
      })
    return () => { cancelled = true }
  }, [isAdmin])

  useEffect(() => {
    if (conflict) alertRef.current?.focus()
  }, [conflict])

  async function reload() {
    const mine = ++loadGen.current
    setLoading(true)
    setNotice('')
    try {
      const res = await fetch(apiUrl('/api/organization/site'))
      const result = await readResponse(res)
      if (mine !== loadGen.current) return
      if (!result.ok || !usableSite(result.body.site)) {
        setLoadFailed(true)
        return
      }
      setSite(result.body.site)
      setLoadFailed(false)
      setConflict(false)
    } catch {
      if (mine !== loadGen.current) return
      setLoadFailed(true)
    } finally {
      if (mine === loadGen.current) setLoading(false)
    }
  }

  async function runAction(path, kind) {
    if (!usableSite(site)) return
    const mine = ++loadGen.current
    setBusy(kind)
    setNotice('')
    setConflict(false)
    try {
      const res = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, expected_revision: site.revision }),
      })
      const result = await readResponse(res)
      if (mine !== loadGen.current) return
      if (result.status === 409 || result.body.code === 'site_revision_conflict') {
        setConflict(true)
        return
      }
      if (!result.ok || !usableSite(result.body.site)) {
        setNotice(t(NOTICE_KEY[result.body.code] || 'site.pub.genericFail'))
        return
      }
      setSite(result.body.site)
      setLoadFailed(false)
      if (kind === 'publish') {
        setNotice(t(result.body.site.page_published ? 'site.pub.publishedOk' : 'site.pub.publishedOkAddressOff'))
      } else if (kind === 'unpublish') {
        setNotice(t('site.pub.unpublishedOk'))
      } else {
        setNotice(t('site.pub.revertedOk'))
      }
    } catch {
      if (mine !== loadGen.current) return
      setNotice(t('site.pub.genericFail'))
    } finally {
      if (mine === loadGen.current) setBusy('')
    }
  }

  async function onPublish() {
    const ok = await ask({
      title: t('site.pub.confirmTitle'),
      body: t('site.pub.confirmBody'),
      confirmLabel: t('site.pub.confirmAction'),
    })
    if (!ok) return
    await runAction('/api/organization/site/publish', 'publish')
  }

  async function onUnpublish() {
    const ok = await ask({
      title: t('site.pub.unpublishTitle'),
      body: t('site.pub.unpublishBody'),
      confirmLabel: t('site.pub.unpublishAction'),
    })
    if (!ok) return
    await runAction('/api/organization/site/unpublish', 'unpublish')
  }

  async function onRevert() {
    const ok = await ask({
      title: t('site.pub.revertTitle'),
      body: t('site.pub.revertBody'),
      confirmLabel: t('site.pub.revertAction'),
    })
    if (!ok) return
    await runAction('/api/organization/site/revert', 'revert')
  }

  if (!isAdmin) {
    return (
      <PageWrapper type="record" title={t('site.pub.title')}>
        <EmptyState
          icon={AlertTriangle}
          title={t('orgs.adminOnly')}
          body={t('orgs.adminOnlyBody')}
        />
      </PageWrapper>
    )
  }

  if (loading && !site) {
    return (
      <PageWrapper type="record" title={t('site.pub.title')} subtitle={t('site.pub.subtitle')}>
        <p className="flex items-center gap-2 text-sm text-ink-600 dark:text-parchment-200" role="status">
          <Loader2 size={18} className="animate-spin text-brass-600 dark:text-brass-300" aria-hidden="true" />
          {t('site.pub.loading')}
        </p>
      </PageWrapper>
    )
  }

  if (!site) {
    return (
      <PageWrapper type="record" title={t('site.pub.title')}>
        <EmptyState
          icon={AlertTriangle}
          title={t('site.pub.loadFailed')}
          body={t(loadFailed ? 'site.pub.loadFailedBody' : 'site.pub.shape')}
        />
        <button type="button" onClick={reload} className={`${PRIMARY} mt-4`}>
          {t('site.pub.retry')}
        </button>
      </PageWrapper>
    )
  }

  const blocks = homeBlocks(site)
  const publishedWhen = formatWhen(site.published_at, dateLocale)

  return (
    <PageWrapper type="record" title={t('site.pub.title')} subtitle={t('site.pub.subtitle')}>
      <div className="space-y-6">
        <Link
          to="/settings"
          className="inline-flex items-center min-h-[44px] text-sm font-semibold text-church-800 dark:text-brass-300 underline-offset-2 hover:underline rounded-md focus:outline-none focus:ring-2 focus:ring-brass-400"
        >
          {t('site.pub.back')}
        </Link>

        {conflict && (
          <div
            ref={alertRef}
            tabIndex={-1}
            role="alert"
            className="rounded-xl border border-rose-300/80 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brass-400"
          >
            <p className="text-sm text-ink-800 dark:text-parchment-100">{t('site.pub.conflict')}</p>
            <button type="button" onClick={reload} className={`${QUIET} mt-3`}>
              {t('site.pub.reload')}
            </button>
          </div>
        )}

        {loadFailed && (
          <p role="alert" className="text-sm text-ink-700 dark:text-parchment-200">
            {t('site.pub.reloadFailed')}
          </p>
        )}

        {notice && (
          <p role="status" className="text-sm text-ink-700 dark:text-parchment-200">
            {notice}
          </p>
        )}

        <section className="rounded-2xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 shadow-warm p-5 space-y-2">
          <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
            {t('site.pub.publishedHeading')}
          </h2>
          <p className="text-sm text-ink-700 dark:text-parchment-200">{statusCopy(site, t)}</p>
          {site.has_published && publishedWhen && (
            <p className="text-sm text-ink-500 dark:text-parchment-300/80">
              {t('site.pub.publishedAt', { when: publishedWhen })}
            </p>
          )}
        </section>

        <section
          aria-label={t('site.pub.previewLabel')}
          className="rounded-2xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100/80 dark:bg-ink-900/80 shadow-warm p-5"
        >
          <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
            {t('site.pub.previewLabel')}
          </h2>
          {blocks.length === 0 ? (
            <p className="mt-3 text-sm text-ink-600 dark:text-parchment-200">{t('site.pub.previewEmpty')}</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {blocks.map((block, index) => (
                <li key={`${block?.type || 'block'}-${index}`} className="text-base font-display text-ink-900 dark:text-parchment-50">
                  {blockLabel(block, locale) || t('site.pub.blockUntitled')}
                </li>
              ))}
            </ul>
          )}
        </section>

        {site.history.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
              {t('site.pub.historyLabel')}
            </h2>
            <ol className="space-y-1">
              {site.history.map((entry) => {
                const label = historyCopy(entry?.action, t)
                if (!label) return null
                const when = formatWhen(entry.created_at, dateLocale)
                return (
                  <li key={entry.seq} className="text-sm text-ink-600 dark:text-parchment-200">
                    {when ? `${label} — ${when}` : label}
                  </li>
                )
              })}
            </ol>
          </section>
        )}

        <div className="flex flex-wrap gap-3" aria-busy={busy !== ''}>
          <button type="button" className={PRIMARY} onClick={onPublish} disabled={busy !== '' || blocks.length === 0}>
            {busy === 'publish' ? t('site.pub.publishing') : t('site.pub.publish')}
          </button>
          {site.has_published && (
            <button type="button" className={QUIET} onClick={onUnpublish} disabled={busy !== ''}>
              {busy === 'unpublish' ? t('site.pub.unpublishing') : t('site.pub.unpublish')}
            </button>
          )}
          {site.can_revert && (
            <button type="button" className={QUIET} onClick={onRevert} disabled={busy !== ''}>
              {busy === 'revert' ? t('site.pub.reverting') : t('site.pub.revert')}
            </button>
          )}
        </div>
      </div>
    </PageWrapper>
  )
}
