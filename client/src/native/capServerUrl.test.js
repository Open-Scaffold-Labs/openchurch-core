import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertIosBuildEnv, resolveCapServer } from './capServerUrl'

const CONFIG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../capacitor.config.json'), 'utf8')

describe('CAP_SERVER_URL', () => {
  it('is optional and becomes the WebView address without a query', () => {
    expect(resolveCapServer(undefined)).toBeNull()
    expect(resolveCapServer('  ')).toBeNull()
    expect(resolveCapServer('http://192.168.1.20:5202/')).toEqual({
      url: 'http://192.168.1.20:5202',
      cleartext: true,
      allowNavigation: ['192.168.1.20'],
    })
    expect(resolveCapServer('https://review.example')).toEqual({
      url: 'https://review.example',
      cleartext: false,
      allowNavigation: ['review.example'],
    })
  })

  it('refuses credentials and does not repeat them', () => {
    expect(() => resolveCapServer('https://user:s3cret@review.example')).toThrow(/must not include a username or password/)
    try {
      resolveCapServer('https://user:s3cret@review.example')
    } catch (error) {
      expect(error.message).not.toContain('s3cret')
      expect(error.message).not.toContain('user:s3cret')
    }
  })

  it('refuses a non-http address and a query', () => {
    expect(() => resolveCapServer('capacitor://localhost')).toThrow(/http or https/)
    expect(() => resolveCapServer('https://review.example/login?x=1')).toThrow(/query or fragment/)
  })

  it('refuses a split API address and a push flag other than 1', () => {
    expect(assertIosBuildEnv({}).server).toBeNull()
    expect(assertIosBuildEnv({ VITE_ENABLE_IOS_PUSH: '1' }).push).toBe(true)
    expect(() => assertIosBuildEnv({ VITE_API_URL: 'https://api.example' })).toThrow(/refuses VITE_API_URL/)
    expect(() => assertIosBuildEnv({ VITE_ENABLE_IOS_PUSH: 'true' })).toThrow(/exactly 1/)
  })

  it('a release build refuses a cleartext http CAP_SERVER_URL', () => {
    // Development may still point the shell at a LAN http address.
    expect(assertIosBuildEnv({ CAP_SERVER_URL: 'http://192.168.1.20:5202' }).server.cleartext).toBe(true)
    let caught
    try {
      assertIosBuildEnv({ CAP_RELEASE: '1', CAP_SERVER_URL: 'http://parish.example' })
    } catch (error) {
      caught = error
    }
    expect(caught?.code).toBe('cap_server_url_release_http')
    expect(caught?.message).toMatch(/release builds must use https/)
    const ok = assertIosBuildEnv({ CAP_RELEASE: '1', CAP_SERVER_URL: 'https://parish.example' })
    expect(ok.release).toBe(true)
    expect(ok.server).toEqual({ url: 'https://parish.example', cleartext: false, allowNavigation: ['parish.example'] })
    expect(assertIosBuildEnv({}).release).toBe(false)
    expect(() => assertIosBuildEnv({ CAP_RELEASE: 'true' })).toThrow(/CAP_RELEASE must be unset or exactly 1/)
  })

  it('the committed shell config has no parish address and no team id', () => {
    const config = JSON.parse(CONFIG)
    expect(config.appId).toBe('com.openscaffoldlabs.openchurch')
    expect(config.server).toEqual({ errorPath: 'offline.html' })
    expect(config.ios.contentInset).toBe('never')
    expect(config.ios.backgroundColor).toBe('#FBF8F2')
    expect(CONFIG).not.toMatch(/DEVELOPMENT_TEAM|BEGIN [A-Z ]*PRIVATE KEY|aps-environment|https?:\/\//)
  })
})
