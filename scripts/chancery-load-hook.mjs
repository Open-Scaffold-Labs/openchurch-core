// Records file modules loaded while the chancery artifact check imports
// the built handler, and refuses a file URL whose real path sits outside
// the isolated function copy. Permanent source. It is not written and deleted.
import { appendFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

function inside(file, dir) {
  const rel = relative(dir, file)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function allowed(real) {
  const root = process.env.CHANCERY_FUNC_ROOT
  if (!root) return false
  let funcRoot
  try { funcRoot = realpathSync(root) } catch { return false }
  if (inside(real, funcRoot)) return true
  const extra = (process.env.CHANCERY_ALLOW || '').split('\n').filter(Boolean)
  for (const item of extra) {
    try {
      if (realpathSync(item) === real) return true
    } catch { /* an allow-list entry that is already gone is not a pass */ }
  }
  return false
}

export async function resolve(specifier, context, next) {
  const result = await next(specifier, context)
  const url = result && result.url ? result.url : ''
  if (url.startsWith('file:')) {
    let real
    try { real = realpathSync(fileURLToPath(url)) } catch {
      throw new Error(`CHANCERY_ARTIFACT_OUTSIDE missing ${url}`)
    }
    if (!allowed(real)) throw new Error(`CHANCERY_ARTIFACT_OUTSIDE ${real}`)
  }
  return result
}

export async function load(url, context, next) {
  if (url.startsWith('file:') && process.env.CHANCERY_LOAD_LIST) {
    appendFileSync(process.env.CHANCERY_LOAD_LIST, `${url}\n`)
  }
  return next(url, context)
}
