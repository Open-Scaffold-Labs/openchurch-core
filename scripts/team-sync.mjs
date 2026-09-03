#!/usr/bin/env node
// team-sync — who has touched this repository since I last looked, and am I
// standing on it?
//
// WHY THIS EXISTS
//
// OpenChurch is worked by several agents at once — Claude sessions, Cursor,
// Grokbot — plus Jose. Twice in one day that produced a surprise that cost
// real time:
//
//   2026-09-03  A Cursor PR fixed case-sensitive donor identity while a
//               Claude session was fixing the same defect, and created its
//               own migration 097 against the other's 097. Two 097s cannot
//               coexist in one chain. Found only because a fetch happened to
//               run before a push.
//   2026-09-03  Four commits landed on top of that session's work — two of
//               them CORRECTING it — inside the same working directory,
//               between two turns of the same session.
//
// The second one is the sharper hazard: it is not only the remote that moves.
// The working copy moves too, so `git rev-parse HEAD` can differ from what a
// long-running session believes without anything being pulled.
//
// THE ATTRIBUTION TRAP, and the reason this script exists rather than a
// remembered `git log`:
//
//   git log --format='%an' → "Jose Rivera", for every commit, always.
//
// Everything merges through his GitHub account, so the author field cannot
// tell a Cursor Agent commit from a Claude one from something Jose typed
// himself. The Co-Authored-By TRAILER is the only honest signal, and reading
// it is the whole point of this file.
//
// READ-ONLY. It fetches (which writes only remote-tracking refs) and reads.
// It never checks out, merges, rebases, resets, pushes, or changes a
// working-tree file. Deciding what to do about a divergence is a person's
// call and often a conversation.
//
//   node scripts/team-sync.mjs              # since the last run
//   node scripts/team-sync.mjs --since SHA  # since a commit you name
//   node scripts/team-sync.mjs --no-fetch   # offline; says so in the output
//
// Exit 0 = in sync. Exit 1 = something needs a human decision (behind,
// diverged, or a migration-number collision). Exit 2 = could not ask.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const SINCE_ARG = args.includes('--since') ? args[args.indexOf('--since') + 1] : null
const NO_FETCH = args.includes('--no-fetch')

const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: 'utf8', ...opts })
const git = (...a) => {
  const r = sh('git', a)
  if (r.status !== 0) return null
  return r.stdout.trim()
}
const gitLines = (...a) => (git(...a) || '').split('\n').filter(Boolean)

if (!git('rev-parse', '--git-dir')) {
  console.error('team-sync: not a git repository.')
  process.exit(2)
}

// The marker lives in .git/, which is never committed and never shared — so
// "since you last looked" is per-clone, which is what it should mean.
const MARKER = join(git('rev-parse', '--git-dir'), 'oc-team-sync-last')

let problems = 0
const bad = (s) => { problems++; return s }

console.log('\n─── team-sync ' + '─'.repeat(52))

// ── 1. fetch, so every answer below is about the real remote ────────────
let fetchNote = ''
if (NO_FETCH) {
  fetchNote = 'OFFLINE (--no-fetch) — everything below may be stale'
} else {
  const f = sh('git', ['fetch', '--prune', 'origin'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  fetchNote = f.status === 0 ? 'fetched' : bad('FETCH FAILED — everything below may be stale')
}

const head = git('rev-parse', '--short', 'HEAD')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
const upstream = git('rev-parse', '--short', 'origin/main')
const ahead = Number(git('rev-list', '--count', 'origin/main..HEAD') ?? 0)
const behind = Number(git('rev-list', '--count', 'HEAD..origin/main') ?? 0)
const dirty = gitLines('status', '--porcelain').filter(l => !l.startsWith('??')).length
const untracked = gitLines('status', '--porcelain').filter(l => l.startsWith('??')).length

console.log(`remote      ${fetchNote}`)
console.log(`branch      ${branch}`)
console.log(`HEAD        ${head}`)
console.log(`origin/main ${upstream}`)
console.log(`position    ${ahead} ahead, ${behind} behind` +
  (behind && ahead ? bad('   ← DIVERGED') : behind ? bad('   ← BEHIND') : ''))
console.log(`tree        ${dirty} modified, ${untracked} untracked`)

// ── 2. DID THE WORKING COPY MOVE UNDER ME? ──────────────────────────────
const lastSeen = SINCE_ARG || (existsSync(MARKER) ? readFileSync(MARKER, 'utf8').trim() : null)
let baseline = null
if (lastSeen && git('cat-file', '-t', lastSeen) === 'commit') baseline = lastSeen

if (baseline && baseline !== git('rev-parse', 'HEAD')) {
  const movedLocal = Number(git('rev-list', '--count', `${baseline}..HEAD`) ?? 0)
  if (movedLocal) {
    console.log(`\n⚠  THE LOCAL WORKING COPY MOVED since you last looked: ${movedLocal} commit(s)`)
    console.log('   Another agent worked in this same directory. Nothing was pulled by you.')
  }
}

// ── 3. WHO. The trailer, never the author field. ────────────────────────
const range = baseline ? `${baseline}..origin/main` : 'origin/main~12..origin/main'
const label = baseline ? `since ${baseline.slice(0, 7)}` : 'last 12 on origin/main'
const rows = gitLines('log', range, '--format=%h\x1f%(trailers:key=Co-Authored-By,valueonly=true,separator=%x2c)\x1f%(trailers:key=Co-authored-by,valueonly=true,separator=%x2c)\x1f%cr\x1f%s')

console.log(`\n─── commits (${label}) ${'─'.repeat(Math.max(0, 40 - label.length))}`)
if (!rows.length) {
  console.log('none — nobody has pushed since you last looked.')
} else {
  const who = (a, b) => {
    const raw = (a || b || '').replace(/<[^>]*>/g, '').split(',')[0].trim()
    if (!raw) return 'unattributed'
    if (/cursor/i.test(raw)) return 'Cursor'
    if (/grok/i.test(raw)) return 'Grokbot'
    if (/fable/i.test(raw)) return 'Fable'
    if (/claude/i.test(raw)) return 'Claude'
    return raw.slice(0, 18)
  }
  const tally = {}
  for (const r of rows) {
    const [sha, t1, t2, when, subj] = r.split('\x1f')
    const w = who(t1, t2)
    tally[w] = (tally[w] || 0) + 1
    console.log(`  ${sha}  ${w.padEnd(12)} ${when.padEnd(14)} ${subj.slice(0, 54)}`)
  }
  console.log('  ' + '-'.repeat(70))
  console.log('  ' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '))
  console.log('\n  NOTE: the author field reads "Jose Rivera" on every one of these.')
  console.log('        The names above come from Co-Authored-By trailers.')
}

// ── 4. MIGRATION COLLISION — the specific thing that bit us ─────────────
// Two agents numbering the next migration at the same time is not a merge
// conflict git can see: both add a differently-named file, both edit
// index.js, and only the chain notices.
const MIGDIR = 'server/src/migrations'
const numsOf = (listing) => {
  const m = {}
  for (const f of listing) {
    const hit = /^(\d{3})-/.exec(f)
    if (hit) (m[hit[1]] ||= []).push(f)
  }
  return m
}
const localFiles = existsSync(MIGDIR) ? readdirSync(MIGDIR).filter(f => /^\d{3}-.*\.js$/.test(f)) : []
const remoteFiles = gitLines('ls-tree', '--name-only', `origin/main:${MIGDIR}`).filter(f => /^\d{3}-.*\.js$/.test(f))

console.log(`\n─── migration chain ${'─'.repeat(46)}`)
const localNums = numsOf(localFiles), remoteNums = numsOf(remoteFiles)
const collisions = []
for (const n of Object.keys(localNums)) {
  const l = localNums[n], r = remoteNums[n] || []
  const union = new Set([...l, ...r])
  if (union.size > 1) collisions.push({ n, files: [...union] })
}
const localHead = localFiles.sort().at(-1) ?? '(none)'
const remoteHead = remoteFiles.sort().at(-1) ?? '(none)'
console.log(`local tree   ${localFiles.length} migration(s), head ${localHead}`)
console.log(`origin/main  ${remoteFiles.length} migration(s), head ${remoteHead}`)
if (collisions.length) {
  console.log(bad('\n⚠  MIGRATION NUMBER COLLISION:'))
  for (const c of collisions) console.log(`     ${c.n} → ${c.files.join('  vs  ')}`)
  console.log('     Renumber yours to the next free slot and update index.js + names.js.')
} else {
  console.log('no number collisions between your tree and origin/main.')
}

// ── 5. WORK IN FLIGHT ───────────────────────────────────────────────────
const branches = gitLines('for-each-ref', '--sort=-committerdate',
  '--format=%(refname:short)\x1f%(committerdate:relative)', 'refs/remotes/origin')
  .map(l => l.split('\x1f'))
  .filter(([n]) => n !== 'origin' && n !== 'origin/main' && n !== 'origin/HEAD')
  .slice(0, 6)
console.log(`\n─── work in flight ${'─'.repeat(47)}`)
//
// "Unmerged commits" is the wrong measure and its first draft here was
// wrong because of it. Every PR in this repo lands squashed, so the source
// branch's own commits stay unreachable from main forever even though their
// CONTENT is merged — `rev-list main..branch` therefore reports 1-2
// "unmerged" on every branch ever merged, and a check that cries wolf on
// everything gets ignored.
//
// `git cherry` is the honest instrument: it compares PATCHES, marking '-'
// for one already upstream (by content, whatever its sha) and '+' for one
// genuinely absent. A branch whose every commit is '-' is a leftover, not
// live work, and saying so is the difference between "three agents are
// editing your files" and "three branches nobody deleted".
//
// Note also that `git diff main branch` (two dots) is the wrong diff for
// this question: it shows main's NEWER work missing from the branch as
// deletions, which reads alarmingly like the branch deleting your files.
// Three dots, from the merge base, is what "what does this branch add"
// means.
if (branches.length) {
  for (const [n, when] of branches) {
    const cherry = gitLines('cherry', 'origin/main', n)
    const live = cherry.filter(l => l.startsWith('+')).length
    const merged = cherry.filter(l => l.startsWith('-')).length
    const files = gitLines('diff', '--name-only', `origin/main...${n}`)
    const state = live
      ? `${live} LIVE commit(s)` + (merged ? `, ${merged} already merged` : '')
      : merged ? `leftover — all ${merged} already merged` : 'nothing to merge'
    console.log(`  ${n.replace('origin/', '').padEnd(40)} ${when.padEnd(15)} ${state}`)
    if (live && files.length) {
      // cherry over-reports on a SQUASHED merge: two commits squashed into
      // one produce a patch identical to neither, so both read as absent.
      // The settling question is per FILE — is the branch's version already
      // what main has? All same → merged leftover, whatever cherry thinks.
      // Some different → main may simply have moved past it, so name the
      // files and let a person judge rather than guessing in a summary line.
      const same = [], diff = []
      for (const f of files) {
        const inBranch = sh('git', ['cat-file', '-e', `${n}:${f}`]).status === 0
        if (!inBranch) { diff.push(f); continue }
        ;(sh('git', ['diff', '--quiet', `${n}:${f}`, `origin/main:${f}`]).status === 0 ? same : diff).push(f)
      }
      if (!diff.length) {
        console.log(`      every file identical to main — merged leftover (cherry over-reports a squash)`)
      } else {
        console.log(`      ${same.length} file(s) already identical to main; ${diff.length} differ:`)
        console.log(`        ${diff.slice(0, 6).join(', ')}${diff.length > 6 ? ` (+${diff.length - 6})` : ''}`)
        console.log(`      differ ≠ unmerged: main may have moved past this branch. Check before assuming.`)
      }
    }
  }
  const anyLive = branches.some(([n]) => gitLines('cherry', 'origin/main', n).some(l => l.startsWith('+')))
  if (!anyLive) console.log('\n  No live parallel work. Every branch above is a merged leftover.')
} else console.log('  no other remote branches.')

const gh = sh('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName',
  '--jq', '.[] | "  #\\(.number) \\(.headRefName) — \\(.title)"'])
console.log('')
if (gh.status === 0) {
  console.log(gh.stdout.trim() ? '  open PRs:\n' + gh.stdout.trimEnd() : '  open PRs: none')
} else {
  console.log('  open PRs: could not ask (gh unavailable or unauthenticated)')
}

// ── 6. MERGED vs DEPLOYED ───────────────────────────────────────────────
// Two different questions. main moving is not production moving.
// No hardcoded production URL — a live Vercel alias must not ship in the
// public snapshot. Set OCHR_PROD_URL locally when you want this probe.
console.log(`\n─── merged vs deployed ${'─'.repeat(43)}`)
const PROD = process.env.OCHR_PROD_URL
if (!PROD) {
  console.log('skipped — set OCHR_PROD_URL to compare main against a deployment')
} else {
  try {
    const res = await fetch(`${PROD}/api/health`, { signal: AbortSignal.timeout(12000) })
    const h = await res.json()
    const prodSha = (h.commit_short || h.commit || '').slice(0, 7)
    const known = prodSha && git('cat-file', '-t', prodSha) === 'commit'
    const gap = known ? Number(git('rev-list', '--count', `${prodSha}..origin/main`) ?? 0) : null
    console.log(`production   ${prodSha || '?'}  migration ${h.migration || '?'}  ${h.status}/${h.db}`)
    console.log(`origin/main  ${upstream}  migration head ${remoteHead.replace(/\.js$/, '')}`)
    if (gap === null) console.log('gap          unknown — production is on a commit this clone does not have')
    else if (gap === 0) console.log('gap          none — production is current with main')
    else console.log(`gap          ${gap} commit(s) merged but NOT deployed`)
  } catch (e) {
    console.log(`could not reach ${PROD} — ${e.message}`)
  }
}

// ── 7. verdict + marker ─────────────────────────────────────────────────
console.log('\n' + '─'.repeat(66))
if (behind || collisions.length) {
  console.log('NOT IN SYNC — resolve the above before building on this tree.\n')
} else if (ahead) {
  console.log(`IN SYNC with origin/main, carrying ${ahead} unpushed commit(s).\n`)
} else {
  console.log('IN SYNC — level with origin/main.\n')
}

try { writeFileSync(MARKER, git('rev-parse', 'HEAD') + '\n') } catch { /* advisory only */ }
process.exit(problems ? 1 : 0)
