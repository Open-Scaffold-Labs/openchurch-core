// V1.3 motion studies, guarded at the source like App.chrome.test.jsx:
//   #10 the sidebar's active marker is ONE shared element that glides
//       (layoutId) inside a layoutScroll nav, not a per-link background;
//   #3  schedule tiles ease their liturgical stripe (lit-ease) instead of
//       the default 150ms colour snap;
//   #4  the kiosk checkmark draws itself (pathLength 0 → 1).
// Reduce-motion for all three comes from MotionConfig reducedMotion="user"
// (main.jsx) and the base-layer rule in index.css; both are asserted too.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(join(HERE, p), 'utf8')

describe('V1.3 motion studies', () => {
  it('#10 sidebar: one gliding marker, measured inside the scrolling nav', () => {
    const app = read('App.jsx')
    expect(app).toMatch(/<motion\.nav layoutScroll/)
    expect(app.match(/layoutId="nav-active-marker"/g)).toHaveLength(1)
    // the old per-link active background must not come back alongside it
    expect(app).not.toMatch(/\? 'bg-parchment-50 dark:bg-ink-800 text-church-900/)
  })

  it('#3 schedule tiles ease their liturgical colour', () => {
    const sched = read('pages/Schedule.jsx')
    expect(sched.match(/border-l-\[3px\] \$\{stripeCls\}[^`]*lit-ease/g)).toHaveLength(2)
    expect(read('index.css')).toMatch(/\.lit-ease \{[\s\S]*?transition-duration: 600ms/)
  })

  it('#4 kiosk checkmark draws itself', () => {
    const kiosk = read('pages/Kiosk.jsx')
    expect(kiosk).toMatch(/<motion\.path[\s\S]*?initial=\{\{ pathLength: 0 \}\}[\s\S]*?animate=\{\{ pathLength: 1 \}\}/)
  })

  it('reduce-motion is honoured app-wide', () => {
    expect(read('main.jsx')).toMatch(/<MotionConfig reducedMotion="user">/)
    expect(read('index.css')).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration: 0\.01ms !important/)
  })
})
