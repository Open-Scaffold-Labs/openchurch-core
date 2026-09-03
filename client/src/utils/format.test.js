// mutate() — the helper that decides whether a write is allowed to look
// successful.
//
// The defect it replaced was `await fetch(url, {method:'DELETE'})` followed by
// a refetch: a 403 from the write gate was discarded, the list reloaded with
// the row still in it, and the person was left believing a destructive action
// had happened. Tasks even said "This cannot be undone" first.
//
// So the assertions below are mostly about the failure paths. The success path
// was never the part that lied.

import { describe, it, expect, vi } from 'vitest'
import { mutate, loadOne } from './format'

const respond = (status, body) => vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError('Unexpected end of JSON input')
    return body
  },
})))

describe('mutate', () => {
  it('REPORTS SUCCESS ONLY WHEN THE SERVER SAID SO', async () => {
    respond(200, { id: 7 })
    const r = await mutate('/api/things/7', { method: 'DELETE' })
    expect(r).toEqual({ ok: true, data: { id: 7 }, error: null })
  })

  it('SURVIVES A 204 WITH NO BODY', async () => {
    // A successful DELETE frequently returns no content. Treating an
    // unparseable empty body as failure would make every correct delete look
    // broken — the opposite defect, equally bad.
    respond(204, undefined)
    const r = await mutate('/api/things/7', { method: 'DELETE' })
    expect(r.ok).toBe(true)
    expect(r.error).toBeNull()
  })

  it('DOES NOT REPORT SUCCESS ON A 403 — THE ORIGINAL DEFECT', async () => {
    // A viewer pressing delete. The old code discarded this entirely.
    respond(403, { error: 'Viewers cannot delete events.' })
    const r = await mutate('/api/events/3', { method: 'DELETE' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Viewers cannot delete events.')
  })

  it('PREFERS THE SERVER MESSAGE, FALLS BACK TO THE STATUS', async () => {
    // The server knows more than we do. When it says nothing, the status code
    // still has to reach the person — "that didn't go through" with no number
    // is not something a support ticket can act on.
    respond(500, undefined)
    const r = await mutate('/api/tasks/9', { method: 'DELETE' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/500/)
  })

  it('TREATS A NETWORK FAILURE AS A VALUE, NOT AN EXCEPTION', async () => {
    // A caller that has to remember try/catch is a caller that will forget.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const r = await mutate('/api/tasks/9', { method: 'DELETE' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Nothing was changed/i)
  })

  it('SENDS JSON ONLY WHEN THERE IS A BODY', async () => {
    // A DELETE with Content-Type: application/json and no body is the kind of
    // thing that works everywhere until it meets a strict proxy.
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    vi.stubGlobal('fetch', f)

    await mutate('/api/tasks/1', { method: 'DELETE' })
    expect(f.mock.calls[0][1].headers).toBeUndefined()
    expect(f.mock.calls[0][1].body).toBeUndefined()

    await mutate('/api/tasks/1/status', { method: 'PATCH', body: { status: 'done' } })
    expect(f.mock.calls[1][1].headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ status: 'done' })
  })
})

// ---------------------------------------------------------------------------
// loadOne shape validation.
//
// WHAT EXACT DEFECT THESE DETECT: loadOne returning ok:true for a 200 whose
// body is not the object shape the caller reads fields from.
//
// Observed 27 Aug at runtime: /api/tasks/stats answered 200 with an array.
// loadOne accepted it, `stats` became [] (truthy), parseInt(stats.completed)
// was NaN, and the Daily Tasks page rendered "NaN" progress to the parish
// with no warning. A confident wrong number is worse than a visible failure.
// ---------------------------------------------------------------------------

describe('loadOne shape validation', () => {
  const okJson = (body, type = 'application/json') =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': type } }))

  it('accepts a plain object', async () => {
    global.fetch = okJson({ total: 3, completed: 1 })
    const r = await loadOne('/x')
    expect(r.ok).toBe(true)
    expect(r.data.total).toBe(3)
  })

  it('REFUSES an array — the shape that produced NaN', async () => {
    global.fetch = okJson([])
    const r = await loadOne('/x')
    expect(r.ok).toBe(false)
    expect(r.data).toBe(null)
  })

  it('REFUSES null', async () => {
    global.fetch = okJson(null)
    const r = await loadOne('/x')
    expect(r.ok).toBe(false)
  })

  it('REFUSES a scalar', async () => {
    global.fetch = okJson(7)
    const r = await loadOne('/x')
    expect(r.ok).toBe(false)
  })

  it('returns the caller fallback when it refuses', async () => {
    global.fetch = okJson([])
    const r = await loadOne('/x', { total: 0 })
    expect(r.ok).toBe(false)
    expect(r.data).toEqual({ total: 0 })
  })

  it('a caller may opt into another shape', async () => {
    global.fetch = okJson([1, 2])
    const r = await loadOne('/x', [], Array.isArray)
    expect(r.ok).toBe(true)
    expect(r.data).toEqual([1, 2])
  })
})
