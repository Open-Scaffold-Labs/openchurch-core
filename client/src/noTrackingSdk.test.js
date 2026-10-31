// Stage 9: finite known-SDK / loader regression guard. SUPPORTING evidence
// for the Apple label rows, not a no-tracking certification: see
// scripts/tracking-scan.mjs for what it does and does not see.

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { TRACKING_PACKAGES, scanText, scanTree, shippedInputs } from '../scripts/tracking-scan.mjs'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(CLIENT, 'package.json'), 'utf8'))

describe('Stage 9: known tracking SDKs in the web client', () => {
  it('declares no listed tracking or analytics package', () => {
    const deps = { ...PKG.dependencies, ...PKG.devDependencies }
    expect(TRACKING_PACKAGES.filter(n => n in deps)).toEqual([])
  })

  it('no shipped client input (src, public, index.html) loads a listed SDK or vendor hook', () => {
    expect(scanTree(CLIENT)).toEqual([])
  })
})

// Fixtures are built in memory / a temp dir, so the real-tree scan above
// never sees them. Each must be flagged by the ACTUAL scanner.
const BYPASSES = {
  'dynamic import()':        "import('workbox-google-analytics').then(m => m.initialize())",
  'require()':               "const ga = require('workbox-google-analytics'); ga.initialize()",
  'side-effect import':      "import 'workbox-google-analytics'",
  'static import from':      "import * as ga from 'workbox-google-analytics'",
  're-export':               "export { initialize } from 'workbox-google-analytics'",
  'subpath specifier':       "import { initialize } from 'workbox-google-analytics/initialize.js'",
  'template-literal import': 'await import(`posthog-js`)',
  'SW importScripts':        "importScripts('https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-google-analytics.prod.js')",
  'Amplitude CDN loader':    '<script src="https://cdn.amplitude.com/libs/analytics-browser-2.0.0-min.js.gz"></script>',
  'Segment snippet':         'analytics.load("x"); s.src="https://cdn.segment.com/analytics.js/v1/"',
  'gtag snippet':            "gtag('config', 'G-XXXX')",
}

describe('scanner catches each loader form (red without the rule)', () => {
  for (const [name, src] of Object.entries(BYPASSES)) {
    it(name, () => { expect(scanText(src).length).toBeGreaterThan(0) })
  }
  it('does not flag ordinary code or the workbox modules the SW really uses', () => {
    expect(scanText("import { precacheAndRoute } from 'workbox-precaching'\nconst analyticsPanel = 1")).toEqual([])
  })
})

describe('shipped-input coverage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-trackscan-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  mkdirSync(join(dir, 'public', 'vendor'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  writeFileSync(join(dir, 'src', 'lib', 'helper.mjs'), "export default () => import('workbox-google-analytics')")
  writeFileSync(join(dir, 'src', 'swHelper.cjs'), "module.exports = require('react-ga4')")
  writeFileSync(join(dir, 'public', 'vendor', 'tag.html'), '<script async src="https://www.googletagmanager.com/gtag/js?id=G-X"></script>')
  writeFileSync(join(dir, 'public', 'vendor', 'amp.js'), "s.src='https://cdn.amplitude.com/libs/x.js'")
  writeFileSync(join(dir, 'src', 'thing.test.js'), "import('workbox-google-analytics')")
  writeFileSync(join(dir, 'src', 'app.js.map'), 'googletagmanager.com')
  mkdirSync(join(dir, 'public', '__fixtures__'), { recursive: true })
  writeFileSync(join(dir, 'public', 'tag.test.js'), "import('workbox-google-analytics')")
  writeFileSync(join(dir, 'public', '__fixtures__', 'tag.js'), "s.src='https://cdn.segment.com/analytics.js/v1/x'")

  it('flags a .mjs source, a .cjs helper and copied public assets', () => {
    const hits = scanTree(dir).join('\n')
    expect(hits).toMatch(/helper\.mjs/)
    expect(hits).toMatch(/swHelper\.cjs/)
    expect(hits).toMatch(/public\/vendor\/tag\.html/)
    expect(hits).toMatch(/public\/vendor\/amp\.js/)
  })
  it('scans public/ files even with test or fixture names (they ship as-is)', () => {
    const hits = scanTree(dir).join('\n')
    expect(hits).toMatch(/public\/tag\.test\.js/)
    expect(hits).toMatch(/public\/__fixtures__\/tag\.js/)
  })
  it('skips tests and source maps outside public (not shipped code)', () => {
    const files = shippedInputs(dir).join('\n')
    expect(files).not.toMatch(/thing\.test\.js/)
    expect(files).not.toMatch(/app\.js\.map/)
  })
})
