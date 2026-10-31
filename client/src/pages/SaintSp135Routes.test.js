// SP-135: unknown client routes render NotFound, signed-in and signed-out.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { matchPath } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
const src = readFileSync(join(process.cwd(), 'src/App.jsx'), 'utf8')
const start = src.indexOf('function ProtectedLayout()')
const block = src.slice(src.indexOf('<Routes>', start), src.indexOf('</Routes>', start))
const routePaths = [...block.matchAll(/<Route path="([^"]+)"/g)].map(m => m[1]).filter(p => p !== '*')
const listSrc = src.slice(src.indexOf('export const APP_ROUTE_PATHS = ['), src.indexOf(']\n', src.indexOf('export const APP_ROUTE_PATHS = [')))
const listed = [...listSrc.matchAll(/'([^']+)'/g)].map(m => m[1])
const isApp = p => listed.some(x => matchPath(x, p))

describe('SP-135 catch-all routes', () => {
  it('signed-in shell ends in <Route path="*"> rendering NotFound home="/"', () => {
    expect(block).toMatch(/<Route path="\*" element={<NotFound home="\/" \/>} \/>/)
  })
  it('APP_ROUTE_PATHS matches every signed-in <Route> exactly', () => {
    expect(listed.length).toBeGreaterThan(40)
    expect([...listed].sort()).toEqual([...routePaths].sort())
  })
  it('signed-out: unknown path renders NotFound home="/login"; known path still goes to login', () => {
    expect(src).toMatch(/if \(!isAppRoute\(location\.pathname\)\) \{\s*return <main[^>]*><NotFound home="\/login" \/><\/main>/)
    expect(isApp('/dashboard')).toBe(false)
    expect(isApp('/no/such/page')).toBe(false)
    for (const p of ['/', '/mass-intentions', '/clients/7', '/register/3/certificate', '/audit']) expect(isApp(p)).toBe(true)
  })
})
