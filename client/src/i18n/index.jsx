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
//   2. The active language's shared string
//   3. This tradition's English override (only when the locale has no string)
//   4. English, then the key itself
//
// A missing translation can never blank a screen, and a tradition that
// overrides one key inherits the other ~640. Tradition English must not
// shadow a valid shared Spanish (or other locale) string — that was the
// LOC-L1-01 defect: sparse `general.es` let `general.en['sheet.title']`
// print "Intentions for the Week" on a Spanish sacristy sheet.
//
// dateLocale feeds toLocaleDateString so weekday and month names follow
// the language everywhere dates are formatted.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { STRINGS } from './strings'
import { TRADITION_STRINGS } from './traditions'

function localeDict(locale) {
  return STRINGS[locale] ?? STRINGS.en
}

const LocaleContext = createContext(null)

export function LocaleProvider({ children }) {
  const { user } = useAuth()
  const [override, setOverride] = useState(() => {
    try { return localStorage.getItem('ochr_locale') || '' } catch { return '' }
  })

  // The parish's own language (migration 093). Until that column existed
  // this term was permanently null and the whole i18n spine ran off the
  // per-device override below — so a parish could not be Spanish, only a
  // browser could, and every new device started in English.
  const orgLocale = user?.organization?.locale || 'en'

  // A parishioner on a giving page, a check-in kiosk or a form is NOT signed
  // in, so `user` is null and every one of those screens resolved to English
  // no matter what the parish had set. There is no session to read the
  // language from, so the page tells us: each public endpoint now returns
  // its organization's locale alongside the church's name, and the page
  // hands it here after its own fetch.
  //
  // This is the half of the locale work that reaches the person who may not
  // read English at all. The signed-in half only ever reached staff.
  const [publicLocale, setPublicLocale] = useState('')

  // Order matters, and both halves are deliberate. An explicit per-device
  // choice wins, because a bilingual parish really does have one secretary
  // reading English and another reading Spanish on the same roster. The
  // parish default is what applies when nobody has chosen — which is now
  // most of the time, and is the case that was broken.
  // A signed-in user of one parish looking at ANOTHER parish's public page
  // should see that page in its own language, which is why publicLocale
  // outranks orgLocale — you are looking at them, not at yourself. An
  // explicit per-device choice still wins over both.
  const locale = override || publicLocale || orgLocale
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

  // Stable identity. Public pages put this in a useCallback/useEffect load
  // chain (PublicGive, and any sibling that learns the parish language from
  // its own endpoint). When publicLocale was listed in the memo deps below,
  // every successful load rebuilt this function, which rebuilt `load`, which
  // re-fired the effect, which set loading=true again and flashed the
  // spinner over a form that had just appeared — flaking the give-page
  // suite in CI on a race of a few milliseconds.
  const setPublicLocaleStable = useCallback((l) => {
    setPublicLocale(STRINGS[l] ? l : '')
  }, [])

  const value = useMemo(() => {
    const dict = localeDict(locale)
    const trad = TRADITION_STRINGS[tradition]
    const t = (key, vars) => {
      let s = trad?.[locale]?.[key] ?? dict[key] ?? trad?.en?.[key] ?? localeDict('en')[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
      return s
    }
    return {
      locale,
      // Exposed so the settings screen can say what the parish default is
      // and offer to fall back to it. A device override that silently
      // outranks a newly-set parish language, with nothing on screen
      // explaining why, is the same "confidently wrong" failure this
      // codebase has been removing everywhere else.
      orgLocale,
      usingOverride: Boolean(override) && override !== orgLocale,
      // Public pages call this with the locale their endpoint returned.
      // Ignores anything not shipped, so a future locale in the database
      // cannot put a page into a language the bundle has no strings for.
      setPublicLocale: setPublicLocaleStable,
      tradition,
      setLocale,
      t,
      // BCP-47 tag for date/number formatting.
      dateLocale: locale === 'es' ? 'es' : 'en-US',
    }
  }, [locale, orgLocale, override, setPublicLocaleStable, tradition]) // eslint-disable-line react-hooks/exhaustive-deps

  // index.html ships `<html lang="en">` as a literal. A screen reader
  // announces the page in whatever that attribute says, and browsers offer
  // to translate on it — so a fully Spanish parish was telling assistive
  // technology it was reading English on every single page.
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale() {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>')
  return ctx
}

// Inner ErrorBoundary and ToastProvider sit INSIDE LocaleProvider
// (main.jsx) so an App-tree crash and toast chrome follow the live
// locale spine (device override, public page, or parish default).
// An outer ErrorBoundary wraps Auth + Locale so a crash in those
// providers still shows recovery chrome. PageErrorBoundary is also
// inside the provider. Same hook covers tests and any mount that is
// still outside the spine (including the outer boundary): use the
// live locale when present; otherwise the device override
// (ochr_locale), which is the first term of LocaleProvider's own order.
export function useOptionalLocale() {
  const ctx = useContext(LocaleContext)
  if (ctx) return ctx
  let locale = 'en'
  try {
    const stored = localStorage.getItem('ochr_locale')
    if (stored && STRINGS[stored]) locale = stored
  } catch { /* private mode — stay on English */ }
  const dict = localeDict(locale)
  const t = (key, vars) => {
    let s = dict[key] ?? localeDict('en')[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
    return s
  }
  return { locale, t }
}
