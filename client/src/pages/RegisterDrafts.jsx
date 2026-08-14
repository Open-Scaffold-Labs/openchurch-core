// Register digitization sandbox (SAC.6) — the staging area between a
// CSV export / OCR pass over the paper register and the permanent
// sacramental register. Paste rows, review each draft side-by-side
// (raw on the left, structured form on the right), then commit or
// discard. Nothing reaches the register without a human commit.
//
// URL: /register/drafts   (admin/staff — writes are writeGated server-side)

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check, ClipboardPaste, Loader2, Trash2, Upload } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useToast } from '../components/ToastProvider'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'

const TYPES = ['baptism', 'reconciliation', 'first_communion', 'confirmation', 'marriage', 'holy_orders', 'anointing', 'burial']

// Header names we recognize in a pasted CSV (case-insensitive). Anything
// unrecognized stays in raw_payload only — visible in review, never
// silently written to the register.
const HEADER_MAP = {
  type: 'type', sacrament: 'type',
  date: 'date',
  minister: 'minister', celebrant: 'minister',
  place: 'place', church: 'place',
  certificate_no: 'certificate_no', certificate: 'certificate_no', 'cert no': 'certificate_no',
  notes: 'notes', note: 'notes',
  godparents: 'godparents', sponsors: 'sponsors',
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
  return lines.slice(1).map(line => {
    const cells = line.split(',').map(c => c.trim())
    const raw = {}
    const draft = {}
    headers.forEach((h, i) => {
      const val = cells[i] ?? ''
      raw[h] = val
      const field = HEADER_MAP[h]
      if (!field || !val) return
      if (field === 'godparents' || field === 'sponsors') {
        draft.meta_attributes = draft.meta_attributes || {}
        draft.meta_attributes[field] = val.split(/;|\|/).map(s => s.trim()).filter(Boolean)
      } else if (field === 'type') {
        const t = val.toLowerCase().replace(/\s+/g, '_')
        if (TYPES.includes(t)) draft.type = t
      } else {
        draft[field] = val
      }
    })
    return { source: 'csv', raw_payload: raw, draft }
  })
}

export default function RegisterDrafts() {
  const toast = useToast()
  const { t } = useLocale()
  const [drafts,  setDrafts]  = useState([])
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [csv,     setCsv]     = useState('')
  const [staging, setStaging] = useState(false)
  const [busyId,  setBusyId]  = useState(null)
  const [rowErr,  setRowErr]  = useState({})

  async function load() {
    setLoading(true); setError('')
    try {
      const r = await fetch(apiUrl('/api/sacraments/drafts?status=pending&limit=100'))
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `Failed to load (${r.status})`)
      setDrafts(d.drafts ?? [])
    } catch { setError(t('err.load')) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    fetch(apiUrl('/api/clients'))
      .then(r => r.json())
      .then(list => setMembers(Array.isArray(list) ? list : []))
      .catch(() => {})
  }, [])

  const memberOptions = useMemo(
    () => members.map(m => ({ id: m.id, name: m.name })).sort((a, b) => a.name.localeCompare(b.name)),
    [members]
  )

  async function stageCsv() {
    const parsed = parseCsv(csv)
    if (!parsed.length) { setError('Paste a CSV with a header row and at least one data row.'); return }
    setStaging(true); setError('')
    try {
      const r = await fetch(apiUrl('/api/sacraments/drafts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drafts: parsed }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `Failed to stage (${r.status})`)
      setCsv('')
      await load()
    } catch { setError(t('err.save')) }
    finally { setStaging(false) }
  }

  function setField(id, field, value) {
    setDrafts(ds => ds.map(d => d.id === id
      ? { ...d, draft: { ...d.draft, [field]: value === '' ? undefined : value } }
      : d))
  }
  function setMetaList(id, key, text) {
    setDrafts(ds => ds.map(d => {
      if (d.id !== id) return d
      const names = text.split(/;|,/).map(s => s.trim()).filter(Boolean)
      const meta = { ...(d.draft.meta_attributes || {}) }
      if (names.length) meta[key] = names; else delete meta[key]
      return { ...d, draft: { ...d.draft, meta_attributes: Object.keys(meta).length ? meta : undefined, [`_${key}_text`]: text } }
    }))
  }

  async function commit(d) {
    setBusyId(d.id); setRowErr(e => ({ ...e, [d.id]: '' }))
    try {
      // Persist the edited draft, then commit it.
      const { _godparents_text, _sponsors_text, ...draftBody } = d.draft
      let r = await fetch(apiUrl(`/api/sacraments/drafts/${d.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: draftBody }),
      })
      let body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || `Failed to save draft (${r.status})`)

      r = await fetch(apiUrl(`/api/sacraments/drafts/${d.id}/commit`), { method: 'POST' })
      body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || `Failed to commit (${r.status})`)
      setDrafts(ds => ds.filter(x => x.id !== d.id))
      // The amen — the most sacred write in the product should not
      // pass in silence.
      toast.success(t('drafts.committed'))
    } catch { setRowErr(e => ({ ...e, [d.id]: t('err.save') })) }
    finally { setBusyId(null) }
  }

  async function discard(d) {
    setBusyId(d.id)
    try {
      const r = await fetch(apiUrl(`/api/sacraments/drafts/${d.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'discarded' }),
      })
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || 'Failed to discard') }
      setDrafts(ds => ds.filter(x => x.id !== d.id))
    } catch { setRowErr(e => ({ ...e, [d.id]: t('err.save') })) }
    finally { setBusyId(null) }
  }

  const inputCls = 'w-full px-2.5 py-1.5 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-brass-400/50'
  const labelCls = 'block text-[11px] font-medium text-ink-500 dark:text-parchment-300/70 mb-0.5'

  return (
    <PageWrapper>
      <div className="mb-6">
        <Link to="/register" className="inline-flex items-center gap-1.5 text-sm text-church-700 dark:text-brass-300 hover:underline">
          <ArrowLeft size={15} /> {t('drafts.back')}
        </Link>
        <h1 className="mt-2 text-2xl font-display font-bold text-ink-900 dark:text-parchment-50">{t('drafts.title')}</h1>
        <p className="text-sm text-ink-500 dark:text-parchment-300/70">
          {t('drafts.sub')}
        </p>
      </div>

      {/* Stage new rows */}
      <div className="mb-8 rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 p-4">
        <div className="flex items-center gap-2 mb-2 text-ink-700 dark:text-parchment-200">
          <ClipboardPaste size={16} />
          <h2 className="text-sm font-semibold">{t('drafts.paste')}</h2>
        </div>
        <p className="text-xs text-ink-500 dark:text-parchment-300/70 mb-2">
          {t('drafts.pasteHelp')}
        </p>
        <textarea
          rows={4}
          value={csv}
          onChange={e => setCsv(e.target.value)}
          placeholder={'type,date,minister,place\nbaptism,1998-05-17,Fr. Ortega,St. Brigid'}
          className={`${inputCls} font-mono text-xs`}
        />
        <div className="mt-2 flex justify-end">
          <button type="button" onClick={stageCsv} disabled={staging || !csv.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-50">
            {staging ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} {t('drafts.stage')}
          </button>
        </div>
      </div>

      {error && <p className="mb-4 text-sm text-rose-700 dark:text-rose-300">{error}</p>}

      {/* Pending drafts */}
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
      ) : drafts.length === 0 ? (
        <EmptyState title={t('drafts.emptyTitle')} body={t('drafts.emptyBody')} />
      ) : (
        <ul className="space-y-4">
          {drafts.map(d => (
            <li key={d.id} className="rounded-xl border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-50 dark:bg-ink-900 p-4">
              <div className="grid md:grid-cols-2 gap-4">
                {/* Raw, verbatim */}
                <div className="min-w-0">
                  <p className={labelCls}>{t('drafts.original')} ({d.source})</p>
                  <pre className="text-xs bg-parchment-100/60 dark:bg-ink-800 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap text-ink-700 dark:text-parchment-200">
{JSON.stringify(d.raw_payload, null, 2)}
                  </pre>
                </div>
                {/* Structured draft */}
                <div className="grid grid-cols-2 gap-2 content-start">
                  <div>
                    <label className={labelCls}>{t('drafts.sacrament')}</label>
                    <select value={d.draft.type ?? ''} onChange={e => setField(d.id, 'type', e.target.value)} className={inputCls}>
                      <option value="">{t('drafts.choose')}</option>
                      {TYPES.map(ty => <option key={ty} value={ty}>{t(`sac.${ty}`)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>{t('register.date')}</label>
                    <input type="date" value={d.draft.date ?? ''} onChange={e => setField(d.id, 'date', e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>{t('drafts.memberOpt')}</label>
                    <select value={d.draft.client_id ?? ''} onChange={e => setField(d.id, 'client_id', e.target.value ? Number(e.target.value) : undefined)} className={inputCls}>
                      <option value="">{t('drafts.notLinked')}</option>
                      {memberOptions.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>{t('register.minister')}</label>
                    <input value={d.draft.minister ?? ''} onChange={e => setField(d.id, 'minister', e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>{t('register.place')}</label>
                    <input value={d.draft.place ?? ''} onChange={e => setField(d.id, 'place', e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>{t('register.certNo')}</label>
                    <input value={d.draft.certificate_no ?? ''} onChange={e => setField(d.id, 'certificate_no', e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>{t('drafts.godparents')}</label>
                    <input value={d.draft._godparents_text ?? (d.draft.meta_attributes?.godparents ?? []).join('; ')}
                      onChange={e => setMetaList(d.id, 'godparents', e.target.value)} placeholder={t('drafts.namesPlaceholder')} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>{t('drafts.sponsors')}</label>
                    <input value={d.draft._sponsors_text ?? (d.draft.meta_attributes?.sponsors ?? []).join('; ')}
                      onChange={e => setMetaList(d.id, 'sponsors', e.target.value)} placeholder={t('drafts.namesPlaceholder')} className={inputCls} />
                  </div>
                  <div className="col-span-2">
                    <label className={labelCls}>{t('drafts.notes')}</label>
                    <input value={d.draft.notes ?? ''} onChange={e => setField(d.id, 'notes', e.target.value)} className={inputCls} />
                  </div>
                </div>
              </div>

              {rowErr[d.id] && <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{rowErr[d.id]}</p>}

              <div className="mt-3 flex items-center justify-end gap-2">
                <button type="button" onClick={() => discard(d)} disabled={busyId === d.id}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-600 dark:text-parchment-300 hover:text-rose-700 dark:hover:text-rose-300 disabled:opacity-50">
                  <Trash2 size={13} /> {t('drafts.discard')}
                </button>
                <button type="button" onClick={() => commit(d)} disabled={busyId === d.id || !d.draft.type}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-50">
                  {busyId === d.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {t('drafts.commit')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageWrapper>
  )
}
