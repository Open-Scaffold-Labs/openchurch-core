#!/usr/bin/env node
// Fingerprint PNG evidence files: IHDR dimensions + sha256 of the bytes.
//
// Headed packets failed integrity when a 390×844 image was filed as desktop,
// and when the same sha256 was sold as two captures (desktop/phone, or
// online/offline). Folder names are labels. This tool reads the file.
//
// It does not know viewports, product SHAs, or verdicts. A clean run is
// necessary for HE-1 (`.ai/protocols/HEADED-EVIDENCE.md`) and not sufficient.
//
//   node tools/headed-evidence/fingerprint.mjs <png> [png…]
//   node tools/headed-evidence/fingerprint.mjs --compare a.png b.png
//   node tools/headed-evidence/fingerprint.mjs --json <png> [png…]
//   node tools/headed-evidence/fingerprint.mjs --self-test

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// 1×1 fully-transparent RGBA PNG. Dimensions and hash are part of --self-test
// so a broken parser cannot stay green.
const FIXTURE_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)
const FIXTURE_1X1_SHA =
  'ebf4f635a17d10d6eb46ba680b70142419aa3220f228001a036d311a22ee9d2a'

function usage(stream = process.stderr) {
  stream.write(
    'usage:\n' +
      '  node tools/headed-evidence/fingerprint.mjs <png> [png…]\n' +
      '  node tools/headed-evidence/fingerprint.mjs --compare a.png b.png\n' +
      '  node tools/headed-evidence/fingerprint.mjs --json <png> [png…]\n' +
      '  node tools/headed-evidence/fingerprint.mjs --self-test\n',
  )
}

function fingerprint(path) {
  let buf
  try {
    buf = readFileSync(path)
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`)
  }
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error(`not a PNG: ${path}`)
  }
  const ihdr = buf.subarray(12, 16).toString('binary')
  if (ihdr !== 'IHDR') {
    throw new Error(`PNG missing IHDR: ${path}`)
  }
  return {
    path,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
  }
}

function printTable(rows) {
  const cols = ['path', 'ihdr', 'sha256', 'bytes']
  const cells = rows.map(r => ({
    path: r.path,
    ihdr: `${r.width}x${r.height}`,
    sha256: r.sha256,
    bytes: String(r.bytes),
  }))
  const widths = Object.fromEntries(
    cols.map(c => [c, Math.max(c.length, ...cells.map(row => row[c].length))]),
  )
  const line = row => cols.map(c => row[c].padEnd(widths[c])).join('  ')
  process.stdout.write(line(Object.fromEntries(cols.map(c => [c, c]))) + '\n')
  for (const row of cells) process.stdout.write(line(row) + '\n')
}

function duplicateGroups(rows) {
  const byHash = new Map()
  for (const r of rows) {
    const list = byHash.get(r.sha256) || []
    list.push(r.path)
    byHash.set(r.sha256, list)
  }
  return [...byHash.values()].filter(list => list.length > 1)
}

function reportDuplicates(groups) {
  if (groups.length === 0) return
  process.stderr.write('DUPLICATE\n')
  for (const list of groups) {
    process.stderr.write(`  ${list.join(' ≡ ')}\n`)
  }
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'headed-evidence-'))
  const a = join(dir, 'a.png')
  const b = join(dir, 'b.png')
  const other = join(dir, 'other.png')
  const txt = join(dir, 'note.txt')
  try {
    writeFileSync(a, FIXTURE_1X1)
    writeFileSync(b, FIXTURE_1X1)
    writeFileSync(txt, 'not a png')

    const row = fingerprint(a)
    if (row.width !== 1 || row.height !== 1) {
      throw new Error(`self-test: expected IHDR 1x1, got ${row.width}x${row.height}`)
    }
    if (row.sha256 !== FIXTURE_1X1_SHA) {
      throw new Error(`self-test: sha256 mismatch: ${row.sha256}`)
    }
    if (fingerprint(b).sha256 !== row.sha256) {
      throw new Error('self-test: identical files hashed differently')
    }

    // 2×1 transparent PNG — same format, different IHDR, must not collide.
    const twoByOne = Buffer.from(FIXTURE_1X1)
    twoByOne.writeUInt32BE(2, 16)
    writeFileSync(other, twoByOne)
    const otherRow = fingerprint(other)
    if (otherRow.width !== 2 || otherRow.height !== 1) {
      throw new Error(`self-test: patched IHDR expected 2x1, got ${otherRow.width}x${otherRow.height}`)
    }
    if (otherRow.sha256 === row.sha256) {
      throw new Error('self-test: different files shared a hash')
    }

    let threw = false
    try {
      fingerprint(txt)
    } catch {
      threw = true
    }
    if (!threw) throw new Error('self-test: non-PNG was accepted')

    process.stdout.write('self-test OK\n')
    process.stdout.write(`  fixture 1x1 sha256=${FIXTURE_1X1_SHA}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  usage(args.length === 0 ? process.stderr : process.stdout)
  process.exit(args.length === 0 ? 1 : 0)
}

if (args[0] === '--self-test') {
  try {
    selfTest()
    process.exit(0)
  } catch (err) {
    process.stderr.write(err.message + '\n')
    process.exit(4)
  }
}

const json = args[0] === '--json'
const compare = args[0] === '--compare'
const paths = json || compare ? args.slice(1) : args

if (compare && paths.length !== 2) {
  usage()
  process.exit(1)
}
if (paths.length === 0) {
  usage()
  process.exit(1)
}

let rows
try {
  rows = paths.map(fingerprint)
} catch (err) {
  process.stderr.write(err.message + '\n')
  process.exit(2)
}

if (json) {
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
} else if (compare) {
  const [a, b] = rows
  process.stdout.write(`${a.path}  ${a.width}x${a.height}  ${a.sha256}\n`)
  process.stdout.write(`${b.path}  ${b.width}x${b.height}  ${b.sha256}\n`)
  if (a.sha256 === b.sha256) {
    process.stderr.write('DUPLICATE  identical sha256 — cannot be sold as two captures\n')
    process.exit(3)
  }
  process.stdout.write('distinct\n')
  process.exit(0)
} else {
  printTable(rows)
}

const groups = duplicateGroups(rows)
if (groups.length > 0) {
  reportDuplicates(groups)
  process.exit(3)
}

process.exit(0)
