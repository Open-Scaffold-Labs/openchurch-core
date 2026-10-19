// OC-READY-01-016 — PWA fixed chrome clears iOS safe-area insets.
// Mutate any one of these and the matching test goes red:
//   1. index.html drops viewport-fit=cover
//   2. a safe-* utility loses env(safe-area-inset-*, 0px)
//   3. a named fixed/sticky surface drops its inset class
//
// Desktop / zero-inset is unchanged by construction: every rule falls
// back to 0px. jsdom cannot honour env(), so this is a source contract
// the way motion.test.js pins the reduced-motion stylesheet. The
// rendered OfflineBanner class is asserted in OfflineBanner.test.jsx.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_ROOT = join(CLIENT_ROOT, 'src')

function readClient(rel) {
  return readFileSync(join(CLIENT_ROOT, rel), 'utf8')
}

function readSrc(rel) {
  return readFileSync(join(SRC_ROOT, rel), 'utf8')
}

function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

function utilityBlock(css, className) {
  const bare = stripCssComments(css)
  const re = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`)
  const m = bare.match(re)
  expect(m, `index.css must define .${className}`).toBeTruthy()
  return m[1]
}

const SURFACES = [
  { file: 'components/OfflineBanner.jsx', cls: 'safe-pt', needle: 'fixed top-0' },
  { file: 'components/InstallPrompt.jsx', cls: 'safe-mb', needle: 'fixed bottom-4' },
  { file: 'components/UpdatePrompt.jsx', cls: 'safe-mb', needle: 'fixed bottom-4' },
  { file: 'components/AssistantWidget.jsx', cls: 'safe-mb', needle: 'fixed bottom-5' },
  { file: 'App.jsx', cls: 'safe-pt', needle: '<header className="' },
  { file: 'App.jsx', cls: 'safe-h-16', needle: '<header className="' },
  { file: 'App.jsx', cls: 'safe-pt', needle: 'fixed inset-y-0 left-0' },
  { file: 'App.jsx', cls: 'safe-pb', needle: 'fixed inset-y-0 left-0' },
  // L0-01 — Feedback/Confirm inherit MobileSheet bottom-sheet padding.
  { file: 'components/MobileSheet.jsx', cls: 'safe-pb', needle: 'export const sheetPanelCls' },
  { file: 'components/FeedbackModal.jsx', cls: 'sheetPanelCls', needle: 'className={sheetPanelCls}' },
  { file: 'components/ConfirmProvider.jsx', cls: 'sheetPanelCls', needle: 'className={`${sheetPanelCls}' },
]

describe('PWA safe-area insets (OC-READY-01-016)', () => {
  it('keeps viewport-fit=cover so env() can resolve on iOS standalone', () => {
    expect(readClient('index.html')).toMatch(/viewport-fit=cover/)
  })

  it('defines the shared utilities with a 0px fallback', () => {
    const css = readSrc('index.css')
    expect(utilityBlock(css, 'safe-pt')).toMatch(/padding-top:\s*env\(safe-area-inset-top,\s*0px\)/)
    expect(utilityBlock(css, 'safe-pb')).toMatch(/padding-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/)
    expect(utilityBlock(css, 'safe-mb')).toMatch(/margin-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/)
    expect(utilityBlock(css, 'safe-h-16')).toMatch(
      /height:\s*calc\(4rem \+ env\(safe-area-inset-top,\s*0px\)\)/,
    )
  })

  it('pins every flush PWA chrome surface to an inset utility', () => {
    for (const { file, cls, needle } of SURFACES) {
      const src = readSrc(file)
      const idx = src.indexOf(needle)
      expect(idx, `${file} must still contain ${JSON.stringify(needle)}`).toBeGreaterThan(-1)
      // Take a short window around the needle so a class on a different
      // element in the same file cannot satisfy the pin.
      const window = src.slice(Math.max(0, idx - 80), idx + needle.length + 200)
      expect(window, `${file} ${needle} must carry ${cls}`).toMatch(new RegExp(`\\b${cls}\\b`))
    }
  })
})
