import { STRINGS } from './strings'

// English-only t() for pure helpers (cash-count labels etc.) that are also
// called outside a LocaleProvider — unit tests and English-only call sites.
// Same interpolation and key fallback as useLocale().t.
export function enT(key, vars) {
  let s = STRINGS.en[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  return s
}
