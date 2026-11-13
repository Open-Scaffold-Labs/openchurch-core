// Ports openscaffold-schedule #4 (3da374b) public-manifest-defaults tests
// onto the vendored copy. Unbuilt rails, the unverified fee claim, and the
// dead checkout manifest link must never reappear in the default discovery
// files from buildPublicAgentBookingManifest.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  buildPublicAgentBookingManifest,
  handleInboundAgentCaller,
} = require('../src/lib/openscaffold-schedule/agentBookingEndpoint.js')

const REMOVED = /finix|x_money|apple_pay|stripe_raw_pi|0\.25|per-cover|agent-checkout/

function defaultManifest() {
  return buildPublicAgentBookingManifest({
    orgId: 'org_rest_1',
    tenantSlug: 'bistro-open',
    businessName: 'Bistro Open',
    verticalKey: 'open-restaurant',
    baseUrl: 'https://bistro.openscaffold.app',
  })
}

describe('vendored openscaffold-schedule public manifest defaults', () => {
  it('omits unbuilt rails, fee claims, and agent-checkout from JSON and llms.txt', () => {
    const { wellKnownAgentBookingJson, llmsTxt } = defaultManifest()
    const json = JSON.stringify(wellKnownAgentBookingJson)

    expect(json).not.toMatch(REMOVED)
    expect(llmsTxt).not.toMatch(REMOVED)
    expect(wellKnownAgentBookingJson.payment_rails).toEqual([])
    expect(wellKnownAgentBookingJson.online_payments).toBe('in_testing')
    expect(wellKnownAgentBookingJson.endpoints.agent_checkout).toBeUndefined()
    expect(
      llmsTxt.includes('- Online Payments: in testing (test mode only; no payment rails are live)')
    ).toBe(true)
    expect(llmsTxt.includes('agent-checkout')).toBe(false)
    expect(llmsTxt.includes('checkout manifest')).toBe(false)
  })

  it('omits agent-checkout from the default inbound caller response', () => {
    const out = handleInboundAgentCaller({
      orgId: 'org_rest_1',
      verticalKey: 'open-restaurant',
      callerUserAgent: 'Grok-Bot/0.77',
      endCustomerName: 'Test Guest',
      endCustomerPhone: '+15551112222',
      requestedStartIso: '2026-10-25T19:00:00Z',
      partyOrGuestCount: 4,
    })
    expect(JSON.stringify(out)).not.toMatch(REMOVED)
    expect(out.structured_response.agent_checkout_endpoint).toBeUndefined()
  })

  it('lists rails only when the caller passes them and status is not in_testing', () => {
    const live = buildPublicAgentBookingManifest({
      orgId: 'org_rest_1',
      tenantSlug: 'bistro-open',
      businessName: 'Bistro Open',
      verticalKey: 'open-restaurant',
      baseUrl: 'https://bistro.openscaffold.app',
      supportedPaymentRails: ['example_rail'],
      onlinePaymentsStatus: 'live',
    })
    expect(live.wellKnownAgentBookingJson.payment_rails).toEqual(['example_rail'])
    expect(live.wellKnownAgentBookingJson.online_payments).toBe('live')
    expect(live.llmsTxt.includes('- Payment Rails: example_rail')).toBe(true)
    expect(live.llmsTxt.includes('Online Payments: in testing')).toBe(false)

    const stillTesting = buildPublicAgentBookingManifest({
      orgId: 'org_rest_1',
      tenantSlug: 'bistro-open',
      businessName: 'Bistro Open',
      verticalKey: 'open-restaurant',
      baseUrl: 'https://bistro.openscaffold.app',
      supportedPaymentRails: ['example_rail'],
      onlinePaymentsStatus: 'in_testing',
    })
    expect(stillTesting.wellKnownAgentBookingJson.payment_rails).toEqual(['example_rail'])
    expect(
      stillTesting.llmsTxt.includes(
        '- Online Payments: in testing (test mode only; no payment rails are live)'
      )
    ).toBe(true)
    expect(stillTesting.llmsTxt.includes('example_rail')).toBe(false)
  })
})
