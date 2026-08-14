# Reference — Public-Site Patterns (salvaged from the retired `src/public/` prototype)

The `client/src/public/` prototype (a hand-built public parish website, ~2,300 lines) was retired on 2026-07-05 — it was dead code (nothing in the live app imported it) and its `data.js` held scraped real-person contact info. Two patterns in it were worth keeping for whenever we build the real per-tenant public site (`/p/:slug`). They're captured here, sanitized, so the *approach* survives without the dead code. Full original is recoverable from git history before that commit if ever needed.

## 1. Lightweight EN/ES i18n (no library)

A tiny context + a `t({en, es})` picker. Inline bilingual objects live next to the content instead of separate translation files — good for a small, mostly-static site; revisit if strings ever get large or non-developers need to edit them.

```jsx
// LanguageContext.jsx
import { createContext, useContext, useEffect, useState } from 'react'

const LanguageContext = createContext(null)
const KEY = 'oc_public_lang'

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() =>
    (typeof window !== 'undefined' && localStorage.getItem(KEY)) || 'en')
  const setLang = (l) => {
    setLangState(l)
    if (typeof window !== 'undefined') localStorage.setItem(KEY, l)
  }
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  return <LanguageContext.Provider value={{ lang, setLang }}>{children}</LanguageContext.Provider>
}

export function useLang() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLang must be used inside LanguageProvider')
  return ctx
}

// t({ en, es }) → the right string; falls back to English.
export function useT() {
  const { lang } = useLang()
  return (strings) => strings[lang] ?? strings.en
}
```

Usage: `const t = useT()` then `t({ en: 'Mass Times', es: 'Horarios de Misa' })`. Content data is authored as `{ en, es }` objects.

**First-visit language choice** (worth reusing for a bilingual congregation): show a one-time, equal-weight EN/Español modal before anything else, with no assumed default, tracked in `localStorage` (`*_welcome_seen_v1`). Deliberately gives Spanish-speaking visitors a first-class choice rather than making English primary.

## 2. Runtime white-label theming via `data-parish-theme`

Palette + fonts are exposed as CSS custom properties keyed off a `data-parish-theme` attribute on `<html>`. Switching the attribute re-themes the whole site with zero React re-render, and Tailwind color classes read the vars through `rgb(var(--…) / <alpha-value>)` so alpha utilities keep working.

```jsx
// PublicThemeProvider — writes <html data-parish-theme="...">, persisted in localStorage.
useEffect(() => { document.documentElement.setAttribute('data-parish-theme', theme) }, [theme])
```

```css
/* index.css — one var set per theme; :root holds the default. */
:root, [data-parish-theme='classic'] {
  --parish-primary: 106 46 47;      /* space-separated RGB for rgb(var()/alpha) */
  --parish-accent:  197 179 88;
  --parish-font-serif: '"Playfair Display"', Georgia, serif;
}
[data-parish-theme='modern']   { --parish-primary: 30 58 95;  /* … */ }
[data-parish-theme='reverent'] { --parish-primary: 31 58 95;  /* … */ }
```

```js
// tailwind.config.js — map tokens to the vars.
colors: { parish: { primary: 'rgb(var(--parish-primary) / <alpha-value>)' } }
```

When we build the real per-tenant public site, each church's palette should come from its `ochr_organizations` row (theme/brand columns) rather than a hardcoded attribute — but this attribute-swap + CSS-var mechanism is the right runtime shape to reuse.

## What was NOT kept (deliberately)
The seeded parish content (`data.js`), the specific QAS palette values, and the prototype page components — all tied to one hardcoded church and, in `data.js`, containing scraped real contacts. The real public site is per-tenant and API-driven; none of that content should be reintroduced.
