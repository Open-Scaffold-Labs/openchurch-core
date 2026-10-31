// R345-5: retained scripts and tests must resolve inside the public export.
// The lists and the verify block come from push-public-snapshot.sh. On the
// public snapshot that script is withheld, so the export simulation is
// skipped and this file checks the tree it is standing in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan as scanDocs } from './withheld-read-scan.mjs'
import { missingRelativeImports as missingImports } from './export-boundary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const SCRIPT = process.env.SNAPSHOT_SCRIPT || join(repo, 'push-public-snapshot.sh')
const privateMapName = 'CURRENT-EXECUTION-MAP.md'
const PRIVATE_MAP = join(repo, 'docs', privateMapName)
const publicSnapshot = !existsSync(SCRIPT) && !existsSync(PRIVATE_MAP)
const onPrivate = !publicSnapshot
const tPrivate = onPrivate ? test : test.skip

function bashArray(text, name) {
  const m = text.match(new RegExp(String.raw`(?:^|\n)${name}=\(([\s\S]*?)\n\)`))
  if (!m) throw new Error(`missing ${name} in snapshot script`)
  return [...m[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1])
}

function parseLists(text) {
  return {
    withheld: bashArray(text, 'WITHHELD_FILES'),
    publicDocs: bashArray(text, 'PUBLIC_DOCS'),
    publicRootMd: bashArray(text, 'PUBLIC_ROOT_MD'),
  }
}

function walkFiles(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkFiles(p, out)
    else out.push(p)
  }
  return out
}

// Mirrors push-public-snapshot.sh section 2. The no-push snapshot run is
// the shell itself; this applies the script's own lists to a copy.
function applyWithhold(root, lists) {
  for (const rel of lists.withheld) rmSync(join(root, rel), { recursive: true, force: true })
  const docs = join(root, 'docs')
  if (existsSync(docs)) {
    for (const file of walkFiles(docs, [])) {
      const rel = relative(root, file).split(sep).join('/')
      const ok = lists.publicDocs.some((allow) => (
        allow.endsWith('/') ? rel.startsWith(allow) : rel === allow
      ))
      if (!ok) rmSync(file, { force: true })
    }
  }
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.md')) continue
    const p = join(root, name)
    if (!statSync(p).isFile()) continue
    if (!lists.publicRootMd.includes(name)) rmSync(p, { force: true })
  }
}

function materialize(dest) {
  mkdirSync(dest, { recursive: true })
  const listed = spawnSync('git', ['-C', repo, 'ls-files', '-z', '-c', '-o', '--exclude-standard'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (listed.status !== 0) throw new Error(listed.stderr.toString() || 'git ls-files failed')
  const files = listed.stdout.toString('utf8').split('\0').filter(Boolean)
  for (const rel of files) {
    const from = join(repo, rel)
    if (!existsSync(from) || !statSync(from).isFile()) continue
    const to = join(dest, rel)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

function exportTree() {
  const dest = mkdtempSync(join(tmpdir(), 'oc-export-'))
  materialize(dest)
  applyWithhold(dest, parseLists(readFileSync(SCRIPT, 'utf8')))
  return dest
}

test('a missing relative import is a finding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-eb-'))
  writeFileSync(join(dir, 'a.mjs'), "import './gone.mjs'\n")
  writeFileSync(join(dir, 'gone.js'), 'export {}\n')
  const hits = missingImports(dir)
  assert.equal(hits.length, 1)
  assert.match(hits[0], /a\.mjs:1 imports missing \.\/gone\.mjs/)
  rmSync(dir, { recursive: true, force: true })
})

test('static, side-effect, re-export, dynamic import, and require are checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-eb-'))
  writeFileSync(join(dir, 'a.mjs'), [
    "import { y } from './static.mjs'",
    "import './side.mjs'",
    "export { x } from './re.mjs'",
    "import('./dyn.mjs')",
    "require('./cjs.cjs')",
  ].join('\n'))
  const hits = missingImports(dir)
  for (const spec of ['./static.mjs', './side.mjs', './re.mjs', './dyn.mjs', './cjs.cjs']) {
    assert.ok(hits.some((hit) => hit.includes(spec)), hits.join('\n'))
  }
  rmSync(dir, { recursive: true, force: true })
})

test('a comment or a string that mentions an import is not a finding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-eb-'))
  writeFileSync(join(dir, 'a.mjs'), "// import './gone.mjs'\nconst s = \"import './gone.mjs'\"\nexport const n = 1\n")
  assert.deepEqual(missingImports(dir), [])
  rmSync(dir, { recursive: true, force: true })
})

test('a regex literal that contains quotes does not hide the next import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-eb-'))
  writeFileSync(join(dir, 'a.mjs'), 'const re = /"([^"]+)"/g\nimport "./gone.mjs"\n')
  const hits = missingImports(dir)
  assert.equal(hits.length, 1)
  assert.match(hits[0], /a\.mjs:2 imports missing \.\/gone\.mjs/)
  rmSync(dir, { recursive: true, force: true })
})

test('an extensionless client import resolves to jsx', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-eb-'))
  writeFileSync(join(dir, 'page.jsx'), "import Page from './Page'\n")
  writeFileSync(join(dir, 'Page.jsx'), 'export default 1\n')
  assert.deepEqual(missingImports(dir), [])
  rmSync(dir, { recursive: true, force: true })
})

test('this tree resolves its own relative imports', () => {
  const hits = missingImports(repo)
  assert.deepEqual(hits, [], hits.slice(0, 20).join('\n'))
})

tPrivate('the snapshot script withholds the private-doc assertion and not the shipped guard', () => {
  const lists = parseLists(readFileSync(SCRIPT, 'utf8'))
  assert.ok(lists.withheld.includes('client/src/native/iosXcodeDoc.test.js'))
  assert.equal(lists.withheld.includes('scripts/ios-local-api.mjs'), false)
  assert.equal(lists.withheld.includes('scripts/ios-local-api-guard.mjs'), false)
  assert.equal(lists.withheld.includes('scripts/lib/review-host-launcher-guard.mjs'), false)
  assert.equal(lists.publicDocs.includes('docs/IOS-BUILD.md'), false)
  assert.equal(lists.publicDocs.some((doc) => doc.includes('app-store')), false)
})

tPrivate('the export built from the snapshot lists keeps every relative import', () => {
  const tree = exportTree()
  try {
    const iosDoc = 'IOS-BUILD.md'
    assert.equal(existsSync(join(tree, 'docs', iosDoc)), false)
    assert.equal(existsSync(join(tree, 'docs', 'app-store', 'review-host-launcher-guard.mjs')), false)
    assert.equal(existsSync(join(tree, 'client', 'src', 'native', 'iosXcodeDoc.test.js')), false)
    assert.equal(existsSync(join(tree, 'scripts', 'lib', 'review-host-launcher-guard.mjs')), true)
    assert.equal(existsSync(join(tree, 'scripts', 'ios-local-api-guard.mjs')), true)
    const preflight = readFileSync(join(tree, 'client', 'src', 'native', 'iosXcodePreflight.test.js'), 'utf8')
    assert.equal(preflight.includes('IOS-BUILD.md'), false)
    const guard = readFileSync(join(tree, 'scripts', 'ios-local-api-guard.mjs'), 'utf8')
    assert.equal(guard.includes('docs/app-store'), false)
    const hits = missingImports(tree)
    assert.deepEqual(hits, [], hits.slice(0, 20).join('\n'))
    assert.deepEqual(scanDocs(tree), [])
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

tPrivate('a retained script that imports a withheld module fails that export', () => {
  const tree = exportTree()
  try {
    const guard = join(tree, 'scripts', 'ios-local-api-guard.mjs')
    writeFileSync(guard, `${readFileSync(guard, 'utf8')}\nimport '../docs/app-store/review-host-launcher-guard.mjs'\n`)
    const hits = missingImports(tree)
    assert.ok(hits.some((hit) => hit.includes('review-host-launcher-guard.mjs')), hits.join('\n'))
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

const src = onPrivate ? readFileSync(SCRIPT, 'utf8') : ''
const blockStart = src.indexOf('# >>> export-boundary')
const blockEnd = src.indexOf('# <<< export-boundary')
const block = blockStart >= 0 && blockEnd > blockStart ? src.slice(blockStart, blockEnd) : ''

function runBlock(tree, checker) {
  const prog = `set -eo pipefail\nfail_check() { echo "  ✗ $1 — stopping"; exit 1; }\nSRC=${JSON.stringify(repo)}\ncd ${JSON.stringify(tree)}\n${block}\necho SENTINEL_PASSED\n`
  return spawnSync('bash', ['--noprofile', '--norc', '-c', prog], {
    encoding: 'utf8',
    env: { ...process.env, ...(checker ? { EB_CHECKER: checker } : {}) },
  })
}

tPrivate('the snapshot verify block is present', () => {
  assert.ok(block.length > 50)
  assert.match(block, /export-boundary check failed/)
})

tPrivate('the snapshot verify block passes a tree whose import exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-eb-sh-'))
  writeFileSync(join(dir, 'a.mjs'), "import './b.mjs'\n")
  writeFileSync(join(dir, 'b.mjs'), 'export const n = 1\n')
  const result = runBlock(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /SENTINEL_PASSED/)
  rmSync(dir, { recursive: true, force: true })
})

tPrivate('the snapshot verify block fails a missing import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-eb-sh-'))
  writeFileSync(join(dir, 'a.mjs'), "import './gone.mjs'\n")
  const result = runBlock(dir)
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /SENTINEL_PASSED/)
  assert.match(result.stdout, /imports missing \.\/gone\.mjs/)
  rmSync(dir, { recursive: true, force: true })
})

tPrivate('the snapshot verify block fails closed when the checker is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-eb-sh-'))
  writeFileSync(join(dir, 'a.mjs'), 'export const n = 1\n')
  const result = runBlock(dir, '/nonexistent/export-boundary.mjs')
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /SENTINEL_PASSED/)
  assert.match(result.stdout, /checker did not complete|MODULE_NOT_FOUND|Cannot find module/)
  rmSync(dir, { recursive: true, force: true })
})

tPrivate('the snapshot verify block fails closed when the checker throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-eb-sh-'))
  const badDir = mkdtempSync(join(tmpdir(), 'oc-eb-bad-'))
  const bad = join(badDir, 'bad.mjs')
  writeFileSync(bad, "throw new Error('boom')\n")
  writeFileSync(join(dir, 'a.mjs'), 'export const n = 1\n')
  const result = runBlock(dir, bad)
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /SENTINEL_PASSED/)
  rmSync(dir, { recursive: true, force: true })
  rmSync(badDir, { recursive: true, force: true })
})
