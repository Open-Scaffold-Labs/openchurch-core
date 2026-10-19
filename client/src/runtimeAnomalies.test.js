// RUNTIME-L2-11 — two earlier audit anomalies, classified from source.
//
// 1. authenticated/local `/clients/1` HTTP 400
//    The profile page fetches `/api/clients/${id}`, not `/clients/${id}`.
//    The SPA route is React. A 400 on the document URL is not this GET.
//
// 2. console `icon-192` 404 while `/icon-192.png` returns 200
//    Every shipped reference is the absolute path `/icon-192.png`. A
//    relative `icon-192.png` from `/clients/1` would request
//    `/clients/icon-192.png` (404) while the root file stays 200.
//
// Headed / local-API / production retrieval: NOT MEASURED on this PR.
// Mutate the fetch path or drop the leading slash and these tests go red.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(CLIENT_ROOT, '..')

function read(rel) {
  return readFileSync(join(CLIENT_ROOT, rel), 'utf8')
}

describe('RUNTIME-L2-11 /clients/1 is not the API GET', () => {
  it('MemberDetail loads the member through /api/clients/${id}', () => {
    const src = read('src/pages/MemberDetail.jsx')
    expect(src).toMatch(/fetch\(apiUrl\(`\/api\/clients\/\$\{id\}`\)\)/)
    expect(src).not.toMatch(/fetch\(apiUrl\(`\/clients\/\$\{id\}`\)\)/)
    expect(src).toMatch(/if \(r\.status === 404\) throw new Error\('not-found'\)/)
    expect(src).toMatch(/if \(!r\.ok\) throw new Error\(t\('member\.failedStatus', \{ status: r\.status \}\)\)/)
  })

  it('App mounts the profile on /clients/:id (SPA), not an API path', () => {
    const src = read('src/App.jsx')
    expect(src).toMatch(/path="\/clients\/:id"/)
  })
})

describe('RUNTIME-L2-11 icon-192 references stay root-absolute', () => {
  it('vite manifest + includeAssets use /icon-192.png, never a relative href', () => {
    const vite = read('vite.config.js')
    expect(vite).toMatch(/src:\s*['"]\/icon-192\.png['"]/)
    expect(vite).toMatch(/['"]icon-192\.png['"]/)
    expect(vite).not.toMatch(/src:\s*['"]icon-192\.png['"]/)
    expect(vite).not.toMatch(/src:\s*['"]\.\/icon-192\.png['"]/)
  })

  it('index.html does not introduce a relative icon-192 URL', () => {
    const html = read('index.html')
    expect(html).not.toMatch(/(?:href|src)=['"](?:\.\/)?icon-192/)
    expect(html).toMatch(/href="\/icon\.svg"/)
  })

  it('the PNG exists at public/icon-192.png', () => {
    expect(existsSync(join(CLIENT_ROOT, 'public', 'icon-192.png'))).toBe(true)
  })

  it('Vercel catch-all rewrite is SPA index.html, not /api, after /api/:path*', () => {
    const vercel = readFileSync(join(REPO_ROOT, 'vercel.json'), 'utf8')
    expect(vercel).toMatch(/"source": "\/api\/:path\*"/)
    expect(vercel).toMatch(/"destination": "\/index.html"/)
    expect(vercel).not.toMatch(/"destination": "\/api\/clients/)
  })
})
