// Native chrome for the Capacitor shell. No-op unless the bridge says
// this page is inside the iOS app. Plugins are imported only on that
// path so a web build that never calls this file does not ship them.

import { Capacitor } from '@capacitor/core'
import { externalClickDecision } from './awayNavigation.js'
import { keyboardLiftTarget } from './keyboardField.js'

function parchmentStatusStyle(Style, dark) {
  // Capacitor names these for the background, not the icon.
  // Style.Light = dark icons on a light bar. Style.Dark = light icons.
  return dark ? Style.Dark : Style.Light
}

async function applyStatusBar() {
  const { StatusBar, Style } = await import('@capacitor/status-bar')
  const dark = document.documentElement.classList.contains('dark')
  await StatusBar.setStyle({ style: parchmentStatusStyle(Style, dark) })
  await StatusBar.setOverlaysWebView({ overlay: true })
}

export function bindExternalLinks(doc, pageHref, openSystem, openMail) {
  const onClick = (event) => {
    const decision = externalClickDecision(event, pageHref())
    if (decision.action === 'system') {
      event.preventDefault()
      Promise.resolve(openSystem(decision.url)).catch((error) => {
        console.warn('[native] external page did not open', error?.name || 'error')
      })
      return
    }
    if (decision.action === 'mail') {
      event.preventDefault()
      openMail(decision.url)
      return
    }
    if (decision.action === 'block') event.preventDefault()
  }
  doc.addEventListener('click', onClick, true)
  return () => doc.removeEventListener('click', onClick, true)
}

async function openSystem(url) {
  const { openSystemBrowser } = await import('./systemBrowser.js')
  await openSystemBrowser(url)
}

function openMail(url) {
  window.location.assign(url)
}

async function installKeyboardLift() {
  const { Keyboard } = await import('@capacitor/keyboard')
  await Keyboard.addListener('keyboardWillShow', () => {
    const field = keyboardLiftTarget(document.activeElement)
    field?.scrollIntoView({ block: 'center', inline: 'nearest' })
  })
}

export async function initNativeShell() {
  if (!Capacitor.isNativePlatform()) return

  document.documentElement.classList.add('native-shell')
  bindExternalLinks(document, () => window.location.href, openSystem, openMail)

  try {
    await applyStatusBar()
    const observer = new MutationObserver(() => {
      applyStatusBar().catch((error) => {
        console.warn('[native] status bar was not updated', error?.name || 'error')
      })
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  } catch (error) {
    console.warn('[native] status bar was not set', error?.name || 'error')
  }

  try {
    await installKeyboardLift()
  } catch (error) {
    console.warn('[native] keyboard was not set', error?.name || 'error')
  }

  try {
    const { SplashScreen } = await import('@capacitor/splash-screen')
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })
    await SplashScreen.hide()
  } catch (error) {
    console.warn('[native] splash was not hidden', error?.name || 'error')
  }
}
