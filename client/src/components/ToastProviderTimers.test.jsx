// CI flake (main run 39319821005): an auto-dismiss setTimeout outlived its
// ToastProvider and fired after jsdom teardown ("window is not defined").
// The provider now clears pending dismiss timers on unmount.
import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocaleProvider } from '../i18n'
import { ToastProvider, useToast } from './ToastProvider'

// Exit animation off, so removal is synchronous and only the dismiss timer matters.
vi.mock('framer-motion', async () => {
  const React = await import('react')
  const strip = ({ initial, animate, exit, transition, layout, ...rest }) => rest
  const motion = new Proxy({}, { get: (_, tag) => React.forwardRef((p, ref) => React.createElement(tag, { ...strip(p), ref })) })
  return { motion, AnimatePresence: ({ children }) => children }
})

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, loading: false, canWrite: false, isAdmin: false }),
}))

function Fire() {
  const toast = useToast()
  return <button type="button" onClick={() => toast.success('Saved toast')}>notify</button>
}
const mount = () => render(<LocaleProvider><ToastProvider><Fire /></ToastProvider></LocaleProvider>)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ToastProvider auto-dismiss timers', () => {
  it('control: still auto-dismisses after 4s while mounted', () => {
    mount()
    fireEvent.click(screen.getByText('notify'))
    expect(screen.getByText('Saved toast')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByText('Saved toast')).not.toBeInTheDocument()
  })

  it('clears pending dismiss timers on unmount', () => {
    const { unmount } = mount()
    fireEvent.click(screen.getByText('notify'))
    const spy = vi.spyOn(globalThis, 'clearTimeout')
    unmount()
    const cleared = spy.mock.calls.length
    spy.mockRestore()
    expect(cleared).toBeGreaterThan(0)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    act(() => { vi.advanceTimersByTime(10000) })
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
