import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Building2, AlertTriangle, Loader2, Globe, ExternalLink, Copy, Check, Bell, Cross, Plus, Trash2, Feather, Languages } from 'lucide-react'
import PageWrapper, { PageHeader } from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import TextField from '../components/TextField'
import SaveButton, { useSaveStatus } from '../components/SaveButton'
import { useToast } from '../components/ToastProvider'
import { showParishAiKey } from '../native/aiGate'
import { useNativeAi } from '../native/NativeAiContext'
import { useAuth } from '../context/AuthContext'
import { apiUrl } from '../api'
import { nativeAiFetchInit } from '../native/nativeAiCeiling'
import { LIT_COLOR_DOT, LIT_COLORS, LIT_COLOR_DOT_NONE } from '../utils/liturgicalColors'
import { useConfirm } from '../components/ConfirmProvider'
import { useLocale } from '../i18n'
import { colorLabel } from '../i18n/liturgical'
import { offeredParishTimeZones, parishTimeZoneLabel } from '../utils/parishTimeZone'

// The parish's clock (C4). ochr_organizations.timezone has driven the
// kiosk's "today" since CHK.7 and defaulted to UTC, and until this field no
// screen could set it — the help text sent admins to a control that did not
// exist, and an evening Mass in California was checked in against tomorrow.
//
// The list is the runtime's own IANA table. V8's supportedValuesOf omits
// 'UTC' (it is not a region), so it is added by hand — it is also the
// column's default, so it must always be selectable. The short list is the
// fallback for a runtime without supportedValuesOf, and the "Common" group
// everywhere else.
const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico',
]
function allTimezones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return offeredParishTimeZones(['UTC', ...Intl.supportedValuesOf('timeZone')])
    }
  } catch { /* fall through to the short list */ }
  return offeredParishTimeZones(COMMON_TIMEZONES)
}
const TIMEZONES = allTimezones()

// Diocese affiliation (DIO.1) — the parish's half of the covenant.
// Deliberately a small Settings card, not a tab: for a parish the
// diocese is a relationship to manage occasionally, not a daily surface.
// Parish data export (EXP.1) — "your data exports anytime" as a button.
// The custody promise every rector asks about, made self-serve: one
// click, one complete JSON file, no email to the vendor required.
function DataExportCard() {
  const { t } = useLocale()
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState('')

  async function download() {
    setBusy(true); setErr('')
    try {
      const res = await fetch(apiUrl('/api/organization/export'))
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') || ''
      const name = /filename="([^"]+)"/.exec(cd)?.[1] || 'openchurch-export.json'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = name
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-white dark:bg-ink-900 shadow-warm p-5">
      <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('orgs.data.title')}</h2>
      <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">
        {t('orgs.data.body')}
      </p>
      {err && <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{err}</p>}
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-700 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800 disabled:opacity-50"
      >
        {busy ? t('orgs.data.preparing') : t('orgs.data.download')}
      </button>
    </div>
  )
}

function DioceseCard() {
  const toast = useToast()
  const ask = useConfirm()
  const { t } = useLocale()
  const [aff, setAff]         = useState(null)
  const [affFailed, setAffFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy]       = useState(false)
  const [grant, setGrant]     = useState('summary')

  const load = () => {
    setAffFailed(false)
    fetch(apiUrl('/api/affiliation'))
      .then(async r => {
        // `{ affiliation: null }` on a 500 said "This parish is independent."
        if (!r.ok) throw new Error('unread')
        const d = await r.json()
        if (!d || typeof d !== 'object' || Array.isArray(d) || !Object.prototype.hasOwnProperty.call(d, 'affiliation')) {
          throw new Error('shape')
        }
        setAff(d.affiliation ?? null)
        setAffFailed(false)
      })
      .catch(() => { setAff(null); setAffFailed(true) })
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const act = async (path, body) => {
    setBusy(true)
    try {
      const res = await fetch(apiUrl(`/api/affiliation${path}`), {
        method: path === '/grant' ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "That didn't save — nothing was lost. Please try again.")
      setAff(d.affiliation ?? null)
      toast.success(t('org.diocese_affiliation_updated'))
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  const GRANT_HELP = {
    summary: 'The diocese sees period-level financial summaries, and the names and roles of your parish leadership.',
    detail:  'The diocese may also drill into account-level lines, and the names and roles of your parish leadership.',
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: 0.2 }}
      className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 space-y-4"
    >
      <div className="flex items-center gap-2 pb-3 border-b border-parchment-300/60 dark:border-brass-900/25">
        <Building2 size={14} className="text-brass-600 dark:text-brass-300" />
        <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('orgs.dio.title')}</h2>
      </div>

      {loading ? (
        <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-brass-500" /></div>
      ) : affFailed ? (
        <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{t('org.affUnread')}</p>
      ) : !aff ? (
        <p className="text-sm text-ink-500 dark:text-parchment-300/70">
          {t('orgs.dio.independent')}
        </p>
      ) : aff.status === 'invited' ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-800 dark:text-parchment-100">
            <span className="font-semibold">{aff.diocese_name}</span>{' '}
            {t('org.has_invited_this_parish_to')}
          </p>
          <div>
            <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('orgs.dio.level')}</label>
            <select value={grant} onChange={e => setGrant(e.target.value)}
              className="px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400">
              <option value="summary">{t('orgs.dio.summary')}</option>
              <option value="detail">{t('orgs.dio.detail')}</option>
            </select>
            <p className="mt-1 text-[11px] text-ink-500 dark:text-parchment-300/70">{GRANT_HELP[grant]}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy} onClick={() => act('/accept', { grant_level: grant })}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 disabled:opacity-40">
              {t('orgs.dio.accept')}
            </button>
            <button type="button" disabled={busy} onClick={() => act('/decline')}
              className="px-3 py-2 text-sm text-ink-500 dark:text-parchment-300/70 hover:underline">
              {t('orgs.dio.decline')}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-800 dark:text-parchment-100">
            {t('orgs.dio.affiliated')} <span className="font-semibold">{aff.diocese_name}</span>
            {aff.status === 'suspended' && (
              <span className="ml-2 inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold bg-parchment-200/80 text-ink-600 dark:bg-ink-800 dark:text-parchment-300">{t('orgs.dio.suspended')}</span>
            )}
          </p>
          {aff.status === 'active' && (
            <div>
              <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('orgs.dio.level')}</label>
              <select value={aff.grant_level} disabled={busy}
                onChange={e => act('/grant', { grant_level: e.target.value })}
                className="px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400">
                <option value="summary">{t('orgs.dio.summary')}</option>
                <option value="detail">{t('orgs.dio.detail')}</option>
              </select>
              <p className="mt-1 text-[11px] text-ink-500 dark:text-parchment-300/70">{GRANT_HELP[aff.grant_level]}</p>
            </div>
          )}
          <button type="button" disabled={busy}
            onClick={async () => {
              if (await ask({
                title: t('orgs.dio.leaveTitle'),
                body: t('orgs.dio.leaveBody'),
                confirmLabel: t('orgs.dio.leaveConfirm'),
              })) act('/leave')
            }}
            className="text-[12px] text-rose-700 dark:text-rose-300 hover:underline">
            {t('orgs.dio.leave')}
          </button>
        </div>
      )}
    </motion.div>
  )
}

// Bring-your-own AI key (AIP.1). The key is write-only: we send it once,
// the server stores it encrypted, and from then on only the provider name
// and the last four characters ever come back. D-01 (2026-10-19): there is
// no platform-managed key, so clearing it turns the parish's AI off.
function AIProviderCard() {
  const toast = useToast()
  const ask = useConfirm()
  const { t } = useLocale()
  const [cfg, setCfg]         = useState(null)   // { source, provider, model, key_last4 }
  const [cfgFailed, setCfgFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy]       = useState(false)
  const [editing, setEditing] = useState(false)
  const [form, setForm]       = useState({ provider: 'anthropic', api_key: '', model: '' })

  useEffect(() => {
    fetch(apiUrl('/api/ai/provider'), nativeAiFetchInit())
      .then(async r => {
        // `null` on a 500 said the parish was on the built-in assistant.
        if (!r.ok) throw new Error('unread')
        const d = await r.json()
        if (!d || typeof d !== 'object' || Array.isArray(d) || (d.source !== 'platform' && d.source !== 'org')) {
          throw new Error('shape')
        }
        setCfg(d)
        setCfgFailed(false)
      })
      .catch(() => { setCfg(null); setCfgFailed(true) })
      .finally(() => setLoading(false))
  }, [])

  const save = async (e) => {
    e.preventDefault()
    if (form.api_key.trim().length < 20) { toast.error(t('org.that_does_not_look_like')); return }
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/ai/provider'), nativeAiFetchInit({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: form.provider,
          api_key: form.api_key.trim(),
          ...(form.model.trim() ? { model: form.model.trim() } : {}),
        }),
      }))
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "That didn't save — please try again.")
      setCfg(d)
      setEditing(false)
      setForm(f => ({ ...f, api_key: '' }))
      toast.success(t('org.ai_provider_saved_your_generations'))
      window.dispatchEvent(new Event('ochr:ai-provider-changed')) // the assistant rechecks its status
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  const clear = async () => {
    if (!(await ask({
      title: 'Remove your API key?',
      body: "AI features that need your parish's key stop working until a key is added again.",
      confirmLabel: 'Remove key',
    }))) return
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/ai/provider'), nativeAiFetchInit({ method: 'DELETE' }))
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "That didn't save — please try again.")
      setCfg(d)
      toast.success(t('org.api_key_removed'))
      window.dispatchEvent(new Event('ochr:ai-provider-changed')) // the assistant rechecks its status
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: 0.22 }}
      className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 space-y-4"
    >
      <div className="flex items-center gap-2 pb-3 border-b border-parchment-300/60 dark:border-brass-900/25">
        <Feather size={14} className="text-brass-600 dark:text-brass-300" />
        <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('orgs.ai.title')}</h2>
      </div>

      {loading ? (
        <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-brass-500" /></div>
      ) : cfgFailed ? (
        <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{t('org.aiUnread')}</p>
      ) : (
        <div className="space-y-3">
          {cfg?.source === 'org' ? (
            <p className="text-sm text-ink-800 dark:text-parchment-100">
              {t('org.using')} <span className="font-semibold capitalize">{cfg.provider}</span> {t('org.with_your_own_key')}{' '}
              <span className="font-mono text-xs">····{cfg.key_last4}</span>
              {cfg.model && <> · model <span className="font-mono text-xs">{cfg.model}</span></>}
            </p>
          ) : (
            <p className="text-sm text-ink-500 dark:text-parchment-300/70">
              {t('orgs.ai.none')}
            </p>
          )}

          {editing ? (
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('orgs.ai.provider')}</label>
                <select value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))} className={inputCls}>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="openai">OpenAI (GPT)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('orgs.ai.key')}</label>
                <input type="password" value={form.api_key} autoComplete="off"
                  placeholder={form.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                  onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))} className={inputCls} />
                <p className="mt-1 text-[11px] text-ink-500 dark:text-parchment-300/70">
                  {t('orgs.ai.stored')}
                </p>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-ink-500 dark:text-parchment-300/70 mb-1">{t('orgs.ai.model')} <span className="font-normal">{t('orgs.optional')}</span></label>
                <input type="text" value={form.model}
                  placeholder={form.provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini'}
                  onChange={e => setForm(f => ({ ...f, model: e.target.value }))} className={inputCls} />
              </div>
              <div className="flex items-center gap-2">
                <button type="submit" disabled={busy}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 disabled:opacity-40">
                  {busy ? t('orgs.saving') : t('orgs.ai.save')}
                </button>
                <button type="button" disabled={busy} onClick={() => { setEditing(false); setForm(f => ({ ...f, api_key: '' })) }}
                  className="px-3 py-2 text-sm text-ink-500 dark:text-parchment-300/70 hover:underline">
                  {t('orgs.cancel')}
                </button>
              </div>
            </form>
          ) : (
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => setEditing(true)}
                className="px-4 py-2 text-sm font-semibold rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-800 dark:text-parchment-100 hover:bg-parchment-100 dark:hover:bg-ink-800/60">
                {cfg?.source === 'org' ? t('orgs.ai.replace') : t('orgs.ai.useOwn')}
              </button>
              {cfg?.source === 'org' && (
                <button type="button" disabled={busy} onClick={clear}
                  className="text-[12px] text-rose-700 dark:text-rose-300 hover:underline">
                  {t('orgs.ai.remove')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </motion.div>
  )
}

function fmtFeastDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Parish feasts (LIT.5b) — a church's own liturgical days, layered over
// the universal calendar. Self-contained card: its own fetch + add/
// delete against /api/parish-feasts (admin-only, like this whole page).
function ParishFeastsCard() {
  const toast = useToast()
  const { t } = useLocale()
  const [feasts, setFeasts]   = useState([])
  const [failed, setFailed]   = useState(false)
  const [loading, setLoading] = useState(true)
  const [form, setForm]       = useState({ date: '', feast_name: '', liturgical_color: 'White' })
  const [saving, setSaving]   = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(apiUrl('/api/parish-feasts'))
      .then(r => {
        if (!r.ok) throw new Error('unread')
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        if (!d || !Array.isArray(d.feasts)) throw new Error('shape')
        setFeasts(d.feasts)
        setFailed(false)
      })
      .catch(() => { if (!cancelled) { setFailed(true); setFeasts([]) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function add(e) {
    e.preventDefault()
    if (!form.date || !form.feast_name.trim()) return
    setSaving(true)
    try {
      const res = await fetch(apiUrl('/api/parish-feasts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: form.date, feast_name: form.feast_name.trim(), liturgical_color: form.liturgical_color }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "That didn't save — nothing was lost. Please try again.")
      // Upsert: one feast per date, kept sorted.
      setFeasts(list => [...list.filter(f => f.date !== d.date), d].sort((a, b) => a.date.localeCompare(b.date)))
      setForm({ date: '', feast_name: '', liturgical_color: 'White' })
      toast.success(t('org.parish_feast_saved'))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(id) {
    try {
      const res = await fetch(apiUrl(`/api/parish-feasts/${id}`), { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error("That didn't delete — nothing was changed. Please try again.")
      setFeasts(list => list.filter(f => f.id !== id))
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: 0.15 }}
      className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 space-y-5"
    >
      <div className="flex items-center gap-2 pb-3 border-b border-parchment-300/60 dark:border-brass-900/25">
        <Cross size={14} className="text-brass-600 dark:text-brass-300" />
        <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">{t('orgs.feast.title')}</h2>
      </div>

      <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 -mt-1">
        {t('orgs.feast.hint')}
      </p>

      {loading ? (
        <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-brass-500" /></div>
      ) : failed ? (
        <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{t('feast.unread')}</p>
      ) : feasts.length === 0 ? (
        <p className="text-sm text-ink-500 dark:text-parchment-300/70">{t('orgs.feast.none')}</p>
      ) : (
        <ul className="divide-y divide-parchment-200/60 dark:divide-brass-900/20">
          {feasts.map(f => (
            <li key={f.id} className="flex items-center gap-3 py-2">
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${LIT_COLOR_DOT[f.liturgical_color] ?? LIT_COLOR_DOT_NONE}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink-900 dark:text-parchment-50 truncate">{f.feast_name}</p>
                <p className="text-[11px] text-ink-500 dark:text-parchment-300/70">{fmtFeastDate(f.date)}</p>
              </div>
              <button
                type="button"
                onClick={() => remove(f.id)}
                className="shrink-0 p-1.5 rounded-lg text-ink-400 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                aria-label={t('orgs.feast.removeAria', { name: f.feast_name })}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="pt-3 border-t border-parchment-300/60 dark:border-brass-900/25 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="date"
            aria-label={t('orgs.feast.date')}
            value={form.date}
            onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            className="px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
          />
          <input
            type="text"
            value={form.feast_name}
            onChange={e => setForm(f => ({ ...f, feast_name: e.target.value }))}
            placeholder={t('orgs.feast.namePh')}
            maxLength={120}
            className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 focus:outline-none focus:ring-2 focus:ring-brass-400"
          />
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label={t('orgs.feast.color')}
            value={form.liturgical_color}
            onChange={e => setForm(f => ({ ...f, liturgical_color: e.target.value }))}
            className="px-3 py-2 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
          >
            {LIT_COLORS.map(c => <option key={c} value={c}>{colorLabel(t, c)}</option>)}
          </select>
          <button
            type="submit"
            disabled={saving || !form.date || !form.feast_name.trim()}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-church-900 dark:bg-parchment-100 text-parchment-50 dark:text-church-900 hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            <Plus size={15} /> {saving ? t('orgs.adding') : t('orgs.feast.add')}
          </button>
        </div>
      </form>
    </motion.div>
  )
}

// Org-wide settings page (Sprint Y / Y.4). Admin-only — the letterhead
// fields here drive every printed giving statement, and future
// invoice / receipt templates will read from the same row. Non-admins
// who type the URL get a friendly Forbidden state.
//
// This is also the first real consumer of SaveButton + useSaveStatus
// (Sprint V3's primitives). The page stays mounted on success, so the
// 'Saved' checkmark actually reads to the admin — perfect fit.

// Field metadata — used to drive both the JSX render order and the
// initial empty-state form. Kept here rather than inline so a new
// field is one entry plus a TextField/textarea in the JSX.
const FIELDS = [
  { key: 'name',            label: 'Church name',     placeholder: 'First Baptist of Austin',                  hint: 'Shown on the letterhead and in your church directory.' },
  { key: 'address',         label: 'Mailing address', placeholder: '142 Olive St, Austin TX 78701',            hint: 'Single line; commas separate floors on the printed statement.' },
  { key: 'tax_id',          label: 'EIN / Tax ID',    placeholder: '12-3456789',                               hint: 'Required by the IRS for the donation receipt to be tax-deductible.' },
  { key: 'signatory_name',  label: 'Signatory name',  placeholder: 'Pastor Jane Doe',                          hint: 'Who signs the receipt — usually the senior pastor or treasurer.' },
  { key: 'signatory_title', label: 'Signatory title', placeholder: 'Senior Pastor',                            hint: 'Title that prints under the signatory name.' },
]

export default function OrgSettings() {
  const { user, updateUser } = useAuth()
  const { t, dateLocale } = useLocale()
  // Timezone options show a localized name ("Pacific Time — Los Angeles",
  // "hora del Pacífico — Los Angeles"); the value stays the IANA id that a
  // save stores. Built once per locale — ~400 zones, two Intl calls each.
  const tzLabels = useMemo(() => {
    const m = new Map()
    for (const z of TIMEZONES) m.set(z, parishTimeZoneLabel(z, dateLocale))
    return m
  }, [dateLocale])
  const tzLabel = (z) => tzLabels.get(z) ?? parishTimeZoneLabel(z, dateLocale)
  const { kind: nativeAiKind } = useNativeAi()
  const isAdmin = user?.role === 'admin'
  const toast = useToast()

  const [form, setForm]     = useState({})
  const [slug, setSlug]     = useState('')
  const [copied, setCopied] = useState(false)
  const [loading, setLoad]  = useState(true)
  const [err, setErr]       = useState('')

  // Full public URL for the church homepage. Built from the live origin
  // so it's copy-paste-ready for a bulletin or social bio.
  const publicUrl = slug ? `${window.location.origin}/p/${slug}` : ''
  const copyPublicUrl = async () => {
    if (!publicUrl) return
    try {
      await navigator.clipboard.writeText(publicUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('org.copy_failed_select_the_link'))
    }
  }

  // Initial load — pull the org's current values into the form state.
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetch(apiUrl('/api/organization'))
      .then(r => {
        if (r.status === 403) throw new Error('admin-only')
        if (!r.ok) throw new Error("Couldn't load organization settings. Nothing was lost — please retry.")
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        setSlug(d.slug ?? '')
        setForm({
          name:                 d.name                 ?? '',
          address:              d.address              ?? '',
          tax_id:               d.tax_id               ?? '',
          signatory_name:       d.signatory_name       ?? '',
          signatory_title:      d.signatory_title      ?? '',
          statement_letterhead: d.statement_letterhead ?? '',
          // Public church-page fields (Anchor 5 / A5.2).
          tagline:              d.tagline              ?? '',
          about:                d.about                ?? '',
          service_times:        d.service_times        ?? '',
          page_published:       d.page_published       ?? false,
          public_display_name:  d.public_display_name  ?? '',
          public_logo_url:      d.public_logo_url      ?? '',
          public_accent_hex:    d.public_accent_hex    ?? '',
          // Reminders (RM.3).
          reminder_lead_hours:  d.reminder_lead_hours  ?? 24,
          // The parish's clock (C4). NOT NULL DEFAULT 'UTC' server-side.
          timezone:             d.timezone             ?? 'UTC',
          // The parish's language (migration 093). NOT NULL with an 'en'
          // default server-side, so the ?? is only for a response that
          // predates the column.
          locale:               d.locale               ?? 'en',
        })
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [isAdmin])

  // PATCH wrapped in useSaveStatus so the SaveButton transitions
  // idle → saving → saved-checkmark → idle automatically.
  const { status, run: save } = useSaveStatus(async () => {
    const res = await fetch(apiUrl('/api/organization'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || "That didn't save — nothing was lost. Please try again.")
    }
    return res.json()
  }, {
    onSuccess: (saved) => {
      // The language the whole app resolves from lives on the in-memory
      // user, and a PATCH does not re-issue the session — so without this
      // an admin sets the parish to Español, the save succeeds, and
      // absolutely nothing on screen changes until they happen to reload.
      // A save that reports success and visibly does nothing is the same
      // lie as a failure that reports nothing at all.
      const org = { ...user?.organization }
      let sessionChanged = false
      if (saved?.locale && saved.locale !== org.locale) {
        org.locale = saved.locale
        sessionChanged = true
      }
      // The sacristy sheet reads this same in-memory zone for its window.
      // A saved timezone that stays on the old session until reload prints
      // one week and stamps another.
      if (typeof saved?.timezone === 'string' && saved.timezone !== org.timezone) {
        org.timezone = saved.timezone
        sessionChanged = true
      }
      if (sessionChanged) updateUser({ organization: org })
      // Subtle confirmation — SaveButton's checkmark covers the
      // primary signal; the toast is for the rare case a screen
      // reader doesn't catch the inline state change.
      toast.info(t('org.org_details_saved'))
    },
  })

  const onSubmit = (e) => {
    e.preventDefault()
    save().catch(err => toast.error(err.message))
  }

  const field = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  if (!isAdmin || err === 'admin-only') {
    return (
      <PageWrapper type="list">
        <div className="max-w-2xl mx-auto space-y-6 py-8">
          <PageHeader title={t('orgs.title')} />
          <EmptyState
            icon={AlertTriangle}
            title={t('orgs.adminOnly')}
            body={t('orgs.adminOnlyBody')}
          />
        </div>
      </PageWrapper>
    )
  }

  if (loading) {
    return (
      <PageWrapper type="list">
        <div className="flex items-center justify-center py-24">
          <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      </PageWrapper>
    )
  }

  if (err) {
    return (
      <PageWrapper type="list">
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState
            icon={AlertTriangle}
            title={t('orgs.loadFailed')}
            body={err}
          />
        </div>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper type="list">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
        >
          <PageHeader title={t('orgs.title')} />
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            {t('orgs.subtitle')}
          </p>
        </motion.div>

        {/* Form */}
        <motion.form
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.05 }}
          onSubmit={onSubmit}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 space-y-5"
        >
          <div className="flex items-center gap-2 pb-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <Building2 size={14} className="text-brass-600 dark:text-brass-300" />
            <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
              {t('orgs.letterhead')}
            </h2>
          </div>

          {FIELDS.map(f => (
            <TextField
              key={f.key}
              label={t(`orgs.f.${f.key}.label`)}
              value={form[f.key] ?? ''}
              onChange={field(f.key)}
              placeholder={t(`orgs.f.${f.key}.ph`)}
              hint={t(`orgs.f.${f.key}.hint`)}
              autoComplete="off"
            />
          ))}

          {/* Free-text preamble — multi-line, so this is a plain
              textarea rather than TextField. Same styling spine. */}
          <div>
            <label htmlFor="statement_letterhead" className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">
              {t('orgs.stmtLetterhead')}
            </label>
            <textarea
              id="statement_letterhead"
              value={form.statement_letterhead ?? ''}
              onChange={field('statement_letterhead')}
              rows={3}
              placeholder={t('orgs.stmtLetterheadPh')}
              className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-brass-400 resize-none"
            />
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
              {t('orgs.stmtHint')}
            </p>
          </div>

          <div className="pt-3 flex items-center justify-end gap-3 border-t border-parchment-300/60 dark:border-brass-900/25">
            <SaveButton status={status}>{t('orgs.saveSettings')}</SaveButton>
          </div>
        </motion.form>

        {/* Public church page (Anchor 5 / A5.2). Same save handler — the
            PATCH ships the whole form, so saving from either card
            persists everything. The publish toggle gates the public
            /p/:slug homepage server-side. */}
        <motion.form
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.08 }}
          onSubmit={onSubmit}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 space-y-5"
        >
          <div className="flex items-center justify-between gap-3 pb-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <div className="flex items-center gap-2">
              <Globe size={14} className="text-brass-600 dark:text-brass-300" />
              <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
                {t('orgs.page.title')}
              </h2>
            </div>
            {/* Publish toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <span className="text-xs font-medium text-ink-600 dark:text-parchment-200">
                {form.page_published ? t('orgs.page.published') : t('orgs.page.draft')}
              </span>
              <input
                type="checkbox"
                className="sr-only peer"
                checked={!!form.page_published}
                onChange={e => setForm(f => ({ ...f, page_published: e.target.checked }))}
              />
              <span className="relative w-9 h-5 rounded-full bg-parchment-300 dark:bg-ink-700 peer-checked:bg-church-800 dark:peer-checked:bg-church-600 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-4" />
            </label>
          </div>

          <div className="space-y-1">
            <Link
              to="/settings/site"
              className="inline-flex items-center min-h-[44px] text-sm font-semibold text-church-800 dark:text-brass-300 underline-offset-2 hover:underline rounded-md focus:outline-none focus:ring-2 focus:ring-brass-400"
            >
              {t('site.pub.settingsLink')}
            </Link>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70">
              {t('site.pub.settingsLinkHint')}
            </p>
          </div>

          {form.page_published && slug ? (
            // Live — surface the shareable URL with copy + view actions.
            <div className="-mt-1 flex flex-wrap items-center gap-2 rounded-lg bg-parchment-100 dark:bg-ink-800/60 border border-parchment-300/60 dark:border-brass-900/30 px-3 py-2">
              <span className="font-mono text-xs text-ink-700 dark:text-parchment-200 truncate flex-1 min-w-0">
                {publicUrl}
              </span>
              <button
                type="button"
                onClick={copyPublicUrl}
                className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-church-800 dark:text-brass-300 hover:bg-parchment-200/70 dark:hover:bg-ink-700/70 transition-colors"
              >
                {copied ? <><Check size={12} /> {t('orgs.copied')}</> : <><Copy size={12} /> {t('orgs.copy')}</>}
              </button>
              <a
                href={`/p/${slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-church-800 dark:text-brass-300 hover:bg-parchment-200/70 dark:hover:bg-ink-700/70 transition-colors"
              >
                {t('orgs.view')} <ExternalLink size={11} />
              </a>
            </div>
          ) : (
            <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 -mt-1">
              {t('orgs.page.liveAt')}{' '}
              <span className="font-mono">/p/{slug || 'your-church'}</span>.
            </p>
          )}

          <TextField
            label={t('orgs.page.tagline')}
            value={form.tagline ?? ''}
            onChange={field('tagline')}
            placeholder={t('orgs.page.taglinePh')}
            hint={t('orgs.page.taglineHint')}
            autoComplete="off"
          />

          <TextField
            label={t('orgs.page.displayName')}
            value={form.public_display_name ?? ''}
            onChange={field('public_display_name')}
            placeholder={t('orgs.page.displayNamePh')}
            hint={t('orgs.page.displayNameHint')}
            autoComplete="off"
          />

          <TextField
            label={t('orgs.page.logoUrl')}
            value={form.public_logo_url ?? ''}
            onChange={field('public_logo_url')}
            placeholder={t('orgs.page.logoUrlPh')}
            hint={t('orgs.page.logoUrlHint')}
            autoComplete="off"
            inputMode="url"
          />

          <TextField
            label={t('orgs.page.accentHex')}
            value={form.public_accent_hex ?? ''}
            onChange={field('public_accent_hex')}
            placeholder={t('orgs.page.accentHexPh')}
            hint={t('orgs.page.accentHexHint')}
            autoComplete="off"
          />

          <div>
            <label htmlFor="service_times" className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">
              {t('orgs.page.times')}
            </label>
            <textarea
              id="service_times"
              value={form.service_times ?? ''}
              onChange={field('service_times')}
              rows={3}
              placeholder={t('orgs.page.timesPh')} aria-label={t('orgs.page.timesPh')}
              className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-brass-400 resize-none"
            />
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
              {t('orgs.page.timesHint')}
            </p>
          </div>

          <div>
            <label htmlFor="about" className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">
              {t('orgs.page.about')}
            </label>
            <textarea
              id="about"
              value={form.about ?? ''}
              onChange={field('about')}
              rows={4}
              placeholder={t('orgs.page.aboutPh')} aria-label={t('orgs.page.aboutPh')}
              className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 placeholder-ink-400 dark:placeholder-parchment-400/50 focus:outline-none focus:ring-2 focus:ring-brass-400 resize-none"
            />
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
              {t('orgs.page.location')}
            </p>
          </div>

          <div className="pt-3 flex items-center justify-end gap-3 border-t border-parchment-300/60 dark:border-brass-900/25">
            <SaveButton status={status}>{t('orgs.page.save')}</SaveButton>
          </div>
        </motion.form>

        {/* Reminders (RM.3) — serving-reminder lead time. Shares the
            single PATCH save like the cards above. */}
        <motion.form
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.1 }}
          onSubmit={onSubmit}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 space-y-5"
        >
          <div className="flex items-center gap-2 pb-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <Bell size={14} className="text-brass-600 dark:text-brass-300" />
            <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
              {t('orgs.rem.title')}
            </h2>
          </div>

          {/* Timezone first: the lead time below is counted on this clock,
              and so is the kiosk's "today". A zone the org already has that
              the runtime does not list (an alias, an older table) is kept as
              its own option rather than silently swapped for the first one. */}
          <div>
            <label htmlFor="org_timezone" className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">
              {t('org.tz.label')}
            </label>
            <select
              id="org_timezone"
              value={form.timezone ?? 'UTC'}
              onChange={field('timezone')}
              className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
            >
              {form.timezone && !TIMEZONES.includes(form.timezone) && (
                <option value={form.timezone}>{tzLabel(form.timezone)}</option>
              )}
              <optgroup label={t('org.tz.common')}>
                {COMMON_TIMEZONES.map(z => <option key={z} value={z}>{tzLabel(z)}</option>)}
              </optgroup>
              {TIMEZONES.length > COMMON_TIMEZONES.length && (
                <optgroup label={t('org.tz.other')}>
                  {TIMEZONES.filter(z => !COMMON_TIMEZONES.includes(z)).map(z => <option key={z} value={z}>{tzLabel(z)}</option>)}
                </optgroup>
              )}
            </select>
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
              {t('org.tz.help')}
            </p>
          </div>

          <div>
            <label htmlFor="reminder_lead_hours" className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">
              {t('orgs.rem.lead')}
            </label>
            <select
              id="reminder_lead_hours"
              value={form.reminder_lead_hours ?? 24}
              onChange={e => setForm(f => ({ ...f, reminder_lead_hours: Number(e.target.value) }))}
              className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
            >
              <option value={12}>{t('orgs.rem.12')}</option>
              <option value={24}>{t('orgs.rem.24')}</option>
              <option value={48}>{t('orgs.rem.48')}</option>
              <option value={72}>{t('orgs.rem.72')}</option>
            </select>
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
              {t('orgs.rem.hint')}
            </p>
          </div>

          <div className="pt-3 flex items-center justify-end gap-3 border-t border-parchment-300/60 dark:border-brass-900/25">
            <SaveButton status={status}>{t('orgs.rem.save')}</SaveButton>
          </div>
        </motion.form>

        {/* Language. The parish's own, not a per-device preference.
            Everything needed to serve a Spanish parish was already
            translated — 1031 interface strings, every notification
            template, all eight certificate types — and none of it could be
            switched on, because until migration 093 an organization had no
            language to set. */}
        <motion.form
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.12 }}
          onSubmit={onSubmit}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-6 space-y-5"
        >
          <div className="flex items-center gap-2 pb-3 border-b border-parchment-300/60 dark:border-brass-900/25">
            <Languages size={14} className="text-brass-600 dark:text-brass-300" />
            <h2 className="text-sm font-semibold text-ink-800 dark:text-parchment-100">
              {t('orgs.lang.title')}
            </h2>
          </div>

          <div>
            <label htmlFor="org_locale" className="block text-xs font-semibold text-ink-600 dark:text-parchment-200 mb-1.5">
              {t('orgs.lang.label')}
            </label>
            <select
              id="org_locale"
              value={form.locale ?? 'en'}
              onChange={e => setForm(f => ({ ...f, locale: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400"
            >
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-parchment-300/70">
              {t('orgs.lang.hint')}
            </p>
          </div>

          <div className="pt-3 flex items-center justify-end gap-3 border-t border-parchment-300/60 dark:border-brass-900/25">
            <SaveButton status={status}>{t('orgs.lang.save')}</SaveButton>
          </div>
        </motion.form>

        {/* Parish feasts (LIT.5b) — manages its own state/save, separate
            from the org PATCH form above. */}
        <ParishFeastsCard />

        {/* Bring-your-own AI key (AIP.1) — admin-only page, so no extra
            role gate needed here; the server enforces regardless. */}
        {showParishAiKey(nativeAiKind) && <AIProviderCard />}

        {/* Diocese affiliation (DIO.1) — invitation / grant level / leave. */}
        <DioceseCard />

        {/* Complete parish export (EXP.1) — the custody promise, self-serve. */}
        <DataExportCard />

        <p className="text-xs text-ink-500 dark:text-parchment-300/70 px-1">
          {t('orgs.propagate')}
        </p>
      </div>
    </PageWrapper>
  )
}
