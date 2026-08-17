// Locale spine — hand-rolled, zero dependencies (OPERATOR.md: no new
// libraries). Resolution order for the active language:
//
//   1. The user's own choice on this device (localStorage 'ochr_locale',
//      set from Preferences) — the secretary and the treasurer may each
//      work in their own language.
//   2. The parish default (user.organization.locale — the server exposes
//      this as of TRAD.1; it read as undefined for a long time before).
//   3. English.
//
// t(key, vars) resolves through four tiers, in order:
//
//   1. This TRADITION's override for the active language
//   2. This tradition's English override
//   3. The active language's shared string
//   4. English, then the key itself
//
// A missing translation can never blank a screen, and a tradition that
// overrides one key inherits the other ~640. Tiers 1-2 are the whole of
// TRAD.1 on the client: the vocabulary seam was already here, built for
// language, and tradition rides the same chain.
//
// dateLocale feeds toLocaleDateString so weekday and month names follow
// the language everywhere dates are formatted.

import { createContext, useContext, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { STRINGS } from './strings'
import { TRADITION_STRINGS } from './traditions'

const LocaleContext = createContext(null)

export function LocaleProvider({ children }) {
  const { user } = useAuth()
  const [override, setOverride] = useState(() => {
    try { return localStorage.getItem('ochr_locale') || '' } catch { return '' }
  })

  const locale = override || user?.organization?.locale || 'en'
  // 'general' rather than Catholic-by-default: an org that has not told us
  // its tradition must not be shown another one's words.
  const tradition = user?.organization?.tradition || 'general'

  const setLocale = (l) => {
    setOverride(l || '')
    try {
      if (l) localStorage.setItem('ochr_locale', l)
      else localStorage.removeItem('ochr_locale')
    } catch { /* private mode — the choice just won't persist */ }
  }

  const value = useMemo(() => {
    const dict = STRINGS[locale] ?? STRINGS.en
    const trad = TRADITION_STRINGS[tradition]
    const t = (key, vars) => {
      let s = trad?.[locale]?.[key] ?? trad?.en?.[key] ?? dict[key] ?? STRINGS.en[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
      return s
    }
    return {
      locale,
      tradition,
      setLocale,
      t,
      // BCP-47 tag for date/number formatting.
      dateLocale: locale === 'es' ? 'es' : 'en-US',
    }
  }, [locale, tradition]) // eslint-disable-line react-hooks/exhaustive-deps

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale() {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>')
  return ctx
}
