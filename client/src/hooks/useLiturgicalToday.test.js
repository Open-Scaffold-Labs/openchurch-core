import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useLiturgicalToday } from './useLiturgicalToday'

// A failed liturgical read must not be remembered as the answer for the
// day. The module cache is shared across mounts, so before this fix one
// network blip hid the Dashboard's liturgical card until a full reload.
describe('useLiturgicalToday', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('reports a failed read as an error, then retries on the next mount', async () => {
    const day = { color: 'green', celebration: 'Ordinary Time' }
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => day })
    vi.stubGlobal('fetch', fetchMock)

    const first = renderHook(() => useLiturgicalToday())
    await waitFor(() => expect(first.result.current.error).toBe(true))
    expect(first.result.current.data).toBeNull()
    first.unmount()

    const second = renderHook(() => useLiturgicalToday())
    await waitFor(() => expect(second.result.current.data).toEqual(day))
    expect(second.result.current.error).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a non-200 reply as an error and does not cache it', async () => {
    vi.resetModules()
    const { useLiturgicalToday: fresh } = await import('./useLiturgicalToday')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ color: 'white' }) })
    vi.stubGlobal('fetch', fetchMock)

    const a = renderHook(() => fresh())
    await waitFor(() => expect(a.result.current.error).toBe(true))
    a.unmount()
    const b = renderHook(() => fresh())
    await waitFor(() => expect(b.result.current.data).toEqual({ color: 'white' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
