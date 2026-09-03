import { useState } from 'react'
import { motion } from 'framer-motion'
import { UserCircle, Languages, KeyRound, Eye, EyeOff } from 'lucide-react'
import { useLocale } from '../i18n'
import PageWrapper from '../components/PageWrapper'
import NotificationPrefs from '../components/NotificationPrefs'
import PushSubscriptionToggle from '../components/PushSubscriptionToggle'
import AvatarUploader from '../components/AvatarUploader'
import TextField from '../components/TextField'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { apiUrl } from '../api'

// Self-serve preferences page. Accessible to every signed-in user
// regardless of role — viewers manage their own profile + notification
// toggles even if they can't write to anything else.
//
// Sections:
//   1. ProfileCard              — the user's own profile picture.
//   2. NotificationPrefs        — which templates the user wants.
//   3. PushSubscriptionToggle   — whether THIS device receives push at
//                                 all (PWA.4b). Different axis from
//                                 the prefs above; user has both.
//   4. PasswordCard             — change your own password (F1). Lives
//                                 here rather than /team because every
//                                 signed-in user owns their credential,
//                                 including viewers.
//
// Future: move CalendarSync selfServe here from /team so staff/viewers
// (currently locked out of /team) can grab their own calendar feed too.

// Profile-picture card — wraps AvatarUploader and persists changes to
// the signed-in user via PATCH /api/auth/avatar, then mirrors the new
// value into AuthContext so the header menu updates instantly.
function ProfileCard() {
  const { user, updateUser } = useAuth()
  const toast = useToast()
  const [saving, setSaving] = useState(false)

  async function handleAvatarChange(dataUrl) {
    setSaving(true)
    try {
      const res = await fetch(apiUrl('/api/auth/avatar'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: dataUrl }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Save failed (${res.status})`)
      }
      const data = await res.json()
      updateUser({ avatar: data.avatar })
      toast.success(dataUrl ? 'Profile picture updated' : 'Profile picture removed')
    } catch (err) {
      toast.error(err.message || 'Could not update profile picture')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25 flex items-center gap-2">
        <UserCircle size={15} className="text-brass-600 dark:text-brass-300" />
        <h2 className="font-semibold text-ink-900 dark:text-parchment-50">Profile picture</h2>
      </div>
      <div className="px-5 py-5">
        <AvatarUploader
          value={user?.avatar ?? null}
          name={user?.name}
          onChange={handleAvatarChange}
          busy={saving}
        />
      </div>
    </div>
  )
}

// Language card — the user's own choice for this device. The parish
// default applies wherever no choice has been made.
function LanguageCard() {
  const { t, locale, setLocale, orgLocale, usingOverride } = useLocale()
  // '' is the parish default — setLocale('') clears the stored override, so
  // this device follows the organization again. It is a real option rather
  // than a reset link because "follow my parish" is a choice somebody makes,
  // and before migration 093 it was not available at all: the parish had no
  // language to follow.
  const OPTIONS = [
    { value: '',   label: t('prefs.parishDefault') },
    { value: 'en', label: t('prefs.english') },
    { value: 'es', label: t('prefs.spanish') },
  ]
  const stored = (() => {
    try { return localStorage.getItem('ochr_locale') || '' } catch { return '' }
  })()
  const langName = t(orgLocale === 'es' ? 'prefs.spanish' : 'prefs.english')
  return (
    <div className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm overflow-hidden">
      <div className="px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25 flex items-center gap-2">
        <Languages size={15} className="text-brass-600 dark:text-brass-300" />
        <h2 className="font-semibold text-ink-900 dark:text-parchment-50">{t('prefs.language')}</h2>
      </div>
      <div className="px-5 py-5">
        {/* flex-wrap, not a fixed row. This became three options when the
            parish default arrived, and the Spanish label for it is
            "Predeterminado de la parroquia" — at 320pt a rigid row either
            overflows or crushes the targets below thumb size. */}
        <div className="flex flex-wrap gap-2">
          {OPTIONS.map(o => (
            <button
              key={o.value}
              type="button"
              onClick={() => setLocale(o.value)}
              className={`px-4 py-2 min-h-[44px] rounded-lg text-sm font-semibold border transition-colors ${
                stored === o.value
                  ? 'bg-parchment-200 dark:bg-ink-700 border-brass-400 dark:border-brass-500/60 text-ink-900 dark:text-parchment-50'
                  : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:border-brass-300 dark:hover:border-brass-900/60'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-500 dark:text-parchment-300/70 leading-relaxed">
          {t('prefs.parishDefaultIs', { lang: langName })}
        </p>
        {/* Said out loud. A device choice that quietly outranks a parish
            language the administrator just set is the same class of thing as
            a screen rendering a failure as a fact: true internally, and
            unexplainable to the person looking at it. */}
        {usingOverride && (
          <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
            {t('prefs.usingOverride')}
          </p>
        )}
        <p className="mt-3 text-xs text-ink-500 dark:text-parchment-300/70 leading-relaxed">
          {t('prefs.languageHelp')}
        </p>
      </div>
    </div>
  )
}


// Password card (F1) — change your own password while signed in.
//
// Until the endpoint behind this existed, the only route to a new
// password was the emailed reset link, which does not send without an
// email provider configured. So this is the ONLY working path today.
//
// The server bumps token_version on success, which kills every session
// signed in with the old password — including this one. It hands back a
// fresh token so this device survives; replaceToken swaps it in without
// disturbing the signed-in user. That is why a successful change says
// "other devices signed out" rather than bouncing the user to /login.
function PasswordCard() {
  const { t } = useLocale()
  const { replaceToken } = useAuth()
  const toast = useToast()

  const [current, setCurrent] = useState('')
  const [next, setNext]       = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow]       = useState(false)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState('')

  const MIN = 8
  const mismatch = confirm.length > 0 && next !== confirm
  const canSubmit = current.length > 0 && next.length >= MIN && next === confirm && !busy

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!canSubmit) return
    setBusy(true)
    try {
      const res = await fetch(apiUrl('/api/auth/password'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, password: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not change password (${res.status})`)
      // Swap in the re-issued token BEFORE clearing the form, so no
      // request can go out on the token the server just invalidated.
      replaceToken(data.token)
      setCurrent(''); setNext(''); setConfirm(''); setShow(false)
      toast.success(t('prefs.pw.done'))
    } catch (err) {
      setError(err.message || t('prefs.pw.failed'))
    } finally {
      setBusy(false)
    }
  }

  const eye = (
    <button
      type="button"
      onClick={() => setShow(s => !s)}
      className="text-ink-500 dark:text-parchment-300/70 hover:text-ink-700 dark:hover:text-parchment-50 transition-colors"
      aria-label={show ? t('prefs.pw.hide') : t('prefs.pw.show')}
    >
      {show ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
    </button>
  )

  return (
    <div className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm overflow-hidden">
      <div className="px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25 flex items-center gap-2">
        <KeyRound size={15} className="text-brass-600 dark:text-brass-300" aria-hidden="true" />
        <h2 className="font-semibold text-ink-900 dark:text-parchment-50">{t('prefs.pw.title')}</h2>
      </div>
      <form onSubmit={handleSubmit} className="px-5 py-5 space-y-4">
        <TextField
          label={t('prefs.pw.current')}
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={e => setCurrent(e.target.value)}
          required
        />
        <TextField
          label={t('prefs.pw.new')}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          trailing={eye}
          hint={t('prefs.pw.hint', { min: MIN })}
          value={next}
          onChange={e => setNext(e.target.value)}
          required
        />
        <TextField
          label={t('prefs.pw.confirm')}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          error={mismatch ? t('prefs.pw.mismatch') : undefined}
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          required
        />

        {error && (
          <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-church-700 text-parchment-50 border border-church-700 transition-colors hover:bg-church-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? t('prefs.pw.saving') : t('prefs.pw.submit')}
          </button>
          <p className="text-xs text-ink-500 dark:text-parchment-300/70 leading-relaxed">
            {t('prefs.pw.note')}
          </p>
        </div>
      </form>
    </div>
  )
}

export default function Preferences() {
  const { t } = useLocale()
  return (
    <PageWrapper>
      <div className="max-w-3xl mx-auto space-y-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="font-display text-3xl font-semibold text-ink-900 dark:text-parchment-50 tracking-tight">{t('prefs.title')}</h1>
          <p className="text-sm text-ink-500 dark:text-parchment-300/70 mt-1">
            {t('prefs.sub')}
          </p>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <LanguageCard />
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <ProfileCard />
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <PasswordCard />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          <NotificationPrefs />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <PushSubscriptionToggle />
        </motion.div>
      </div>
    </PageWrapper>
  )
}
