import { describe, it, expect } from 'vitest'
import { formatMailingAddress, hasMailingAddress } from './memberAddress'

describe('formatMailingAddress (SP-264)', () => {
  it('returns null when empty', () => {
    expect(formatMailingAddress(null)).toBeNull()
    expect(formatMailingAddress({})).toBeNull()
    expect(hasMailingAddress({ mailing_address_line1: '  ' })).toBe(false)
  })
  it('joins line1/line2/city state ZIP', () => {
    expect(formatMailingAddress({
      mailing_address_line1: '100 Parish Rd',
      mailing_address_line2: 'Suite 2',
      mailing_city: 'San Jose',
      mailing_state: 'CA',
      mailing_postal: '95112',
    })).toBe('100 Parish Rd\nSuite 2\nSan Jose, CA 95112')
  })
  it('omits blank parts', () => {
    expect(formatMailingAddress({
      mailing_address_line1: '100 Parish Rd',
      mailing_city: 'San Jose',
      mailing_postal: '95112',
    })).toBe('100 Parish Rd\nSan Jose 95112')
  })
})
