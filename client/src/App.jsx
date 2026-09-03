import { BrowserRouter, Routes, Route, NavLink, useNavigate, Navigate, useLocation } from 'react-router-dom'
import { useRef, useState, useEffect, lazy, Suspense } from 'react'
import { Users, Calendar, DollarSign, Heart, CheckSquare, Clock, Search, Bell, Sun, Moon, LayoutDashboard, LogOut, Settings, User, ChevronDown, ChevronsLeft, ChevronsRight, X, Loader2, Feather, Shield, CreditCard, ScrollText, SlidersHorizontal, BookOpen, Building2, BarChart3, FileText, UserCheck, Menu, Newspaper, ListMusic, Church, Flame, MessageCircle, Landmark, HelpCircle, LifeBuoy, ArchiveRestore, HandCoins, PackageOpen, Compass } from 'lucide-react'
import { AlertTriangle } from 'lucide-react'
import { Users2 } from 'lucide-react'
import FeedbackModal from './components/FeedbackModal'
import OpenMark from './components/OpenMark'
import { ThemeProvider, useTheme } from './context/ThemeContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import { LocaleProvider, useLocale } from './i18n'
import { ConfirmProvider } from './components/ConfirmProvider'
import { apiUrl } from './api'
// Shell components load eagerly — they're the always-present chrome
// (search palette, PWA prompts, error boundary, avatar), not route-split
// content.
import GlobalSearchPalette from './components/GlobalSearchPalette'
import InstallPrompt from './components/InstallPrompt'
import OfflineBanner from './components/OfflineBanner'
import UpdatePrompt from './components/UpdatePrompt'
import PageErrorBoundary from './components/PageErrorBoundary'
import SessionUnconfirmed from './components/SessionUnconfirmed'
import UserAvatar from './components/UserAvatar'
import { mutate, loadList } from './utils/format'

// Route-split pages (POL.1). Each becomes its own chunk via React.lazy,
// so the initial download is the shell + the current route — not all 36
// pages and their chart/markdown libraries up front. The <Suspense>
// boundaries around each <Routes> render a spinner during the brief
// chunk fetch.
const Clients = lazy(() => import('./pages/Clients'))
const Events = lazy(() => import('./pages/Events'))
const Schedule = lazy(() => import('./pages/Schedule'))
const ScheduleConflicts = lazy(() => import('./pages/ScheduleConflicts'))
const Groups = lazy(() => import('./pages/Groups'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Tasks = lazy(() => import('./pages/Tasks'))
const Payroll = lazy(() => import('./pages/Payroll'))
const Finance = lazy(() => import('./pages/Finance'))
const Donations = lazy(() => import('./pages/Donations'))
const GivingStatements = lazy(() => import('./pages/GivingStatements'))
const DonorStatement = lazy(() => import('./pages/DonorStatement'))
const OrgSettings = lazy(() => import('./pages/OrgSettings'))
const Insights = lazy(() => import('./pages/Insights'))
const MemberDetail = lazy(() => import('./pages/MemberDetail'))
const SacramentRecord = lazy(() => import('./pages/SacramentRecord'))
const PublicEvents = lazy(() => import('./pages/PublicEvents'))
const PublicChurch = lazy(() => import('./pages/PublicChurch'))
const PublicGive = lazy(() => import('./pages/PublicGive'))
const PublicForm = lazy(() => import('./pages/PublicForm'))
const PublicSwap = lazy(() => import('./pages/PublicSwap'))
const Kiosk = lazy(() => import('./pages/Kiosk'))
const Pledges = lazy(() => import('./pages/Pledges'))
const Offerings = lazy(() => import('./pages/Offerings'))
const InvoicePrint = lazy(() => import('./pages/InvoicePrint'))
const MigrationStudio = lazy(() => import('./pages/MigrationStudio'))
const ImportReceipt = lazy(() => import('./pages/ImportReceipt'))
const Forms = lazy(() => import('./pages/Forms'))
const FormResponses = lazy(() => import('./pages/FormResponses'))
const AI = lazy(() => import('./pages/AI'))
const Login = lazy(() => import('./pages/Login'))
const Signup = lazy(() => import('./pages/Signup'))
const Welcome = lazy(() => import('./pages/Welcome'))
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const Team = lazy(() => import('./pages/Team'))
const Billing = lazy(() => import('./pages/Billing'))
const Audit = lazy(() => import('./pages/Audit'))
const Archive = lazy(() => import('./pages/Archive'))
const GettingSettled = lazy(() => import('./pages/GettingSettled'))
const SetupRecord = lazy(() => import('./pages/SetupRecord'))
const Notifications = lazy(() => import('./pages/Notifications'))
const Diocese = lazy(() => import('./pages/Diocese'))
const Checkin = lazy(() => import('./pages/Checkin'))
const Preferences = lazy(() => import('./pages/Preferences'))
const Library = lazy(() => import('./pages/Library'))
const Bulletin = lazy(() => import('./pages/Bulletin'))
const PublicBulletin = lazy(() => import('./pages/PublicBulletin'))
const ServicePlanner = lazy(() => import('./pages/ServicePlanner'))
const ServiceMode = lazy(() => import('./pages/ServiceMode'))
const SundayPacket = lazy(() => import('./pages/SundayPacket'))
const SacramentalRegister = lazy(() => import('./pages/SacramentalRegister'))
const SacramentCertificate = lazy(() => import('./pages/SacramentCertificate'))
const MassIntentions = lazy(() => import('./pages/MassIntentions'))
const SacristySheet = lazy(() => import('./pages/SacristySheet'))
const RegisterDrafts = lazy(() => import('./pages/RegisterDrafts'))
const Workbench = lazy(() => import('./pages/Workbench'))
const Support = lazy(() => import('./pages/Support'))
// Help panel + assistant are chrome, but heavy chrome (the help corpus,
// the chat widget) — lazy so the shell chunk stays lean. Rendered inside
// their own <Suspense fallback={null}> because nothing should flicker
// while they load.
const HelpPanel = lazy(() => import('./components/HelpPanel'))
const AssistantWidget = lazy(() => import('./components/AssistantWidget'))

// Centered spinner shown while a route chunk loads. Lives inside the
// content area (or full public viewport), so the app shell never flickers.
function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24" role="status" aria-label="Loading page">
      <Loader2 className="animate-spin text-church-700 dark:text-brass-300" size={24} />
    </div>
  )
}

// Single source of truth for the app's nav. Both the Sidebar and the
// Header's notifications/quick-nav dropdown read from this list.
// The Sidebar intentionally renders the brand church-mark SVG for the
// Dashboard item in place of its icon; every other consumer uses `icon`
// directly.
// Sidebar nav. `section` groups items under a small uppercase
// label in the Sidebar render; an item with no section renders at
// the top above all groups (currently just Dashboard). Section
// order in this list determines render order.
const NAV_ITEMS = [
  { to: '/',          icon: LayoutDashboard, label: 'Dashboard' },

  // People + the things you do with them
  { to: '/clients',   icon: Users,         label: 'Members',     section: 'Pastoral' },
  { to: '/groups',    icon: Users2,        label: 'Groups',      section: 'Pastoral', adminOnly: true },
  { to: '/schedule',  icon: Calendar,      label: 'Schedule',    section: 'Pastoral' },
  { to: '/checkin',   icon: UserCheck,     label: 'Check-in',    section: 'Pastoral' },
  { to: '/register',  icon: Church,        label: 'Register',    section: 'Pastoral' },
  { to: '/mass-intentions', icon: Flame,   label: 'Intentions',  section: 'Pastoral' },
  { to: '/service-planner', icon: ListMusic, label: 'Worship',    section: 'Pastoral' },
  { to: '/schedule/conflicts', icon: AlertTriangle, label: 'Conflicts', section: 'Pastoral', adminOnly: true },
  { to: '/events',    icon: Clock,         label: 'Events',      section: 'Pastoral' },
  { to: '/tasks',     icon: CheckSquare,   label: 'Daily Tasks', section: 'Pastoral' },
  { to: '/forms',     icon: FileText,      label: 'Forms',       section: 'Pastoral', adminOnly: true },
  { to: '/bulletin',  icon: Newspaper,     label: 'Bulletin',    section: 'Pastoral', adminOnly: true },

  // Money in, money out
  { to: '/donations', icon: Heart,         label: 'Donations',   section: 'Stewardship' },
  { to: '/pledges',   icon: Heart,         label: 'Pledges',     section: 'Stewardship', adminOnly: true },
  { to: '/offerings', icon: HandCoins,     label: 'Offerings',   section: 'Stewardship' },
  { to: '/payroll',   icon: DollarSign,    label: 'Payroll',     section: 'Stewardship' },
  { to: '/finance',   icon: Landmark,      label: 'Finance',     section: 'Stewardship', adminOnly: true },
  // DIO.6 — hidden unless this parish is actually affiliated. An
  // independent parish has no diocese, and a nav item promising one it
  // does not have is a small lie told on every page load.
  { to: '/diocese',   icon: Building2,     label: 'Diocese',     section: 'Stewardship', affiliatedOnly: true },

  // AI generation + the archive of what you've made
  { to: '/ai',        icon: Feather,      label: 'AI Studio',   section: 'Studio' },
  { to: '/library',   icon: BookOpen,      label: 'Library',     section: 'Studio' },

  // Org-wide settings (admin)
  // Deliberately NOT adminOnly, and deliberately first in Admin. The
  // person most likely to need orientation is the one who was invited
  // last week and holds the smallest role.
  { to: '/getting-settled', icon: Compass,   label: 'Getting settled', section: 'Admin' },
  { to: '/insights',  icon: BarChart3,     label: 'Insights',    section: 'Admin', adminOnly: true },
  { to: '/team',      icon: Shield,        label: 'Team',        section: 'Admin', adminOnly: true },
  { to: '/settings',  icon: Building2,     label: 'Org details', section: 'Admin', adminOnly: true },
  { to: '/billing',   icon: CreditCard,    label: 'Billing',     section: 'Admin', adminOnly: true },
  { to: '/audit',     icon: ScrollText,    label: 'Audit log',   section: 'Admin', adminOnly: true },
  // Deliberately NOT adminOnly. The person most likely to need this page
  // is whoever just removed the wrong thing, and they are usually not the
  // administrator. They cannot restore it — the page says so, and says who
  // can — but they can see that it is recoverable and stop worrying.
  { to: '/archive',   icon: ArchiveRestore, label: 'Archive',    section: 'Admin' },
  { to: '/support',   icon: LifeBuoy,      label: 'Support',     section: 'Admin', adminOnly: true },
  { to: '/migration', icon: PackageOpen,   label: 'Migration',   section: 'Admin', adminOnly: true },
  { to: '/notifications', icon: Bell,      label: 'Notifications', section: 'Admin', adminOnly: true },

  // Per-user
  { to: '/preferences', icon: SlidersHorizontal, label: 'Preferences', section: 'You' },
]

// Returns NAV_ITEMS filtered by the current user's role. adminOnly
// items are hidden for staff/viewer; affiliatedOnly items are hidden
// until this parish actually has a live diocese affiliation.
function visibleNavFor(role, affiliated) {
  return NAV_ITEMS.filter(item =>
    (!item.adminOnly || role === 'admin') && (!item.affiliatedOnly || affiliated))
}

// Bucket nav items into sections preserving NAV_ITEMS order. Items
// with no section land in the implicit top bucket (rendered without
// a label) so Dashboard stays a flat first row.
function groupNavBySection(items) {
  const groups = []
  const indexBySection = new Map()
  for (const item of items) {
    const key = item.section ?? '__top__'
    if (!indexBySection.has(key)) {
      const group = { section: item.section ?? null, items: [] }
      groups.push(group)
      indexBySection.set(key, group)
    }
    indexBySection.get(key).items.push(item)
  }
  return groups
}

// The Open Mark rendered beside "Dashboard" in the Sidebar (inherits the
// nav item's currentColor).
function BrandMark() {
  return <OpenMark className="h-[17px] w-auto" />
}

// Sidebar. `collapsed` shrinks it to a 64px icon rail; `onToggle`
// flips that state (owned + persisted by ProtectedLayout). In the
// rail state, labels + section headings + the legal footer are
// hidden, icons center, and nav items carry a native `title` tooltip
// so the destination is still discoverable on hover.
function Sidebar({ collapsed: collapsedProp, onToggle, mobileOpen }) {
  const { dark, toggle } = useTheme()
  const { user } = useAuth()
  const { t } = useLocale()
  // One cheap read, cached for the session: does this parish have a live
  // diocese? Failure is treated as "no" — a missing nav item is a smaller
  // wrong than a nav item leading to an empty page.
  const [affiliated, setAffiliated] = useState(false)
  useEffect(() => {
    let alive = true
    fetch(apiUrl('/api/affiliation'))
      .then(r => (r.ok ? r.json() : { affiliation: null }))
      .then(d => { if (alive) setAffiliated(d.affiliation?.status === 'active') })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const items = visibleNavFor(user?.role, affiliated)

  // POL.4 — below md the sidebar is an off-canvas drawer, so the
  // desktop "rail" (collapsed) mode never applies there: a narrow rail
  // is the wrong shape for a slide-in panel. Track the breakpoint and
  // force the expanded layout on mobile.
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const onChange = e => setIsMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const collapsed = collapsedProp && !isMobile

  // Feedback & Support — a gated, in-app line to the founder (FB.1).
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  // Shared className for the bottom-section buttons (collapse + theme).
  // Centered icon in rail mode, icon+label row when expanded.
  const bottomBtnCls = `flex items-center w-full rounded-lg text-sm font-medium text-ink-600 dark:text-parchment-200/70 hover:bg-parchment-200/60 dark:hover:bg-ink-800/60 hover:text-ink-900 dark:hover:text-parchment-50 transition-colors ${
    collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5'
  }`

  return (
    <aside className={`${collapsed ? 'w-16' : 'w-60'} ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 flex flex-col fixed inset-y-0 left-0 z-30 bg-parchment-100 dark:bg-ink-900 border-r border-parchment-300/60 dark:border-brass-900/30 transition-[width,transform] duration-200 ease-out print:hidden`}>
      {/* Wordmark — mark only when collapsed, mark + text when open */}
      <NavLink
        to="/"
        className={`flex items-center h-16 border-b border-parchment-300/60 dark:border-brass-900/30 hover:opacity-90 transition-opacity ${
          collapsed ? 'justify-center px-0' : 'gap-3 px-5'
        }`}
      >
        <div className="w-9 h-9 rounded-lg bg-church-900 dark:bg-brass-200 flex items-center justify-center shadow-warm shrink-0">
          <OpenMark className="h-6 w-auto text-brass-200 dark:text-church-900" />
        </div>
        {!collapsed && (
          <span className="font-display text-2xl font-semibold text-church-900 dark:text-parchment-100 leading-none">
            OpenChurch
          </span>
        )}
      </NavLink>

      {/* Nav */}
      <nav className={`flex-1 py-4 overflow-y-auto overflow-x-hidden ${collapsed ? 'px-2' : 'px-3'}`}>
        {groupNavBySection(items).map((group, gIdx) => (
          <div key={group.section ?? '__top__'} className={gIdx === 0 ? '' : 'mt-5'}>
            {group.section && !collapsed && (
              <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-parchment-300/60">
                {t(`navsec.${group.section}`)}
              </p>
            )}
            {/* Rail mode: a hairline divider replaces the section
                label for non-first groups so the grouping survives. */}
            {group.section && collapsed && gIdx > 0 && (
              <div className="mx-1.5 mb-2 border-t border-parchment-300/50 dark:border-brass-900/25" />
            )}
            <div className="space-y-0.5">
              {group.items.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  title={collapsed ? t(`nav.${label}`) : undefined}
                  className={({ isActive }) =>
                    `relative flex items-center rounded-lg text-sm font-medium transition-colors group ${
                      collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5'
                    } ${
                      isActive
                        ? 'bg-parchment-50 dark:bg-ink-800 text-church-900 dark:text-parchment-50 shadow-warm before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-5 before:rounded-r-full before:bg-brass-500'
                        : 'text-ink-600 dark:text-parchment-200/70 hover:bg-parchment-200/60 dark:hover:bg-ink-800/60 hover:text-ink-900 dark:hover:text-parchment-50'
                    }`
                  }
                >
                  {to === '/' ? <BrandMark /> : <Icon size={17} />}
                  {!collapsed && <span className="flex-1">{t(`nav.${label}`)}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Feedback & Support + collapse toggle + theme toggle + legal footer */}
      <div className={`py-4 border-t border-parchment-300/60 dark:border-brass-900/30 ${collapsed ? 'px-2' : 'px-3'}`}>
        {/* A discrete, serif line straight to the founder's workbench (FB.1). */}
        <button
          onClick={() => setFeedbackOpen(true)}
          title={t('shell.feedback')}
          aria-label={t('shell.feedback')}
          className={`flex items-center w-full rounded-lg font-display text-[15px] italic text-brass-700 dark:text-brass-300 hover:bg-parchment-200/60 dark:hover:bg-ink-800/60 hover:text-church-800 dark:hover:text-parchment-50 transition-colors ${
            collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5'
          }`}
        >
          <MessageCircle size={17} />
          {!collapsed && <span className="flex-1 text-left">{t('shell.feedback')}</span>}
        </button>

        <button
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={collapsed}
          className={bottomBtnCls}
        >
          {collapsed ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
          {!collapsed && t('shell.collapse')}
        </button>

        <button
          onClick={toggle}
          title={collapsed ? (dark ? 'Light mode' : 'Dark mode') : undefined}
          className={bottomBtnCls}
        >
          {dark ? <Sun size={17} /> : <Moon size={17} />}
          {!collapsed && (dark ? t('shell.light') : t('shell.dark'))}
        </button>

        {/* Quiet legal line — anchored to the bottom-left of the app
            shell. Hidden in rail mode (no room). Year is derived so
            it never goes stale.
            Dark-mode opacity was /45, which rendered at 3.11:1 — below AA,
            and this line sits in the sidebar on EVERY page, so it was the
            single most repeated contrast failure in the app. /70 is 5.74:1
            and still reads as quiet legal small print. */}
        {!collapsed && (
          <p className="px-3 mt-3 text-[10px] leading-relaxed text-ink-500 dark:text-parchment-300/70">
            © {new Date().getFullYear()} Open Scaffold Labs, LLC
            <br />
            Lafayette, California
          </p>
        )}
      </div>

      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </aside>
  )
}

function Header({ onMenuClick }) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [notificationsFailed, setNotificationsFailed] = useState(false)
  const ref = useRef(null)
  const navigate = useNavigate()
  const { user } = useAuth()

  // A failed poll leaves the last known list alone. Overwriting it with []
  // silently drops the unread badge to zero every 30 seconds on a flaky
  // connection, and "No notifications yet" is then a lie the user has no
  // way to detect.
  const fetchNotifications = () => {
    loadList(apiUrl('/api/notifications')).then(({ ok, data }) => {
      if (ok) setNotifications(data)
      setNotificationsFailed(!ok)
    })
  }

  useEffect(() => {
    fetchNotifications()
    const id = setInterval(fetchNotifications, 30000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // The list only shows what the server actually recorded. If the write
  // fails the item stays unread and the badge keeps its count — a stale
  // badge is recoverable, a badge that lies about a saved state is not.
  async function markRead(id) {
    const { ok } = await mutate(apiUrl(`/api/notifications/${id}/read`), { method: 'PATCH' })
    if (!ok) return
    setNotifications(ns => ns.map(n => n.id === id ? { ...n, read: true } : n))
  }

  // Click a notification → mark read and jump to the relevant page.
  // Event-typed notifications go to /events; everything else (including
  // legacy rows with no `type`) goes to /tasks.
  function openNotification(n) {
    markRead(n.id)
    const path = n.type === 'event' ? '/events' : '/tasks'
    navigate(path)
    setOpen(false)
  }

  async function markAllRead() {
    const { ok } = await mutate(apiUrl('/api/notifications/read-all'), { method: 'PATCH' })
    if (!ok) return
    setNotifications(ns => ns.map(n => ({ ...n, read: true })))
  }

  const unread = notifications.filter(n => !n.read).length

  function timeAgo(dateStr) {
    const s = Math.floor((Date.now() - new Date(dateStr)) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  }

  // Global search palette (Sprint G). Trigger lives in the header,
  // palette renders into the modal layer. Cmd/Ctrl-K toggles it from
  // anywhere — the listener is global to the Header so any keystroke
  // inside the app shell catches it.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTypeFilter, setSearchTypeFilter] = useState(null)
  useEffect(() => {
    function onKey(e) {
      // Cmd-K (Mac) / Ctrl-K (Win/Linux). Ignore the key inside text
      // inputs that aren't OUR palette — letting cmd-k fire inside
      // someone's password field is fine; we just don't want to
      // catch a literal 'k' character in normal typing. metaKey or
      // ctrlKey makes the chord unambiguous.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setSearchOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <header className="h-16 flex items-center justify-between gap-2 px-4 sm:px-6 bg-parchment-100 dark:bg-ink-900 border-b border-parchment-300/60 dark:border-brass-900/30 sticky top-0 z-10 print:hidden">
      {/* Left group: mobile nav toggle + search. Capped at max-w-xs so
          the right-side controls still pin to the right edge. */}
      <div className="flex items-center gap-2 flex-1 min-w-0 max-w-xs">
        {/* Mobile nav toggle (POL.4) — opens the off-canvas sidebar
            drawer. Hidden at md+ where the sidebar is always docked. */}
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation menu"
          className="tap md:hidden -ml-1 shrink-0 inline-flex items-center justify-center p-2 rounded-lg text-ink-500 dark:text-parchment-300/70 hover:bg-parchment-200/60 dark:hover:bg-ink-800/80 transition-colors"
        >
          <Menu size={18} />
        </button>
        {/* Search trigger — opens the global palette. The kbd hint shows
            on md+ where keyboards are likely; mobile hides it. */}
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label="Open search"
          className="tap inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-parchment-50 dark:bg-ink-800 border border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:bg-parchment-200/60 dark:hover:bg-ink-800/80 transition-colors w-full"
        >
          <Search size={14} className="shrink-0" />
          <span className="text-sm flex-1 text-left hidden sm:inline">{t('shell.search')}</span>
          <span className="text-sm flex-1 text-left sm:hidden">Search</span>
          <kbd className="hidden md:inline px-1.5 py-0.5 rounded border border-parchment-300 dark:border-brass-900/40 bg-parchment-100 dark:bg-ink-900 font-mono text-[10px] text-ink-500 dark:text-parchment-300/70">
            ⌘K
          </kbd>
        </button>
      </div>
      <GlobalSearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        typeFilter={searchTypeFilter}
        setTypeFilter={setSearchTypeFilter}
      />
      <div className="flex items-center gap-3">
        {/* Help & Support (SUP.5) — the ? next to notifications. */}
        <button
          onClick={() => setHelpOpen(true)}
          aria-label={t('help.title')}
          title={t('help.title')}
          className="tap inline-flex items-center justify-center p-2 rounded-lg text-ink-500 hover:text-church-900 dark:text-parchment-200/70 dark:hover:text-brass-200 hover:bg-parchment-200/60 dark:hover:bg-ink-800 transition-colors"
        >
          <HelpCircle size={18} aria-hidden="true" />
        </button>
        {helpOpen && (
          <Suspense fallback={null}>
            <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
          </Suspense>
        )}
        <div className="relative" ref={ref}>
          <button
            onClick={() => setOpen(o => !o)}
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
            aria-expanded={open}
            className="tap relative inline-flex items-center justify-center p-2 rounded-lg text-ink-500 hover:text-church-900 dark:text-parchment-200/70 dark:hover:text-brass-200 hover:bg-parchment-200/60 dark:hover:bg-ink-800 transition-colors"
          >
            <Bell size={18} aria-hidden="true" />
            {unread > 0 && (
              <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 bg-brass-500 text-church-900 text-[9px] font-bold rounded-full flex items-center justify-center leading-none">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
            {unread === 0 && (
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-parchment-300 dark:bg-brass-900/40 rounded-full" />
            )}
          </button>

          {open && (
            // Dark-mode panel uses an explicitly warm brown-charcoal
            // (#322920) rather than ink-900. ink-900 (#1C1916) is so
            // dark its hue is imperceptible and reads cool next to the
            // burgundy + brass chrome. This tone is lighter AND warmer
            // so the panel clearly reads as a warm elevated surface.
            <div className="absolute right-0 mt-2 w-80 bg-parchment-50 dark:bg-[#322920] border border-parchment-300/60 dark:border-brass-900/30 rounded-xl shadow-warm-lg overflow-hidden z-50">
              {/* Notifications section */}
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-parchment-300/60 dark:border-brass-900/30">
                <p className="text-xs font-semibold text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">
                  Notifications {unread > 0 && <span className="text-brass-700 dark:text-brass-300">({unread})</span>}
                </p>
                {unread > 0 && (
                  <button onClick={markAllRead} className="text-xs text-church-700 dark:text-brass-300 hover:text-church-900 dark:hover:text-brass-200 transition-colors">
                    Mark all read
                  </button>
                )}
              </div>

              {notificationsFailed && notifications.length > 0 && (
                <p role="status" className="px-4 py-2 text-[11px] text-amber-700 dark:text-amber-400 border-b border-parchment-200/60 dark:border-brass-900/25">
                  This list may be out of date — the last check didn't reach the server.
                </p>
              )}

              {notifications.length === 0 ? (
                <p role="status" className={`px-4 py-4 text-xs text-center ${notificationsFailed ? 'text-amber-700 dark:text-amber-400' : 'text-ink-500 dark:text-parchment-300/70'}`}>
                  {notificationsFailed
                    ? "We couldn't check your notifications just now."
                    : 'No notifications yet'}
                </p>
              ) : (
                <ul className="max-h-56 overflow-y-auto divide-y divide-parchment-200/60 dark:divide-brass-900/25">
                  {notifications.slice(0, 8).map(n => {
                    const isEvent = n.type === 'event'
                    const TypeIcon = isEvent ? Clock : CheckSquare
                    return (
                      <li key={n.id}
                        className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-parchment-100 dark:hover:bg-ink-800/60 ${!n.read ? 'bg-brass-100/40 dark:bg-brass-900/15' : ''}`}
                        onClick={() => openNotification(n)}
                      >
                        <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${n.read ? 'bg-parchment-300 dark:bg-ink-700' : 'bg-brass-500'}`} />
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs leading-relaxed ${n.read ? 'text-ink-500 dark:text-parchment-300/60' : 'text-ink-800 dark:text-parchment-100 font-medium'}`}>
                            {n.message}
                          </p>
                          <p className="flex items-center gap-1.5 text-[10px] text-ink-400 dark:text-parchment-400/50 mt-0.5">
                            <TypeIcon size={10} className={isEvent ? 'text-church-700 dark:text-brass-300' : 'text-ink-400 dark:text-parchment-400/60'} />
                            <span>{isEvent ? 'Event' : 'Task'}</span>
                            <span>·</span>
                            <span>{timeAgo(n.created_at)}</span>
                          </p>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}

            </div>
          )}
        </div>
        <ProfileDropdown />
      </div>
    </header>
  )
}

// The previous inline GlobalSearch component (a 320px search bar
// embedded directly in the header) has been replaced by
// GlobalSearchPalette — a Cmd/Ctrl-K modal that works on mobile and
// hosts type filters + recent queries. The Header now renders a
// trigger button + mounts the palette. See
// components/GlobalSearchPalette.jsx (Sprint G).

function ProfileDropdown() {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [stats, setStats] = useState({ members: null, events: null, tasks: null })
  const ref = useRef(null)
  const { dark, toggle } = useTheme()
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const displayName  = user?.name  || 'OpenChurch Admin'
  const displayEmail = user?.email || ''
  const orgName      = user?.organization?.name || 'OpenChurch'
  const displayRole  = user?.role === 'admin' ? 'Administrator' : (user?.role || 'Member')

  async function handleLogout() {
    setOpen(false)
    await logout()
    navigate('/login', { replace: true })
  }

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Load counts whenever the dropdown opens (fresh without being wasteful).
  useEffect(() => {
    if (!open) return
    let alive = true
    async function loadCount(url, pick) {
      try {
        const r = await fetch(apiUrl(url))
        if (!r.ok) return null
        const data = await r.json()
        return pick(data)
      } catch {
        return null
      }
    }
    Promise.all([
      loadCount('/api/clients',     d => Array.isArray(d) ? d.length : null),
      loadCount('/api/events',      d => Array.isArray(d) ? d.length : null),
      loadCount('/api/tasks/stats', d => d && d.total != null ? parseInt(d.total, 10) : null),
    ]).then(([members, events, tasks]) => {
      if (alive) setStats({ members, events, tasks })
    })
    return () => { alive = false }
  }, [open])

  const fmt = (n) => n == null ? '—' : n

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={`Account menu for ${displayName}`}
        aria-expanded={open}
        className="tap flex items-center gap-2 p-1 pr-2 rounded-lg hover:bg-parchment-200/60 dark:hover:bg-ink-800 transition-colors"
      >
        <UserAvatar avatar={user?.avatar} name={displayName} className="w-8 h-8" textClassName="text-xs" />
        <ChevronDown size={14} className={`text-ink-400 dark:text-parchment-300/60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 bg-parchment-50 dark:bg-ink-900 border border-parchment-300/60 dark:border-brass-900/30 rounded-xl shadow-warm-lg overflow-hidden z-50">
          {/* Profile header */}
          <div className="px-4 py-4 border-b border-parchment-300/60 dark:border-brass-900/30">
            <div className="flex items-center gap-3">
              <UserAvatar avatar={user?.avatar} name={displayName} className="w-10 h-10" textClassName="text-sm" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-ink-900 dark:text-parchment-50 truncate">{displayName}</p>
                <p className="text-xs text-ink-500 dark:text-parchment-300/70 truncate">{displayEmail}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <span className="inline-block px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-church-50 text-church-900 dark:bg-church-900/30 dark:text-brass-200">
                {displayRole}
              </span>
              <span className="text-[11px] text-ink-500 dark:text-parchment-300/70 truncate">{orgName}</span>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 divide-x divide-parchment-300/60 dark:divide-brass-900/30 border-b border-parchment-300/60 dark:border-brass-900/30">
            <button onClick={() => { navigate('/clients'); setOpen(false) }} className="px-3 py-3 text-center hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors cursor-pointer">
              <p className="text-sm font-bold text-ink-900 dark:text-parchment-50">{fmt(stats.members)}</p>
              <p className="text-[10px] text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">Members</p>
            </button>
            <button onClick={() => { navigate('/events'); setOpen(false) }} className="px-3 py-3 text-center hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors cursor-pointer">
              <p className="text-sm font-bold text-ink-900 dark:text-parchment-50">{fmt(stats.events)}</p>
              <p className="text-[10px] text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">Events</p>
            </button>
            <button onClick={() => { navigate('/tasks'); setOpen(false) }} className="px-3 py-3 text-center hover:bg-parchment-100 dark:hover:bg-ink-800/60 transition-colors cursor-pointer">
              <p className="text-sm font-bold text-ink-900 dark:text-parchment-50">{fmt(stats.tasks)}</p>
              <p className="text-[10px] text-ink-500 dark:text-parchment-300/70 uppercase tracking-wider">Tasks</p>
            </button>
          </div>

          {/* Menu items */}
          <div className="py-1">
            <button
              onClick={() => { navigate('/clients'); setOpen(false) }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-ink-700 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800/60 hover:text-ink-900 dark:hover:text-parchment-50 transition-colors"
            >
              <User size={15} className="text-ink-400 dark:text-parchment-400/60" />
              View Members
            </button>
            <button
              onClick={() => { navigate('/tasks'); setOpen(false) }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-ink-700 dark:text-parchment-200 hover:bg-parchment-100 dark:hover:bg-ink-800/60 hover:text-ink-900 dark:hover:text-parchment-50 transition-colors"
            >
              <Settings size={15} className="text-ink-400 dark:text-parchment-400/60" />
              Manage Tasks
            </button>
          </div>

          {/* Theme toggle */}
          <div className="border-t border-parchment-300/60 dark:border-brass-900/30 px-4 py-3">
            <button
              onClick={toggle}
              className="flex items-center justify-between w-full text-sm text-ink-700 dark:text-parchment-200 hover:text-ink-900 dark:hover:text-parchment-50 transition-colors"
            >
              <span className="flex items-center gap-3">
                {dark ? <Moon size={15} className="text-ink-400 dark:text-parchment-400/60" /> : <Sun size={15} className="text-ink-400 dark:text-parchment-400/60" />}
                {dark ? t('shell.dark') : t('shell.light')}
              </span>
              <div className={`w-8 h-4.5 rounded-full flex items-center px-0.5 transition-colors ${dark ? 'bg-brass-500' : 'bg-parchment-300'}`}>
                <div className={`w-3.5 h-3.5 rounded-full bg-parchment-50 shadow-sm transition-transform ${dark ? 'translate-x-3.5' : 'translate-x-0'}`} />
              </div>
            </button>
          </div>

          {/* Sign out */}
          <div className="border-t border-parchment-300/60 dark:border-brass-900/30">
            <button
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
              onClick={handleLogout}
            >
              <LogOut size={15} />
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Wraps the signed-in shell (sidebar + header + page). Anyone hitting one
// of these routes without a valid session is bounced to /login, preserving
// the attempted URL so we can return them there after sign-in.
function ProtectedLayout() {
  const { isAuthenticated, loading, user, authUnavailable } = useAuth()
  const location = useLocation()

  // Multi-tenant title: reflect the signed-in org's name in the browser
  // tab / bookmark once the session is known. Defensive fallback to the
  // neutral product name so we never show a stale hardcoded church.
  useEffect(() => {
    document.title = user?.organization?.name || 'OpenChurch'
  }, [user?.organization?.name])

  // Sidebar collapse state. Persisted under the ochr_ key prefix so
  // the choice survives reloads. Lifted here (not inside Sidebar)
  // because the main content's left padding has to track the sidebar
  // width in lockstep.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('ochr_sidebar_collapsed') === '1' } catch { return false }
  })
  function toggleSidebar() {
    setSidebarCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem('ochr_sidebar_collapsed', next ? '1' : '0') } catch {}
      return next
    })
  }

  // Mobile drawer open/closed (POL.4). Desktop ignores this — the
  // sidebar is always docked at md+. Close it on every navigation so
  // tapping a nav item doesn't leave the drawer covering the page.
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  useEffect(() => { setMobileNavOpen(false) }, [location.pathname])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-parchment-50 dark:bg-ink-950">
        <Loader2 size={22} className="animate-spin text-church-700 dark:text-brass-300" />
      </div>
    )
  }
  // A credential nobody has rejected is not a signed-out user. Bouncing to
  // /login here told the secretary her session was invalid on the strength
  // of a 500 from the auth check — and cost her her password to undo it.
  if (authUnavailable) return <SessionUnconfirmed />
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return (
    // Print overrides (P7): the artifact pages own the printed sheet.
    // h-screen + overflow-auto would clip a long manifest to one page,
    // and the sidebar's padding would print the artifact off-center —
    // in print the shell flattens to a plain full-width flow.
    <div className="flex h-screen bg-parchment-50 dark:bg-ink-950 print:block print:h-auto print:bg-white">
      <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} mobileOpen={mobileNavOpen} />
      {/* Backdrop behind the mobile drawer (POL.4). Only rendered on
          mobile when open; tapping it dismisses. Sits below the sidebar
          (z-30) and above the content/header (z-10). */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          aria-hidden="true"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <div className={`flex-1 flex flex-col min-w-0 transition-[padding] duration-200 ease-out pl-0 print:!pl-0 print:block ${sidebarCollapsed ? 'md:pl-16' : 'md:pl-60'}`}>
        <Header onMenuClick={() => setMobileNavOpen(true)} />
        {/* min-w-0: a flex child will not shrink below its content's intrinsic
            width. Defensive hardening so one wide table can never push the
            shell past the viewport again. */}
        <main className="flex-1 min-w-0 overflow-auto p-4 sm:p-6 print:overflow-visible print:p-0">
          {/* Suspense scoped to the content area only — during a lazy
              route's chunk fetch the sidebar + header stay put and just
              the page body shows the spinner (POL.1). */}
          <Suspense fallback={<PageFallback />}>
          <Routes>
            {/* Each route is wrapped in a PageErrorBoundary so a render
                error inside a single page leaves the sidebar + header
                fully usable. The root ErrorBoundary still catches
                catastrophic above-layout failures (AuthProvider, etc.). */}
            <Route path="/"          element={<PageErrorBoundary scope="Dashboard"><Dashboard /></PageErrorBoundary>} />
            <Route path="/clients"   element={<PageErrorBoundary scope="Members"><Clients /></PageErrorBoundary>} />
            <Route path="/groups"    element={<PageErrorBoundary scope="Groups"><Groups /></PageErrorBoundary>} />
            <Route path="/clients/:id" element={<PageErrorBoundary scope="Member profile"><MemberDetail /></PageErrorBoundary>} />
            <Route path="/events"    element={<PageErrorBoundary scope="Events"><Events /></PageErrorBoundary>} />
            <Route path="/schedule"  element={<PageErrorBoundary scope="Schedule"><Schedule /></PageErrorBoundary>} />
            <Route path="/checkin"   element={<PageErrorBoundary scope="Check-in"><Checkin /></PageErrorBoundary>} />
            <Route path="/schedule/conflicts" element={<PageErrorBoundary scope="Schedule conflicts"><ScheduleConflicts /></PageErrorBoundary>} />
            <Route path="/tasks"     element={<PageErrorBoundary scope="Tasks"><Tasks /></PageErrorBoundary>} />
            <Route path="/payroll"   element={<PageErrorBoundary scope="Payroll"><Payroll /></PageErrorBoundary>} />
            <Route path="/finance"   element={<PageErrorBoundary scope="Finance"><Finance /></PageErrorBoundary>} />
            {/* DIO.6 — the route exists whether or not the nav shows it, so
                a bookmarked link still works and an unaffiliated parish gets
                an explanation rather than a 404. */}
            <Route path="/diocese"   element={<PageErrorBoundary scope="Diocese"><Diocese /></PageErrorBoundary>} />
            <Route path="/donations" element={<PageErrorBoundary scope="Donations"><Donations /></PageErrorBoundary>} />
            <Route path="/donations/statements" element={<PageErrorBoundary scope="Giving statements"><GivingStatements /></PageErrorBoundary>} />
            <Route path="/donations/statements/:donorKey" element={<PageErrorBoundary scope="Donor statement"><DonorStatement /></PageErrorBoundary>} />
            <Route path="/pledges"   element={<PageErrorBoundary scope="Pledges"><Pledges /></PageErrorBoundary>} />
            <Route path="/offerings" element={<PageErrorBoundary scope="Offerings"><Offerings /></PageErrorBoundary>} />
            <Route path="/offerings/:id/print" element={<PageErrorBoundary scope="Offerings sheet"><InvoicePrint /></PageErrorBoundary>} />
            <Route path="/migration" element={<PageErrorBoundary scope="Migration Studio"><MigrationStudio /></PageErrorBoundary>} />
            <Route path="/migration/:id/receipt" element={<PageErrorBoundary scope="Import receipt"><ImportReceipt /></PageErrorBoundary>} />
            <Route path="/forms"     element={<PageErrorBoundary scope="Forms"><Forms /></PageErrorBoundary>} />
            <Route path="/forms/:id/responses" element={<PageErrorBoundary scope="Form responses"><FormResponses /></PageErrorBoundary>} />
            <Route path="/settings"  element={<PageErrorBoundary scope="Org settings"><OrgSettings /></PageErrorBoundary>} />
            <Route path="/insights"  element={<PageErrorBoundary scope="Insights"><Insights /></PageErrorBoundary>} />
            <Route path="/ai"        element={<PageErrorBoundary scope="AI Studio"><AI /></PageErrorBoundary>} />
            <Route path="/library"   element={<PageErrorBoundary scope="Library"><Library /></PageErrorBoundary>} />
            <Route path="/bulletin"  element={<PageErrorBoundary scope="Bulletin"><Bulletin /></PageErrorBoundary>} />
            <Route path="/service-planner" element={<PageErrorBoundary scope="Service Planner"><ServicePlanner /></PageErrorBoundary>} />
            <Route path="/service-mode/:planId" element={<PageErrorBoundary scope="Service Mode"><ServiceMode /></PageErrorBoundary>} />
            <Route path="/packet" element={<PageErrorBoundary scope="Sunday Packet"><SundayPacket /></PageErrorBoundary>} />
            <Route path="/register"  element={<PageErrorBoundary scope="Sacramental Register"><SacramentalRegister /></PageErrorBoundary>} />
            <Route path="/register/drafts" element={<PageErrorBoundary scope="Register Drafts"><RegisterDrafts /></PageErrorBoundary>} />
            <Route path="/admin/workbench" element={<PageErrorBoundary scope="Workbench"><Workbench /></PageErrorBoundary>} />
                        <Route path="/register/:id" element={<PageErrorBoundary scope="Register entry"><SacramentRecord /></PageErrorBoundary>} />
<Route path="/register/:id/certificate" element={<PageErrorBoundary scope="Certificate"><SacramentCertificate /></PageErrorBoundary>} />
            <Route path="/mass-intentions" element={<PageErrorBoundary scope="Mass Intentions"><MassIntentions /></PageErrorBoundary>} />
            <Route path="/mass-intentions/print" element={<PageErrorBoundary scope="Sacristy Sheet"><SacristySheet /></PageErrorBoundary>} />
            <Route path="/team"        element={<PageErrorBoundary scope="Team"><Team /></PageErrorBoundary>} />
            <Route path="/billing"     element={<PageErrorBoundary scope="Billing"><Billing /></PageErrorBoundary>} />
            <Route path="/audit"       element={<PageErrorBoundary scope="Audit log"><Audit /></PageErrorBoundary>} />
            <Route path="/archive"     element={<PageErrorBoundary scope="Archive & Recovery"><Archive /></PageErrorBoundary>} />
            <Route path="/getting-settled" element={<PageErrorBoundary scope="Getting settled"><GettingSettled /></PageErrorBoundary>} />
            <Route path="/getting-settled/record" element={<PageErrorBoundary scope="First Parish Setup Record"><SetupRecord /></PageErrorBoundary>} />
            <Route path="/support"     element={<PageErrorBoundary scope="Support"><Support /></PageErrorBoundary>} />
            <Route path="/notifications" element={<PageErrorBoundary scope="Notifications"><Notifications /></PageErrorBoundary>} />
            <Route path="/preferences" element={<PageErrorBoundary scope="Preferences"><Preferences /></PageErrorBoundary>} />
          </Routes>
          </Suspense>
        </main>
      </div>
      {/* The in-app assistant (SUP.3) — floating quill, every page. */}
      <Suspense fallback={null}>
        <AssistantWidget />
      </Suspense>
    </div>
  )
}

// If the user is already signed in, they shouldn't see /login or /signup —
// bounce them to the dashboard instead.
function RedirectIfAuthed({ children }) {
  const { isAuthenticated, loading } = useAuth()
  if (loading) return null
  if (isAuthenticated) return <Navigate to="/" replace />
  return children
}

// Gate a route on an authenticated session without rendering the signed-in
// shell (sidebar + header). Used by /welcome, which is a focused one-page
// experience shown once post-signup.
function RequireAuth({ children }) {
  const { isAuthenticated, loading, authUnavailable } = useAuth()
  const location = useLocation()
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-parchment-50 dark:bg-ink-950">
        <Loader2 size={22} className="animate-spin text-church-700 dark:text-brass-300" />
      </div>
    )
  }
  if (authUnavailable) return <SessionUnconfirmed />
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location }} />
  return children
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
        {/* Locale spine — inside AuthProvider so the parish default
            (user.organization.locale) can join the fallback chain. */}
        <LocaleProvider>
        {/* Inside the locale spine, because the confirmation dialog now
            speaks: its "a recoverable copy is kept" note is a translated
            string, and a provider can only read contexts above it. */}
        <ConfirmProvider>
          {/* Install prompt lives outside Routes so it can render on
              any page — including /login + /p/:slug/events where the
              user isn't yet authenticated. Self-hides when the app is
              already installed (standalone display mode) or the user
              has dismissed previously. */}
          <InstallPrompt />
          {/* Offline indicator (PWA.3) — surfaces a thin bar at the
              top of the viewport when navigator.onLine is false.
              Workbox serves cached API data underneath; the banner
              just makes the state visible. */}
          <OfflineBanner />
          {/* Update prompt (PWA.6) — opt-in refresh banner shown when
              vite-plugin-pwa detects a newer build. Pairs with the
              SKIP_WAITING listener in sw.js. */}
          <UpdatePrompt />
          {/* Outer Suspense covers the public routes + the initial load
              of the protected layout chunk (POL.1). */}
          <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/login"   element={<RedirectIfAuthed><Login          /></RedirectIfAuthed>} />
            <Route path="/signup"  element={<RedirectIfAuthed><Signup         /></RedirectIfAuthed>} />
            <Route path="/forgot"  element={<RedirectIfAuthed><ForgotPassword /></RedirectIfAuthed>} />
            <Route path="/reset"   element={<RedirectIfAuthed><ResetPassword  /></RedirectIfAuthed>} />
            <Route path="/welcome" element={<RequireAuth><Welcome /></RequireAuth>} />
            {/* Public parishioner-facing routes (Sprint P). No auth, no
                app shell. Each church gets /p/:slug/events. */}
            <Route path="/p/:slug/events" element={<PublicEvents />} />
            {/* Public online giving (GIV.2). Charges via the payments
                stub server-side until a provider is connected. */}
            <Route path="/p/:slug/give"   element={<PublicGive />} />
            {/* Public read-online weekly bulletin (BUL.3b). */}
            <Route path="/p/:slug/bulletin" element={<PublicBulletin />} />
            {/* Public church homepage (Anchor 5 / A5.2). Gated on
                page_published server-side; unpublished slugs render the
                same "not found" view as the events page. */}
            <Route path="/p/:slug"        element={<PublicChurch />} />
            {/* Public form fill page (Sprint Forms / F.3). Server
                gates on is_public + status='open'; 404s otherwise so
                draft/private forms don't leak via URL guessing. */}
            <Route path="/p/:slug/forms/:formSlug" element={<PublicForm />} />
            {/* Member swap-request page (VS.2). Token-gated; no
                login required. The token resolves to the member
                server-side — wrong/rotated tokens render the same
                generic "Link not found" view. */}
            <Route path="/p/swap/:token"              element={<PublicSwap />} />
            {/* Self-serve check-in kiosk (CHK.7) — token-gated, no login. */}
            <Route path="/kiosk/:token"               element={<Kiosk />} />
            <Route path="/*"       element={<ProtectedLayout />} />
          </Routes>
          </Suspense>
        </ConfirmProvider>
        </LocaleProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  )
}
