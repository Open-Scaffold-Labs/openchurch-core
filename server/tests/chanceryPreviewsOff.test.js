// José 2026-10-23: chancery (opendiocese) Vercel git-triggered deployments
// OFF for every branch, so no Preview deployments. Production is unaffected:
// CI's deploy job ships chancery via `vercel deploy --prebuilt --prod`
// (CLI, not git-triggered). No DB, no network.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cfg = JSON.parse(readFileSync(join(root, 'client-diocese', 'vercel.json'), 'utf8'))
const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')

describe('chancery previews off', () => {
  it('git.deploymentEnabled is false for all branches (Vercel boolean form)', () => {
    expect(cfg.git?.deploymentEnabled).toBe(false)
  })
  it('CI still deploys chancery production through the CLI, not git', () => {
    expect(ci).toMatch(/VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID_DIOCESE }}/)
    expect(ci).toMatch(/vercel deploy --prebuilt --prod --archive=tgz/)
  })
})
