import { useEffect, useState, useCallback } from 'react'
import { Landmark, Loader2, Plus, Upload, RefreshCw } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { useLocale } from '../i18n'
import { apiUrl } from '../api'
import { useConfirm } from '../components/ConfirmProvider'

// Finance Ledger (FIN.1) — the parish's uniform money view against the
// standard chart of accounts. Donations and payroll flow in on their own
// (derived through mappings server-side); manual entries and trial-balance
// imports cover everything else. This page is the parish half of the
// OpenDiocese financial core: the summary it shows is exactly what a
// diocese roll-up will read later.

const SOURCE_CLS = {
  donation: 'bg-brass-50 text-brass-700 dark:bg-brass-900/20 dark:text-brass-300',
  payroll:  'bg-parchment-200/80 text-ink-700 dark:bg-ink-800 dark:text-parchment-200',
  manual:   'bg-parchment-100 text-ink-600 dark:bg-ink-800/60 dark:text-parchment-300',
  import:   'bg-parchment-100 text-ink-600 dark:bg-ink-800/60 dark:text-parchment-300',
}

function monthBounds() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const first = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return { start: first, end: `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}` }
}

const fmtMoney = v => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export default function Finance() {
  const { user } = useAuth()
  const { t } = useLocale()
  const toast = useToast()
  const ask = useConfirm()
  const canWrite = user?.role === 'admin' || user?.role === 'staff'

  const [{ start, end }, setPeriod] = useState(monthBounds)
  const [summary, setSummary]   = useState(null)
  const [entries, setEntries]   = useState([])
  const [coa, setCoa]           = useState([])
  const [mappings, setMappings] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading]   = useState(true)
  const [busy, setBusy]         = useState(false)

  const [manual, setManual] = useState({ entry_date: '', account_code: '', amount: '', memo: '' })
  const [csvText, setCsvText] = useState('')
  const [asOf, setAsOf] = useState('')

  // Diocese submissions (DIO.2) — present only when affiliated.
  const [aff, setAff] = useState(null)
  const [subs, setSubs] = useState([])
  const loadDiocese = useCallback(() => {
    fetch(apiUrl('/api/affiliation'))
      .then(r => (r.ok ? r.json() : { affiliation: null }))
      .then(d => {
        setAff(d.affiliation ?? null)
        if (d.affiliation?.status === 'active') {
          fetch(apiUrl('/api/finance/submissions'))
            .then(r => (r.ok ? r.json() : { submissions: [] }))
            .then(x => setSubs(x.submissions ?? []))
            .catch(() => {})
        }
      })
      .catch(() => {})
  }, [])
  useEffect(() => { loadDiocese() }, [loadDiocese])

  const submitPeriod = async () => {
    if (!(await ask({
      title: `Submit ${start} → ${end} to ${aff?.diocese_name}?`,
      body: 'The totals freeze exactly as they stand right now. Later edits to the ledger will not change what the chancery sees for this period.',
      confirmLabel: 'Submit period',
      tone: 'neutral',
    }))) return
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/finance/submissions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_start: start, period_end: end }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || t('fin.saveError'))
      toast.success('Period submitted to the diocese')
      loadDiocese()
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = `start=${start}&end=${end}`
      const [s, l, c, m] = await Promise.all([
        fetch(apiUrl(`/api/finance/summary?${qs}`)),
        fetch(apiUrl(`/api/finance/ledger?${qs}&limit=50`)),
        fetch(apiUrl('/api/finance/coa')),
        fetch(apiUrl('/api/finance/mappings')),
      ])
      if (!s.ok || !l.ok || !c.ok || !m.ok) throw new Error()
      setSummary(await s.json())
      setEntries((await l.json()).entries ?? [])
      setCoa((await c.json()).accounts ?? [])
      const md = await m.json()
      setMappings(md.mappings ?? [])
      setCategories(md.donation_categories ?? [])
    } catch {
      toast.error(t('fin.loadError'))
    } finally {
      setLoading(false)
    }
  }, [start, end]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  const revenueAccounts = coa.filter(a => a.acct_type === 'revenue' && a.active)
  const expenseAccounts = coa.filter(a => a.acct_type === 'expense' && a.active)
  const mappingFor = (type, key) => mappings.find(m => m.source_type === type && m.source_key === key)?.account_code ?? ''

  const saveMapping = async (source_type, source_key, account_code) => {
    try {
      const res = await fetch(apiUrl('/api/finance/mappings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: [{ source_type, source_key, account_code }] }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || t('fin.saveError'))
      }
      toast.success(t('fin.mappingSaved'))
      load()
    } catch (err) { toast.error(err.message) }
  }

  const addManual = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/finance/ledger'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...manual, amount: Number(manual.amount) }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || t('fin.saveError'))
      }
      setManual({ entry_date: '', account_code: '', amount: '', memo: '' })
      toast.success(t('fin.entrySaved'))
      load()
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  const runImport = async () => {
    if (!csvText.trim() || !asOf) { toast.error(t('fin.importNeeds')); return }
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/finance/ledger/import'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, as_of: asOf }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok && !d.imported) throw new Error(d.error || t('fin.saveError'))
      toast.success(t('fin.imported').replace('{n}', String(d.imported ?? 0)))
      if (d.errors?.length) toast.error(t('fin.importErrors').replace('{n}', String(d.errors.length)))
      setCsvText('')
      load()
    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
  }

  const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500'
  const cardCls = 'rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 bg-parchment-50 dark:bg-ink-900 shadow-warm p-4'

  return (
    <PageWrapper>
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <div className="flex items-center gap-2">
          <Landmark size={20} className="text-church-700 dark:text-brass-300" />
          <div>
            <h1 className="text-2xl font-display font-bold text-ink-900 dark:text-parchment-50">{t('fin.title')}</h1>
            <p className="text-sm text-ink-500 dark:text-parchment-300/70">{t('fin.sub')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={start} onChange={e => setPeriod(p => ({ ...p, start: e.target.value }))} className={inputCls} aria-label={t('fin.from')} />
          <span className="text-ink-400">–</span>
          <input type="date" value={end} onChange={e => setPeriod(p => ({ ...p, end: e.target.value }))} className={inputCls} aria-label={t('fin.to')} />
          <button type="button" onClick={load} aria-label={t('fin.refresh')}
            className="p-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:text-church-700 dark:hover:text-brass-300">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
      ) : (
        <div className="space-y-5">
          {/* Summary tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              [t('fin.revenue'), summary?.totals?.revenue],
              [t('fin.expense'), summary?.totals?.expense],
              [t('fin.net'), summary?.totals?.net],
              [t('fin.assessable'), summary?.totals?.assessable_base],
            ].map(([label, value]) => (
              <div key={label} className={cardCls}>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">{label}</p>
                <p className="mt-1 text-xl font-display font-bold text-ink-900 dark:text-parchment-50">{fmtMoney(value)}</p>
              </div>
            ))}
          </div>

          {/* Rollup groups */}
          <div className={cardCls}>
            <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300 mb-2">{t('fin.byGroup')}</p>
            {(summary?.groups ?? []).length === 0 ? (
              <EmptyState icon={Landmark} title={t('fin.emptyTitle')} body={t('fin.emptyBody')} />
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {(summary?.groups ?? []).map((g, i) => (
                    <tr key={i} className="border-t first:border-t-0 border-parchment-300/50 dark:border-brass-900/25 text-ink-800 dark:text-parchment-100">
                      <td className="py-1.5 pr-2">
                        {g.rollup_group}
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-400 dark:text-parchment-400/60">{t(`fin.${g.acct_type}`)}</span>
                        {g.acct_type === 'revenue' && g.assessable && (
                          <span className="ml-1.5 text-[10px] font-semibold text-brass-700 dark:text-brass-300">{t('fin.assessableTag')}</span>
                        )}
                      </td>
                      <td className="py-1.5 text-right whitespace-nowrap font-medium">{fmtMoney(g.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Category mappings */}
          {canWrite && (
            <div className={cardCls}>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300 mb-1">{t('fin.mappings')}</p>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mb-3">{t('fin.mappingsSub')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {categories.map(cat => (
                  <div key={cat} className="flex items-center gap-2">
                    <span className="flex-1 text-sm text-ink-800 dark:text-parchment-100 truncate">{cat}</span>
                    <select value={mappingFor('donation_category', cat)} aria-label={`${t('fin.account')} — ${cat}`} className={`${inputCls} !w-56`}
                      onChange={e => saveMapping('donation_category', cat, e.target.value)}>
                      <option value="">{t('fin.defaultAccount')}</option>
                      {revenueAccounts.map(a => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                    </select>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-ink-800 dark:text-parchment-100">{t('fin.payrollWages')}</span>
                  <select value={mappingFor('payroll', 'wages')} aria-label={`${t('fin.account')} — ${t('fin.payrollWages')}`} className={`${inputCls} !w-56`}
                    onChange={e => saveMapping('payroll', 'wages', e.target.value)}>
                    <option value="">{t('fin.defaultAccount')}</option>
                    {expenseAccounts.map(a => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Diocese submissions (DIO.2) */}
          {canWrite && aff?.status === 'active' && (
            <div className={cardCls}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300">Diocese reporting</p>
                  <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-0.5">
                    Affiliated with {aff.diocese_name} · sharing: {aff.grant_level}. Submitting freezes the selected period's totals for chancery review.
                  </p>
                </div>
                <button type="button" disabled={busy} onClick={submitPeriod}
                  className="px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60">
                  Submit {start} → {end}
                </button>
              </div>
              {subs.length > 0 && (
                <table className="w-full text-sm mt-3">
                  <tbody>
                    {subs.slice(0, 8).map(sub => (
                      <tr key={sub.id} className="border-t border-parchment-300/50 dark:border-brass-900/25 text-ink-800 dark:text-parchment-100">
                        <td className="py-1.5 pr-2 whitespace-nowrap">{sub.period_start} → {sub.period_end}</td>
                        <td className="py-1.5 pr-2 text-right whitespace-nowrap">{fmtMoney(sub.totals?.revenue)} rev</td>
                        <td className="py-1.5 text-right">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                            sub.status === 'approved' ? 'bg-brass-100/70 text-brass-800 dark:bg-brass-900/30 dark:text-brass-200'
                            : sub.status === 'returned' ? 'bg-rose-50 text-rose-700 dark:bg-rose-900/20 dark:text-rose-300'
                            : 'bg-parchment-200/80 text-ink-700 dark:bg-ink-800 dark:text-parchment-200'
                          }`}>{sub.status}</span>
                          {sub.review_note && <span className="block text-[11px] font-normal text-ink-500 dark:text-parchment-300/70">{sub.review_note}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Manual entry + import */}
          {canWrite && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <form onSubmit={addManual} className={cardCls}>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300 mb-2">{t('fin.addEntry')}</p>
                <div className="grid grid-cols-2 gap-2">
                  <input type="date" required value={manual.entry_date} onChange={e => setManual(f => ({ ...f, entry_date: e.target.value }))} className={inputCls} aria-label={t('fin.date')} />
                  <select required value={manual.account_code} onChange={e => setManual(f => ({ ...f, account_code: e.target.value }))} className={inputCls} aria-label={t('fin.account')}>
                    <option value="">{t('fin.account')}…</option>
                    {coa.filter(a => a.active).map(a => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                  </select>
                  <input type="number" step="0.01" required placeholder={t('fin.amount')} value={manual.amount} onChange={e => setManual(f => ({ ...f, amount: e.target.value }))} className={inputCls} />
                  <input type="text" placeholder={t('fin.memo')} value={manual.memo} onChange={e => setManual(f => ({ ...f, memo: e.target.value }))} className={inputCls} />
                </div>
                <button type="submit" disabled={busy}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-church-800 text-parchment-50 hover:bg-church-900 disabled:opacity-60">
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {t('fin.save')}
                </button>
              </form>

              <div className={cardCls}>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300 mb-1">{t('fin.import')}</p>
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 mb-2">{t('fin.importSub')}</p>
                <textarea rows={4} value={csvText} onChange={e => setCsvText(e.target.value)}
                  placeholder={'account_code,amount,memo\n4110,12500.00,Q2 offertory'}
                  className={`${inputCls} font-mono text-xs`} />
                <div className="mt-2 flex items-center gap-2">
                  <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className={inputCls} aria-label={t('fin.asOf')} title={t('fin.asOf')} />
                  <button type="button" onClick={runImport} disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg border border-brass-400/60 text-brass-800 dark:text-brass-300 hover:bg-brass-50 dark:hover:bg-brass-900/20 disabled:opacity-60">
                    <Upload size={13} /> {t('fin.importBtn')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Recent entries */}
          <div className={cardCls}>
            <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300 mb-2">{t('fin.recent')}</p>
            {entries.length === 0 ? (
              <p className="text-sm text-ink-500 dark:text-parchment-300/70 italic">{t('fin.noEntries')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-widest text-brass-700 dark:text-brass-300">
                      <th className="py-2 pr-3 font-bold">{t('fin.date')}</th>
                      <th className="py-2 pr-3 font-bold">{t('fin.account')}</th>
                      <th className="py-2 pr-3 font-bold">{t('fin.memo')}</th>
                      <th className="py-2 pr-3 font-bold">{t('fin.source')}</th>
                      <th className="py-2 text-right font-bold">{t('fin.amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e, i) => (
                      <tr key={`${e.source_type}-${e.source_id}-${i}`} className="border-t border-parchment-300/50 dark:border-brass-900/25 text-ink-800 dark:text-parchment-100">
                        <td className="py-1.5 pr-3 whitespace-nowrap">{e.entry_date}</td>
                        <td className="py-1.5 pr-3">{e.account_code}<span className="block text-[11px] text-ink-400 dark:text-parchment-400/60">{e.account_name}</span></td>
                        <td className="py-1.5 pr-3">{e.memo || '—'}</td>
                        <td className="py-1.5 pr-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${SOURCE_CLS[e.source_type] || ''}`}>
                            {t(`fin.src_${e.source_type}`)}
                          </span>
                        </td>
                        <td className="py-1.5 text-right whitespace-nowrap font-medium">{fmtMoney(e.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </PageWrapper>
  )
}
