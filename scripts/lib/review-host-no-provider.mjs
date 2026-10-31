// Shipped no-provider gate. No import of docs/.
//
// Fail-closed no-provider gate for the review-host rehearsal and the iOS
// local API launcher.
//
// Runs before any application, monitoring, or provider module is imported.
// A non-empty provider setting is refused. It is not stripped and not logged.
// server/src/db.js and server/src/index.js import dotenv/config, which fills
// any name that is absent from the environment. Deleting a name therefore
// lets a .env file restore it after this check. The seal below pins
// DOTENV_CONFIG_PATH to an empty file and sets every provider name to an
// empty string (dotenv does not override a name that is already present,
// and the server treats an empty RESEND_API_KEY as unset: development
// records stub, production records unconfigured).
//
// This module has no I/O at import time beyond resolving the dotenv parser.
// File reads happen only inside enforceNoProvider. Values are never copied
// into error text. repo root is two levels up, the same depth the private
// docs/app-store re-export used to occupy.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PROVIDER_KEYS, providerEnvRefusal } from './review-host-launcher-guard.mjs'

const require = createRequire(new URL('../../server/package.json', import.meta.url))
const { parse: parseDotenv } = require('dotenv')

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export { PROVIDER_KEYS }

// What a documented review-host process is allowed to inherit. Provider
// names are sealed to '' separately and are not taken from the parent.
export const PASSTHROUGH_KEYS = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'NODE_ENV', 'PORT', 'BIND_HOST', 'HOSTNAME',
  'DATABASE_URL', 'PG_POOL_MAX',
  'JWT_SECRET', 'CHECKIN_CODE_PEPPER',
  'TLS_CERT', 'TLS_KEY',
  'SUPER_ADMIN_EMAIL', 'VENDOR_ADMIN_EMAILS',
  'SUPER_ADMIN_USER_IDS', 'VENDOR_ADMIN_USER_IDS', 'AI_SWITCH_OPERATOR_USER_IDS',
  'OCHR_REHEARSAL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  'MONITORING_LEVEL',
  'DOTENV_CONFIG_PATH',
])

const PRELOAD = /(?:^|\s)(?:--require|--import|--env-file(?:-if-exists)?|-r)(?:\s|=|$)/
const DOTENV_ARG = /^dotenv_config_(?:encoding|path|quiet|debug|override|DOTENV_KEY)=/
const MAX_ENV_BYTES = 1024 * 1024

export function preloadRefusal(env, argv = process.argv) {
  if (env.DOTENV_CONFIG_OVERRIDE) return 'DOTENV_CONFIG_OVERRIDE must be unset (no-provider rehearsal)'
  if (env.DOTENV_KEY || env.DOTENV_CONFIG_DOTENV_KEY) return 'DOTENV_KEY must be unset (no-provider rehearsal)'
  if (PRELOAD.test(env.NODE_OPTIONS || '')) {
    return 'NODE_OPTIONS must not preload modules or env files (no-provider rehearsal)'
  }
  if (argv.some((arg) => DOTENV_ARG.test(arg))) {
    return 'dotenv_config_* arguments are refused (no-provider rehearsal)'
  }
  return null
}

function candidateFiles(env, cwd) {
  const files = [
    path.resolve(cwd, '.env'),
    path.join(repoRoot, '.env'),
    path.join(repoRoot, 'server', '.env'),
  ]
  if (env.DOTENV_CONFIG_PATH) files.push(path.resolve(cwd, env.DOTENV_CONFIG_PATH))
  return [...new Set(files)]
}

function fileRefusal(file) {
  let text
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return `${path.basename(file)} is not a file (no-provider rehearsal)`
    if (st.size > MAX_ENV_BYTES) return `${path.basename(file)} is too large to certify (no-provider rehearsal)`
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    return `${path.basename(file)} is unreadable (no-provider rehearsal)`
  }
  let parsed
  try { parsed = parseDotenv(text) } catch {
    return `${path.basename(file)} could not be parsed (no-provider rehearsal)`
  }
  for (const name of PROVIDER_KEYS) {
    if (parsed[name]) {
      return `${name} is set in ${path.basename(file)} and would be restored after the check`
    }
  }
  return null
}

export function dotenvFileRefusal(env, cwd = process.cwd()) {
  for (const file of candidateFiles(env, cwd)) {
    const reason = fileRefusal(file)
    if (reason) return reason
  }
  return null
}

// Pin dotenv to an empty file and occupy every provider name with ''.
// Call only after the refusals above. Never logs values.
export function sealProviderEnv(env) {
  const file = path.join(os.tmpdir(), `oc-review-no-provider-${process.pid}.env`)
  fs.writeFileSync(file, '', { encoding: 'utf8', mode: 0o600, flag: 'w' })
  env.DOTENV_CONFIG_PATH = file
  delete env.DOTENV_CONFIG_OVERRIDE
  delete env.DOTENV_KEY
  delete env.DOTENV_CONFIG_DOTENV_KEY
  for (const name of PROVIDER_KEYS) env[name] = ''
  return file
}

// Refuse, or seal env in place and return null. Does not import the app.
export function enforceNoProvider(env, cwd = process.cwd(), argv = process.argv) {
  const reason = providerEnvRefusal(env) || preloadRefusal(env, argv) || dotenvFileRefusal(env, cwd)
  if (reason) return reason
  sealProviderEnv(env)
  return null
}

export function buildCleanEnv(env) {
  const out = {}
  for (const key of PASSTHROUGH_KEYS) {
    if (env[key] != null && env[key] !== '') out[key] = env[key]
  }
  for (const key of PROVIDER_KEYS) out[key] = ''
  return out
}
