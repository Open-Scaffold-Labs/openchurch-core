// TARS #377 R377-1 (strict checkout boundary) and R377-3 (trusted app
// downloads survive the capture listener; unsafe links stay blocked).
import { describe, it, expect, vi } from 'vitest'
import { validateCheckoutUrl, isTrustedAppDownload } from './awayNavigation.js'
import { bindExternalLinks } from './shell.js'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }))

const PAGE = 'https://parish.example.org/admin/audit'

describe('R377-1: checkout URLs are absolute, non-credentialed http(s) only', () => {
  const rejected = [
    undefined, null, 42, {}, '', ' ', 'not a url', 'mailto:donor@example.test',
    'tel:+15555550100', 'sms:+15555550100', '/billing', '#checkout', '//checkout.example.com/x',
    'checkout.example.com/x', 'javascript:void(0)', 'data:text/html,x', 'blob:https://parish.example.org/1',
    'https://user:pw@checkout.example.com/', ' https://checkout.example.com/', 'https://checkout.example.com/\n',
    'https://check\tout.example.com/', 'https://checkout.example.com/\u0000', 'ftp://checkout.example.com/', 'https:///x',
  ]
  for (const v of rejected) {
    it(`rejects ${JSON.stringify(v)}`, () => { expect(validateCheckoutUrl(v)).toBeNull() })
  }
  it('accepts absolute https and http', () => {
    expect(validateCheckoutUrl('https://checkout.example.com/s/abc')).toBe('https://checkout.example.com/s/abc')
    expect(validateCheckoutUrl('http://checkout.example.com/s/abc')).toBe('http://checkout.example.com/s/abc')
  })
})

function harness() {
  const openSystem = vi.fn()
  const openMail = vi.fn()
  const unbind = bindExternalLinks(document, () => PAGE, openSystem, openMail)
  const click = (attrs) => {
    const a = document.createElement('a')
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v)
    document.body.appendChild(a)
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    a.dispatchEvent(ev)
    a.remove()
    return ev.defaultPrevented
  }
  return { openSystem, openMail, unbind, click }
}

describe('R377-3: app-generated blob downloads are not cancelled', () => {
  it('lets an OrgSettings/Audit style export through the capture listener', () => {
    const h = harness()
    expect(click(h, { href: 'blob:https://parish.example.org/1f2e', download: 'audit-log.csv' })).toBe(false)
    expect(h.openSystem).not.toHaveBeenCalled()
    expect(h.openMail).not.toHaveBeenCalled()
    h.unbind()
  })
  it('still blocks blob without download, foreign-origin blob, data download and script links', () => {
    const h = harness()
    expect(h.click({ href: 'blob:https://parish.example.org/1f2e' })).toBe(true)
    expect(h.click({ href: 'blob:https://evil.example/1f2e', download: 'x.csv' })).toBe(true)
    expect(h.click({ href: 'data:text/csv,a', download: 'x.csv' })).toBe(true)
    expect(h.click({ href: 'javascript:void(0)', download: 'x' })).toBe(true)
    expect(h.openSystem).not.toHaveBeenCalled()
    h.unbind()
  })
  it('helper only trusts same-origin blob with download', () => {
    const a = document.createElement('a')
    a.setAttribute('href', 'blob:null/1'); a.setAttribute('download', 'x')
    expect(isTrustedAppDownload(a, PAGE)).toBe(false)
  })
})

function click(h, attrs) { return h.click(attrs) }
