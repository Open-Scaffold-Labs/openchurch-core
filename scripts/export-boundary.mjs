// Snapshot guard: every relative import in shipped JS must resolve inside
// the tree being scanned. The withheld-read scan covers literal .md reads.
// It does not follow the module graph, so a shipped script can import a
// withheld .mjs and the public snapshot fails with ERR_MODULE_NOT_FOUND
// (R345-5).
//
// Specifiers are taken from code only (comments and string literals skipped):
//   import … from './x.mjs'     static
//   export … from './x.mjs'     re-export
//   import './x.mjs'            side-effect
//   import('./x.mjs')           dynamic, literal
//   require('./x.cjs')          literal require
// Package and node: specifiers are not repo files. A specifier that already
// has an extension must name that file. An extensionless specifier may be
// a Vite/client import of .js/.jsx/.mjs (and the other code extensions).
//
// Usage: node scripts/export-boundary.mjs [root]
//   prints "file:line imports missing ./spec", exit 1 if any.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.vercel'])
const RESOLVE_EXTS = ['.mjs', '.js', '.jsx', '.cjs', '.ts', '.tsx', '.json']

function isFile(p) {
  try { return statSync(p).isFile() } catch { return false }
}

const BEFORE_REGEX = new Set(['(', '[', '{', ',', ';', ':', '=', '?', '!', '&', '|', '^', '~', '+', '-', '*', '%', '<', '>'])
const REGEX_KEYWORDS = new Set(['return', 'throw', 'case', 'else', 'do', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'yield', 'await', 'new'])

function escapeSkipsNewline(text, i, line) {
  if (text[i + 1] === '\n') return { i: i + 2, line: line + 1 }
  return { i: i + 2, line }
}

// Relative specifiers that appear in code, with 1-based line numbers.
// Strings, comments, and regex literals are not code: a quote inside
// /"([^"]+)"/ must not open a string that swallows the next import.
export function relativeSpecifiers(text) {
  const specs = []
  let i = 0
  let line = 1
  let state = 'code'
  let lastSig = ''
  let lastIdent = ''
  let ident = ''
  const finishIdent = () => {
    if (!ident) return
    lastIdent = ident
    ident = ''
  }
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === '\n') line += 1
    if (state === 'line') {
      if (c === '\n') state = 'code'
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue }
      i += 1
      continue
    }
    if (state === 'sq' || state === 'dq' || state === 'bt') {
      if (c === '\\') { ({ i, line } = escapeSkipsNewline(text, i, line)); continue }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'bt' && c === '`')) {
        state = 'code'
        lastSig = c
        lastIdent = ''
        ident = ''
      }
      i += 1
      continue
    }
    if (state === 'regex' || state === 'class') {
      if (c === '\\') { ({ i, line } = escapeSkipsNewline(text, i, line)); continue }
      if (state === 'regex' && c === '[') { state = 'class'; i += 1; continue }
      if (state === 'class' && c === ']') { state = 'regex'; i += 1; continue }
      if (state === 'regex' && c === '/') {
        state = 'code'
        lastSig = '/'
        lastIdent = ''
        ident = ''
      }
      i += 1
      continue
    }
    if (c === '/' && (n === '/' || n === '*')) {
      finishIdent()
      state = n === '/' ? 'line' : 'block'
      i += 2
      continue
    }
    const word = ident || lastIdent
    if (c === '/' && (lastSig === '' || BEFORE_REGEX.has(lastSig) || REGEX_KEYWORDS.has(word))) {
      finishIdent()
      state = 'regex'
      i += 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      finishIdent()
      state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'bt'
      i += 1
      continue
    }
    if (i === 0 || !/[\w$]/.test(text[i - 1])) {
      const m = /^(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)['"](\.[^'"]+)['"]/.exec(text.slice(i))
      if (m) {
        specs.push({ spec: m[1], line })
        line += m[0].split('\n').length - 1
        i += m[0].length
        lastSig = text[i - 1] || ''
        lastIdent = ''
        ident = ''
        continue
      }
    }
    if (/[\w$]/.test(c)) {
      ident += c
      lastSig = c
      i += 1
      continue
    }
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '\f') {
      finishIdent()
      if (!REGEX_KEYWORDS.has(lastIdent)) lastIdent = ''
      lastSig = c
    } else if (c === '\n' || c === ' ' || c === '\t') {
      finishIdent()
    }
    i += 1
  }
  return specs
}

export function specifierResolves(fromFile, spec) {
  if (!spec.startsWith('.')) return true
  const abs = resolve(dirname(fromFile), spec)
  if (isFile(abs)) return true
  if (extname(spec)) return false
  for (const ext of RESOLVE_EXTS) {
    if (isFile(abs + ext)) return true
  }
  for (const ext of RESOLVE_EXTS) {
    if (isFile(join(abs, 'index' + ext))) return true
  }
  return false
}

export function missingRelativeImports(rootIn) {
  const root = resolve(rootIn)
  const hits = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (SKIP.has(name)) continue
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p); continue }
      if (!EXTS.has(extname(name))) continue
      let text
      try { text = readFileSync(p, 'utf8') } catch { continue }
      for (const spec of relativeSpecifiers(text)) {
        if (!specifierResolves(p, spec.spec)) {
          hits.push(`${relative(root, p)}:${spec.line} imports missing ${spec.spec}`)
        }
      }
    }
  }
  walk(root)
  return hits
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const hits = missingRelativeImports(process.argv[2] || process.cwd())
  for (const hit of hits) console.log(hit)
  process.exit(hits.length ? 1 : 0)
}
