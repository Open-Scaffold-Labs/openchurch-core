import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(HERE, rel), 'utf8')

describe('iOS review surface contracts', () => {
  it('ships a privacy manifest on the app target and does not declare tracking', () => {
    const privacy = read('../../ios/App/App/PrivacyInfo.xcprivacy')
    const pbx = read('../../ios/App/App.xcodeproj/project.pbxproj')
    expect(privacy).toContain('<key>NSPrivacyTracking</key>')
    expect(privacy).toContain('<false/>')
    expect(privacy).toContain('<key>NSPrivacyTrackingDomains</key>')
    expect(privacy).toContain('<key>NSPrivacyCollectedDataTypes</key>')
    expect(privacy).not.toContain('<key>NSPrivacyCollectedDataType</key>')
    expect(privacy).not.toContain('<key>NSPrivacyAccessedAPIType</key>')
    // TARS #372 finding 3: no empty required-reason key in the app manifest.
    expect(privacy).not.toContain('NSPrivacyAccessedAPITypes')
    expect(pbx).toContain('PrivacyInfo.xcprivacy in Resources')
  })

  it('names the camera use and does not add a tracking prompt', () => {
    const plist = read('../../ios/App/App/Info.plist')
    expect(plist).toContain('<key>NSCameraUsageDescription</key>')
    expect(plist).toContain('photograph a profile picture')
    expect(plist).not.toContain('NSUserTrackingUsageDescription')
    expect(plist).toContain('<key>ITSAppUsesNonExemptEncryption</key>')
    expect(plist).toContain('<false/>')
  })

  it('keeps the load-failure page, native keyboard resize, and the browser plugin', () => {
    const config = read('../../capacitor.config.json')
    const pkg = read('../../ios/App/CapApp-SPM/Package.swift')
    const css = read('../index.css')
    const shell = read('./shell.js')
    expect(config).toContain('"errorPath": "offline.html"')
    expect(config).toContain('"resize": "native"')
    // TARS #372 finding 3: resizeOnFullScreen is Android-only; not claimed for iOS.
    expect(config).not.toContain('resizeOnFullScreen')
    expect(read('../../../docs/IOS-BUILD.md')).not.toContain('resizeOnFullScreen')
    expect(pkg).toContain('CapacitorBrowser')
    expect(css).toContain('html.native-shell')
    expect(css).toContain('overscroll-behavior: none')
    expect(shell).toContain("classList.add('native-shell')")
    expect(shell).toContain('keyboardWillShow')
    expect(shell).toContain('bindExternalLinks')
  })

  it('keeps the existing close-login path and the public contact page', () => {
    const prefs = read('../pages/Preferences.jsx')
    const app = read('../App.jsx')
    const login = read('../pages/Login.jsx')
    const signup = read('../pages/Signup.jsx')
    expect(prefs).toContain('<CloseLoginCard />')
    expect(prefs).toContain("apiUrl('/api/auth/close')")
    expect(app).toContain('path="/contact"')
    expect(app).toContain('path="/preferences"')
    expect(login).not.toMatch(/appleid|Sign in with Apple|GoogleOAuth/i)
    expect(signup).not.toMatch(/appleid|Sign in with Apple|GoogleOAuth/i)
  })
})
