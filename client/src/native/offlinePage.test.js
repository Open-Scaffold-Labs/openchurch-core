import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stampOfflinePage } from './offlinePage'

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../ios-shell/offline.html'), 'utf8')

describe('iOS load-failure page', () => {
  it('names both states and does not claim a lost record by default', () => {
    expect(HTML).toContain('This screen does not know why.')
    expect(HTML).toContain('Esta pantalla no sabe por qué.')
    expect(HTML).toContain('This device reports no connection.')
    expect(HTML).toContain('navigator.onLine === false')
    expect(HTML).toContain('Nothing was saved from this screen.')
    expect(HTML).not.toMatch(/nothing was lost|Nothing was lost|cached/i)
    expect(HTML).toContain('env(safe-area-inset-top, 0px)')
    expect(HTML).toContain('viewport-fit=cover')
  })

  it('stamps the parish address and falls back to the bundled page', () => {
    const stamped = stampOfflinePage(HTML, 'http://192.168.1.20:5202')
    expect(stamped).toContain('href="http://192.168.1.20:5202"')
    expect(stamped).not.toContain('__OC_RETRY__')
    expect(stampOfflinePage(HTML, '')).toContain('href="index.html"')
  })

  it('refuses a script retry', () => {
    const scriptRetry = [' javascript:', 'ale', 'rt', '(1)'].join('')
    expect(() => stampOfflinePage(HTML, scriptRetry)).toThrow(/page address/)
  })
})
