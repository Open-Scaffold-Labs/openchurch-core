import { useState, useEffect, useCallback } from 'react'
import { Landmark, Loader2, Plus, Upload, RefreshCw } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import LoadFailure from '../components/LoadFailure'
import { useLoad } from '../hooks/useLoad'
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
  const [busy, setBusy]         = useState(false)

  const [manual, setManual] = useState({ entry_date: '', account_code: '', amount: '', memo: '' })
  const [csvText, setCsvText] = useState('')
  const [asOf, setAsOf] = useState('')

  // Diocese submissions (DIO.2) — present only when affiliated.
  const [aff, setAff] = useState(null)
  const [subs, setSubs] = useState([])
  // NOT migrated, deliberately. This block has the same shape —
  // `r.ok ? r.json() : { submissions: [] }` — and so the same defect, but
  // Pass 7 pilots the load contract where it proves the semantics and does
  // not rewrite Finance. Carried forward in the report.
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

  // Four requests used to ride one Promise.all with `if (!s.ok || !l.ok ||
  // !c.ok || !m.ok) throw`. One failure blanked all four: summary went null,
  // the ledger went to [], and the rollup card rendered
  // "Nothing recorded in this period" — a parish shown an empty set of books
  // because the chart of accounts 404'd. The only other signal was a toast,
  // which is gone in four seconds.
  //
  // Three independent reads now, because they answer three different
  // questions. The money tiles already read `—` for an unknown value
  // (fmtMoney returns a dash for anything non-finite) and that was already
  // right; what was wrong was everything around them.
  const readJson = (path) => async () => {
    const res = await fetch(apiUrl(path))
    if (!res.ok) throw new Error(`Failed (${res.status})`)
    return res.json()
  }
  const qs = `start=${start}&end=${end}`

  // A period with no activity is a real answer, and $0.00 is its honest
  // rendering — so this load is NEVER empty. Emptiness here belongs to the
  // groups list, not to the summary itself.
  const summaryLoad = useLoad(readJson(`/api/finance/summary?${qs}`), [start, end], { isEmpty: () => false })
  const ledgerLoad  = useLoad(
    async () => (await readJson(`/api/finance/ledger?${qs}&limit=50`)())?.entries ?? [],
    [start, end])
  // Chart of accounts + mappings feed the forms below. They are one read
  // because they populate the same controls and are useless apart.
  const settingsLoad = useLoad(async () => {
    const [c, m] = await Promise.all([readJson('/api/finance/coa')(), readJson('/api/finance/mappings')()])
    return { accounts: c.accounts ?? [], mappings: m.mappings ?? [],
             categories: m.donation_categories ?? [], funds: m.funds ?? [] }
  }, [], { isEmpty: () => false })

  const summary   = summaryLoad.data
  const entries   = ledgerLoad.data ?? []
  const coa        = settingsLoad.data?.accounts ?? []
  const mappings   = settingsLoad.data?.mappings ?? []
  const categories = settingsLoad.data?.categories ?? []
  const funds      = settingsLoad.data?.funds ?? []
  const loading = summaryLoad.state === 'loading' && ledgerLoad.state === 'loading'
  const load = async () => {
    await Promise.all([summaryLoad.reload(), ledgerLoad.reload(), settingsLoad.reload()])
  }

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
            className="tap shrink-0 inline-flex items-center justify-center px-3 py-2 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:text-church-700 dark:hover:text-brass-300">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-brass-600" /></div>
      ) : (
        <div className="space-y-5">
          {/* A failed read is announced where the money is, not in a toast
              that has already gone. The tiles themselves were always honest —
              fmtMoney returns a dash for anything non-finite — but a dash
              with no explanation reads as "we have none". */}
          {summaryLoad.state === 'failed' && (
            <LoadFailure variant="strip" body={t('fin.summaryFailedBody')} cause={summaryLoad.error}
              onRetry={summaryLoad.reload} retrying={summaryLoad.retrying} />
          )}
          {summaryLoad.isStale && (
            <LoadFailure variant="strip" body={t('load.staleBody')} cause={summaryLoad.error}
              onRetry={summaryLoad.reload} retrying={summaryLoad.retrying} />
          )}

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
            {summaryLoad.state === 'failed' ? (
              /* NOT "nothing recorded in this period". We did not read the
                 period. A parish looking at its own books must never be
                 shown an empty set of them because a request failed. */
              <LoadFailure variant="strip" body={t('fin.summaryFailedBody')} cause={summaryLoad.error}
                onRetry={summaryLoad.reload} retrying={summaryLoad.retrying} />
            ) : (summary?.groups ?? []).length === 0 ? (
              <EmptyState icon={Landmark} title={t('fin.emptyTitle')} body={t('fin.emptyBody')} />
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {(summary?.groups ?? []).map((g, i) => (
                    <tr key={i} className="border-t first:border-t-0 border-parchment-300/50 dark:border-brass-900/25 text-ink-800 dark:text-parchment-100">
                      <td className="py-1.5 pr-2">
                        {g.rollup_group}
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-500 dark:text-parchment-300/70">{t(`fin.${g.acct_type}`)}</span>
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

          {/* Funds → accounts (086).
              Placed ABOVE the category mappings on purpose: a fund is a
              record the parish deliberately created and designates gifts
              to; a category is a word somebody typed on one gift. The
              fund is the stronger signal and the ledger now prefers it,
              so it should be the first thing offered, not a footnote
              under the weaker one.

              The wording is the careful part. A parish must be able to
              tell OpenChurch that the roof fund is restricted capital
              WITHOUT the screen implying they are choosing what their
              diocese assesses. They are classifying, not deciding — and
              where a diocese is attached, the assessable column is the
              diocese's and says so. */}
          {canWrite && funds.length > 0 && (
            <div className={cardCls}>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-brass-700 dark:text-brass-300 mb-1">{t('fin.fundMappings')}</p>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mb-1">{t('fin.fundMappingsSub')}</p>
              <p className="text-xs text-ink-500 dark:text-parchment-300/70 mb-3">
                {aff?.status === 'active'
                  ? t('fin.fundMappingsDiocese', { diocese: aff.diocese_name })
                  : t('fin.fundMappingsNoDiocese')}
              </p>
              <div className="space-y-2">
                {funds.map(f => {
                  const code = mappingFor('fund', String(f.id))
                  const acct = revenueAccounts.find(a => a.code === code)
                  return (
                    <div key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="flex-1 min-w-[9rem] text-sm text-ink-800 dark:text-parchment-100 truncate">
                        {f.name}
                        <span className="ml-2 text-xs text-ink-500 dark:text-parchment-300/70 whitespace-nowrap">
                          {f.gift_count === 1
                            ? t('fin.fundOneGift', { total: fmtMoney(f.gift_total) })
                            : t('fin.fundGifts', { n: f.gift_count, total: fmtMoney(f.gift_total) })}
                        </span>
                      </span>
                      <select value={code} aria-label={`${t('fin.account')} — ${f.name}`} className={`${inputCls} !w-56`}
                        onChange={e => saveMapping('fund', String(f.id), e.target.value)}>
                        <option value="">{t('fin.defaultAccount')}</option>
                        {revenueAccounts.map(a => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                      </select>
                      {/* A fact about the account, not a switch. Stated in
                          the ordinary muted type either way — nothing here
                          is a warning, and "not counted" is not a prize. */}
                      <span className="w-full sm:w-44 text-xs text-ink-500 dark:text-parchment-300/70">
                        {acct
                          ? (acct.assessable ? t('fin.fundCounted') : t('fin.fundNotCounted'))
                          : t('fin.fundCountedDefault')}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

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
            {ledgerLoad.state === 'failed' ? (
              <LoadFailure variant="strip" body={t('fin.ledgerFailedBody')} cause={ledgerLoad.error}
                onRetry={ledgerLoad.reload} retrying={ledgerLoad.retrying} />
            ) : entries.length === 0 ? (
              <p className="text-sm text-ink-500 dark:text-parchment-300/70 italic">{t('fin.noEntries')}</p>
            ) : (
              // tabIndex + role: a horizontally scrolling region has to be
              // reachable by keyboard, or the columns past the right edge are
              // unreachable to anyone not using a mouse or a thumb. Only bites
              // on narrow viewports — which is exactly where the ledger
              // overflows, and exactly where it matters.
              <div
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label="Ledger entries — scrolls horizontally"
              >
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
                        <td className="py-1.5 pr-3">{e.account_code}<span className="block text-[11px] text-ink-500 dark:text-parchment-300/70">{e.account_name}</span></td>
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
