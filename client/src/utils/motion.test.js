// OC-READY-01-015 — prefers-reduced-motion.
// Mutate any one of these and the matching test goes red:
//   1. page/item entrance variants keep a non-zero duration when reduce
//   2. the reduced path still offsets on the y axis
//   3. index.css loses @media (prefers-reduced-motion: reduce)
//   4. MotionConfig in main.jsx stops asking the user

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { itemEntranceVariants, pageEntranceVariants } from './motion'

const SRC_ROOT = dirname(fileURLToPath(import.meta.url))
const INDEX_CSS = readFileSync(join(SRC_ROOT, '..', 'index.css'), 'utf8')
const MAIN_SRC = readFileSync(join(SRC_ROOT, '..', 'main.jsx'), 'utf8')
const PAGE_SRC = readFileSync(join(SRC_ROOT, '..', 'components', 'PageWrapper.jsx'), 'utf8')

function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

function reducedMotionBlock(src) {
  const bare = stripCssComments(src)
  const start = bare.indexOf('@media (prefers-reduced-motion: reduce)')
  expect(start, 'index.css must declare prefers-reduced-motion: reduce').toBeGreaterThan(-1)
  const open = bare.indexOf('{', start)
  expect(open).toBeGreaterThan(start)
  let depth = 0
  let end = -1
  for (let i = open; i < bare.length; i += 1) {
    if (bare[i] === '{') depth += 1
    if (bare[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  expect(end).toBeGreaterThan(open)
  return bare.slice(open, end + 1)
}

describe('entrance variants (OC-READY-01-015)', () => {
  it('skips offset and duration when reduced motion is set', () => {
    const page = pageEntranceVariants(true)
    expect(page.hidden).toEqual({ opacity: 1, y: 0 })
    expect(page.show.opacity).toBe(1)
    expect(page.show.y).toBe(0)
    expect(page.show.transition.duration).toBe(0)
    expect(page.show.transition.staggerChildren).toBe(0)

    const item = itemEntranceVariants(true)
    expect(item.hidden).toEqual({ opacity: 1, y: 0 })
    expect(item.show.transition.duration).toBe(0)
  })

  it('keeps the ceremonial entrance when motion is welcome', () => {
    const page = pageEntranceVariants(false)
    expect(page.hidden).toEqual({ opacity: 0, y: 12 })
    expect(page.show.transition.duration).toBe(0.25)
    expect(page.show.transition.staggerChildren).toBe(0.06)

    const item = itemEntranceVariants(false)
    expect(item.hidden).toEqual({ opacity: 0, y: 10 })
    expect(item.show.transition.duration).toBe(0.22)
  })
})

describe('global CSS reduced-motion kill (OC-READY-01-015)', () => {
  it('zeros non-essential transitions and animations', () => {
    const block = reducedMotionBlock(INDEX_CSS)
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/)
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/)
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/)
    expect(block).toMatch(/transition-delay:\s*0s\s*!important/)
  })
})

describe('Framer Motion root (OC-READY-01-015)', () => {
  it('asks MotionConfig to honour the user preference', () => {
    expect(MAIN_SRC).toMatch(/from ['"]framer-motion['"]/)
    expect(MAIN_SRC).toMatch(/<MotionConfig\s+reducedMotion=["']user["']/)
  })

  it('PageWrapper skips the hidden entrance when reduced motion is set', () => {
    expect(PAGE_SRC).toMatch(/useReducedMotion/)
    expect(PAGE_SRC).toMatch(/pageEntranceVariants\(reduceMotion\)/)
    expect(PAGE_SRC).toMatch(/initial=\{reduceMotion \? false : ['"]hidden['"]\}/)
  })
})
