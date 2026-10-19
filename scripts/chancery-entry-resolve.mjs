#!/usr/bin/env node
// Synthetic source-tree check. This does not inspect .vercel/output and
// it is not an artifact pass.
//
// deploy-diocese replaces the file: symlink with a directory that contains
// only package.json. This script does that replacement in the working tree,
// checks that the chancery entry's relative import still names
// server/src/app.js, and checks that the package specifier does not.
// A missing server dependency is not a success. This script never imports
// the server.

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'client-diocese/node_modules/openchurch-server')
const entryPath = join(root, 'client-diocese/api/index.js')
const tracedApp = join(root, 'server/src/app.js')

function fail(message) {
  process.stderr.write(`chancery-entry-resolve: ${message}\n`)
  process.exitCode = 1
}

const source = readFileSync(entryPath, 'utf8')
const match = source.match(/import\s+app\s+from\s+['"]([^'"]+)['"]/)
if (!match) {
  fail('client-diocese/api/index.js has no app import')
  process.exit(1)
}
const specifier = match[1]
if (!specifier.startsWith('.')) {
  fail(`app import must be a relative path, found ${specifier}`)
  process.exit(1)
}

let original = null
try {
  const stat = lstatSync(dest)
  if (!stat.isSymbolicLink()) {
    fail(`${dest} is not the file: symlink`)
    process.exit(1)
  }
  original = readlinkSync(dest)
} catch {
  fail(`${dest} is missing. Install client-diocese first so the file: link exists.`)
  process.exit(1)
}

const probeDir = mkdtempSync(join(tmpdir(), 'chancery-source-stub-'))
const probePath = join(probeDir, 'resolve-probe.mjs')
let ownedProbe = false
if (existsSync(probePath)) {
  fail(`probe already exists at ${probePath}; refusing to overwrite it`)
  process.exit(1)
}

function restoreLink() {
  if (original == null) return
  rmSync(dest, { recursive: true, force: true })
  symlinkSync(original, dest)
}

try {
  writeFileSync(probePath, `
const spec = process.argv[2]
const parent = process.argv[3]
try {
  process.stdout.write(import.meta.resolve(spec, parent))
} catch (err) {
  if (err && err.url) process.stdout.write(String(err.url))
  process.stderr.write(String(err && err.code || 'ERR') + '\\n')
  process.exit(2)
}
`, { flag: 'wx' })
  ownedProbe = true

  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  copyFileSync(join(root, 'server/package.json'), join(dest, 'package.json'))

  const parent = pathToFileURL(entryPath).href
  const resolved = spawnSync(process.execPath, [
    '--experimental-import-meta-resolve',
    probePath,
    specifier,
    parent,
  ], {
    cwd: probeDir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '' },
  })
  const resolvedUrl = (resolved.stdout || '').trim()
  const tracedUrl = pathToFileURL(tracedApp).href
  if (resolved.status !== 0 || resolvedUrl !== tracedUrl || !existsSync(tracedApp)) {
    process.stderr.write(resolved.stderr || '')
    fail(`synthetic source stub resolved to ${resolvedUrl || '(nothing)'}; expected ${tracedUrl}`)
  } else {
    process.stdout.write(`CHANCERY_SOURCE_STUB resolved ${resolvedUrl}\n`)
  }

  const packaged = spawnSync(process.execPath, [
    '--experimental-import-meta-resolve',
    probePath,
    'openchurch-server/src/app.js',
    parent,
  ], {
    cwd: probeDir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '' },
  })
  const packagedUrl = (packaged.stdout || '').trim()
  let packagedFile = ''
  if (packagedUrl.startsWith('file:')) {
    try { packagedFile = fileURLToPath(packagedUrl) } catch { packagedFile = '' }
  }
  if (packagedFile && existsSync(packagedFile)) {
    fail(`synthetic source stub still has a file for the package specifier: ${packagedUrl}`)
  } else if (!process.exitCode) {
    process.stdout.write('CHANCERY_SOURCE_STUB package path is absent after the package.json-only directory\n')
    process.stdout.write('CHANCERY_SOURCE_STUB not a Vercel function artifact\n')
  }
} catch (err) {
  if (err && err.code === 'EEXIST') {
    fail(`probe already exists at ${probePath}; refusing to overwrite it`)
  } else {
    throw err
  }
} finally {
  restoreLink()
  if (ownedProbe) rmSync(probeDir, { recursive: true, force: true })
}

if (process.exitCode) process.exit(process.exitCode)
