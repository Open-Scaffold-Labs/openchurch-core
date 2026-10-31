// Snapshot guard helper: find shipped JS that reads a repo document by a
// literal path that is absent from the tree being scanned (i.e. withheld).
// Covers both shapes:
//   join of ROOT with one literal docs path            (one literal path)
//   join of here, '..' hops, then docs + sub + file   (segment form; R335-1)
// Usage: node scripts/withheld-read-scan.mjs [root]   → prints "file:line reads withheld doc", exit 1 if any.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs'])
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage'])

// Returns the repo-relative .md paths a source text reads via join(...) literals.
export function docReads(text) {
  const out = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/join\(([^()]*)\)/g)) {
      const segs = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(s => s[1]).filter(s => s !== '..' && s !== '.')
      if (!segs.length || !segs[segs.length - 1].endsWith('.md')) continue
      const rel = segs.join('/').replace(/\/+/g, '/')
      const k = rel.indexOf('docs/')
      out.push({ line: i + 1, doc: k >= 0 ? rel.slice(k) : rel })
    }
  })
  return out
}

export function scan(rootIn) {
  const root = resolve(rootIn)
  const hits = []
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (SKIP.has(n)) continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!EXTS.has(extname(n))) continue
      for (const r of docReads(readFileSync(p, 'utf8'))) {
        if (!existsSync(join(root, r.doc))) hits.push(`${relative(root, p)}:${r.line} reads withheld ${r.doc}`)
      }
    }
  }
  walk(root)
  return hits
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hits = scan(process.argv[2] || process.cwd())
  for (const h of hits) console.log(h)
  process.exit(hits.length ? 1 : 0)
}
