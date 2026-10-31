import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DIALOG_TITLE_CLS, DialogFooter } from './DialogChrome'

describe('DialogChrome', () => {
  it('exports a serif dialog title class', () => {
    expect(DIALOG_TITLE_CLS).toMatch(/font-display/)
    expect(DIALOG_TITLE_CLS).toMatch(/text-2xl/)
  })

  it('puts Cancel as a text button and the primary action on the right', () => {
    const onCancel = vi.fn()
    const onPrimary = vi.fn()
    render(
      <DialogFooter
        cancelLabel="Cancel"
        onCancel={onCancel}
        primaryLabel="Save"
        onPrimary={onPrimary}
      />,
    )
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const save = screen.getByRole('button', { name: 'Save' })
    expect(cancel.className).not.toMatch(/border/)
    expect(cancel.className).toMatch(/text-sm/)
    fireEvent.click(cancel)
    expect(onCancel).toHaveBeenCalled()
    fireEvent.click(save)
    expect(onPrimary).toHaveBeenCalled()
  })
})
