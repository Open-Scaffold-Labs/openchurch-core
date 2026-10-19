import { render, screen } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import ClosureReceipt from './ClosureReceipt'
import { STRINGS } from '../i18n/strings'

afterEach(cleanup)
const receipt = { access_revoked: true, live_profile_processed: true, reviews: [
  { kind: 'audit_subject_text', row_count: 2, disposition: 'retained_for_review', note: 'unsafe raw note' },
  { kind: 'unmapped_text', row_count: null, disposition: 'not_measured' },
  { kind: 'backup', row_count: 0, disposition: 'unknown' },
] }
describe('closure receipt truth', () => {
  it.each(['en', 'es'])('%s: distinguishes measured rows from unmeasured copies', locale => {
    const S = STRINGS[locale]
    const t = (key, vars = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll('{'+k+'}', String(v)), S[key])
    render(<ClosureReceipt receipt={receipt} t={t} />)
    expect(screen.getByText(t('team.receipt.count', { n: 2 }))).toBeInTheDocument()
    expect(screen.getAllByText(t('team.receipt.unknownCount'))).toHaveLength(2)
    expect(screen.getByText(t('team.receipt.note.unmapped_text'))).toBeInTheDocument()
    expect(screen.queryByText(t('team.receipt.count', { n: 0 }))).not.toBeInTheDocument()
    expect(screen.queryByText('unsafe raw note')).not.toBeInTheDocument()
    expect(screen.getByText(t('team.closureRemaining'))).toBeInTheDocument()
  })
  it('does not invent a complete detailed receipt', () => {
    render(<ClosureReceipt receipt={{ access_revoked: true }} t={key => STRINGS.en[key]} />)
    expect(screen.getByText(STRINGS.en['team.receipt.notLoaded'])).toBeInTheDocument()
  })
})

