import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Source contract: the unread register must offer Try again (Quiet Craft 5).
describe('SacramentalRegister Try again', () => {
  const src = readFileSync(join(__dirname, 'SacramentalRegister.jsx'), 'utf8')
  it('wires error.tryAgain onto the load-failed EmptyState', () => {
    expect(src).toMatch(/action=\{\{\s*label:\s*t\('error\.tryAgain'\)/)
    expect(src).toMatch(/setRetryTick/)
  })
})
