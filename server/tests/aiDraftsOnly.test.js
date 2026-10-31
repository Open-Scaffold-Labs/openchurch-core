// Drafts-only rule (Landscape pattern #4, José 2026-10-25): the AI never
// messages anyone on its own. Every capability returns a draft to the person
// who asked; a person approves every word before anything leaves the parish.
//
// What this file PROVES (R412-1, narrowed honestly):
//   1. Policy: no capability may declare tools, actions, recipients or a send
//      step, and output is text or json. Enforced by validatePolicy.
//   2. Source (static, regex): in a module that imports ai/gate.js, no single
//      top-level function both calls dispatch() and directly calls one of the
//      NAMED transports below; a module importing both gets a reviewed reason.
// What it does NOT prove: an indirect send (AI text stored, then sent by
// another function or module), a queued send (e.g. a scheduled-notification
// row), or a transport under a name not in OUTBOUND. Those stay a review
// rule, not an enforced boundary. There is no AI-origin tag at the send layer.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPABILITIES, validatePolicy } from '../src/ai/policy.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

describe('policy: every AI capability is drafts-only', () => {
  it('the shipped capabilities declare no send ability', () => {
    for (const [id, c] of Object.entries(CAPABILITIES)) {
      expect(['text', 'json'], id).toContain(c.output?.type)
      for (const k of ['tools', 'actions', 'send', 'autoSend', 'recipients', 'channels']) {
        expect(c[k], `${id}.${k}`).toBeUndefined()
      }
    }
  })

  for (const [k, v] of [['tools', [{ name: 'send_sms' }]], ['autoSend', true], ['actions', ['notify']], ['send', true], ['recipients', ['all']], ['channels', ['sms']]]) {
    it(`validatePolicy rejects a capability that declares ${k}`, () => {
      const bad = { ...CAPABILITIES.parish_message_draft_v1, [k]: v }
      const problems = validatePolicy({ capabilities: { bad } })
      expect(problems.join('\n')).toMatch(/drafts-only/)
    })
  }

  it('validatePolicy rejects an output type other than text or json', () => {
    const bad = { ...CAPABILITIES.parish_message_draft_v1, output: { type: 'message' } }
    expect(validatePolicy({ capabilities: { bad } }).join('\n')).toMatch(/drafts-only/)
  })
})

// ------------------------------------------------------------ source scan --

const OUTBOUND = [/\bsendEmail\s*\(/, /\bnotify\s*\(/, /\bdispatchStub\s*\(/, /\bsendPush\w*\s*\(/, /\bsendSms\w*\s*\(/i]
const GATE_IMPORT = /from\s+['"][./]*\/?(?:\.\.\/)*ai\/gate(?:\.js)?['"]|from\s+['"]\.\/gate(?:\.js)?['"]/

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'migrations' ? [] : walk(p)
    return /\.js$/.test(e.name) && !/\.test\.js$/.test(e.name) ? [p] : []
  })
}

// Top-level function bodies, crude but sufficient: from a `function name(` at
// column 0 (optionally export/async) to the next line that is exactly `}`.
export function functionBodies(src) {
  const out = []
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm
  let m
  while ((m = re.exec(src))) {
    const end = src.indexOf('\n}\n', m.index)
    out.push({ name: m[1], body: src.slice(m.index, end === -1 ? undefined : end) })
  }
  return out
}

// A function that calls the gate may not also call an outbound transport.
export function draftsOnlyViolations(src) {
  return functionBodies(src)
    .filter(f => /\bdispatch\s*\(/.test(f.body) && OUTBOUND.some(r => r.test(f.body)))
    .map(f => f.name)
}

// Modules that import BOTH the gate and a transport, with the reason the
// transport carries only human-written text. Adding one needs review.
const MIXED_ALLOWED = {
  'routes/supportTickets.js':
    'forwardToSupport sends the reporter\'s own description; notifyReporter sends the human resolution_notes. runDiagnostic only writes the ticket row.',
}

describe('source scan: no AI-calling function directly calls a named transport', () => {
  const files = walk(SRC).filter(f => GATE_IMPORT.test(fs.readFileSync(f, 'utf8')))

  it('finds the AI-calling modules (guards against a scan that matches nothing)', () => {
    const rel = files.map(f => path.relative(SRC, f))
    expect(rel).toEqual(expect.arrayContaining(['routes/assistant.js', 'routes/ai.js', 'routes/supportTickets.js']))
  })

  for (const f of walk(SRC)) {
    const src = fs.readFileSync(f, 'utf8')
    if (!GATE_IMPORT.test(src)) continue
    const rel = path.relative(SRC, f)
    it(`${rel}: no function both calls dispatch() and a named transport`, () => {
      expect(draftsOnlyViolations(src)).toEqual([])
    })
    const importsTransport = /from\s+['"][^'"]*(?:email\/send|notifications\/transport|push)[^'"]*['"]/.test(src)
    if (importsTransport) {
      it(`${rel}: mixing the AI gate with a transport is reviewed`, () => {
        expect(MIXED_ALLOWED[rel], `${rel} imports the AI gate and a transport; add a reviewed reason`).toBeTruthy()
      })
    }
  }

  it('supportTickets: the reporter letter never carries the AI diagnosis', () => {
    const src = fs.readFileSync(path.join(SRC, 'routes/supportTickets.js'), 'utf8')
    const nr = functionBodies(src).find(f => f.name === 'notifyReporter')
    expect(nr).toBeTruthy()
    expect(nr.body).not.toMatch(/diagnosis/)
  })

  it('the scanner catches a function that calls dispatch() and notify() directly', () => {
    const mutant = [
      "import { dispatch } from '../ai/gate.js'",
      "import { notify } from '../notifications/transport.js'",
      'export async function autoReply(orgId, to) {',
      "  const { text } = await dispatch({ orgId, capabilityId: 'parish_message_draft_v1' })",
      '  await notify({ recipient: to, vars: { body: text } })',
      '}',
      '',
    ].join('\n')
    expect(draftsOnlyViolations(mutant)).toEqual(['autoReply'])
  })
})

describe('known limit of the scan (R412-1): pinned so the claim stays honest', () => {
  it('does NOT catch an indirect send through a second function', () => {
    const indirect = [
      'async function draft(orgId) {',
      "  const { text } = await dispatch({ orgId, capabilityId: 'parish_message_draft_v1' })",
      '  return text',
      '}',
      'export async function relay(orgId, to) {',
      '  await notify({ recipient: to, vars: { body: await draft(orgId) } })',
      '}',
      '',
    ].join('\n')
    // If this starts returning a name, the scan got stronger: update the
    // header and PR claims rather than deleting this test.
    expect(draftsOnlyViolations(indirect)).toEqual([])
  })
})

describe('assistant tells people it drafts and never sends', () => {
  it('the system prompt states the drafts-only boundary', () => {
    const src = fs.readFileSync(path.join(SRC, 'routes/assistant.js'), 'utf8')
    expect(src).toMatch(/never send, post, text or email anything/i)
  })
})
