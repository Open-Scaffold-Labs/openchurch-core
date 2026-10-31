import { describe, expect, it } from 'vitest'
import { assertSystemHttpUrl, classifyAwayNavigation, externalClickDecision } from './awayNavigation'

const PAGE = 'https://parish.example/schedule'

function click(href, extra = {}) {
  return externalClickDecision({
    button: 0,
    target: {
      closest: (sel) => (sel === 'a[href]' ? { getAttribute: () => href } : null),
    },
    ...extra,
  }, PAGE)
}

describe('away navigation', () => {
  it('keeps parish pages in the webview and sends other sites to the system browser', () => {
    expect(classifyAwayNavigation('/bulletin', PAGE)).toMatchObject({ action: 'stay' })
    expect(classifyAwayNavigation('https://parish.example/billing', PAGE)).toMatchObject({ action: 'stay' })
    expect(classifyAwayNavigation('#office', PAGE)).toMatchObject({ action: 'stay' })
    expect(classifyAwayNavigation('https://maps.example/search?q=1', PAGE)).toEqual({
      action: 'system',
      url: 'https://maps.example/search?q=1',
    })
  })

  it('sends mail and phone links to the system handler', () => {
    expect(classifyAwayNavigation('mailto:office@parish.example', PAGE)).toMatchObject({
      action: 'mail',
      url: 'mailto:office@parish.example',
    })
    expect(classifyAwayNavigation('tel:+15551212', PAGE).action).toBe('mail')
  })

  it('refuses script, data, and credentialed addresses', () => {
    const script = ['java', 'script:', 'ale', 'rt(1)'].join('')
    expect(classifyAwayNavigation(script, PAGE).action).toBe('block')
    expect(classifyAwayNavigation('data:text/html,hi', PAGE).action).toBe('block')
    expect(classifyAwayNavigation('https://user:secret@pay.example/c', PAGE).action).toBe('block')
    expect(assertSystemHttpUrl(script)).toBeNull()
    expect(assertSystemHttpUrl('https://user:secret@pay.example/c')).toBeNull()
    expect(assertSystemHttpUrl('https://pay.example/c')).toBe('https://pay.example/c')
  })

  it('a plain click on an outside link leaves the webview; a modified click does not', () => {
    const script = ['java', 'script:', 'ale', 'rt(1)'].join('')
    expect(click('https://pay.example/c')).toMatchObject({ action: 'system', url: 'https://pay.example/c' })
    expect(click('/events').action).toBe('ignore')
    expect(click(script).action).toBe('block')
    expect(click('https://pay.example/c', { metaKey: true }).action).toBe('ignore')
    expect(click('https://pay.example/c', { defaultPrevented: true }).action).toBe('ignore')
    expect(externalClickDecision({ button: 0, target: { closest: () => null } }, PAGE).action).toBe('ignore')
  })
})

describe('TARS #372 finding 1: unsafe or unparseable schemes are blocked, never ignored', () => {
  const page = 'https://parish.example.org/p/st-test/give'
  const unsafe = [
    'JaVaScRiPt:void(0)',
    '  javascript:void(0)',
    'java\tscript:void(0)',
    'java\nscript:void(0)',
    '\u0001javascript:void(0)',
    'javascript\u0000:void(0)',
    'jav&#x09;ascript:void(0)',
    'vbscript:msgbox(1)',
    'DATA:text/html,<b>x</b>',
    'blob:https://parish.example.org/1',
    'file:///etc/passwd',
    'intent://x#Intent;end',
    'http://[::1',
    'https://user:pw@evil.example',
  ]
  for (const href of unsafe) {
    it(`blocks ${JSON.stringify(href)}`, () => {
      const d = classifyAwayNavigation(href, page)
      expect(d.action === 'block' || d.action === 'stay').toBe(true)
      expect(d.action).not.toBe('ignore')
      if (d.action === 'stay') expect(new URL(d.url).origin).toBe('https://parish.example.org')
    })
  }
  it('blocks script schemes outright, including obfuscated ones', () => {
    for (const href of ['JaVaScRiPt:x', 'java\tscript:x', '\u0001javascript:x', ' vbscript:x', 'file:///x']) {
      expect(classifyAwayNavigation(href, page).action).toBe('block')
    }
  })
  it('blocks non-string and unparseable input', () => {
    expect(classifyAwayNavigation(undefined, page).action).toBe('block')
    expect(classifyAwayNavigation('http://[::1', page).action).toBe('block')
    expect(classifyAwayNavigation('https://x.example', 'not a url').action).toBe('block')
  })
  it('the click decision prevents default for a blocked link', () => {
    const a = document.createElement('a')
    a.setAttribute('href', 'java\tscript:void(0)')
    const d = externalClickDecision({ button: 0, target: a }, page)
    expect(d.action).toBe('block')
  })
})
