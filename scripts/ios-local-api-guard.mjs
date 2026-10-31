// Pure plan for the iOS shell's local API. No import of the app or of pg.
//
// server/src/index.js loads dotenv and then runs migrations. A bare
// `npm run dev` therefore migrates whatever DATABASE_URL is in server/.env.
// This plan refuses that target, and a provider setting, before the
// launcher spawns the server. The child is pinned to the local-db URL.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { checkDatabaseUrl } from './lib/review-host-launcher-guard.mjs'
import { PROVIDER_KEYS, enforceNoProvider } from './lib/review-host-no-provider.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// The only database this launcher will start. local-db.mjs owns this URL.
export const PINNED_DATABASE_URL = 'postgresql://postgres@localhost:5433/openchurch_local'

export const IOS_LOCAL_JWT = 'ios-shell-local-jwt-not-a-secret'
export const IOS_LOCAL_PEPPER = 'ios-shell-local-pepper-not-a-secret'

const PASSTHROUGH = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
]

function isPinnedDatabaseUrl(raw) {
  if (checkDatabaseUrl(raw)) return false
  let url
  try { url = new URL(String(raw)) } catch { return false }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  return url.hostname === 'localhost'
    && url.port === '5433'
    && name === 'openchurch_local'
    && url.username === 'postgres'
    && url.password === ''
    && !url.search
    && !url.hash
}

function databaseTargetRefusal(raw) {
  if (raw == null || String(raw).trim() === '') return null
  if (isPinnedDatabaseUrl(raw)) return null
  const structural = checkDatabaseUrl(raw)
  if (structural) return structural
  return 'DATABASE_URL is not the pinned local database'
}

const require = createRequire(new URL('../server/package.json', import.meta.url))
const { parse: parseDotenv } = require('dotenv')

function fileDatabaseRefusal(root, env) {
  const files = [
    path.join(root, '.env'),
    path.join(root, 'server', '.env'),
  ]
  if (env.DOTENV_CONFIG_PATH) files.push(path.resolve(root, env.DOTENV_CONFIG_PATH))
  for (const file of files) {
    let text
    try {
      const st = fs.statSync(file)
      if (!st.isFile()) return `${path.basename(file)} is not a file`
      if (st.size > 1024 * 1024) return `${path.basename(file)} is too large to certify`
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') continue
      return `${path.basename(file)} is unreadable`
    }
    let parsed
    try { parsed = parseDotenv(text) } catch {
      return `${path.basename(file)} could not be parsed`
    }
    const reason = databaseTargetRefusal(parsed.DATABASE_URL)
    if (reason) {
      const rel = path.relative(root, file) || path.basename(file)
      return `DATABASE_URL in ${rel} is not the pinned local database`
    }
    for (const key of ['PGHOST', 'PGHOSTADDR']) {
      if (parsed[key]) return `${key} in ${path.basename(file)} must be unset`
    }
  }
  return null
}

function shellRefusal(env) {
  if (env.NODE_ENV != null && String(env.NODE_ENV).trim() && env.NODE_ENV !== 'development') {
    return 'NODE_ENV must be unset or development'
  }
  if (env.VERCEL_ENV) return 'VERCEL_ENV must be unset'
  if (env.SEED_DEMO) return 'SEED_DEMO must be unset'
  if (env.PORT != null && String(env.PORT).trim() && String(env.PORT) !== '3034') {
    return 'PORT must be unset or 3034'
  }
  for (const key of ['PGHOST', 'PGHOSTADDR']) {
    if (env[key]) return `${key} must be unset`
  }
  return databaseTargetRefusal(env.DATABASE_URL)
}

export function planIosLocalApi(env = process.env, options = {}) {
  const root = options.root || repoRoot
  const copy = { ...env }
  const early = shellRefusal(copy) || fileDatabaseRefusal(root, copy)
  if (early) return { refuse: early }
  const provider = enforceNoProvider(copy, root)
  if (provider) return { refuse: provider }
  const childEnv = {}
  for (const key of PASSTHROUGH) {
    if (copy[key] != null && copy[key] !== '') childEnv[key] = copy[key]
  }
  childEnv.NODE_ENV = 'development'
  childEnv.PORT = '3034'
  childEnv.DATABASE_URL = PINNED_DATABASE_URL
  childEnv.JWT_SECRET = IOS_LOCAL_JWT
  childEnv.CHECKIN_CODE_PEPPER = IOS_LOCAL_PEPPER
  childEnv.SEED_DEMO = ''
  if (!copy.DOTENV_CONFIG_PATH) return { refuse: 'no-provider seal missing' }
  childEnv.DOTENV_CONFIG_PATH = copy.DOTENV_CONFIG_PATH
  for (const key of PROVIDER_KEYS) childEnv[key] = ''
  return { refuse: null, childEnv }
}
