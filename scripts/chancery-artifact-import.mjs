#!/usr/bin/env node
// Fail-closed check of a produced Vercel function.
//
//   node scripts/chancery-artifact-import.mjs .vercel/output
//   node scripts/chancery-artifact-import.mjs path/to/api/index.func
//
// Requires .vc-config.json, the handler it names, and every file module
// that handler actually loads. The function directory is copied into an
// empty temp directory and imported from that copy, so checkout parents
// and ancestor node_modules are not on the module path. A child guard
// rejects CommonJS require() and symlink targets that realpath outside
// the copy. The child environment is PATH plus NODE_ENV=development.
// A missing file, a module that resolves outside the function directory,
// or a skipped import fails the process. This does not deploy and does
// not read a credential.

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hookPath = join(here, 'chancery-load-hook.mjs')
const outputArg = process.argv[2]
if (!outputArg) {
  process.stderr.write('chancery-artifact-import: pass the .vercel/output directory or a .func directory\n')
  process.exit(1)
}

function fail(message) {
  process.stderr.write(`chancery-artifact-import: ${message}\n`)
  process.exitCode = 1
}

function walkConfigs(dir, found, depth) {
  if (depth > 8) return
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkConfigs(full, found, depth + 1)
    else if (entry.isFile() && entry.name === '.vc-config.json') found.push(full)
  }
}

const root = outputArg
const configs = []
const direct = join(root, '.vc-config.json')
if (existsSync(direct)) configs.push(direct)
else walkConfigs(root, configs, 0)
if (configs.length === 0) {
  fail(`no .vc-config.json under ${root}`)
  process.exit(1)
}

function inside(file, rootDir) {
  const rel = relative(rootDir, file)
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`) && !rel.startsWith(`..${sep}`))
}

for (const configPath of configs) {
  const funcDir = dirname(configPath)
  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (err) {
    fail(`could not read ${configPath}: ${err.message}`)
    continue
  }
  if (!config || typeof config.handler !== 'string' || config.handler === '') {
    fail(`${configPath} has no handler`)
    continue
  }
  if (!config.runtime && !config.launcherType) {
    fail(`${configPath} has no runtime`)
    continue
  }
  const handlerPath = join(funcDir, config.handler)
  if (!existsSync(handlerPath)) {
    fail(`handler is missing: ${handlerPath}`)
    continue
  }

  const workDir = mkdtempSync(join(tmpdir(), 'chancery-artifact-'))
  const listPath = join(workDir, 'loaded.txt')
  const runnerPath = join(workDir, 'import-handler.mjs')
  const copyDir = join(workDir, 'function')
  let ownedRunner = false
  try {
    if (existsSync(runnerPath)) {
      fail(`runner already exists at ${runnerPath}; refusing to overwrite it`)
      continue
    }
    writeFileSync(runnerPath, `
const denied = ['DATABASE_URL', 'PROD_DATABASE_URL', 'VERCEL_TOKEN']
for (const name of denied) {
  if (process.env[name]) {
    console.error('CHANCERY_ARTIFACT_REFUSED ' + name)
    process.exit(1)
  }
}
const mod = await import(process.env.CHANCERY_HANDLER)
const app = mod && mod.default !== undefined ? mod.default : mod
if (typeof app !== 'function') {
  console.error('CHANCERY_ARTIFACT_REFUSED handler export is ' + typeof app)
  process.exit(1)
}
console.log('CHANCERY_HANDLER_FUNCTION')
`, { flag: 'wx' })
    ownedRunner = true
    cpSync(funcDir, copyDir, { recursive: true, verbatimSymlinks: true })
    const copiedHandler = join(copyDir, config.handler)
    if (!existsSync(copiedHandler)) {
      fail(`copied handler is missing: ${copiedHandler}`)
      continue
    }
    const copyRoot = realpathSync(copyDir)
    let copiedReal
    try { copiedReal = realpathSync(copiedHandler) } catch {
      fail(`copied handler is missing: ${copiedHandler}`)
      continue
    }
    if (!inside(copiedReal, copyRoot)) {
      fail(`handler symlink escapes the function artifact: ${copiedReal}`)
      continue
    }

    const run = spawnSync(process.execPath, [
      '--require', join(here, 'chancery-cjs-guard.cjs'),
      '--import', join(here, 'chancery-register-hook.mjs'),
      runnerPath,
    ], {
      cwd: workDir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '',
        NODE_ENV: 'development',
        CHANCERY_LOAD_LIST: listPath,
        CHANCERY_HANDLER: pathToFileURL(copiedHandler).href,
        CHANCERY_HOOK_PATH: hookPath,
        CHANCERY_FUNC_ROOT: copyRoot,
        CHANCERY_ALLOW: [
          hookPath,
          join(here, 'chancery-register-hook.mjs'),
          join(here, 'chancery-cjs-guard.cjs'),
          runnerPath,
        ].join('\n'),
      },
    })
    process.stdout.write(run.stdout || '')
    if (run.status !== 0) {
      process.stderr.write(run.stderr || '')
      fail(`handler import failed for ${handlerPath}`)
      continue
    }
    if (!String(run.stdout || '').includes('CHANCERY_HANDLER_FUNCTION')) {
      fail(`handler import produced no function marker for ${handlerPath}`)
      continue
    }
    if (!existsSync(listPath)) {
      fail(`handler import recorded no files for ${handlerPath}`)
      continue
    }
    const loaded = readFileSync(listPath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
    if (loaded.length === 0) {
      fail(`handler import skipped every file for ${handlerPath}`)
      continue
    }
    const funcRoot = copyRoot
    const allowed = new Set([
      realpathSync(hookPath),
      realpathSync(join(here, 'chancery-register-hook.mjs')),
      realpathSync(join(here, 'chancery-cjs-guard.cjs')),
      realpathSync(runnerPath),
    ])
    let handlerSeen = false
    const handlerReal = copiedReal
    for (const url of loaded) {
      if (!url.startsWith('file:')) continue
      let file
      try { file = fileURLToPath(url) } catch { fail(`unreadable load url ${url}`); continue }
      let real
      try { real = realpathSync(file) } catch {
        fail(`loaded file is missing: ${file}`)
        continue
      }
      if (real === handlerReal) handlerSeen = true
      if (allowed.has(real)) continue
      if (!inside(real, funcRoot)) {
        fail(`loaded file is outside the function artifact: ${real}`)
      }
    }
    if (!handlerSeen) fail(`load list did not include the handler ${handlerPath}`)
    if (!process.exitCode) {
      process.stdout.write(`CHANCERY_ARTIFACT_ENTRY ${handlerPath}\n`)
      process.stdout.write(`CHANCERY_ARTIFACT_CONFIG ${configPath}\n`)
      process.stdout.write(`CHANCERY_ARTIFACT_ISOLATED ${copyRoot}\n`)
      process.stdout.write(`CHANCERY_ARTIFACT_FILES ${loaded.length}\n`)
      process.stdout.write('CHANCERY_ARTIFACT_OK\n')
    }
  } catch (err) {
    if (err && err.code === 'EEXIST') fail(`runner already exists at ${runnerPath}; refusing to overwrite it`)
    else throw err
  } finally {
    if (ownedRunner) rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.exitCode) process.exit(process.exitCode)
