import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import UserAvatar from './UserAvatar'

describe('UserAvatar Quiet Craft 5', () => {
  it('shows person initials when a name is present', () => {
    render(<UserAvatar name="Maria Ruiz" />)
    expect(screen.getByText('MR')).toBeInTheDocument()
  })

  it('does not fall back to the product initials OC when the name is empty', () => {
    const { container } = render(<UserAvatar name="" />)
    expect(container.textContent).not.toContain('OC')
    // Quiet placeholder while the form is still blank
    expect(container.textContent).toContain('·')
  })
})
