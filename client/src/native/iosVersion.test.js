import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildNumber, marketingVersion, versionXcconfig } from './iosVersion.js'

const clientRoot = join(__dirname, '..', '..')
const read = (p) => readFileSync(join(clientRoot, p), 'utf8')

describe('iOS version stamping', () => {
  it('uses package.json semver as MARKETING_VERSION', () => {
    expect(marketingVersion('1.2.3')).toBe('1.2.3')
    expect(() => marketingVersion('1.0')).toThrow(/semver/)
    expect(() => marketingVersion('1.0.0-beta')).toThrow(/semver/)
    expect(() => marketingVersion(undefined)).toThrow(/semver/)
  })

  it('defaults the build number to 1 and reads OC_IOS_BUILD_NUMBER', () => {
    expect(buildNumber({})).toBe('1')
    expect(buildNumber({ OC_IOS_BUILD_NUMBER: '' })).toBe('1')
    expect(buildNumber({ OC_IOS_BUILD_NUMBER: '202610231530' })).toBe('202610231530')
    for (const bad of ['0', '-3', '1.2', 'abc', '01']) {
      expect(() => buildNumber({ OC_IOS_BUILD_NUMBER: bad })).toThrow(/positive integer/)
    }
  })

  it('renders the xcconfig', () => {
    const out = versionXcconfig('1.0.0', { OC_IOS_BUILD_NUMBER: '42' })
    expect(out).toContain('MARKETING_VERSION = 1.0.0\n')
    expect(out).toContain('CURRENT_PROJECT_VERSION = 42\n')
  })

  it('committed Version.xcconfig matches package.json with dev build 1', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(read('ios/Version.xcconfig')).toBe(versionXcconfig(pkg.version, {}))
  })

  it('debug and release xcconfigs include Version.xcconfig', () => {
    for (const f of ['ios/debug.xcconfig', 'ios/release.xcconfig']) {
      expect(read(f)).toMatch(/^#include "Version\.xcconfig"$/m)
    }
  })

  it('project.pbxproj carries no version literals that would override the xcconfig', () => {
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj')
    expect(pbx).not.toMatch(/MARKETING_VERSION\s*=/)
    expect(pbx).not.toMatch(/CURRENT_PROJECT_VERSION\s*=/)
    const plist = read('ios/App/App/Info.plist')
    expect(plist).toContain('$(MARKETING_VERSION)')
    expect(plist).toContain('$(CURRENT_PROJECT_VERSION)')
  })

  it('ios-sync writes Version.xcconfig', () => {
    const sync = read('scripts/ios-sync.mjs')
    expect(sync).toContain('versionXcconfig')
    expect(sync).toContain("'Version.xcconfig'")
  })
})
