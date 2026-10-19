import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Users, DollarSign, Feather, TrendingUp, AlertTriangle, Loader2, UserCheck, Heart, UserX } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { apiUrl } from '../api'
import { useAuth } from '../context/AuthContext'
import { useLocale } from '../i18n'

// Tenant analytics dashboard (Sprint A). Admin-only — every chart
// rolls up real numbers that staff/viewers shouldn't be enumerating.
//
// Layout, top to bottom:
//   - 4 summary cards: members, YTD donations, AI this month
//     (with delta vs last month), active staff
//   - Members joined per month (area chart, last 12)
//   - Donations per month (bar chart, last 12)
//   - Donation categories (top 5 + 'other' bucket)
//
// Single fetch — /api/insights bundles all four shapes. Server is
// private-cached 60s so reload-spam is cheap.

function fmtCurrency(n) {
  return Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}
function fmtMonth(ym, dateLocale) {
  // 'YYYY-MM' → 'Mon' (short month name). Used as the X-axis label.
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(dateLocale, { month: 'short' })
}

// One brass voice, not a traffic light. These four cards used to be
// colour-coded violet / emerald / indigo / brass, which is the generic-SaaS
// habit of making hue carry the category. It doesn't: the icon and the label
// already say which card this is, and four different accent families on one
// row is the exact rainbow the C3 sweep removed from Donations, Members and
// Payroll. Hue is reserved for meaning that changes (see the fulfillment bar
// below, where it does).
function SummaryCard({ icon: Icon, label, value, sub }) {
  return (
    <div className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-brass-700 dark:text-brass-300 bg-brass-50 dark:bg-brass-900/20">
          <Icon size={16} />
        </div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-parchment-300/70">{label}</p>
      </div>
      <p className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 leading-tight">
        {value}
      </p>
      {sub && (
        <p className="text-xs text-ink-500 dark:text-parchment-300/70 mt-1">{sub}</p>
      )}
    </div>
  )
}

// Category breakdown as a horizontal bar list with proportional fill.
// Chose a bar list over a pie/donut because at small donation totals
// (1-2 categories) pies look comically lopsided; bars degrade more
// gracefully.
function CategoryBars({ categories }) {
  const { t } = useLocale()
  if (!categories?.length) {
    return (
      <p className="text-sm text-ink-500 dark:text-parchment-300/70 py-6 text-center">
        {t('ins.noDon')}
      </p>
    )
  }
  const max = Math.max(...categories.map(c => c.total))
  return (
    <ul className="space-y-3">
      {categories.slice(0, 6).map(c => {
        const pct = (c.total / max) * 100
        return (
          <li key={c.category}>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-sm font-semibold text-ink-700 dark:text-parchment-200 capitalize">
                {c.category}
              </span>
              <span className="text-sm tabular-nums text-ink-900 dark:text-parchment-50">
                {fmtCurrency(c.total)} <span className="text-ink-500 dark:text-parchment-300/70 text-xs">· {t(c.count === 1 ? 'ins.gift1' : 'ins.giftN', { n: c.count })}</span>
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-parchment-200/80 dark:bg-ink-800 overflow-hidden">
              <div
                className="h-full bg-brass-500 dark:bg-brass-400 transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export default function Insights() {
  const { user } = useAuth()
  const { t, dateLocale } = useLocale()
  const isAdmin = user?.role === 'admin'

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  // "Who hasn't shown up" — pastoral care list. Separate fetch so the
  // weeks selector can re-query without reloading the whole dashboard.
  // A refused read is not "everyone has been seen." The previous list
  // is cleared on failure so a later miss is not the old answer.
  const [lapsedWeeks, setLapsedWeeks] = useState(3)
  const [lapsed, setLapsed] = useState(null)
  const [lapsedErr, setLapsedErr] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetch(apiUrl(`/api/insights/lapsed?weeks=${lapsedWeeks}`))
      .then(async r => {
        if (!r.ok) throw new Error(`${r.status}`)
        const d = await r.json()
        if (!d || !Array.isArray(d.members)) throw new Error('malformed')
        return d
      })
      .then(d => { if (!cancelled) { setLapsedErr(false); setLapsed(d) } })
      .catch(() => { if (!cancelled) { setLapsed(null); setLapsedErr(true) } })
    return () => { cancelled = true }
  }, [isAdmin, lapsedWeeks])

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetch(apiUrl('/api/insights'))
      .then(r => {
        if (r.status === 403) throw new Error('admin-only')
        if (!r.ok) throw new Error(`Failed (${r.status})`)
        return r.json()
      })
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isAdmin])

  if (!isAdmin || err === 'admin-only') {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState
            icon={AlertTriangle}
            title={t('ins.adminOnly')}
            body={t('ins.adminOnlyBody')}
          />
        </div>
      </PageWrapper>
    )
  }

  if (loading) {
    return (
      <PageWrapper>
        <div className="flex items-center justify-center py-24">
          <Loader2 size={20} className="animate-spin text-church-700 dark:text-brass-300" />
        </div>
      </PageWrapper>
    )
  }

  if (err) {
    return (
      <PageWrapper>
        <div className="max-w-2xl mx-auto py-16">
          <EmptyState icon={AlertTriangle} title={t('ins.loadError')} body={err} />
        </div>
      </PageWrapper>
    )
  }

  const s = data.summary
  // AI usage delta — small text under the AI card. Positive = growing
  // AI use this month vs last; negative = cooling off. Useful signal
  // because AI quota is a real cost on paid plans.
  const fmtMonthL = (ym) => fmtMonth(ym, dateLocale)
  const aiDelta = s.ai_this_month - s.ai_last_month
  const aiDeltaLabel = aiDelta === 0
    ? t('ins.sameAsLast')
    : t('ins.vsLast', { d: `${aiDelta > 0 ? '+' : ''}${aiDelta}` })

  return (
    <PageWrapper>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">
            {t('ins.title')}
          </h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            {t('ins.sub')}
          </p>
        </motion.div>

        {/* Summary cards — Members + YTD donations + AI + Attendance.
            Active staff dropped to the 5th slot since attendance is
            the more church-relevant signal. Grid wraps at lg. */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-4"
        >
          <SummaryCard icon={Users}      label={t('ins.members')}        value={s.member_count} sub={t('ins.realOnly')} />
          <SummaryCard icon={DollarSign} label={t('ins.ytd')}  value={fmtCurrency(s.ytd_donations)} sub={t('ins.sinceJan')} />
          <SummaryCard icon={Feather}   label={t('ins.aiMonth')}  value={s.ai_this_month} sub={aiDeltaLabel} />
          <SummaryCard
            icon={UserCheck}
            label={t('ins.avgAtt')}
            value={s.avg_attendance_rate === null
              ? '—'
              : `${Math.round(s.avg_attendance_rate * 100)}%`}
            sub={s.avg_attendance_rate === null
              ? t('ins.noEvents')
              : t(s.tracked_events === 1 ? 'ins.marked1' : 'ins.markedN', { n: s.tracked_events })}
           />
        </motion.div>

        {/* Pledge fulfillment card — Sprint D / D.3. Renders only
            when at least one active pledge exists. Links to the
            /pledges page for the full picture. */}
        {s.pledge_fulfillment !== null && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.07 }}
            className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5"
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2">
                <Heart size={14} className="text-brass-700 dark:text-brass-300" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">
                  {t('ins.pledges')}
                </h2>
                <span className="text-[11px] text-ink-500 dark:text-parchment-300/70">
                  · {t('ins.active', { n: s.pledges_active })}
                </span>
              </div>
              <Link to="/pledges" className="text-xs font-semibold text-church-700 dark:text-brass-300 hover:underline">
                {t('ins.manage')} →
              </Link>
            </div>
            <div className="flex items-baseline gap-3 mb-3">
              <p className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tabular-nums">
                {Math.round(s.pledge_fulfillment * 100)}%
              </p>
              <p className="text-sm text-ink-500 dark:text-parchment-300/70 tabular-nums">
                {t('ins.ofPledged', { a: fmtCurrency(s.pledges_received), b: fmtCurrency(s.pledges_pledged) })}
              </p>
            </div>
            <div className="h-2 rounded-full bg-parchment-200/80 dark:bg-ink-800 overflow-hidden">
              <div
                // Here hue DOES carry meaning — it tracks a value that moves.
                // Fully pledged reads brass (the gilt, finished state) rather
                // than the SaaS-green it used to be; amber and rose are the
                // sanctioned warm warning tones.
                className={`h-full transition-all duration-300 ${
                  s.pledge_fulfillment >= 1     ? 'bg-brass-500'
                  : s.pledge_fulfillment >= 0.5 ? 'bg-amber-500'
                  : 'bg-rose-500'
                }`}
                style={{ width: `${Math.min(100, s.pledge_fulfillment * 100)}%` }}
              />
            </div>
          </motion.div>
        )}

        {/* Who hasn't shown up — members with a real attendance/check-in
            history whose last appearance is older than N weeks. Never-seen
            members are excluded server-side (they're an onboarding
            problem, not a lapse). A refused read still shows the card. */}
        {(lapsed || lapsedErr) && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
            className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2">
                <UserX size={14} className="text-brass-700 dark:text-brass-300" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300">
                  {t('ins.lapsedTitle')}
                </h2>
              </div>
              <label className="flex items-center gap-2 text-xs text-ink-500 dark:text-parchment-300/70">
                {t('ins.absentFor')}
                <select
                  value={lapsedWeeks}
                  onChange={e => setLapsedWeeks(Number(e.target.value))}
                  className="px-2 py-1 rounded-lg border border-parchment-300/70 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-800 text-ink-900 dark:text-parchment-50 focus:outline-none focus:ring-2 focus:ring-church-500"
                >
                  {[2, 3, 4, 6, 8, 12].map(w => <option key={w} value={w}>{t('ins.weeksN', { n: w })}</option>)}
                </select>
              </label>
            </div>
            {lapsedErr ? (
              <p role="status" className="px-5 py-4 text-center text-sm text-amber-800 dark:text-amber-300">
                {t('ins.lapsedUnread')}
              </p>
            ) : lapsed.members.length === 0 ? (
              <p className="text-sm text-ink-500 dark:text-parchment-300/70 py-4 text-center">
                {t('ins.lapsedNone', { n: lapsed.weeks })}
              </p>
            ) : (
              <>
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 mb-3">
                  {t(lapsed.members.length === 1 ? 'ins.lapsedSub1' : 'ins.lapsedSubN', { n: lapsed.members.length, w: lapsed.weeks })}
                </p>
                <ul className="divide-y divide-parchment-200/60 dark:divide-brass-900/30 max-h-80 overflow-y-auto">
                  {lapsed.members.map(m => (
                    <li key={m.id} className="py-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <Link to={`/clients/${m.id}`} className="text-sm font-semibold text-ink-800 dark:text-parchment-100 hover:text-church-700 dark:hover:text-brass-300 truncate block">
                          {m.name}
                        </Link>
                        <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 truncate">
                          {[m.email, m.phone].filter(Boolean).join(' · ') || t('ins.noContact')}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs font-semibold tabular-nums px-2.5 py-1 rounded-full bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300 border border-rose-100 dark:border-rose-800/30">
                        {t('ins.wChip', { n: m.weeks_absent })}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </motion.div>
        )}

        {/* Members joined per month */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300 mb-4">
            {t('ins.joined')}
          </h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.members_joined} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                <defs>
                  <linearGradient id="memberFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#9F8240" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#9F8240" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(0 0 0 / 0.06)" />
                <XAxis dataKey="month" tickFormatter={fmtMonthL} tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(v) => [t(v === 1 ? 'ins.tip1' : 'ins.tipN', { n: v }), t('ins.tipJoined')]}
                  labelFormatter={fmtMonthL}
                  contentStyle={{ borderRadius: 8, fontSize: 12 }}
                />
                <Area type="monotone" dataKey="count" stroke="#7B2D26" strokeWidth={2} fill="url(#memberFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </motion.div>

        {/* Donations per month */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300 mb-4">
            {t('ins.donMonth')}
          </h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.donations_monthly} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(0 0 0 / 0.06)" />
                <XAxis dataKey="month" tickFormatter={fmtMonthL} tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => `$${v >= 1000 ? `${Math.round(v/1000)}k` : v}`} tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(v) => [fmtCurrency(v), t('ins.tipDon')]}
                  labelFormatter={fmtMonthL}
                  contentStyle={{ borderRadius: 8, fontSize: 12 }}
                />
                <Bar dataKey="total" fill="#7B2D26" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </motion.div>

        {/* Attendance trend — Sprint T / T.3. Line chart of monthly
            avg attendance rate. Skipped when no events have been
            tracked yet (the chart would just be a flat line on the
            zero axis). */}
        {s.avg_attendance_rate !== null && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18 }}
            className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5"
          >
            <h2 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300 mb-4">
              {t('ins.attTrend')}
            </h2>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.attendance_monthly} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgb(0 0 0 / 0.06)" />
                  <XAxis dataKey="month" tickFormatter={fmtMonthL} tick={{ fontSize: 11 }} />
                  <YAxis
                    domain={[0, 1]}
                    tickFormatter={(v) => `${Math.round(v * 100)}%`}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip
                    formatter={(v, name) => name === 'avg_rate'
                      ? [`${Math.round(v * 100)}%`, t('ins.tipAtt')]
                      : [v, name]}
                    labelFormatter={fmtMonthL}
                    contentStyle={{ borderRadius: 8, fontSize: 12 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="avg_rate"
                    stroke="#7B2D26"
                    strokeWidth={2}
                    dot={{ r: 3, fill: '#7B2D26' }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-ink-500 dark:text-parchment-300/70 mt-2 px-1">
              {t('ins.trendNote')}
            </p>
          </motion.div>
        )}

        {/* Donation categories */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-parchment-50 dark:bg-ink-900 rounded-2xl border border-parchment-300/60 dark:border-brass-900/30 shadow-warm p-5"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wider text-brass-700 dark:text-brass-300 mb-4">
            {t('ins.donCats')}
          </h2>
          <CategoryBars categories={data.donations_by_category} />
        </motion.div>

        <p className="text-xs text-ink-500 dark:text-parchment-300/70 px-1">
          {t('ins.footnote')}
        </p>
      </div>
    </PageWrapper>
  )
}
