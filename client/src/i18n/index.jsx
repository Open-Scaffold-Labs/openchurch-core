// Locale spine — hand-rolled, zero dependencies (OPERATOR.md: no new
// libraries). Resolution order for the active language:
//
//   1. The user's own choice on this device (localStorage 'ochr_locale',
//      set from Preferences) — the secretary and the treasurer may each
//      work in their own language.
//   2. The parish default (user.organization.locale, once the server
//      exposes it — reads as undefined until then, harmlessly).
//   3. English.
//
// t(key, vars) looks up the active dictionary, falls back to English,
// then to the key itself — a missing translation can never blank a
// screen. dateLocale feeds toLocaleDateString so weekday and month
// names follow the language everywhere dates are formatted.

import { createContext, useContext, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { STRINGS } from './strings'

const LocaleContext = createContext(null)

export function LocaleProvider({ children }) {
  const { user } = useAuth()
  const [override, setOverride] = useState(() => {
    try { return localStorage.getItem('ochr_locale') || '' } catch { return '' }
  })

  const locale = override || user?.organization?.locale || 'en'

  const setLocale = (l) => {
    setOverride(l || '')
    try {
      if (l) localStorage.setItem('ochr_locale', l)
      else localStorage.removeItem('ochr_locale')
    } catch { /* private mode — the choice just won't persist */ }
  }

  const value = useMemo(() => {
    const dict = STRINGS[locale] ?? STRINGS.en
    const t = (key, vars) => {
      let s = dict[key] ?? STRINGS.en[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
      return s
    }
    return {
      locale,
      setLocale,
      t,
      // BCP-47 tag for date/number formatting.
      dateLocale: locale === 'es' ? 'es' : 'en-US',
    }
  }, [locale]) // eslint-disable-line react-hooks/exhaustive-deps

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale() {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>')
  return ctx
}
