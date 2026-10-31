import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // Dialog scroll-locks and page-title effects can leak across files in a
  // shared jsdom worker and flake focus / document.title assertions.
  document.body.style.overflow = ''
  document.title = ''
})
