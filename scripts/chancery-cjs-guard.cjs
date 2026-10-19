'use strict'
// CommonJS require() does not pass through the ESM load hook. While the
// artifact check imports the copied function, a resolved file must realpath
// inside that copy or the allow list. A parent outside the copy does not
// skip that check: createRequire(<outside file>) must not load a module that
// exists only outside. A nested require('../outside.cjs'), a symlink to the
// outside, or an ancestor node_modules package is refused before that file
// runs. createRequire(<outside path>) from a parent that is already inside
// the copy stays refused by the same resolved-path check.
const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const rootEnv = process.env.CHANCERY_FUNC_ROOT
if (!rootEnv) {
  process.stderr.write('CHANCERY_ARTIFACT_REFUSED missing CHANCERY_FUNC_ROOT\n')
  process.exit(1)
}

const funcRoot = fs.realpathSync(rootEnv)
const allow = new Set(
  (process.env.CHANCERY_ALLOW || '').split('\n').filter(Boolean).map((item) => {
    try { return fs.realpathSync(item) } catch { return item }
  })
)

function inside(file, dir) {
  const rel = path.relative(dir, file)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const orig = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  const resolved = orig.call(this, request, parent, isMain, options)
  if (typeof resolved !== 'string') return resolved
  if (resolved.startsWith('node:') || Module.builtinModules.includes(resolved)) return resolved
  if (!path.isAbsolute(resolved)) return resolved
  const from = parent && typeof parent.filename === 'string' ? parent.filename : ''
  if (!from || !path.isAbsolute(from)) return resolved
  let real
  try { real = fs.realpathSync(resolved) } catch {
    const missing = new Error(`CHANCERY_ARTIFACT_OUTSIDE missing ${resolved}`)
    missing.code = 'ERR_MODULE_NOT_FOUND'
    throw missing
  }
  if (!inside(real, funcRoot) && !allow.has(real)) {
    const outside = new Error(`CHANCERY_ARTIFACT_OUTSIDE ${real}`)
    outside.code = 'ERR_MODULE_NOT_FOUND'
    throw outside
  }
  if (process.env.CHANCERY_LOAD_LIST) {
    fs.appendFileSync(process.env.CHANCERY_LOAD_LIST, `${pathToFileURL(real).href}\n`)
  }
  return resolved
}
