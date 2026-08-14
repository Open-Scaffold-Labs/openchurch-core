import { useState } from 'react'
import { motion } from 'framer-motion'
import { UserCircle, Languages } from 'lucide-react'
import { useLocale } from '../i18n'
import PageWrapper from '../components/PageWrapper'
import NotificationPrefs from '../components/NotificationPrefs'
import PushSubscriptionToggle from '../components/PushSubscriptionToggle'
import AvatarUploader from '../components/AvatarUploader'
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
  const { t, locale, setLocale } = useLocale()
  const OPTIONS = [
    { value: 'en', label: t('prefs.english') },
    { value: 'es', label: t('prefs.spanish') },
  ]
  return (
    <div className="bg-parchment-50 dark:bg-ink-900/90 rounded-2xl border border-parchment-300/50 dark:border-brass-900/30 shadow-warm overflow-hidden">
      <div className="px-5 py-4 border-b border-parchment-300/50 dark:border-brass-900/25 flex items-center gap-2">
        <Languages size={15} className="text-brass-600 dark:text-brass-300" />
        <h2 className="font-semibold text-ink-900 dark:text-parchment-50">{t('prefs.language')}</h2>
      </div>
      <div className="px-5 py-5">
        <div className="flex gap-2">
          {OPTIONS.map(o => (
            <button
              key={o.value}
              type="button"
              onClick={() => setLocale(o.value)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                locale === o.value
                  ? 'bg-parchment-200 dark:bg-ink-700 border-brass-400 dark:border-brass-500/60 text-ink-900 dark:text-parchment-50'
                  : 'border-parchment-300/70 dark:border-brass-900/40 text-ink-500 dark:text-parchment-300/70 hover:border-brass-300 dark:hover:border-brass-900/60'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-500 dark:text-parchment-300/70 leading-relaxed">
          {t('prefs.languageHelp')}
        </p>
      </div>
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
