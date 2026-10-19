// ARG-236-5 M20. The privacy suite inits Sentry through a test seam.
// This spawns the production branch (NODE_ENV=production + SENTRY_DSN)
// against a localhost ingest and reads back booleans only.

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const probe = join(here, 'support/sentryProdProbe.mjs')

describe('production Sentry init', () => {
  it('scrubs token paths, referer, and secret headers on the real init path', async () => {
    const env = { ...process.env, NODE_ENV: 'production' }
    delete env.SENTRY_DSN
    const child = spawn(process.execPath, [probe], {
      cwd: join(here, '..'),
      env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    const line = stdout.split('\n').find((row) => row.startsWith('PROBE_RESULT '))
    expect(line, `probe exit ${exit}`).toBeTruthy()
    const result = JSON.parse(line.slice('PROBE_RESULT '.length))
    expect(result).toEqual({
      enabled: true,
      sawKiosk: true,
      sawSwap: true,
      sawCalendar: true,
      sawUnsubscribe: true,
      kioskAbsent: true,
      swapAbsent: true,
      calAbsent: true,
      unsubAbsent: true,
      inviteAbsent: true,
      queryAbsent: true,
      cookieAbsent: true,
      apiKeyAbsent: true,
      cityAbsent: true,
      kioskPattern: true,
      swapPattern: true,
      calPattern: true,
      unsubPattern: true,
    })
    expect(exit).toBe(0)
    expect(stderr.includes('PROBE_RESULT')).toBe(false)
  }, 20_000)
})
