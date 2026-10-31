// Finite known-SDK / loader regression scanner for the web client (Stage 9).
//
// WHAT IT IS: a denylist check. It flags (a) module specifiers that load a
// listed tracking/analytics package in any loader form, and (b) loader
// hosts / global hooks of the listed vendors, in executable client inputs
// that ship: client/src, client/public and client/index.html.
//
// WHAT IT IS NOT: a no-tracking or no-advertising certification. It cannot
// see advertising purposes, custom network code, server-side sharing,
// vendors not listed here, obfuscated loaders, or a native wrapper. Apple's
// "tracking" is about purpose and linking/sharing, not package names.
// Supporting evidence only; the label answers stay founder/counsel.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

export const TRACKING_PACKAGES = [
  'workbox-google-analytics', 'react-ga', 'react-ga4', 'ga-4-react',
  '@vercel/analytics', '@vercel/speed-insights', 'posthog-js', 'mixpanel-browser',
  '@segment/analytics-next', 'analytics', 'amplitude-js', '@amplitude/analytics-browser',
  'hotjar', '@hotjar/browser', 'react-facebook-pixel', 'logrocket', '@fullstory/browser',
  'plausible-tracker', '@datadog/browser-rum', 'heap-api',
]

// Loader hosts and global hooks of the listed vendors (CDN snippets).
export const TRACKING_HOOKS = [
  /googletagmanager\.com/, /google-analytics\.com/, /\bgtag\s*\(/, /\bga\s*\(\s*['"](create|send)['"]/,
  /\bfbq\s*\(/, /connect\.facebook\.net/,
  /static\.hotjar\.com/, /\bhj\s*\(\s*['"]/,
  /cdn\.segment\.com/, /plausible\.io\/js/,
  /cdn\.amplitude\.com/, /api2?\.amplitude\.com/, /\bamplitude\.(getInstance|init)\s*\(/,
  /cdn\.mxpnl\.com/, /\bmixpanel\.(init|track)\s*\(/,
  /(app|us|eu)(-assets)?\.i?\.?posthog\.com/, /\bposthog\.(init|capture)\s*\(/,
  /cdn\.(lr-ingest|logrocket)\.(io|com)/, /\bLogRocket\.init\s*\(/,
  /fullstory\.com\/s\/fs\.js/, /edge\.fullstory\.com/,
  /datadoghq-browser-agent\.com/, /browser-intake-datadoghq/,
  /heapanalytics\.com/, /\bheap\.load\s*\(/,
  /va\.vercel-scripts\.com/, /\/_vercel\/(insights|speed-insights)\//,
]

const esc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
// Any loader form whose specifier is the package or a subpath of it:
// import x from / import 'p' / export … from / import('p') / require('p')
// / importScripts('…p…'). Template-literal quotes included.
function specifierPatterns(pkg) {
  const spec = `['"\`]${esc(pkg)}(?:/[^'"\`]*)?['"\`]`
  return [
    new RegExp(`\\bfrom\\s*${spec}`),
    new RegExp(`\\bimport\\s*${spec}`),
    new RegExp(`\\bimport\\s*\\(\\s*${spec}`),
    new RegExp(`\\brequire\\s*\\(\\s*${spec}`),
    new RegExp(`\\bimportScripts\\s*\\([^)]*${esc(pkg)}`),
  ]
}
const SPEC_RULES = TRACKING_PACKAGES.flatMap(p => specifierPatterns(p).map(re => ({ re, why: `loads ${p}` })))
const HOOK_RULES = TRACKING_HOOKS.map(re => ({ re, why: `vendor hook ${re}` }))

export function scanText(text) {
  const hits = []
  for (const { re, why } of [...SPEC_RULES, ...HOOK_RULES]) if (re.test(text)) hits.push(why)
  return hits
}

const EXEC = /\.(m?jsx?|cjs|tsx?|mts|cts|html?|svg)$/i
// Not shipped as code: tests, fixtures, source maps — but ONLY outside
// client/public. Everything under public/ is copied into the build as-is,
// whatever it is named, so it is always scanned.
const SKIP = p => /\.test\.|\.spec\.|[\\/]__fixtures__[\\/]|[\\/]src[\\/]test[\\/]|\.map$/i.test(p)

export function shippedInputs(clientDir) {
  const out = []
  const walk = (d, shipsAsIs) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p, shipsAsIs) }
      else if (EXEC.test(n) && (shipsAsIs || !SKIP(p))) out.push(p)
    }
  }
  if (existsSync(join(clientDir, 'src'))) walk(join(clientDir, 'src'), false)
  if (existsSync(join(clientDir, 'public'))) walk(join(clientDir, 'public'), true)
  if (existsSync(join(clientDir, 'index.html'))) out.push(join(clientDir, 'index.html'))
  return out
}

export function scanTree(clientDir) {
  const hits = []
  for (const f of shippedInputs(clientDir)) {
    for (const why of scanText(readFileSync(f, 'utf8'))) hits.push(`${relative(clientDir, f)}: ${why}`)
  }
  return hits
}
