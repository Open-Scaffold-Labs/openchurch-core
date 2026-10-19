// Both of these rules were written because a real browser did the wrong thing,
// and both were pinned by mutation there. These tests exist so CI watches them
// too — a browser probe on one Mac is not a gate.
//
// Each block names the parish consequence, not the mechanism, because that is
// what a future change has to keep true.
import { describe, it, expect } from 'vitest'
import { createCachePolicy } from './swPolicy.js'

const CACHED = { body: 'yesterday' }
const serve = policy => policy.onlyWhenOffline.cachedResponseWillBeUsed({ cachedResponse: CACHED })

describe('connectivity — a cached answer may be served only while offline', () => {
  it('serves the cache when the worker says the browser is offline', async () => {
    const p = createCachePolicy(() => false)
    expect(await serve(p)).toBe(CACHED)
  })

  it('refuses the cache when the worker says the browser is online', async () => {
    const p = createCachePolicy(() => true)
    expect(await serve(p)).toBeNull()
  })

  it('THE DEFECT: a stale page flag cannot override a worker that knows it is online', async () => {
    // An earlier offline blip, an unloaded tab, or a client that never sent an
    // update leaves pageOnline=false behind. Before the fix this OR-ed with the
    // worker's own signal and served a 24h-old ledger during a genuine network
    // error, with no offline banner on screen.
    const p = createCachePolicy(() => true)
    p.setPageOnline(false)
    expect(await serve(p)).toBeNull()
  })

  it('the page flag still decides when the worker has no signal of its own', async () => {
    const p = createCachePolicy(() => undefined)
    expect(await serve(p)).toBeNull()   // unknown is not offline
    p.setPageOnline(false)
    expect(await serve(p)).toBe(CACHED)
    p.setPageOnline(true)
    expect(await serve(p)).toBeNull()
  })

  it('the startup window: no page has spoken yet, and nothing stale is served', async () => {
    const p = createCachePolicy(() => true)
    expect(await serve(p)).toBeNull()
  })
})

describe('cache generation — a logout ends the generation its requests belong to', () => {
  const issue = async (policy) => {
    const state = {}
    await policy.generationGuard.requestWillFetch({ request: 'REQ', state })
    return state
  }
  const land = (policy, state, response = 'RESP') =>
    policy.generationGuard.cacheWillUpdate({ response, state })

  it('a response landing in its own generation is cached', async () => {
    const p = createCachePolicy(() => true)
    const state = await issue(p)
    expect(await land(p, state)).toBe('RESP')
  })

  it('THE DEFECT: a response issued before a logout cannot be cached after it', async () => {
    // Parish A's roster held open, logout purge fires, the late response lands
    // and re-creates the cache the purge just emptied. Parish B then signs in
    // on the same machine, goes offline, and is shown parish A's members.
    const p = createCachePolicy(() => true)
    const inFlight = await issue(p)
    p.endGeneration()
    expect(await land(p, inFlight)).toBeNull()
  })

  it('requests issued after the logout cache normally again', async () => {
    const p = createCachePolicy(() => true)
    p.endGeneration()
    const state = await issue(p)
    expect(await land(p, state)).toBe('RESP')
  })

  it('concurrent requests are judged independently, not as a batch', async () => {
    const p = createCachePolicy(() => true)
    const before = await issue(p)
    p.endGeneration()
    const after = await issue(p)
    expect(await land(p, before)).toBeNull()
    expect(await land(p, after)).toBe('RESP')
  })

  it('requestWillFetch passes the request through untouched', async () => {
    const p = createCachePolicy(() => true)
    expect(await p.generationGuard.requestWillFetch({ request: 'REQ', state: {} })).toBe('REQ')
  })
})
