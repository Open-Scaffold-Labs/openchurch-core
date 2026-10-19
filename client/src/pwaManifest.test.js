// OC-READY-01 — PWA install icons + orientation unlock.
// Mutate any one of these and the matching test goes red:
//   1. Manifest icons fall back to SVG-only
//   2. 192 / 512 PNG assets go missing or stop being PNG
//   3. orientation is locked to portrait
//   4. apple-touch-icon.png is unlinked

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VITE_SRC = readFileSync(join(CLIENT_ROOT, 'vite.config.js'), 'utf8')
const INDEX_SRC = readFileSync(join(CLIENT_ROOT, 'index.html'), 'utf8')
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function readPublicPng(name) {
  const buf = readFileSync(join(CLIENT_ROOT, 'public', name))
  expect(buf.subarray(0, 8).equals(PNG_SIG), `${name} is image/png`).toBe(true)
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  }
}

function manifestIconBlock() {
  const start = VITE_SRC.indexOf('icons: [')
  expect(start).toBeGreaterThan(-1)
  const end = VITE_SRC.indexOf('],', start)
  expect(end).toBeGreaterThan(start)
  return VITE_SRC.slice(start, end)
}

describe('PWA install contract (OC-READY-01)', () => {
  it('does not lock orientation to portrait', () => {
    expect(VITE_SRC).not.toMatch(/orientation:\s*['"]portrait['"]/)
    expect(VITE_SRC).toMatch(/orientation:\s*['"]any['"]/)
  })

  it('lists PNG icons at 192 and 512 for any + maskable, not SVG-only', () => {
    const icons = manifestIconBlock()
    expect(icons).toMatch(/src:\s*['"]\/icon-192\.png['"]/)
    expect(icons).toMatch(/src:\s*['"]\/icon-512\.png['"]/)
    expect(icons).toMatch(/src:\s*['"]\/icon-192-maskable\.png['"]/)
    expect(icons).toMatch(/src:\s*['"]\/icon-512-maskable\.png['"]/)
    expect(icons).toMatch(/sizes:\s*['"]192x192['"]/)
    expect(icons).toMatch(/sizes:\s*['"]512x512['"]/)
    expect(icons).toMatch(/type:\s*['"]image\/png['"]/)
    expect(icons).toMatch(/purpose:\s*['"]any['"]/)
    expect(icons).toMatch(/purpose:\s*['"]maskable['"]/)
    expect(icons).not.toMatch(/image\/svg\+xml/)
    expect(icons).not.toMatch(/icon\.svg/)
  })

  it('ships the PNG assets at the declared sizes', () => {
    expect(readPublicPng('icon-192.png')).toEqual({ width: 192, height: 192 })
    expect(readPublicPng('icon-512.png')).toEqual({ width: 512, height: 512 })
    expect(readPublicPng('icon-192-maskable.png')).toEqual({ width: 192, height: 192 })
    expect(readPublicPng('icon-512-maskable.png')).toEqual({ width: 512, height: 512 })
    expect(readPublicPng('apple-touch-icon.png')).toEqual({ width: 180, height: 180 })
  })

  it('keeps the apple-touch-icon link', () => {
    expect(INDEX_SRC).toMatch(/rel="apple-touch-icon"/)
    expect(INDEX_SRC).toMatch(/href="\/apple-touch-icon\.png"/)
    // The 180×180 file is in public/. A comment that says iOS is still
    // waiting on that file is a false claim. This does not prove Add to
    // Home Screen.
    expect(INDEX_SRC).not.toMatch(/falls back to a screenshot/)
    expect(INDEX_SRC).not.toMatch(/before\s+public launch/)
  })

  it('includeAssets only names files that exist in public/', () => {
    const start = VITE_SRC.indexOf('includeAssets:')
    expect(start).toBeGreaterThan(-1)
    const end = VITE_SRC.indexOf('],', start)
    const block = VITE_SRC.slice(start, end)
    const names = [...block.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(readFileSync(join(CLIENT_ROOT, 'public', name)).length, name).toBeGreaterThan(0)
    }
  })
})
