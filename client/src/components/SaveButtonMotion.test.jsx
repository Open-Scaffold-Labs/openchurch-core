import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { STRINGS } from '../i18n/strings'
import SaveButton from './SaveButton'

vi.mock('../i18n', () => ({
  useLocale: () => ({
    t: (key) => STRINGS.en[key] ?? key,
    locale: 'en',
  }),
}))

describe('SaveButton saved state (V1.4, study #6)', () => {
  it('CONTROL: idle is burgundy', () => {
    render(<SaveButton status="idle">Save</SaveButton>)
    expect(screen.getByRole('button').className).toMatch(/bg-church-900/)
    expect(screen.getByRole('button').className).not.toMatch(/bg-sage-700/)
  })
  it('saved turns sage and is not dimmed like a dead control', () => {
    render(<SaveButton status="saved">Save</SaveButton>)
    const b = screen.getByRole('button')
    expect(b.className).toMatch(/bg-sage-700/)
    expect(b.className).not.toMatch(/disabled:opacity-60/)
    expect(b).toHaveTextContent('Saved')
  })
})
