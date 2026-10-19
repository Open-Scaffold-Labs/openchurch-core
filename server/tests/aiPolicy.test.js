// The AI policy is config, and config that is only read at runtime is config
// nobody checks. These tests are the standing check: they assert the rules
// OSL AI's contract states, against the policy we actually ship.
//
// Each block states the rule first, then attacks it with a policy that breaks
// it — because a test that only asserts the good case keeps passing when the
// rule is deleted.

import { describe, it, expect } from 'vitest'
import { ROUTES, CAPABILITIES, POLICY_VERSION, validatePolicy } from '../src/ai/policy.js'

describe('the shipped AI policy', () => {
  it('is internally consistent', () => {
    expect(validatePolicy()).toEqual([])
  })

  it('names a policy version, because the contract records one on every result', () => {
    expect(POLICY_VERSION).toBeTruthy()
  })

  it('points every capability at a route that exists', () => {
    for (const [id, c] of Object.entries(CAPABILITIES)) {
      expect(ROUTES[c.routeId], `${id} → ${c.routeId}`).toBeTruthy()
    }
  })
})

describe('no capability can reach restricted data', () => {
  // A diocese is billed from the assessable base. Nothing that drafts prose
  // may read the rows that figure comes from, and the boundary is worth
  // pinning rather than remembering.
  it('every capability is public or internal only', () => {
    for (const [id, c] of Object.entries(CAPABILITIES)) {
      expect(c.allowedDataClasses, `${id}`).not.toContain('restricted')
    }
  })

  it('no commercial route accepts restricted data either', () => {
    for (const [id, r] of Object.entries(ROUTES)) {
      if (r.deployment === 'commercial') {
        expect(r.allowedDataClasses, `${id}`).not.toContain('restricted')
      }
    }
  })

  it('ATTACK: a capability permitting data its route refuses is caught', () => {
    const problems = validatePolicy({
      routes: { r: { ...ROUTES['anthropic-managed'], allowedDataClasses: ['public'] } },
      capabilities: {
        bad: { ...CAPABILITIES.parish_message_draft_v1, routeId: 'r', allowedDataClasses: ['internal'] },
      },
    })
    expect(problems.join('\n')).toMatch(/allows internal but route r does not/)
  })
})

describe('the chancery capability cannot speak about money', () => {
  const chancery = CAPABILITIES.chancery_message_draft_v1

  it('exists and drafts only', () => {
    expect(chancery.output.type).toBe('text')
    expect(chancery.validateResult).toBeUndefined()
  })

  it('forbids stating an assessment figure, a balance, or a submission status', () => {
    expect(chancery.systemPrompt).toMatch(/never state or imply an assessment figure/i)
    expect(chancery.systemPrompt).toMatch(/balance owed/i)
    expect(chancery.systemPrompt).toMatch(/submission status/i)
  })

  it('is internal-only, like every other drafting capability', () => {
    expect(chancery.allowedDataClasses).toEqual(['internal'])
  })
})

describe('drafting never claims accuracy', () => {
  // The contract: no validation callback implies no claim of semantic
  // accuracy or verified citations. Every capability we ship is creative
  // drafting, so none of them may quietly grow a validator without also
  // growing the schema and human-commit story that belongs with one.
  it('no capability declares a semantic validator', () => {
    for (const [id, c] of Object.entries(CAPABILITIES)) {
      expect(c.validateResult, `${id}`).toBeUndefined()
    }
  })

  it('every capability returns text, not structured claims', () => {
    for (const [id, c] of Object.entries(CAPABILITIES)) {
      expect(c.output.type, `${id}`).toBe('text')
    }
  })

  it('ATTACK: json output with no schema is caught', () => {
    const problems = validatePolicy({
      capabilities: {
        bad: { ...CAPABILITIES.parish_message_draft_v1, output: { type: 'json' } },
      },
    })
    expect(problems.join('\n')).toMatch(/json output with no schema/)
  })
})

describe('routes are approved destinations, not suggestions', () => {
  it('every route is https', () => {
    for (const [id, r] of Object.entries(ROUTES)) {
      expect(r.baseUrl.startsWith('https://'), `${id}`).toBe(true)
    }
  })

  it('every route pins an exact model', () => {
    for (const [id, r] of Object.entries(ROUTES)) {
      expect(r.model, `${id}`).toBeTruthy()
    }
  })

  it('ATTACK: a plaintext endpoint is caught', () => {
    const problems = validatePolicy({
      routes: { r: { ...ROUTES['anthropic-managed'], baseUrl: 'http://api.anthropic.com' } },
      capabilities: {},
    })
    expect(problems.join('\n')).toMatch(/is not https/)
  })

  it('ATTACK: a credential-free commercial route is caught', () => {
    const problems = validatePolicy({
      routes: { r: { ...ROUTES['anthropic-managed'], credentialMode: 'none' } },
      capabilities: {},
    })
    expect(problems.join('\n')).toMatch(/credential-free commercial route/)
  })

  it('ATTACK: a commercial route accepting restricted data is caught', () => {
    const problems = validatePolicy({
      routes: {
        r: { ...ROUTES['anthropic-managed'], allowedDataClasses: ['internal', 'restricted'] },
      },
      capabilities: {},
    })
    expect(problems.join('\n')).toMatch(/commercial deployment accepts restricted data/)
  })
})

describe('there is no cross-provider fallback', () => {
  // Removing it was Dale's decision on 2026-09-08. The shape that enforces it
  // is one route per capability — there is nowhere for a second provider to
  // be named, and a test that says so keeps it that way.
  it('a capability names exactly one route', () => {
    for (const [id, c] of Object.entries(CAPABILITIES)) {
      expect(typeof c.routeId, `${id}`).toBe('string')
      expect(Array.isArray(c.routeId), `${id}`).toBe(false)
    }
  })

  it('the platform funds Anthropic only; OpenAI is reachable only with an org key', () => {
    for (const [id, r] of Object.entries(ROUTES)) {
      if (r.credentialMode === 'managed') {
        expect(r.provider, `${id} is managed`).toBe('anthropic')
      }
    }
    expect(ROUTES['openai-byok'].credentialMode).toBe('byok')
  })
})

describe('budgets can actually stop a call', () => {
  it('every capability reserves a positive whole number of microdollars', () => {
    for (const [id, c] of Object.entries(CAPABILITIES)) {
      expect(Number.isInteger(c.reservationUsd), `${id} is an integer`).toBe(true)
      expect(c.reservationUsd, `${id} is positive`).toBeGreaterThan(0)
    }
  })

  it('every capability bounds input, output and time', () => {
    for (const [id, c] of Object.entries(CAPABILITIES)) {
      expect(c.maxInputBytes, `${id}`).toBeGreaterThan(0)
      expect(c.maxOutputTokens, `${id}`).toBeGreaterThan(0)
      expect(c.timeoutMs, `${id}`).toBeGreaterThan(0)
    }
  })

  it('ATTACK: a zero reservation is caught', () => {
    const problems = validatePolicy({
      capabilities: { bad: { ...CAPABILITIES.parish_message_draft_v1, reservationUsd: 0 } },
    })
    expect(problems.join('\n')).toMatch(/reservationUsd must be a positive whole number/)
  })

  it('ATTACK: an anonymous capability on the platform bill is caught', () => {
    const problems = validatePolicy({
      capabilities: { bad: { ...CAPABILITIES.parish_message_draft_v1, allowAnonymous: true } },
    })
    expect(problems.join('\n')).toMatch(/anonymous access to a managed-credential route/)
  })
})

describe('the five parish capabilities match what is shipped today', () => {
  // routes/ai.js exposes /enhance plus four generate types. If one is added
  // there without a capability here, the swap in phase 5 silently loses it.
  it('covers enhance and all four generate types', () => {
    for (const id of [
      'parish_text_enhance_v1',
      'parish_sermon_draft_v1',
      'parish_message_draft_v1',
      'parish_devotional_draft_v1',
      'parish_announcement_draft_v1',
    ]) {
      expect(CAPABILITIES[id], id).toBeTruthy()
    }
  })

  it('keeps the sermon ceiling that routes/ai.js already uses', () => {
    expect(CAPABILITIES.parish_sermon_draft_v1.maxOutputTokens).toBe(1500)
  })
})
