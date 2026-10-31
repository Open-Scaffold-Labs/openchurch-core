// B-450-1: name-tag HTML must interpolate t(), never print literal "{t('…')}".
import { describe, it, expect } from 'vitest'
import { STRINGS } from '../i18n/strings'
import { buildNameTagHtml } from './Checkin'

function makeT(locale) {
  const dict = STRINGS[locale] ?? STRINGS.en
  return (key, vars) => {
    let s = dict[key] ?? STRINGS.en[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
    return s
  }
}

const TAG = {
  name: 'Ana Pérez',
  kind: 'child',
  code: 'AB12',
  room: 'Nursery',
  eventTitle: 'Sunday Mass',
  eventDate: 'Sun, Oct 28',
}

describe('buildNameTagHtml (B-450-1)', () => {
  it('English: title and pickup label come from t(), never a raw {t(...)} stub', () => {
    const html = buildNameTagHtml(TAG, makeT('en'))
    expect(html).toContain('<title>Name tag</title>')
    expect(html).toContain('Pickup code')
    expect(html).toContain('AB12')
    expect(html).not.toMatch(/\{t\(/)
  })

  it('Spanish: title and pickup label are Spanish, never a raw {t(...)} stub', () => {
    const html = buildNameTagHtml(TAG, makeT('es'))
    expect(html).toContain('<title>Gafete</title>')
    expect(html).toContain('Código de recogida')
    expect(html).not.toContain('Name tag')
    expect(html).not.toContain('Pickup code')
    expect(html).not.toMatch(/\{t\(/)
  })

  it('omits the pickup block when there is no code', () => {
    const html = buildNameTagHtml({ ...TAG, code: null }, makeT('en'))
    expect(html).not.toContain('Pickup code')
    expect(html).not.toContain('class="code"')
    expect(html).not.toContain('class="codelabel"')
  })
})
