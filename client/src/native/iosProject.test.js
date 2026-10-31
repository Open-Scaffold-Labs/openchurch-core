import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const IOS = join(dirname(fileURLToPath(import.meta.url)), '../../ios')
const pbx = readFileSync(join(IOS, 'App/App.xcodeproj/project.pbxproj'), 'utf8')
const plist = readFileSync(join(IOS, 'App/App/Info.plist'), 'utf8')
const gitignore = readFileSync(join(IOS, '.gitignore'), 'utf8')
const template = readFileSync(join(IOS, 'PushNotifications.entitlements.template'), 'utf8')
const appDelegate = readFileSync(join(IOS, 'App/App/AppDelegate.swift'), 'utf8')

describe('iOS project signing stays a placeholder', () => {
  it('has no team id, no push entitlement on the target, and no arbitrary cleartext', () => {
    expect(pbx).not.toMatch(/DEVELOPMENT_TEAM\s*=\s*[A-Z0-9]/)
    expect(pbx).not.toMatch(/CODE_SIGN_ENTITLEMENTS/)
    expect(pbx).not.toMatch(/aps-environment/)
    expect(pbx).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.openscaffoldlabs.openchurch')
    expect(pbx).toContain('release.xcconfig')
    expect(plist).not.toMatch(/NSAllowsArbitraryLoads/)
    expect(plist).toContain('<key>NSAllowsLocalNetworking</key>')
    expect(plist).toContain('UIStatusBarStyleDarkContent')
  })

  it('forwards remote registration to Capacitor without keeping the token', () => {
    expect(appDelegate).toContain('didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data')
    expect(appDelegate).toContain('didFailToRegisterForRemoteNotificationsWithError error: Error')
    expect(appDelegate).toContain('NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)')
    expect(appDelegate).toContain('NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)')
    expect(appDelegate).not.toMatch(/print\s*\(|NSLog\s*\(|Logger\s*\(|os_log\s*\(|UserDefaults/)
    expect(pbx).not.toMatch(/CODE_SIGN_ENTITLEMENTS/)
    expect(pbx).not.toContain('PushNotifications.entitlements')
  })

  it('keeps the push entitlement unwired and the team file uncommitted', () => {
    expect(template).toContain('<string>development</string>')
    expect(pbx).not.toContain('PushNotifications.entitlements')
    expect(gitignore).toContain('Local.xcconfig')
    expect(gitignore).toContain('App/App/capacitor.config.json')
    expect(gitignore).toContain('App/App/public')
  })
})
