// The artifact gate must fail closed when a nested CommonJS require
// loads a file outside the function, including an ancestor node_modules
// package or a dependency visible only through the runner's NODE_PATH.
// createRequire(<outside file>) from an in-artifact file must not load a
// module that exists only outside. An in-artifact require of a nested file
// and a packaged dependency passes.
// Node 22 matches the chancery deployment runtime.

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const importer = join(dirname(fileURLToPath(import.meta.url)), 'chancery-artifact-import.mjs')
const nodeMajor = process.versions.node.split('.')[0]

function config(handler = 'handler.mjs') {
  return JSON.stringify({
    runtime: 'nodejs22.x',
    handler,
    launcherType: 'Nodejs',
  })
}

function handlerSource() {
  return "import dep from './dep.cjs'\nexport default function app() { return dep }\n"
}

function runImporter(funcDir, extraEnv = {}) {
  return spawnSync(process.execPath, [importer, funcDir], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', ...extraEnv },
  })
}

function refuse(result, marker) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  assert.notEqual(result.status, 0, text)
  assert.equal(String(result.stdout || '').includes('CHANCERY_ARTIFACT_OK'), false, text)
  if (marker) assert.equal(existsSync(marker), false, `outside module ran: ${marker}\n${text}`)
}

test('the containment check runs on Node 22', () => {
  assert.equal(nodeMajor, '22')
  process.stdout.write(`CHANCERY_NODE v${process.versions.node}\n`)
})

test('a nested CommonJS require of a file outside the function fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'chancery-outside-'))
  const func = join(root, 'api.func')
  const marker = join(root, 'outside-ran')
  try {
    mkdirSync(func)
    writeFileSync(join(func, '.vc-config.json'), config())
    writeFileSync(join(func, 'handler.mjs'), handlerSource())
    writeFileSync(join(func, 'dep.cjs'), "module.exports = require('../outside.cjs')\n")
    writeFileSync(join(root, 'outside.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\nmodule.exports = {}\n`)
    refuse(runImporter(func), marker)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an ancestor node_modules package is not borrowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'chancery-ancestor-'))
  const func = join(root, 'api.func')
  const marker = join(root, 'ancestor-ran')
  const pkg = join(root, 'node_modules', 'chancery-borrowed')
  try {
    mkdirSync(func)
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(func, '.vc-config.json'), config())
    writeFileSync(join(func, 'handler.mjs'), handlerSource())
    writeFileSync(join(func, 'dep.cjs'), "module.exports = require('chancery-borrowed')\n")
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'chancery-borrowed', main: 'index.js' }))
    writeFileSync(join(pkg, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\nmodule.exports = {}\n`)
    refuse(runImporter(func), marker)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a dependency visible only through the runner NODE_PATH is not borrowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'chancery-nodepath-'))
  const func = join(root, 'api.func')
  const marker = join(root, 'nodepath-ran')
  const provided = join(root, 'runner-modules', 'chancery-runner-dep')
  try {
    mkdirSync(func)
    mkdirSync(provided, { recursive: true })
    writeFileSync(join(func, '.vc-config.json'), config())
    writeFileSync(join(func, 'handler.mjs'), handlerSource())
    writeFileSync(join(func, 'dep.cjs'), "module.exports = require('chancery-runner-dep')\n")
    writeFileSync(join(provided, 'package.json'), JSON.stringify({ name: 'chancery-runner-dep', main: 'index.js' }))
    writeFileSync(join(provided, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\nmodule.exports = {}\n`)
    refuse(runImporter(func, { NODE_PATH: join(root, 'runner-modules') }), marker)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a symlink inside the function that points outside is not loaded', () => {
  const root = mkdtempSync(join(tmpdir(), 'chancery-symlink-'))
  const func = join(root, 'api.func')
  const marker = join(root, 'symlink-ran')
  const outside = join(root, 'outside.cjs')
  try {
    mkdirSync(func)
    writeFileSync(join(func, '.vc-config.json'), config())
    writeFileSync(join(func, 'handler.mjs'), handlerSource())
    writeFileSync(join(func, 'dep.cjs'), "module.exports = require('./escape.cjs')\n")
    writeFileSync(outside, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\nmodule.exports = {}\n`)
    symlinkSync(outside, join(func, 'escape.cjs'))
    refuse(runImporter(func), marker)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createRequire from an in-artifact file cannot load a module that exists only outside', () => {
  const root = mkdtempSync(join(tmpdir(), 'chancery-createrequire-'))
  const func = join(root, 'api.func')
  const marker = join(root, 'createrequire-ran')
  const outsideDir = join(root, 'outside')
  const parentFile = join(outsideDir, 'parent.cjs')
  try {
    mkdirSync(func)
    mkdirSync(outsideDir)
    writeFileSync(join(func, '.vc-config.json'), config())
    writeFileSync(join(func, 'handler.mjs'), handlerSource())
    writeFileSync(parentFile, 'module.exports = { parent: true }\n')
    writeFileSync(join(outsideDir, 'payload.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\nmodule.exports = { payload: true }\n`)
    writeFileSync(
      join(func, 'dep.cjs'),
      `const { createRequire } = require('node:module')\nconst req = createRequire(${JSON.stringify(parentFile)})\nmodule.exports = req('./payload.cjs')\n`,
    )
    refuse(runImporter(func), marker)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an in-artifact nested require and packaged dependency pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'chancery-inside-'))
  const func = join(root, 'api.func')
  const pkg = join(func, 'node_modules', 'chancery-inside-pkg')
  try {
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(func, '.vc-config.json'), config())
    writeFileSync(join(func, 'handler.mjs'), handlerSource())
    writeFileSync(join(func, 'inside.cjs'), 'module.exports = { inside: true }\n')
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'chancery-inside-pkg', main: 'index.js' }))
    writeFileSync(join(pkg, 'index.js'), 'module.exports = { packaged: true }\n')
    writeFileSync(join(func, 'dep.cjs'), "const inside = require('./inside.cjs')\nconst pkg = require('chancery-inside-pkg')\nif (!inside.inside || !pkg.packaged) throw new Error('in-artifact dependency did not load')\nmodule.exports = { ok: true }\n")
    const result = runImporter(func)
    const text = `${result.stdout || ''}\n${result.stderr || ''}`
    assert.equal(result.status, 0, text)
    assert.equal(String(result.stdout || '').includes('CHANCERY_HANDLER_FUNCTION'), true, text)
    assert.equal(String(result.stdout || '').includes('CHANCERY_ARTIFACT_OK'), true, text)
    assert.equal(String(result.stdout || '').includes('CHANCERY_ARTIFACT_ISOLATED'), true, text)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
