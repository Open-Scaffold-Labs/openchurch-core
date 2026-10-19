// OC-CYCLE-MAX-05 night-close residual: browsers request /favicon.ico
// even when the document already links /icon.svg. The parish client
// must answer that path with a real ICO, and must keep the SVG and
// apple-touch links pointed at files that exist.
//
// Mutate the link or remove public/favicon.ico and this goes red.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_SRC = readFileSync(join(CLIENT_ROOT, 'index.html'), 'utf8')
const VITE_SRC = readFileSync(join(CLIENT_ROOT, 'vite.config.js'), 'utf8')

function icoDirectory(buf) {
  expect(buf.readUInt16LE(0), 'ICO reserved').toBe(0)
  expect(buf.readUInt16LE(2), 'ICO type').toBe(1)
  const count = buf.readUInt16LE(4)
  expect(count).toBeGreaterThan(0)
  const images = []
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    images.push({
      width: buf.readUInt8(off) || 256,
      height: buf.readUInt8(off + 1) || 256,
    })
  }
  return images
}

describe('parish client favicon paths', () => {
  it('links /favicon.ico, /icon.svg, and /apple-touch-icon.png', () => {
    expect(INDEX_SRC).toMatch(/<link rel="icon" href="\/favicon\.ico" sizes="16x16 32x32" \/>/)
    expect(INDEX_SRC).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/icon\.svg" \/>/)
    expect(INDEX_SRC).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" \/>/)
  })

  it('ships public/favicon.ico with 16 and 32 images', () => {
    const ico = readFileSync(join(CLIENT_ROOT, 'public', 'favicon.ico'))
    const images = icoDirectory(ico)
    expect(images).toEqual(expect.arrayContaining([
      { width: 16, height: 16 },
      { width: 32, height: 32 },
    ]))
  })

  it('names favicon.ico in includeAssets', () => {
    const start = VITE_SRC.indexOf('includeAssets:')
    expect(start).toBeGreaterThan(-1)
    const end = VITE_SRC.indexOf('],', start)
    const block = VITE_SRC.slice(start, end)
    expect(block).toMatch(/['"]favicon\.ico['"]/)
  })
})
