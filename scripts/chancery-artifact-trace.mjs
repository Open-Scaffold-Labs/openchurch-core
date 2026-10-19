#!/usr/bin/env node
// Credential-free local trace of the chancery function file set.
//
// Uses @vercel/nft, the same tracer the Node builder uses, because this
// environment must not call vercel build, pull production env, or deploy.
// The deploy job runs chancery-artifact-import.mjs on the real
// .vercel/output after vercel build and the materialize step.
//
//   node scripts/chancery-artifact-trace.mjs --nft /path/to/@vercel/nft/out/index.js
//
// Proves two loads against the traced files after the package.json-only
// materialize step:
//   the old package specifier fails
//   the corrected relative handler loads

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const importer = join(root, 'scripts/chancery-artifact-import.mjs')
const nftFlag = process.argv.indexOf('--nft')
const nftHref = nftFlag === -1 ? '@vercel/nft' : pathToFileURL(process.argv[nftFlag + 1]).href

const { nodeFileTrace } = await import(nftHref)
const traced = await nodeFileTrace(['client-diocese/api/index.js'], {
  base: root,
  processCwd: root,
})
const files = [...traced.fileList]
process.stdout.write(`CHANCERY_TRACE_FILES ${files.length}\n`)

function copyTraced(funcDir) {
  for (const rel of files) {
    const src = isAbsolute(rel) ? rel : join(root, rel)
    const destRel = isAbsolute(rel) ? relative(root, rel) : rel
    if (!destRel || destRel.startsWith('..')) {
      throw new Error(`traced file is outside the repo: ${rel}`)
    }
    const dest = join(funcDir, destRel)
    const stat = lstatSync(src)
    if (!stat.isFile()) continue
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }
  const stub = join(funcDir, 'client-diocese/node_modules/openchurch-server')
  rmSync(stub, { recursive: true, force: true })
  mkdirSync(stub, { recursive: true })
  copyFileSync(join(root, 'server/package.json'), join(stub, 'package.json'))
  writeFileSync(join(funcDir, '.vc-config.json'), JSON.stringify({
    runtime: 'nodejs22.x',
    handler: 'client-diocese/api/index.js',
    launcherType: 'Nodejs',
  }, null, 2))
}

function runImport(funcDir) {
  return spawnSync(process.execPath, [importer, funcDir], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '' },
  })
}

const work = mkdtempSync(join(tmpdir(), 'chancery-trace-'))
try {
  const oldDir = join(work, 'old.func')
  mkdirSync(oldDir)
  copyTraced(oldDir)
  const oldEntry = join(oldDir, 'client-diocese/api/index.js')
  const oldSource = readFileSync(oldEntry, 'utf8')
  if (!oldSource.includes("from '../../server/src/app.js'")) {
    throw new Error('corrected entry specifier was not in the traced handler')
  }
  writeFileSync(oldEntry, oldSource.replace(
    "from '../../server/src/app.js'",
    "from 'openchurch-server/src/app.js'",
  ))
  const oldRun = runImport(oldDir)
  const oldText = `${oldRun.stdout || ''}\n${oldRun.stderr || ''}`
  if (oldRun.status === 0 || !/ERR_MODULE_NOT_FOUND|handler is missing|loaded file is missing|handler import failed/.test(oldText)) {
    process.stdout.write(oldRun.stdout || '')
    process.stderr.write(oldRun.stderr || '')
    throw new Error('old package.json-only entry was expected to fail the artifact import')
  }
  const moduleLine = (oldRun.stderr || '').split('\n').find((line) => line.includes('ERR_MODULE_NOT_FOUND'))
    || 'handler import failed'
  process.stdout.write(`CHANCERY_OLD_ENTRY_FAILED ${moduleLine.trim()}\n`)

  const nextDir = join(work, 'corrected.func')
  mkdirSync(nextDir)
  copyTraced(nextDir)
  const nextRun = runImport(nextDir)
  process.stdout.write(nextRun.stdout || '')
  if (nextRun.status !== 0 || !String(nextRun.stdout || '').includes('CHANCERY_ARTIFACT_OK')) {
    process.stderr.write(nextRun.stderr || '')
    throw new Error('corrected built handler did not load')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
